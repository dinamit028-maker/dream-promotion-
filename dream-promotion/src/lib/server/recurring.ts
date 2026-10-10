import { adminDb } from './admin';
import { businessOpen } from './business';
import { notifyManagers } from './notify';
import { byKey, issuerUser, resendPaylink, sendPaylink, settingsOf } from './paylinks';
import { dashboardOrigin } from './reminders';
import { chargeKey, composeCharge, customerOfLead, draftBody, toRecurringPlan, type PeriodContext } from '@/features/finance/recurring';
import { documentRow } from '@/features/finance/rows';
import { documentFailure } from '@/features/store/commerce';
import { israelParts } from '@/lib/il-time';

/**
 * Recurring charges on the dashboard's server (docs/FINANCE_ADDITIONS_HE.md T4; migration 20261010004500) — service role, so
 * every read and write names the charge's own business.
 *   the timer  /api/cron/commerce (every 2 minutes) asks recurring_due: the database makes each plan's charge for its period
 *              once (08:00–20:00 Israel time, not on Saturday; plan + period is unique) and hands out what waits — a charge
 *              handed out and not answered is handed out again after 10 minutes, at most 5 times
 *   a charge   its plan's lines → the one document builder (composeCharge: the business's invoice, today, due by its terms) —
 *              issued only for the amount the owner approved; the document's key recurring:<plan>:<period> keeps it one
 *              document, however many tries. A draft instead: document_drafts with the charge's own id (issuing it in the
 *              document center marks the charge issued, in the database). Then recurring_charge_done.
 *   the link   when the plan asks for one: a payment link of the invoice (sendPaylink — the database checks the terminal); by
 *              email only when it is a real link and the customer has an email. Never a card or a bank charge.
 *   blocked    what only the business can fix (the business's details, the customer's dealer number, an amount that moved) —
 *              held with the Hebrew reason for "נסו שוב"; anything else waits for the next run.
 */
type Db = ReturnType<typeof adminDb>;
const today = () => israelParts(Date.now()).date;

export type ChargeResult = {
  charge: string; business: string; result: 'issued' | 'draft' | 'blocked' | 'waiting' | 'none'; document?: string; error?: string; note?: string;
};
export interface RecurringRun { charges: number; issued: number; drafts: number; blocked: number; waiting: number; pushed: number }

/** a database without migration 4500 yet: the function is not there — nothing to do (not an error every 2 minutes) */
const missing = (e: { code?: string; message?: string }) =>
  e.code === 'PGRST202' || e.code === '42883' || /recurring_due.*(does not exist|schema cache)|schema cache/i.test(String(e.message ?? ''));

export async function recurringCron(now = new Date(), deadline = Date.now() + 10_000): Promise<RecurringRun | null> {
  const db = adminDb();
  const { data, error } = await db.rpc('recurring_due', { p_now: now.toISOString(), p_limit: 30 });
  if (error) { if (missing(error)) return null; throw new Error(error.message); }
  const results: ChargeResult[] = [];
  for (const id of (Array.isArray(data) ? data : []) as string[]) {
    if (Date.now() > deadline) break;                                    // the rest is handed out again in 10 minutes
    results.push(await runCharge(id));
  }
  // one notification per business: what was issued, what waits for approval, what was held
  const by = new Map<string, { issued: number; draft: number; blocked: number }>();
  for (const r of results) {
    if (!r.business || !['issued', 'draft', 'blocked'].includes(r.result)) continue;
    const n = by.get(r.business) ?? { issued: 0, draft: 0, blocked: 0 };
    n[r.result as 'issued' | 'draft' | 'blocked'] += 1;
    by.set(r.business, n);
  }
  let pushed = 0;
  for (const [business, n] of by) {
    const body = [
      n.issued ? (n.issued === 1 ? 'הופקה חשבונית אחת' : `הופקו ${n.issued} חשבוניות`) : '',
      n.draft ? (n.draft === 1 ? 'טיוטה אחת מחכה לאישור' : `${n.draft} טיוטות מחכות לאישור`) : '',
      n.blocked ? (n.blocked === 1 ? 'חיוב אחד לא הופק — לבדוק' : `${n.blocked} חיובים לא הופקו — לבדוק`) : '',
    ].filter(Boolean).join(' · ');
    const p = await notifyManagers(business, { title: 'חיובים חוזרים', body, url: '/finance/recurring', tag: `recurring-${business}` }).catch(() => ({ sent: 0 }));
    pushed += p.sent;
  }
  const count = (k: ChargeResult['result']) => results.filter((r) => r.result === k).length;
  return { charges: results.length, issued: count('issued'), drafts: count('draft'), blocked: count('blocked'), waiting: count('waiting'), pushed };
}

/** one charge the timer handed out: its document (or draft), its link, and the answer to the database */
export async function runCharge(id: string): Promise<ChargeResult> {
  const db = adminDb();
  const { data: row } = await db.from('recurring_charges').select('*').eq('id', id).maybeSingle();
  const c = row as any;
  if (!c) return { charge: id, business: '', result: 'none' };
  const base = { charge: id, business: String(c.business_id) };
  if (c.status !== 'pending') return { ...base, result: 'none' };
  const answer = async (status: 'issued' | 'draft' | 'blocked', x: { document?: string; draft?: string; paylink?: string | null; note?: string; error?: string } = {})
    : Promise<ChargeResult> => {
    const { data, error } = await db.rpc('recurring_charge_done', {
      p_charge: id, p_status: status, p_document: x.document ?? null, p_draft: x.draft ?? null, p_paylink: x.paylink ?? null,
      p_note: (x.note ?? '').slice(0, 300), p_error: (x.error ?? '').slice(0, 300),
    });
    if (error) return { ...base, result: 'waiting', error: String(error.message ?? error) };   // asked again in 10 minutes
    const done = String(data ?? '');
    return { ...base, result: (['issued', 'draft', 'blocked'].includes(done) ? done : 'none') as ChargeResult['result'], document: x.document, error: x.error, note: x.note };
  };
  const block = (reason: string) => answer('blocked', { error: reason });
  if (!(await businessOpen(c.business_id))) return { ...base, result: 'waiting', error: 'business_locked' };
  const { data: p } = await db.from('recurring_plans').select('*').eq('id', c.plan_id).eq('business_id', c.business_id).maybeSingle();
  if (!p) return block('החיוב החוזר לא נמצא.');
  const plan = toRecurringPlan(p);
  const { data: lead } = await db.from('leads').select('name, phone, email, billing_name, billing_dealer, billing_street, billing_city')
    .eq('id', plan.leadId).eq('business_id', c.business_id).maybeSingle();
  if (!lead) return block('הלקוח/ה של החיוב החוזר לא נמצא/ה.');
  // who issues it: who made the plan while they still write the business's money, else its owner
  const userId = await issuerUser(db, { user_id: (await writesMoney(db, c.business_id, plan.userId)) ? plan.userId : null, business_id: c.business_id });
  if (!userId) return block('לא נמצא בעל/ת העסק להפקת המסמך.');
  const [s, { data: fp }] = await Promise.all([
    settingsOf(db, c.business_id),
    db.from('business_finance_profile').select('payment_terms').eq('business_id', c.business_id).maybeSingle(),
  ]);
  const ctx: PeriodContext = { entity: s.entity, vatRate: s.vatRate, terms: String((fp as any)?.payment_terms ?? 'immediate'), customer: customerOfLead(lead as any), today: today() };
  const res = composeCharge(plan, c.period_date, ctx);
  if (!res.ok) return block(`לא הופק: ${res.errors.join(' · ')}`);
  const failed = (e: unknown): Promise<ChargeResult> | ChargeResult => {
    const f = documentFailure(e);
    if (!f.blocked) { console.error('[recurring] charge', id, (e as any)?.message ?? e); return { ...base, result: 'waiting', error: f.reason }; }
    return block(f.reason);
  };

  if (plan.mode === 'draft') {
    // the draft's id is the charge's: a second try finds it (23505), never a second draft
    const ins = await db.from('document_drafts').insert({
      id, user_id: userId, business_id: c.business_id, doc_type: res.doc.docType, customer_name: res.doc.customerName, lead_id: plan.leadId,
      total: res.doc.total, body: draftBody(plan, c.period_date, ctx),
    }).select('id').maybeSingle();
    if (ins.error && ins.error.code !== '23505') return failed(ins.error);
    return answer('draft', { draft: id });
  }

  const key = chargeKey(plan.id, c.period_date);
  let docId = await byKey(db, c.business_id, key);
  if (!docId) {
    const ins = await db.from('documents').insert({
      ...documentRow(res.doc, { userId, idempotencyKey: key, vatRate: res.totals.vatRate, leadId: plan.leadId }), business_id: c.business_id,
    }).select('id').single();
    if (!ins.error && ins.data) docId = (ins.data as any).id;
    else if (ins.error?.code === '23505' && /idempotency/.test(`${ins.error.message} ${(ins.error as any).details ?? ''}`)) docId = await byKey(db, c.business_id, key);
    if (!docId) return failed(ins.error);
  }
  const link = plan.sendLink ? await linkFor(db, { businessId: c.business_id, userId }, docId!, res.doc.total, ctx.customer.email ?? '') : { paylink: null, note: '' };
  return answer('issued', { document: docId!, paylink: link.paylink, note: link.note });
}

/** a member who may still write the money (owner / editor with full access) — a plan outlives its maker's membership */
async function writesMoney(db: Db, businessId: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const { data } = await db.from('business_members').select('role, access').eq('business_id', businessId).eq('user_id', userId).maybeSingle();
  return Boolean(data && ['owner', 'editor'].includes((data as any).role) && ((data as any).access ?? 'full') === 'full');
}

/** the invoice's payment link — the one an earlier try made, else a new one; a terminal that is not ready is a note, never a failure */
async function linkFor(db: Db, c: { businessId: string; userId: string }, docId: string, amount: number, email: string): Promise<{ paylink: string | null; note: string }> {
  const { data: had } = await db.from('payment_requests').select('id').eq('business_id', c.businessId).eq('document_id', docId).eq('kind', 'document').limit(1);
  const first = ((had ?? []) as any[])[0];
  if (first) return { paylink: first.id, note: '' };
  const origin = dashboardOrigin();
  if (!origin) return { paylink: null, note: 'לא נוצר לינק לתשלום: חסרה כתובת הדשבורד (APP_URL ב-Vercel).' };
  const r = await sendPaylink(c, { kind: 'document', target: docId, amount, days: 14, via: 'link' }, origin);
  if (!r.ok) return { paylink: null, note: `לא נוצר לינק לתשלום: ${r.message}` };
  const linkId = String(r.link.id);
  if (r.link.is_test) return { paylink: linkId, note: 'לינק בדיקה — לא נשלח ללקוח/ה (תשלום אמיתי בלינק עוד לא הופעל).' };
  if (!email) return { paylink: linkId, note: 'הלינק מוכן. אין מייל בכרטיס — שולחים אותו מהמסמך (וואטסאפ).' };
  const sent = await resendPaylink({ businessId: c.businessId }, linkId, 'email', origin);
  return { paylink: linkId, note: sent.ok && sent.emailed ? 'הלינק נשלח ללקוח/ה במייל.' : 'הלינק מוכן — המייל לא נשלח. שולחים אותו מהמסמך.' };
}
