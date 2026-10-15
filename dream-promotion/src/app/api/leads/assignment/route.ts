import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { claim, deliver, queueMessage } from '@/lib/server/lead-routing';
import { whatsappConfigured } from '@/lib/server/whatsapp';
import { NOTICE_COLUMNS, NOT_READY, leadsCaller, noticeView } from '@/lib/server/lead-departments';
import { NO_DEPARTMENT, WA_NOT_CONNECTED, leadTemplateParams, waErrorHint } from '@/features/crm/lead-routing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * A contact's department, person and WhatsApp messages (2.99) — the card.
 *  GET ?lead=<id>        → its department, its person, why, and every message about it (any member, not a cashier)
 *  POST { action }       → the owner only:
 *    assign { leadId, staffId | null, send }  another person (or none); with send, the template to the new person — once per
 *                                             contact and person, ever (a move back and forth never sends twice)
 *    resend { id }                            a message that failed, or was skipped (WhatsApp not connected / an old lead),
 *                                             sent now — taken by one sender only, never one that went out
 */
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const bad = (message: string, code = 'invalid', status = 400) => json({ code, message }, status);

async function card(biz: string, leadId: string, owner: boolean) {
  const db = adminDb();
  const [{ data: lead, error }, { data: notes }] = await Promise.all([
    db.from('leads').select('id, department_id, assigned_staff_id, routed_at, routed_by').eq('id', leadId).eq('business_id', biz).maybeSingle(),
    db.from('lead_notifications').select(NOTICE_COLUMNS).eq('lead_id', leadId).eq('business_id', biz).order('created_at', { ascending: true }),
  ]);
  if (error) return null; // before the migration
  if (!lead) return { missing: true as const };
  const l = lead as any;
  return {
    lead: { id: l.id, departmentId: l.department_id ?? null, assignedStaffId: l.assigned_staff_id ?? null, routedAt: l.routed_at ?? null, routedBy: l.routed_by ?? '' },
    notifications: (notes ?? []).map((n: any) => ({ ...noticeView(n), hint: waErrorHint(n.error_code ?? ''), ...(owner ? { raw: n.error?.response ?? null } : {}) })),
    connected: whatsappConfigured(), owner,
  };
}

export async function GET(req: Request) {
  const c = await leadsCaller(req, false);
  if ('res' in c) return c.res;
  const leadId = new URL(req.url).searchParams.get('lead') ?? '';
  const r = await card(c.biz, leadId, c.owner);
  if (!r) return json({ ready: false, ...NOT_READY });
  if ('missing' in r) return bad('איש הקשר לא נמצא.', 'not_found', 404);
  return json({ ready: true, ...r });
}

export async function POST(req: Request) {
  const c = await leadsCaller(req, true);
  if ('res' in c) return c.res;
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  const db = adminDb();

  if (body.action === 'assign') {
    const leadId = String(body.leadId ?? '');
    const { data: lead, error } = await db.from('leads').select('id, name, phone, notes, department_id, assigned_staff_id, routed_at')
      .eq('id', leadId).eq('business_id', c.biz).maybeSingle();
    if (error) return json(NOT_READY, 409);
    if (!lead) return bad('איש הקשר לא נמצא.', 'not_found', 404);
    const l = lead as any;
    let to: { id: string; name: string; phone: string } | null = null;
    if (body.staffId) {
      const { data: s } = await db.from('lead_staff').select('id, name, phone, active').eq('id', String(body.staffId)).eq('business_id', c.biz).maybeSingle();
      if (!(s as any)?.active) return bad('צריך לבחור אדם מהצוות.');
      to = s as any;
    }
    const before = l.assigned_staff_id as string | null;
    if (before !== (to?.id ?? null)) {
      const up = await db.from('leads').update({ assigned_staff_id: to?.id ?? null, routed_at: l.routed_at ?? new Date().toISOString() })
        .eq('id', leadId).eq('business_id', c.biz);
      if (up.error) return bad(up.error.message, 'db', 500);
      const { data: prev } = before ? await db.from('lead_staff').select('name').eq('id', before).maybeSingle() : { data: null };
      await db.from('lead_activities').insert({
        user_id: c.userId, business_id: c.biz, lead_id: leadId, kind: 'note',
        body: to ? `👤 הליד הועבר ל${to.name}${(prev as any)?.name ? ` (במקום ${(prev as any).name})` : ''}` : `👤 הליד כבר לא משויך ל${(prev as any)?.name ?? 'אף אחד'}`,
      });
    }
    let sent: unknown = null;
    if (to && body.send) {
      const { data: dept } = l.department_id ? await db.from('lead_departments').select('name').eq('id', l.department_id).maybeSingle() : { data: null };
      const connected = whatsappConfigured();
      const id = await queueMessage({
        businessId: c.biz, leadId, staff: to, kind: 'move', dedupeKey: `move:${leadId}:${to.id}`,
        params: leadTemplateParams({ department: (dept as any)?.name ?? NO_DEPARTMENT, name: l.name, phone: l.phone ?? '', details: l.notes ?? '' }),
        status: connected ? 'queued' : 'skipped', reason: connected ? '' : 'not_connected',
      });
      if (!id) sent = { status: 'already', message: `כבר נשלחה ל${to.name} הודעה על הליד הזה — היא לא נשלחת שוב.` };
      else if (!connected) sent = { status: 'skipped', message: WA_NOT_CONNECTED };
      else {
        const row = await claim(id, ['queued']);
        sent = row ? await deliver(row) : { status: 'taken' };
      }
    }
    const view = await card(c.biz, leadId, true);
    return json({ ok: true, sent, ...(view && !('missing' in view) ? view : {}) });
  }

  if (body.action === 'resend') {
    if (!whatsappConfigured()) return json({ code: 'not_connected', message: WA_NOT_CONNECTED }, 409);
    const id = String(body.id ?? '');
    const { data: n } = await db.from('lead_notifications').select('id, lead_id, status').eq('id', id).eq('business_id', c.biz).maybeSingle();
    if (!n) return bad('ההודעה לא נמצאה.', 'not_found', 404);
    const row = await claim(id, ['failed', 'skipped']);
    if (!row) return bad('ההודעה כבר נשלחה, או שהיא נשלחת עכשיו.', 'taken', 409);
    const sent = await deliver(row);
    const view = await card(c.biz, (n as any).lead_id, true);
    return json({ ok: true, sent, ...(view && !('missing' in view) ? view : {}) });
  }

  return bad('פעולה לא מוכרת.');
}
