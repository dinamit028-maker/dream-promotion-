import { periodOf, type PeriodKind } from './reports';
import { chargesVat, entityOf } from './rules';
import { pctOf } from './vat';
import type { Line } from './plans';
import type { RecurringPlan } from './recurring';
import type { FinanceSection } from './routes';

/**
 * The overview leads to action (docs/FINANCE_ADDITIONS_HE.md T7; 2.97): every card opens a list filtered by the same rules as
 * its number, for the same period — and the list's number is the card's. The cards that come from finance_summary() are
 * figured by the database; the lists that read the rows themselves (late payments, expenses, drafts, the week's charges, the
 * invoices without an allocation number) are figured here, by the database function's own rules — and the card shows the very
 * same function's answer where it has no number of its own in the summary (drafts, the week's charges). Pure functions: the
 * screens, tests/overview-lists.test.ts and the e2e (tests/e2e/overview.e2e.ts) hold them to one another.
 */
const ag = (n: number) => Math.round((Number(n) || 0) * 100);
const sh = (a: number) => a / 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// ---- the cards, and where each one leads -----------------------------------------------------------------------------------------
export type CardId = 'income' | 'expenses' | 'profit' | 'vat' | 'cash' | 'open' | 'overdue' | 'pending' | 'week' | 'drafts' | 'nodoc' | 'allocation';
/**
 * The screen and the address of a card's list, for the overview's period. Income: "לפי לקוח" in the reports (its total is the
 * money summary's income — checked in reports.check.sql), before the reports are in the database the income screen. Money in:
 * the income screen. Profit and VAT: the reports' summary (the same function). Owed, late and the register's requests: the
 * receivables. The week's charges: the recurring charges. Expenses and drafts: the expenses. Allocation numbers: the documents.
 */
export function cardTarget(card: CardId, p: { from: string; to: string }, o: { reports: boolean }): { section: FinanceSection; params: Record<string, string> } {
  const period = { from: p.from, to: p.to };
  switch (card) {
    case 'income': return o.reports ? { section: 'reports', params: { view: 'customers', ...period } } : { section: 'income', params: period };
    case 'expenses': return { section: 'expenses', params: { show: 'confirmed', ...period } };
    case 'profit': case 'vat': return { section: 'reports', params: { view: 'summary', ...period } };
    case 'cash': case 'nodoc': return { section: 'income', params: period };
    case 'open': return { section: 'receivables', params: {} };
    case 'overdue': return { section: 'receivables', params: { show: 'overdue' } };
    case 'pending': return { section: 'receivables', params: { show: 'pending' } };
    case 'week': return { section: 'recurring', params: { show: 'week' } };
    case 'drafts': return { section: 'expenses', params: { show: 'drafts' } };
    case 'allocation': return { section: 'documents', params: { show: 'allocation', ...period } };
  }
}

// ---- a period in the address (?from=…&to=…) ------------------------------------------------------------------------------------
export interface QueryPeriod { from: string; to: string; label: string; kind: PeriodKind | 'custom' }
/** the period an address names — a month, a VAT period or a year by its name, else "טווח"; null when it names none or a wrong one
 *  (the money summary takes up to 3,700 days) */
export function periodFromQuery(q: URLSearchParams): QueryPeriod | null {
  const from = q.get('from') ?? '', to = q.get('to') ?? '';
  if (!DATE.test(from) || !DATE.test(to) || from > to || Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))) return null;
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5 > 3700) return null;
  for (const kind of ['month', 'bimonth', 'year'] as const) {
    const p = periodOf(kind, from);
    if (p.from === from && p.to === to) return { ...p, kind };
  }
  return { from, to, label: 'טווח', kind: 'custom' };
}

// ---- late: by the lines (receivable_lines) — finance_summary's "overdue" and "overdueCount" ----------------------------------
export interface LateDoc {
  documentId: string; docType: number; docNumber: number; docDate: string; customerName: string; customerPhone: string; customerEmail: string;
  shareToken: string; leadId: string | null; balance: number;
  /** what of it is late (its lines past their date), the earliest late date, and the late lines themselves */
  late: number; since: string; lines: Line[];
}
/** the invoices with something late — what is late of each (a plan's payments past their date; an invoice without a plan: its
 *  balance past its date), the latest-late first; total and count are the summary's */
export function overdueDocs(lines: Pick<Line, keyof Line>[], today: string): { docs: LateDoc[]; total: number; count: number } {
  const by = new Map<string, LateDoc>();
  for (const l of lines) {
    if (!(ag(l.open) > 0 && l.dueDate && l.dueDate < today)) continue;
    const d = by.get(l.documentId) ?? { documentId: l.documentId, docType: l.docType, docNumber: l.docNumber, docDate: l.docDate, customerName: l.customerName,
      customerPhone: l.customerPhone, customerEmail: l.customerEmail, shareToken: l.shareToken, leadId: l.leadId, balance: l.docBalance, late: 0, since: l.dueDate, lines: [] };
    d.late = sh(ag(d.late) + ag(l.open));
    if (l.dueDate < d.since) d.since = l.dueDate;
    d.lines.push(l as Line);
    by.set(l.documentId, d);
  }
  const docs = [...by.values()].sort((a, b) => a.since.localeCompare(b.since) || a.docNumber - b.docNumber);
  return { docs, total: sh(docs.reduce((a, d) => a + ag(d.late), 0)), count: docs.length };
}
/** how many days a date is behind today */
export const daysBehind = (date: string, today: string) => Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 864e5);

// ---- expenses: their cost as the money summary counts it ----------------------------------------------------------------------
type ExpenseLike = { status: string; amountBeforeVat: number; vatAmount: number; vatDeductiblePct: number; supplierDocType: string; total: number };
/** an expense's cost (finance_summary): before VAT, plus the VAT that is not offset — a credit note takes off; in agorot */
export function expenseCostA(e: ExpenseLike, vatOn: boolean): number {
  const sign = e.supplierDocType === 'credit' ? -1 : 1;
  return sign * (ag(e.amountBeforeVat) + ag(e.vatAmount) - (vatOn ? pctOf(ag(e.vatAmount), e.vatDeductiblePct) : 0));
}
/** the overview's "הוצאות": the confirmed expenses of the period at their cost, and the manual expense entries (5100) — so: the
 *  expenses screen shows the same number as the card */
export function expensesCost(list: ExpenseLike[], vatOn: boolean, manual = 0): { count: number; cost: number; manual: number; total: number } {
  const confirmed = list.filter((e) => e.status === 'confirmed');
  const cost = confirmed.reduce((a, e) => a + expenseCostA(e, vatOn), 0);
  return { count: confirmed.length, cost: sh(cost), manual: sh(ag(manual)), total: sh(cost + ag(manual)) };
}
/** expenses waiting for approval (drafts — whatever their date): how many, and their sum (a credit note takes off) */
export function draftsTotal(list: Pick<ExpenseLike, 'status' | 'total' | 'supplierDocType'>[]): { count: number; total: number } {
  const d = list.filter((e) => e.status === 'draft');
  return { count: d.length, total: sh(d.reduce((a, e) => a + (e.supplierDocType === 'credit' ? -1 : 1) * ag(e.total), 0)) };
}

// ---- the charges of the week: active recurring plans whose next charge is due by the end of the next 7 days --------------------
/**
 * "חיובים השבוע": every active plan whose next charge is due by six days from today — one the timer did not make yet (its day
 * passed: a Saturday, or before 08:00) keeps its date and is still to come; a plan whose end is before its next date charges nothing
 * more. By date.
 */
export function weekCharges<T extends Pick<RecurringPlan, 'status' | 'nextDate' | 'endDate' | 'amount'>>(plans: T[], today: string) {
  const until = addDays(today, 6);
  const list = plans.filter((p) => p.status === 'active' && DATE.test(p.nextDate ?? '') && p.nextDate <= until && (!p.endDate || p.nextDate <= p.endDate))
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate));
  return { plans: list, count: list.length, total: sh(list.reduce((a, p) => a + ag(p.amount), 0)), until };
}

// ---- tax invoices above the threshold without an allocation number: finance_summary's "allocationMissing" -----------------------
export interface AllocDoc { id: string; docType: number; docDate: string; afterDiscount: number; customerDealer?: string | null; issuer?: { entityType?: string | null } | null }
export interface AllocRule { effectiveFrom: string; thresholdBeforeVat: number }
export interface AllocRow { documentId: string; status: string; isTest: boolean }
/**
 * As the database counts them: a 305 / 320 of the period, of a VAT-charging issuer (the document's own, else the business's), to a
 * customer with a dealer number, above the threshold in force on its date (none in force: never) — and no number approved or typed
 * in for it (a test number is not one).
 */
export function allocationMissingDocs<T extends AllocDoc>(docs: T[], rules: AllocRule[], allocations: AllocRow[], businessEntity: string): T[] {
  const sorted = [...rules].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const real = new Set(allocations.filter((a) => (a.status === 'approved' || a.status === 'manual') && !a.isTest).map((a) => a.documentId));
  return docs.filter((d) => {
    if (d.docType !== 305 && d.docType !== 320) return false;
    if (!chargesVat(entityOf(d.issuer?.entityType || businessEntity))) return false;
    if (!(d.customerDealer ?? '')) return false;
    const rule = sorted.find((r) => r.effectiveFrom <= d.docDate);
    if (!rule || !(ag(d.afterDiscount) > ag(rule.thresholdBeforeVat))) return false;
    return !real.has(d.id);
  });
}
