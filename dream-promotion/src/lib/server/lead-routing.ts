import { adminDb } from './admin';
import { pushToUser } from './push';
import { sendNewLead, whatsappConfigured, type WaSend } from './whatsapp';
import {
  NO_DEPARTMENT, isFresh, leadFacts, leadTemplateParams, routeLead, waErrorCode,
  type DeptRule, type RoutingDept, type WaError,
} from '@/features/crm/lead-routing';
import type { MappedLead } from '@/features/crm/meta-leads';

/**
 * Lead departments on the server (2.99, migration 20261012005300). A new lead from a Meta form → its department (lead-routing.ts)
 * → the contact gets the department and the person responsible ("אחראי") → one WhatsApp message (the template lead_assigned) to that
 * person only, queued in lead_notifications and sent at the end of the sync:
 *  - never twice: one row per Meta lead and person (unique dedupe_key), and a row is taken by one sender only
 *    (queued → sending, a conditional update) — a second sync, or two at once, find it taken;
 *  - a failure: one more try (not after a timeout — the first may have arrived), then Meta's whole error on the row
 *    and a push to the business's owners;
 *  - WhatsApp not connected (no token) or a lead older than 24 hours: the contact is still assigned; the message is
 *    "skipped" with its reason, and the owner may send it from the card.
 * Before the migration, or in a business with no departments and no default recipient, nothing here runs: the import is as before.
 */

export type StaffRow = { id: string; name: string; phone: string; active: boolean; member_user_id: string | null };
export type RoutingConfig = { depts: RoutingDept[]; staff: Map<string, StaffRow>; defaultStaffId: string | null };

const RETRY_WAIT_MS = 1_500;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** the business's departments (active, with their rules), its team and its default recipient — null: nothing to route */
export async function loadRouting(businessId: string): Promise<RoutingConfig | null> {
  const db = adminDb();
  const [staff, depts, rules, setting] = await Promise.all([
    db.from('lead_staff').select('id, name, phone, active, member_user_id').eq('business_id', businessId),
    db.from('lead_departments').select('id, name, staff_id, position, active').eq('business_id', businessId).eq('active', true),
    db.from('lead_department_rules').select('department_id, kind, form_id, form_name, campaign, question, answer').eq('business_id', businessId),
    db.from('lead_routing').select('default_staff_id').eq('business_id', businessId).maybeSingle(),
  ]);
  if (staff.error || depts.error || rules.error) return null; // before migration 20261012005300
  const team = new Map<string, StaffRow>(((staff.data ?? []) as StaffRow[]).map((s) => [s.id, s]));
  const live = (id: string | null | undefined) => (id && team.get(id)?.active ? id : null);
  const byDept = new Map<string, DeptRule[]>();
  for (const r of (rules.data ?? []) as any[]) {
    const list = byDept.get(r.department_id) ?? [];
    list.push({ kind: r.kind, formId: r.form_id, formName: r.form_name, campaign: r.campaign, question: r.question, answer: r.answer });
    byDept.set(r.department_id, list);
  }
  const out: RoutingDept[] = ((depts.data ?? []) as any[])
    .filter((d) => live(d.staff_id))
    .map((d) => ({ id: d.id, name: d.name, staffId: d.staff_id, position: d.position ?? 0, rules: byDept.get(d.id) ?? [] }));
  const defaultStaffId = live((setting.data as any)?.default_staff_id ?? null);
  if (!out.length && !defaultStaffId) return null;
  return { depts: out, staff: team, defaultStaffId };
}

export type RouteInput = {
  businessId: string; leadId: string; formName: string; lead: MappedLead;
  /** the contact existed before this lead (same phone): it keeps a person it already has */
  existing: boolean;
};

/**
 * One lead from a Meta form: sets the contact's department and person (a new contact always; an existing one only when it has
 * no person yet) and queues the message to the person. Returns the queued row's id (null: nobody to send to / already queued).
 */
export async function routeMetaLead(cfg: RoutingConfig, input: RouteInput, now = new Date()): Promise<string | null> {
  const db = adminDb();
  const { businessId, leadId, formName, lead } = input;
  const r = routeLead(cfg.depts, leadFacts(lead, formName), cfg.defaultStaffId);
  let assign = true;
  if (input.existing) {
    const { data } = await db.from('leads').select('assigned_staff_id').eq('id', leadId).eq('business_id', businessId).maybeSingle();
    assign = !(data as any)?.assigned_staff_id;
  }
  if (assign) {
    const { error } = await db.from('leads').update({
      department_id: r.departmentId, assigned_staff_id: r.staffId, routed_at: now.toISOString(), routed_by: r.by,
    }).eq('id', leadId).eq('business_id', businessId);
    if (error) throw new Error(`route_lead: ${error.message}`);
  }
  const person = r.staffId ? cfg.staff.get(r.staffId) : null;
  if (!person?.active) return null;
  const params = leadTemplateParams({ department: r.departmentId ? r.departmentName : NO_DEPARTMENT, name: lead.name, phone: lead.phone, formName, email: lead.email, answers: lead.answers });
  const fresh = isFresh(lead.createdAt, now.getTime());
  return queueMessage({
    businessId, leadId, staff: person, kind: 'lead', dedupeKey: `lead:${lead.externalId}:${person.id}`, externalId: lead.externalId, params,
    status: !fresh ? 'skipped' : whatsappConfigured() ? 'queued' : 'skipped', reason: !fresh ? 'old_lead' : whatsappConfigured() ? '' : 'not_connected',
  });
}

/** a row in lead_notifications; null when the same key is there already (never twice) */
export async function queueMessage(m: {
  businessId: string; leadId: string; staff: Pick<StaffRow, 'id' | 'name' | 'phone'>; kind: 'lead' | 'move'; dedupeKey: string;
  externalId?: string; params: string[]; status: 'queued' | 'skipped'; reason: string;
}): Promise<string | null> {
  const { data, error } = await adminDb().from('lead_notifications').insert({
    business_id: m.businessId, lead_id: m.leadId, staff_id: m.staff.id, kind: m.kind, dedupe_key: m.dedupeKey.slice(0, 200),
    external_id: m.externalId ?? '', staff_name: m.staff.name, to_phone: m.staff.phone, params: m.params, status: m.status, reason: m.reason,
  }).select('id').single();
  if (error) {
    if ((error as any).code === '23505') return null;
    throw new Error(`queue_message: ${error.message}`);
  }
  return (data as any).id as string;
}

type NoteRow = {
  id: string; business_id: string; lead_id: string; staff_id: string; staff_name: string; to_phone: string; params: string[];
  status: string; attempts: number; kind: string;
};
export type Delivered = { status: 'sent' | 'failed' | 'skipped' | 'taken'; code?: string; error?: WaError; messageId?: string; attempts?: number };

/** takes a row for sending — from 'queued' (the timer), or from 'failed' / 'skipped' (the owner's "שליחה שוב"); one taker */
export async function claim(id: string, from: string[]): Promise<NoteRow | null> {
  const db = adminDb();
  const { data: row } = await db.from('lead_notifications')
    .select('id, business_id, lead_id, staff_id, staff_name, to_phone, params, status, attempts, kind').eq('id', id).maybeSingle();
  if (!row || !from.includes((row as any).status)) return null;
  const { data: took } = await db.from('lead_notifications').update({ status: 'sending', claimed_at: new Date().toISOString() })
    .eq('id', id).eq('status', (row as any).status).select('id');
  return Array.isArray(took) && took.length === 1 ? (row as NoteRow) : null;
}

/** sends a row already taken: to the person's number now (still on the team), one more try on a definite failure */
export async function deliver(row: NoteRow, opts: { waitMs?: number } = {}): Promise<Delivered> {
  const db = adminDb();
  const done = (patch: Record<string, unknown>) => db.from('lead_notifications').update(patch).eq('id', row.id);
  if (!whatsappConfigured()) {
    await done({ status: 'skipped', reason: 'not_connected', claimed_at: null });
    return { status: 'skipped', code: 'not_connected' };
  }
  const { data: person } = await db.from('lead_staff').select('id, name, phone, active').eq('id', row.staff_id).eq('business_id', row.business_id).maybeSingle();
  if (!(person as any)?.active) {
    await done({ status: 'skipped', reason: 'staff_removed', claimed_at: null });
    return { status: 'skipped', code: 'staff_removed' };
  }
  const to = String((person as any).phone);
  const params = Array.isArray(row.params) ? row.params.map(String) : [];
  let attempts = row.attempts ?? 0;
  let res: WaSend = await sendNewLead(to, params); attempts++;
  if (!res.ok && res.definite && !['not_connected', 'invalid_recipient'].includes(res.error.code)) {
    await wait(opts.waitMs ?? RETRY_WAIT_MS);
    // "text too long": the second try carries the form's details shortened
    const again = res.error.code === '132005' ? params.map((p, i) => (i === 3 && p.length > 300 ? `${p.slice(0, 299)}…` : p)) : params;
    res = await sendNewLead(to, again); attempts++;
  }
  if (res.ok) {
    await done({ status: 'sent', attempts, wa_message_id: res.messageId, sent_at: new Date().toISOString(), error_code: '', error: null, to_phone: to, reason: '' });
    return { status: 'sent', messageId: res.messageId, attempts };
  }
  const code = waErrorCode(res.error);
  await done({ status: 'failed', attempts, error_code: code, error: { ...res.error, response: res.body ?? null }, to_phone: to });
  await pushFailure(row, code);
  return { status: 'failed', code, error: res.error, attempts };
}

/** the owners of the business hear about a message that did not go out */
async function pushFailure(row: NoteRow, code: string) {
  try {
    const db = adminDb();
    const [{ data: owners }, { data: lead }] = await Promise.all([
      db.from('business_members').select('user_id').eq('business_id', row.business_id).eq('role', 'owner'),
      db.from('leads').select('name').eq('id', row.lead_id).maybeSingle(),
    ]);
    const dept = Array.isArray(row.params) ? String(row.params[0] ?? '') : '';
    for (const o of (owners ?? []) as { user_id: string }[]) {
      await pushToUser(o.user_id, {
        title: '⚠️ ליד לא נשלח בוואטסאפ',
        body: `${(lead as any)?.name ?? 'ליד'}${dept ? ` · ${dept}` : ''} → ${row.staff_name} · קוד ${code}`,
        url: `/leads?lead=${row.lead_id}`, tag: `lead-wa-${row.id}`,
      });
    }
  } catch { /* the failure is on the row and on the card either way */ }
}

/** the queue: every 'queued' message (of one business, or all), oldest first, while there is time */
export async function sendQueued(opts: { deadline: number; businessId?: string; limit?: number; waitMs?: number }) {
  const out = { sent: 0, failed: 0, skipped: 0 };
  let q = adminDb().from('lead_notifications').select('id').eq('status', 'queued');
  if (opts.businessId) q = q.eq('business_id', opts.businessId);
  const { data, error } = await q.order('created_at', { ascending: true }).limit(opts.limit ?? 50);
  if (error) return out; // before the migration
  for (const { id } of (data ?? []) as { id: string }[]) {
    // a message with its one more try takes up to ~17 s: none starts that late
    if (Date.now() > opts.deadline - 5_000) break;
    const row = await claim(id, ['queued']);
    if (!row) continue;
    const r = await deliver(row, { waitMs: opts.waitMs });
    if (r.status === 'sent') out.sent++; else if (r.status === 'failed') out.failed++; else out.skipped++;
  }
  return out;
}

