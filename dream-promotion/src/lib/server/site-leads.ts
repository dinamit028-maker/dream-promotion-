import { adminDb } from './admin';
import { pushToUser } from './push';
import { whatsappConfigured } from './whatsapp';
import { claim, deliver, loadRouting, queueMessage, type RoutingConfig } from './lead-routing';
import { NO_DEPARTMENT, isFresh, leadTemplateParams } from '@/features/crm/lead-routing';
import { routeSite, siteDetails, type SiteRequest } from '@/features/crm/site-leads';

/**
 * A request of the site (2.102, migration 20261017005400) — "בקשת הצעת מחיר" of a product sold by a quote, or the contact form —
 * is already a contact in the leads (sf_lead_request: a new one, or a note on the card of the one with the same phone). Here the
 * dashboard's server routes it, as a lead from a Meta form is routed (lead-routing.ts):
 *  - its department: a rule of a department that fits it (a question "מקור" = "אתר", "נושא" = …), else the department the owner
 *    chose for the site's requests (lead_routing.site_department_id), else none — and then the default recipient;
 *  - the contact gets the department and the person (a new contact always; a known one only when it has no person yet);
 *  - one WhatsApp message (the team's template, NEW_LEAD_TEMPLATE) to that person only — never twice ('site:<request>:<person>'),
 *    sent now;
 *  - the business's owners get a push about it either way;
 *  - the request is marked routed (routed_at): the storefront's call and the cron never route it twice.
 * Before the migration nothing here runs (no request is ever recorded).
 */

const COLUMNS = 'id, business_id, kind, item_id, model, item_name, lead_id, new_contact, name, phone, email, qty, topic, notes, page, preview, routed_at, created_at';

export type SiteRouted = { status: 'routed' | 'already' | 'not_found' | 'no_contact'; department?: string; staff?: string | null; message?: string | null; sent?: string };

/** the department the owner chose for the site's requests — null before the migration, or when none (or it was removed) */
async function siteDepartment(businessId: string, cfg: RoutingConfig | null): Promise<RoutingConfig['depts'][number] | null> {
  if (!cfg) return null;
  const { data, error } = await adminDb().from('lead_routing').select('site_department_id').eq('business_id', businessId).maybeSingle();
  const id = error ? null : ((data as any)?.site_department_id as string | null) ?? null;
  return id ? cfg.depts.find((d) => d.id === id) ?? null : null;
}

/** routes one request (the storefront's call, or the cron) — once */
export async function routeSiteRequest(requestId: string, now = new Date()): Promise<SiteRouted> {
  const db = adminDb();
  const { data: row, error } = await db.from('site_requests').select(COLUMNS).eq('id', requestId).maybeSingle();
  if (error || !row) return { status: 'not_found' };
  const r = row as SiteRequest & { routed_at: string | null };
  if (r.routed_at) return { status: 'already' };
  // taken by one router only: the storefront's call and the cron may come at once. A failure on the way gives it back to the
  // cron; the message is never sent twice anyway (its key), and the owners hear once — after it was routed
  const { data: took } = await db.from('site_requests').update({ routed_at: now.toISOString() }).eq('id', r.id).is('routed_at', null).select('id');
  if (!Array.isArray(took) || took.length !== 1) return { status: 'already' };
  try {
    const out = await routeTaken(r, now);
    await pushOwners(r);
    return out;
  } catch (e) {
    await db.from('site_requests').update({ routed_at: null }).eq('id', r.id);
    throw e;
  }
}

async function routeTaken(r: SiteRequest, now: Date): Promise<SiteRouted> {
  const db = adminDb();
  if (!r.lead_id) return { status: 'no_contact' };
  const cfg = await loadRouting(r.business_id);
  if (!cfg) return { status: 'routed', department: NO_DEPARTMENT, staff: null, message: null };
  const route = routeSite(cfg.depts, r, await siteDepartment(r.business_id, cfg), cfg.defaultStaffId);
  // the contact: a new one gets the department and the person; a known one keeps a person it already has
  let assign = r.new_contact;
  if (!assign) {
    const { data } = await db.from('leads').select('assigned_staff_id').eq('id', r.lead_id).eq('business_id', r.business_id).maybeSingle();
    assign = !(data as any)?.assigned_staff_id;
  }
  if (assign) {
    const { error } = await db.from('leads').update({ department_id: route.departmentId, assigned_staff_id: route.staffId, routed_at: now.toISOString(), routed_by: route.by })
      .eq('id', r.lead_id).eq('business_id', r.business_id);
    if (error) throw new Error(`route_site: ${error.message}`);
  }
  const person = route.staffId ? cfg.staff.get(route.staffId) : null;
  if (!person?.active) return { status: 'routed', department: route.departmentName, staff: null, message: null };
  const params = leadTemplateParams({ department: route.departmentId ? route.departmentName : NO_DEPARTMENT, name: r.name, phone: r.phone, details: siteDetails(r) });
  const fresh = isFresh(r.created_at, now.getTime());
  const id = await queueMessage({
    businessId: r.business_id, leadId: r.lead_id, staff: person, kind: 'lead', dedupeKey: `site:${r.id}:${person.id}`, externalId: r.id, params,
    status: !fresh ? 'skipped' : whatsappConfigured() ? 'queued' : 'skipped', reason: !fresh ? 'old_lead' : whatsappConfigured() ? '' : 'not_connected',
  });
  if (!id) return { status: 'routed', department: route.departmentName, staff: person.name, message: null };
  const taken = await claim(id, ['queued']);
  const sent = taken ? (await deliver(taken)).status : 'skipped';
  return { status: 'routed', department: route.departmentName, staff: person.name, message: id, sent };
}

/** the business's owners hear about a new request of the site (a push; the request itself is on the contact's card) */
async function pushOwners(r: SiteRequest) {
  try {
    const { data: owners } = await adminDb().from('business_members').select('user_id').eq('business_id', r.business_id).eq('role', 'owner');
    for (const o of (owners ?? []) as { user_id: string }[]) {
      await pushToUser(o.user_id, {
        title: r.kind === 'quote' ? '📩 בקשת הצעת מחיר מהאתר' : '📩 פנייה מהאתר',
        body: [r.name, r.model, r.preview ? 'בדיקה מהתצוגה המקדימה' : ''].filter(Boolean).join(' · ').slice(0, 160),
        url: r.lead_id ? `/leads?lead=${r.lead_id}` : '/leads', tag: `site-${r.id}`,
      });
    }
  } catch { /* the request is on the card either way */ }
}

/** the cron: requests the storefront's call missed (the last 3 days), oldest first, while there is time */
export async function siteRequestsCron(deadline: number, now = new Date()) {
  const since = new Date(now.getTime() - 3 * 86400e3).toISOString();
  const { data, error } = await adminDb().from('site_requests').select('id').is('routed_at', null).gte('created_at', since)
    .order('created_at', { ascending: true }).limit(20);
  if (error) return null; // before the migration
  const out = { routed: 0, sent: 0 };
  for (const { id } of (data ?? []) as { id: string }[]) {
    if (Date.now() > deadline - 5_000) break;
    const r = await routeSiteRequest(id, now).catch(() => null);
    if (r?.status === 'routed') { out.routed++; if (r.sent === 'sent') out.sent++; }
  }
  return out;
}

