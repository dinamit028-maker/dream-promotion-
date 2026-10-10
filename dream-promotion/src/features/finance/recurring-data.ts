import { supabase } from '@/lib/supabase/client';
import {
  CHARGE_COLUMNS, PLAN_COLUMNS, recurringErrorHe, toCharge, toRecurringPlan, usedLines, type PlanInput, type RecurringCharge, type RecurringPlan,
} from './recurring';

/**
 * The screens' reads and calls of recurring charges (migration 20261010004500). The database checks everything again:
 * recurring_plan_save / _set and recurring_charge_retry (finance_guard + can_write), and row-level security on every read
 * (never a cashier, never another business). Until the migration is in the database the screen says so (recurringReady).
 */
export const RECURRING_MIGRATION = 'החיובים החוזרים עוד לא הופעלו במסד הנתונים (מיגרציה 20261010004500). אחרי שבעל המערכת מריץ אותה — המסך הזה נפתח.';
let readyCache: boolean | null = null;
export async function recurringReady(): Promise<boolean> {
  if (readyCache) return true;
  const { error } = await supabase().from('recurring_plans').select('id').limit(1);
  readyCache = !error;
  return readyCache;
}

export type Res<T> = { ok: true; data: T } | { ok: false; error: string };
const FAILED = 'הטעינה נכשלה. נסו שוב.';

/** the business's plans (or one customer's) */
export async function loadRecurringPlans(f: { leadId?: string } = {}): Promise<Res<RecurringPlan[]>> {
  let q = supabase().from('recurring_plans').select(PLAN_COLUMNS).order('created_at', { ascending: false }).limit(500);
  if (f.leadId) q = q.eq('lead_id', f.leadId);
  const { data, error } = await q;
  return error ? { ok: false, error: FAILED } : { ok: true, data: ((data ?? []) as any[]).map(toRecurringPlan) };
}
/** the charges: of some plans, or the latest of the business */
export async function loadRecurringCharges(f: { planIds?: string[]; limit?: number } = {}): Promise<Res<RecurringCharge[]>> {
  let q = supabase().from('recurring_charges').select(CHARGE_COLUMNS).order('period_date', { ascending: false }).limit(f.limit ?? 300);
  if (f.planIds) q = q.in('plan_id', f.planIds.length ? f.planIds : ['00000000-0000-0000-0000-000000000000']);
  const { data, error } = await q;
  return error ? { ok: false, error: FAILED } : { ok: true, data: ((data ?? []) as any[]).map(toCharge) };
}

/** what the charges point to: their documents (number, total), their drafts (still open?) and their links (paid?) */
export interface ChargeRefs {
  docs: Map<string, { docType: number; docNumber: number; total: number }>;
  drafts: Map<string, { open: boolean; documentId: string | null }>;
  links: Map<string, { status: string; isTest: boolean }>;
}
export async function loadChargeRefs(charges: RecurringCharge[]): Promise<ChargeRefs> {
  const sb = supabase();
  const ids = (k: 'documentId' | 'draftId' | 'paylinkId') => [...new Set(charges.map((c) => c[k]).filter(Boolean) as string[])];
  const [d, dr, l] = await Promise.all([
    ids('documentId').length ? sb.from('documents').select('id, doc_type, doc_number, total').in('id', ids('documentId')) : Promise.resolve({ data: [] as any[] }),
    ids('draftId').length ? sb.from('document_drafts').select('id, status, document_id').in('id', ids('draftId')) : Promise.resolve({ data: [] as any[] }),
    ids('paylinkId').length ? sb.from('payment_requests').select('id, status, is_test').in('id', ids('paylinkId')) : Promise.resolve({ data: [] as any[] }),
  ]);
  return {
    docs: new Map(((d.data ?? []) as any[]).map((x) => [x.id, { docType: Number(x.doc_type), docNumber: Number(x.doc_number), total: Number(x.total) }])),
    drafts: new Map(((dr.data ?? []) as any[]).map((x) => [x.id, { open: x.status === 'open', documentId: x.document_id ?? null }])),
    links: new Map(((l.data ?? []) as any[]).map((x) => [x.id, { status: String(x.status), isTest: Boolean(x.is_test) }])),
  };
}

/** a plan: a new one (its id from the editor — the same press again is the same plan) or new terms for one */
export async function saveRecurringPlan(id: string, p: PlanInput, amount: number): Promise<Res<{ result: string; next: string; status: string }>> {
  const { data, error } = await supabase().rpc('recurring_plan_save', {
    p_id: id, p_lead: p.leadId, p_name: p.name.trim(), p_lines: usedLines(p.lines), p_prices_include_vat: p.pricesIncludeVat, p_amount: amount,
    p_every: p.every, p_day: p.day, p_start: p.startDate, p_end: p.endDate || null, p_mode: p.mode, p_send_link: p.sendLink, p_note: p.note.trim(),
  });
  if (error) return { ok: false, error: recurringErrorHe(error) };
  const r = (data ?? {}) as Record<string, any>;
  return { ok: true, data: { result: String(r.result ?? ''), next: String(r.next ?? ''), status: String(r.status ?? 'active') } };
}
/** pause / resume / end — what was issued stays; a charge that waited is held ("נסו שוב" issues it, by choice) */
export async function setRecurringPlan(id: string, action: 'pause' | 'resume' | 'end', reason = ''): Promise<Res<{ status: string; next: string; held: number }>> {
  const { data, error } = await supabase().rpc('recurring_plan_set', { p_plan: id, p_action: action, p_reason: reason.trim().slice(0, 300) });
  if (error) return { ok: false, error: recurringErrorHe(error) };
  const r = (data ?? {}) as Record<string, any>;
  return { ok: true, data: { status: String(r.status ?? ''), next: String(r.next ?? ''), held: Number(r.held ?? 0) } };
}
/** "נסו שוב": a held charge goes back to the timer (within two minutes) */
export async function retryRecurringCharge(id: string): Promise<Res<boolean>> {
  const { data, error } = await supabase().rpc('recurring_charge_retry', { p_charge: id });
  if (error) return { ok: false, error: recurringErrorHe(error) };
  return { ok: true, data: data === true };
}
