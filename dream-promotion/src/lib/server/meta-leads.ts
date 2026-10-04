import { adminDb } from './admin';
import { open } from './secrets';
import { businessOpen } from './business';
import { formLeads, leadForms } from './meta';
import {
  META_LEADS_SOURCE, RECONNECT_FOR_LEADS, SPONSORED_TAG, isLeadsPermissionError, leadNote, mapMetaLead, noteMarker, planImport,
  type MappedLead,
} from '@/features/crm/meta-leads';

/**
 * Leads from Meta Lead Ads forms into the CRM (the timer every 10 minutes, and "סנכרון עכשיו").
 * Per Facebook Page whose switch is on (social_accounts.leads_enabled) and whose business is open:
 * every form → the leads since the last sync → contacts in THAT Page's business. A lead always goes to
 * the business the Page is assigned to (business_id is set explicitly, never from anyone's "current" one).
 * Nothing is imported twice: the Meta lead id is unique per business; a lead that matched an existing
 * contact by phone is marked inside its note.
 */
const FIRST_SYNC_DAYS = 30;                 // a Page switched on for the first time brings the last month
const OVERLAP_MS = 10 * 60_000;             // re-read a little before the last sync — duplicates are skipped anyway

type PageRow = { id: string; external_id: string; access_token: string; business_id: string; user_id: string; display_name: string | null };
export type PageResult = { accountId: string; page: string; imported: number; noted: number; skipped: number; error?: string };

/** Who is recorded as the creator of imported contacts: the business owner (else whoever connected the Page). */
async function ownerOf(businessId: string, fallback: string) {
  const { data } = await adminDb().from('business_members').select('user_id, role, created_at').eq('business_id', businessId);
  const rows = (data ?? []) as { user_id: string; role: string; created_at: string }[];
  return (rows.find((r) => r.role === 'owner') ?? rows[0])?.user_id ?? fallback;
}

export async function syncPage(page: PageRow, now = new Date()): Promise<PageResult> {
  const db = adminDb();
  const res: PageResult = { accountId: page.id, page: page.display_name ?? page.external_id, imported: 0, noted: 0, skipped: 0 };
  const { data: state } = await db.from('meta_lead_sync').select('last_synced_at, imported_total').eq('social_account_id', page.id).maybeSingle();
  const since = state?.last_synced_at ? +new Date(state.last_synced_at) - OVERLAP_MS : +now - FIRST_SYNC_DAYS * 864e5;
  const saveState = (patch: Record<string, unknown>) => db.from('meta_lead_sync').upsert({
    social_account_id: page.id, business_id: page.business_id, ...patch,
  }, { onConflict: 'social_account_id' });

  try {
    const token = open(page.access_token);
    const owner = await ownerOf(page.business_id, page.user_id);
    for (const form of await leadForms(token, page.external_id)) {
      const raw = await formLeads(token, form.id, since / 1000);
      if (!raw.length) continue;
      const mapped = raw.map((r) => mapMetaLead(r, form.labels));
      const added = await importLeads(page.business_id, owner, form.name, mapped);
      res.imported += added.imported; res.noted += added.noted; res.skipped += added.skipped;
    }
    await saveState({ last_synced_at: now.toISOString(), last_error: '', imported_total: (state?.imported_total ?? 0) + res.imported });
  } catch (e: any) {
    const m = String(e?.message ?? e);
    res.error = isLeadsPermissionError(m) || /reconnect_required/.test(m) ? RECONNECT_FOR_LEADS : m.replace(/^[a-z_0-9]+:\s*/i, '').slice(0, 240);
    await saveState({ last_error: res.error });
  }
  return res;
}

/** Writes one form's batch into one business. Exported for tests (in-memory database). */
export async function importLeads(businessId: string, owner: string, formName: string, mapped: MappedLead[]) {
  const db = adminDb();
  const out = { imported: 0, noted: 0, skipped: 0 };
  const { data: existing } = await db.from('leads').select('id, phone, external_id').eq('business_id', businessId).limit(10000);
  // leads that matched an existing contact earlier carry their Meta id in a note
  const { data: notes } = await db.from('lead_activities').select('body').eq('business_id', businessId).eq('kind', 'note').limit(10000);
  const noted = new Set<string>();
  for (const n of (notes ?? []) as { body: string }[]) for (const m of mapped) if (n.body?.includes(noteMarker(m.externalId))) noted.add(m.externalId);

  const created = new Map<string, string>(); // Meta id → new contact id (for a second lead with the same phone)
  const note = (leadId: string, m: MappedLead) => db.from('lead_activities').insert({
    user_id: owner, business_id: businessId, lead_id: leadId, kind: 'note', body: leadNote(formName, m),
    ...(m.createdAt ? { created_at: m.createdAt } : {}),
  });

  for (const step of planImport(mapped, (existing ?? []) as any[], noted)) {
    const m = step.lead;
    if (step.kind === 'skip') { out.skipped++; continue; }
    if (step.kind === 'existing' || step.kind === 'same_batch') {
      const leadId = step.kind === 'existing' ? step.leadId : created.get(step.firstExternalId);
      if (!leadId) { out.skipped++; continue; }
      await note(leadId, m); out.noted++; continue;
    }
    const ins = await db.from('leads').insert({
      user_id: owner, business_id: businessId, name: m.name, phone: m.phone, email: m.email,
      source: `Meta · ${formName}`.slice(0, 120), status: 'חדש', tags: [SPONSORED_TAG],
      external_source: META_LEADS_SOURCE, external_id: m.externalId,
      ...(m.createdAt ? { date: m.createdAt.slice(0, 10) } : {}),
    }).select('id').single();
    if (ins.error) {
      if (ins.error.code === '23505') { out.skipped++; continue; } // imported by a parallel run
      throw new Error(`insert_lead: ${ins.error.message}`);
    }
    created.set(m.externalId, ins.data.id);
    await note(ins.data.id, m);
    out.imported++;
  }
  return out;
}

/** Pages to sync: switched on, assigned, still connected — optionally of one business / some Pages. */
export async function syncLeads(opts: { deadline: number; businessId?: string; accountIds?: string[] }) {
  const db = adminDb();
  let q = db.from('social_accounts').select('id, external_id, access_token, business_id, user_id, display_name')
    .eq('provider', 'facebook').eq('leads_enabled', true).eq('status', 'active').not('business_id', 'is', null);
  if (opts.businessId) q = q.eq('business_id', opts.businessId);
  if (opts.accountIds?.length) q = q.in('id', opts.accountIds);
  const { data: pages, error } = await q;
  if (error) throw new Error(error.message);

  const open_ = new Map<string, boolean>();
  const summary = { pages: 0, imported: 0, noted: 0, skipped: 0, lockedSkipped: 0, errors: 0, results: [] as PageResult[] };
  for (const p of (pages ?? []) as PageRow[]) {
    if (Date.now() > opts.deadline) break;
    if (!open_.has(p.business_id)) open_.set(p.business_id, await businessOpen(p.business_id));
    if (!open_.get(p.business_id)) { summary.lockedSkipped++; continue; } // a locked business is not served
    const r = await syncPage(p);
    summary.pages++; summary.imported += r.imported; summary.noted += r.noted; summary.skipped += r.skipped;
    if (r.error) summary.errors++;
    summary.results.push(r);
  }
  return summary;
}
