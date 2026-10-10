import { composeDocument, computeLines, type ComposeCustomer, type ComposeResult } from './compose';
import type { ComposerBody } from './quotes';
import { dueDateFor } from './receivables';
import { chargesVat, invoiceDocType, type EntityType } from './rules';
import { ag } from './vat';
import { ils } from '@/features/register/money';
import { HE_MONTHS } from '@/lib/utils';

/**
 * Recurring charges ("חיובים חוזרים", docs/FINANCE_ADDITIONS_HE.md T4; migration 20261010004500): a retainer, a monthly
 * subscription, a standing order. A plan = a customer, lines, every 1 / 2 / 3 / 6 / 12 months on a day 1–28, from a start to an
 * end (or none), and what each period makes — an invoice at once (with a payment link, when the terminal is ready) or a draft the
 * owner issues. No card and no bank account is ever charged (an automatic charge is a separate stage, after an explicit approval).
 * The database decides (recurring_plan_save / _set, recurring_due: one charge per plan and period); these are the screens' and the
 * server's rules: the schedule (the same as recurring_date / recurring_on_or_after — tests/recurring.test.ts holds them to the
 * examples of tests/sql/recurring.check.sql), the labels, the checks before saving, and the document of a period.
 */
export type Every = 1 | 2 | 3 | 6 | 12;
export const EVERY: { months: Every; label: string }[] = [
  { months: 1, label: 'כל חודש' }, { months: 2, label: 'כל חודשיים' }, { months: 3, label: 'כל 3 חודשים' }, { months: 6, label: 'כל חצי שנה' },
  { months: 12, label: 'כל שנה' },
];
export const everyLabel = (n: number) => EVERY.find((e) => e.months === n)?.label ?? `כל ${n} חודשים`;
export type PlanStatus = 'active' | 'paused' | 'ended';
export type PlanMode = 'issue' | 'draft';
export type ChargeStatus = 'pending' | 'draft' | 'issued' | 'blocked';
export const STATUS_HE: Record<PlanStatus, string> = { active: 'פעיל', paused: 'מושהה', ended: 'הסתיים' };
export const MODE_HE: Record<PlanMode, string> = { issue: 'חשבונית אוטומטית', draft: 'טיוטה לאישור' };
export const LINES_MAX = 30;
export const AMOUNT_MAX = 1_000_000;

export interface RecurringLine { name: string; qty: number; unitPrice: number; itemId?: string; variantId?: string }
export interface RecurringPlan {
  id: string; leadId: string; userId: string | null; name: string; lines: RecurringLine[]; pricesIncludeVat: boolean; amount: number; every: Every;
  day: number; startDate: string; endDate: string | null; nextDate: string; mode: PlanMode; sendLink: boolean; status: PlanStatus; note: string;
  pausedAt: string | null; endedAt: string | null; endReason: string; createdAt: string;
}
export interface RecurringCharge {
  id: string; planId: string; periodDate: string; status: ChargeStatus; documentId: string | null; draftId: string | null; paylinkId: string | null;
  note: string; error: string; attempts: number; createdAt: string; updatedAt: string;
}
export const PLAN_COLUMNS = 'id, lead_id, user_id, name, lines, prices_include_vat, amount, every_months, day_of_month, start_date, end_date, next_date, mode, '
  + 'send_link, status, note, paused_at, ended_at, end_reason, created_at';
export const CHARGE_COLUMNS = 'id, plan_id, period_date, status, document_id, draft_id, paylink_id, note, error, attempts, created_at, updated_at';
const toLine = (l: any): RecurringLine => ({
  name: String(l?.name ?? ''), qty: Number(l?.qty ?? 0), unitPrice: Number(l?.unitPrice ?? 0),
  ...(l?.itemId ? { itemId: String(l.itemId), ...(l?.variantId ? { variantId: String(l.variantId) } : {}) } : {}),
});
export const toRecurringPlan = (r: any): RecurringPlan => ({
  id: r.id, leadId: r.lead_id, userId: r.user_id ?? null, name: r.name ?? '', lines: Array.isArray(r.lines) ? r.lines.map(toLine) : [],
  pricesIncludeVat: r.prices_include_vat !== false, amount: Number(r.amount), every: Number(r.every_months) as Every, day: Number(r.day_of_month),
  startDate: r.start_date, endDate: r.end_date ?? null, nextDate: r.next_date, mode: r.mode === 'draft' ? 'draft' : 'issue', sendLink: Boolean(r.send_link),
  status: r.status, note: r.note ?? '', pausedAt: r.paused_at ?? null, endedAt: r.ended_at ?? null, endReason: r.end_reason ?? '', createdAt: r.created_at,
});
export const toCharge = (r: any): RecurringCharge => ({
  id: r.id, planId: r.plan_id, periodDate: r.period_date, status: r.status, documentId: r.document_id ?? null, draftId: r.draft_id ?? null,
  paylinkId: r.paylink_id ?? null, note: r.note ?? '', error: r.error ?? '', attempts: Number(r.attempts ?? 0), createdAt: r.created_at, updatedAt: r.updated_at,
});

// ---- the schedule (the database's recurring_date / recurring_on_or_after) -------------------------------------------------------
const ymd = (d: string) => d.split('-').map(Number) as [number, number, number];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** the k-th date of a schedule: the anchor's month, every `every` months later, on `day` */
export function recurringDate(anchor: string, every: number, day: number, k: number): string {
  const [y, m] = ymd(anchor);
  const i = y * 12 + (m - 1) + every * k;
  return `${pad(Math.floor(i / 12), 4)}-${pad((i % 12) + 1)}-${pad(day)}`;
}
/** the first date of the schedule on or after `from` (never before the anchor); null for a day past the 28th */
export function onOrAfter(anchor: string, every: number, day: number, from: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !(every >= 1) || !(day >= 1 && day <= 28)) return null;
  const [ay, am] = ymd(anchor);
  const [fy, fm] = ymd(from);
  let k = Math.max(0, Math.trunc(((fy - ay) * 12 + fm - am) / every) - 1);
  for (;;) {
    const d = recurringDate(anchor, every, day, k);
    if (d >= from && d >= anchor) return d;
    k += 1;
  }
}
/** a new plan's first charge: the first date of the schedule from the start — never one in the past (as recurring_plan_save) */
export const firstCharge = (start: string, every: number, day: number, today: string) => onOrAfter(start, every, day, start > today ? start : today);
/** the next n dates of a plan, from its next date, up to its end */
export function upcoming(p: { startDate: string; every: number; day: number; nextDate: string; endDate: string | null }, n: number): string[] {
  const out: string[] = [];
  let d: string | null = p.nextDate;
  while (d && out.length < n && (!p.endDate || d <= p.endDate)) {
    out.push(d);
    d = onOrAfter(p.startDate, p.every, p.day, addDay(d));
  }
  return out;
}
const addDay = (d: string) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
const addMonthsYm = (d: string, n: number) => { const [y, m] = ymd(d); const i = y * 12 + (m - 1) + n; return { y: Math.floor(i / 12), m: i % 12 }; };

/** "כל חודש ב-5 לחודש" / "כל שנה ב-5 במרץ" */
export function scheduleLabel(every: number, day: number, anyDate?: string | null): string {
  if (every === 12 && anyDate) return `כל שנה ב-${day} ב${HE_MONTHS[ymd(anyDate)[1] - 1]}`;
  return `${everyLabel(every)} ב-${day} לחודש`;
}
/** the period a charge is for: "נובמבר 2026", or "נובמבר 2026 – ינואר 2027" for a longer one */
export function periodLabel(period: string, every: number): string {
  const [y, m] = ymd(period);
  const first = `${HE_MONTHS[m - 1]} ${y}`;
  if (every <= 1) return first;
  const last = addMonthsYm(period, every - 1);
  return `${first} – ${HE_MONTHS[last.m]} ${last.y}`;
}
/** the document's note (the customer reads it) and its key — one document per plan and period, whoever issues it, however often */
export const chargeNote = (name: string, period: string, every: number) => `חיוב חוזר: ${name.trim()} · ${periodLabel(period, every)}`.slice(0, 1000);
export const chargeKey = (planId: string, period: string) => `recurring:${planId}:${period}`;

// ---- the screens' checks (the database checks again) ----------------------------------------------------------------------------
export interface PlanInput {
  leadId: string | null; name: string; lines: RecurringLine[]; pricesIncludeVat: boolean; every: number; day: number; startDate: string;
  endDate: string | null; mode: PlanMode; sendLink: boolean; note: string;
}
const started = (l: RecurringLine) => Boolean(l.name.trim()) || Boolean(l.unitPrice);
export const usedLines = (lines: RecurringLine[]) => lines.filter(started).map((l) => ({ ...l, name: l.name.trim() }));
/** what a period comes to (what the owner approves; the server issues only this): the lines with the business's VAT */
export function planTotal(lines: RecurringLine[], pricesIncludeVat: boolean, entity: EntityType, vatRate: number): number {
  return computeLines(usedLines(lines), { pricesIncludeVat, rate: chargesVat(entity) ? vatRate : 0 }).totals.total;
}
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** the reason a plan cannot be saved, in Hebrew — or null. `charged`: the plan made a charge (its schedule stays) */
export function planError(p: PlanInput, total: number, today: string, o: { charged?: boolean; startWas?: string } = {}): string | null {
  if (!p.leadId) return 'בחרו לקוח/ה מאנשי הקשר.';
  if (!p.name.trim()) return 'תנו שם לחיוב (למשל "ריטיינר חודשי").';
  if (p.name.trim().length > 120) return 'השם ארוך מדי (עד 120 תווים).';
  const lines = usedLines(p.lines);
  if (!lines.length) return 'צריך לפחות שורה אחת (תיאור ומחיר).';
  if (lines.length > LINES_MAX) return `עד ${LINES_MAX} שורות.`;
  if (lines.some((l) => !l.name || l.name.length > 120 || !(l.qty > 0) || !(l.unitPrice >= 0))) return 'בכל שורה: תיאור, כמות גדולה מאפס ומחיר.';
  if (!(total > 0)) return 'הסכום חייב להיות גדול מאפס.';
  if (total > AMOUNT_MAX) return 'הסכום גדול מדי (עד ₪1,000,000 לתקופה).';
  if (!EVERY.some((e) => e.months === p.every)) return 'בחרו כל כמה זמן.';
  if (!(Number.isInteger(p.day) && p.day >= 1 && p.day <= 28)) return 'יום החיוב: בין 1 ל-28 (יום שיש בכל חודש).';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.startDate)) return 'תאריך ההתחלה לא תקין.';
  if (p.startDate !== o.startWas && (p.startDate < addDays(today, -366) || p.startDate > addDays(today, 366))) return 'תאריך ההתחלה — עד שנה אחורה או קדימה.';
  if (p.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(p.endDate)) return 'תאריך הסיום לא תקין.';
  if (p.endDate && p.endDate < p.startDate) return 'תאריך הסיום לפני ההתחלה.';
  if (!o.charged && p.endDate) {
    const first = firstCharge(p.startDate, p.every, p.day, today);
    if (first && first > p.endDate) return `החיוב הראשון יהיה ב-${first.split('-').reverse().join('/')} — אחרי תאריך הסיום.`;
  }
  if (p.note.length > 300) return 'ההערה ארוכה מדי (עד 300 תווים).';
  return null;
}

/** the database's refusals, for the screens */
export function recurringErrorHe(e: { message?: string; code?: string } | null | undefined): string {
  const m = String(e?.message ?? '');
  if (m.includes('recurring_customer: a plan keeps')) return 'חיוב חוזר נשאר עם אותו לקוח/ה. ללקוח/ה אחר/ת — חיוב חוזר חדש.';
  if (m.includes('recurring_customer')) return 'הלקוח/ה לא נמצא/ה בעסק הזה.';
  if (m.includes('recurring_schedule')) return 'אחרי החיוב הראשון לא משנים את התדירות, היום או ההתחלה. מסיימים את החיוב החוזר ופותחים חדש.';
  if (m.includes('recurring_ended')) return 'חיוב חוזר שהסתיים לא משתנה.';
  if (m.includes('no charge before the end date')) return 'החיוב הראשון יוצא אחרי תאריך הסיום — אין מה לחייב.';
  if (m.includes('recurring_end')) return 'תאריך הסיום לא תקין (לא לפני ההתחלה).';
  if (m.includes('recurring_start')) return 'תאריך ההתחלה — עד שנה אחורה או קדימה.';
  if (m.includes('the item') || m.includes('the variant')) return 'אחד הפריטים לא נמצא בקטלוג של העסק. בחרו אותו מחדש.';
  if (m.includes('recurring_lines')) return 'אחת השורות לא תקינה (תיאור, כמות גדולה מאפס ומחיר).';
  if (m.includes('recurring_amount')) return 'הסכום לא תקין (גדול מאפס, עד ₪1,000,000, באגורות).';
  if (m.includes('recurring_every')) return 'בחרו כל כמה זמן: חודש, חודשיים, 3 חודשים, חצי שנה או שנה.';
  if (m.includes('recurring_day')) return 'יום החיוב: בין 1 ל-28.';
  if (m.includes('recurring_name')) return 'תנו שם לחיוב (עד 120 תווים).';
  if (m.includes('recurring_note')) return 'ההערה ארוכה מדי (עד 300 תווים).';
  if (m.includes('recurring_not_found')) return 'החיוב החוזר לא נמצא בעסק הזה.';
  if (m.includes('business_locked')) return 'העסק נעול — אי אפשר לשנות כרגע.';
  if (m.includes('not allowed') || e?.code === '42501') return 'אין לך הרשאה לנהל את הכספים של העסק.';
  return 'החיוב החוזר לא נשמר. נסו שוב.';
}

// ---- what a period makes (the server) ---------------------------------------------------------------------------------------------
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** the customer on the document: the card's billing details (a business customer), else its name and contacts */
export function customerOfLead(l: { name?: string | null; phone?: string | null; email?: string | null; billing_name?: string | null; billing_dealer?: string | null;
  billing_street?: string | null; billing_city?: string | null } | null | undefined): ComposeCustomer {
  const email = String(l?.email ?? '').trim();
  return {
    name: String(l?.billing_name || l?.name || '').trim().slice(0, 120), phone: String(l?.phone ?? '').trim(), email: EMAIL.test(email) ? email : '',
    dealer: String(l?.billing_dealer ?? '').trim(), street: String(l?.billing_street ?? '').trim(), city: String(l?.billing_city ?? '').trim(),
  };
}
export interface PeriodContext { entity: EntityType; vatRate: number; terms: string; customer: ComposeCustomer; today: string }
type PlanTerms = Pick<RecurringPlan, 'name' | 'lines' | 'pricesIncludeVat' | 'amount' | 'every'>;
/**
 * The invoice of a period, through the one document builder: the business's invoice (305; an exempt dealer's 300), today, due by
 * the business's terms. Issued only when it comes to the amount the owner approved — a VAT rate that changed (on prices before
 * VAT) is the owner's to approve again, never an amount nobody saw.
 */
export function composeCharge(p: PlanTerms, period: string, o: PeriodContext): ComposeResult {
  const res = composeDocument({
    docType: invoiceDocType(o.entity), entity: o.entity, vatRate: o.vatRate, pricesIncludeVat: p.pricesIncludeVat, lines: usedLines(p.lines),
    customer: o.customer, docDate: o.today, dueDate: dueDateFor(o.today, o.terms), notes: chargeNote(p.name, period, p.every), today: o.today,
  });
  if (!res.ok) return res;
  if (ag(res.doc.total) !== ag(p.amount)) {
    return { ok: false, errors: [`הסכום יצא ${ils(res.doc.total)} ולא ${ils(p.amount)} כמו בחיוב החוזר (אולי השתנה שיעור המע״מ). פותחים את החיוב החוזר, בודקים ושומרים — ואז "נסו שוב".`] };
  }
  return res;
}
/** a period as a draft for the owner: what the document center's composer opens (the same lines, customer and note) */
export function draftBody(p: PlanTerms, period: string, o: PeriodContext): ComposerBody {
  return {
    lines: usedLines(p.lines), pricesIncludeVat: p.pricesIncludeVat, discount: { kind: 'sum', value: 0 }, customer: o.customer,
    notes: chargeNote(p.name, period, p.every), terms: o.terms, dueDate: dueDateFor(o.today, o.terms), payments: [],
  };
}

// ---- the screens' words ----------------------------------------------------------------------------------------------------------
/** a charge's state: issued, a draft waiting (or deleted: "not this period"), waiting for the timer, or held with why */
export function chargeLine(c: Pick<RecurringCharge, 'status' | 'draftId' | 'error'>): { text: string; tone: 'ok' | 'warn' | 'bad' | 'default' } {
  if (c.status === 'issued') return { text: 'הופק', tone: 'ok' };
  if (c.status === 'draft') return c.draftId ? { text: 'טיוטה לאישור', tone: 'warn' } : { text: 'הטיוטה נמחקה — לא חויב', tone: 'default' };
  if (c.status === 'blocked') return { text: `לא הופק${c.error ? `: ${c.error}` : ''}`, tone: 'bad' };
  return { text: 'ממתין להפקה', tone: 'default' };
}
/** a plan's line under its name: the next charge, paused, or ended (and why) */
export function planLine(p: Pick<RecurringPlan, 'status' | 'nextDate' | 'endReason'>): string {
  if (p.status === 'paused') return 'מושהה — לא מחייב עד שממשיכים';
  if (p.status === 'ended') return `הסתיים${p.endReason ? ` · ${p.endReason}` : ''}`;
  return `החיוב הבא: ${p.nextDate.split('-').reverse().join('/')}`;
}
/** the editor's start: today's day of the month (at most the 28th), from today, an invoice with a link each month */
export function newPlanInput(today: string, leadId: string | null = null): PlanInput {
  return {
    leadId, name: '', lines: [{ name: '', qty: 1, unitPrice: 0 }], pricesIncludeVat: true, every: 1, day: Math.min(28, Number(today.slice(8, 10)) || 1),
    startDate: today, endDate: null, mode: 'issue', sendLink: true, note: '',
  };
}
export const planInputOf = (p: RecurringPlan): PlanInput => ({
  leadId: p.leadId, name: p.name, lines: p.lines.length ? p.lines : [{ name: '', qty: 1, unitPrice: 0 }], pricesIncludeVat: p.pricesIncludeVat, every: p.every,
  day: p.day, startDate: p.startDate, endDate: p.endDate, mode: p.mode, sendLink: p.sendLink, note: p.note,
});
