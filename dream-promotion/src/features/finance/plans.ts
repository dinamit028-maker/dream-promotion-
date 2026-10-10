import { ag, sh } from './vat';

/**
 * Payment plans ("פריסה לתשלומים", docs/FINANCE_ADDITIONS_HE.md T3; migration 20261010004400): the balance of an open invoice
 * (also a package's) split into dated payments that add up to it to the agora. Not card installments (the provider's) — dates
 * the business collects on. The money still pays the invoice (payments); a plan only says when each part is due.
 * The database decides again (payment_plan_create, under the invoice's lock) — these are the screens' rules and the lines'
 * arithmetic, the same as the view receivable_lines (planLines; tests/plans.test.ts holds them to the same examples).
 */
export interface PlanItem { n: number; dueDate: string; amount: number }
export interface Plan {
  id: string; documentId: string; leadId: string | null; total: number; payments: number; status: 'active' | 'cancelled'; note: string;
  createdAt: string; cancelledAt: string | null; cancelReason: string; items: PlanItem[];
}
export const toPlan = (r: any, items: any[] = []): Plan => ({
  id: r.id, documentId: r.document_id, leadId: r.lead_id ?? null, total: Number(r.total), payments: Number(r.payments), status: r.status, note: r.note ?? '',
  createdAt: r.created_at, cancelledAt: r.cancelled_at ?? null, cancelReason: r.cancel_reason ?? '',
  items: items.filter((i) => i.plan_id === r.id).map((i) => ({ n: Number(i.n), dueDate: i.due_date, amount: Number(i.amount) })).sort((a, b) => a.n - b.n),
});

/** a line of what is owed (the view receivable_lines): an invoice without a plan, a payment of its plan, or what is owed beyond it */
export interface Line {
  documentId: string; leadId: string | null; docType: number; docNumber: number; docDate: string; customerName: string; customerPhone: string;
  customerEmail: string; shareToken: string; docBalance: number; planId: string | null; itemId: string | null; n: number | null; ofN: number | null;
  dueDate: string | null; amount: number; open: number;
}
export const LINE_COLUMNS = 'document_id, lead_id, doc_type, doc_number, doc_date, customer_name, customer_phone, customer_email, share_token, doc_balance, '
  + 'plan_id, item_id, n, of_n, due_date, amount, open_amount';
export const toLine = (r: any): Line => ({
  documentId: r.document_id, leadId: r.lead_id ?? null, docType: Number(r.doc_type), docNumber: Number(r.doc_number), docDate: r.doc_date,
  customerName: r.customer_name ?? '', customerPhone: r.customer_phone ?? '', customerEmail: r.customer_email ?? '', shareToken: r.share_token ?? '',
  docBalance: Number(r.doc_balance), planId: r.plan_id ?? null, itemId: r.item_id ?? null, n: r.n == null ? null : Number(r.n),
  ofN: r.of_n == null ? null : Number(r.of_n), dueDate: r.due_date ?? null, amount: Number(r.amount), open: Number(r.open_amount),
});

export const PLAN_MIN = 2;
export const PLAN_MAX = 36;
/** how far ahead a payment may be (as the database: 1,830 days) */
export const PLAN_MAX_DAYS = 1830;

const addDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
/** the same day n months later — the month's last day when it is shorter (31.1 → 28.2 / 29.2) */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1, 12));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}
/** equal parts to the agora: what does not divide goes on the first payments, an agora each (1,000 / 3 → 333.34, 333.33, 333.33) */
export function splitEven(total: number, count: number): number[] {
  const t = ag(total), k = Math.max(1, Math.floor(count));
  const base = Math.floor(t / k), extra = t - base * k;
  return Array.from({ length: k }, (_, i) => sh(base + (i < extra ? 1 : 0)));
}
/** a plan to start from: equal parts, the first on `first`, then every `everyMonths` months (the owner changes any of it) */
export function draftPlan(balance: number, count: number, first: string, everyMonths = 1): PlanItem[] {
  const parts = splitEven(balance, count);
  return parts.map((amount, i) => ({ n: i + 1, dueDate: addMonths(first, i * everyMonths), amount }));
}
/** the payments after a change of one of them: the ones after it share what is left, equally (the earlier ones stay) */
export function rebalance(items: PlanItem[], balance: number, changed: number): PlanItem[] {
  const before = items.slice(0, changed + 1).reduce((a, i) => a + ag(i.amount), 0);
  const rest = items.slice(changed + 1);
  if (!rest.length) return items;
  const parts = splitEven(Math.max(0, sh(ag(balance) - before)), rest.length);
  return items.map((it, i) => (i <= changed ? it : { ...it, amount: parts[i - changed - 1] }));
}

/** the screen's check before sending (the database checks the same again, under the invoice's lock) — Hebrew, or null */
export function planError(items: Pick<PlanItem, 'dueDate' | 'amount'>[], balance: number, today: string): string | null {
  if (!(ag(balance) > 0)) return 'אין יתרה לפריסה על המסמך הזה.';
  if (items.length < PLAN_MIN) return `פריסה היא לפחות ${PLAN_MIN} תשלומים.`;
  if (items.length > PLAN_MAX) return `עד ${PLAN_MAX} תשלומים.`;
  let prev = '';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!(it.amount > 0) || Math.abs(ag(it.amount) - it.amount * 100) > 1e-6) return `תשלום ${i + 1}: סכום גדול מאפס, עד אגורות.`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.dueDate)) return `תשלום ${i + 1}: חסר תאריך.`;
    if (it.dueDate < today) return `תשלום ${i + 1}: התאריך כבר עבר.`;
    if (daysBetween(today, it.dueDate) > PLAN_MAX_DAYS) return `תשלום ${i + 1}: יותר מ-5 שנים קדימה.`;
    if (prev && it.dueDate <= prev) return `תשלום ${i + 1}: התאריך צריך להיות אחרי התשלום הקודם.`;
    prev = it.dueDate;
  }
  const sum = items.reduce((a, i) => a + ag(i.amount), 0), want = ag(balance);
  if (sum !== want) {
    const d = sh(Math.abs(want - sum));
    return `סכום התשלומים ${fmt(sh(sum))}, והיתרה ${fmt(balance)} — ${sum < want ? 'חסרים' : 'יש עודף של'} ${fmt(d)}.`;
  }
  return null;
}
const fmt = (n: number) => `₪${n.toLocaleString('he-IL', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

/**
 * The lines of an invoice, as the view receivable_lines makes them: without a plan, one line (its balance); with a plan, what
 * the invoice went down since the plan was made (total − balance, payments and credits) covers the payments in order; more owed
 * than the plan (money given back) is a line of its own (n null). Agorot all the way.
 */
export function planLines(balance: number, plan: { total: number; items: Pick<PlanItem, 'n' | 'amount' | 'dueDate'>[] } | null,
                          ownDue: string | null, docDate: string): { n: number | null; dueDate: string | null; amount: number; open: number }[] {
  const b = ag(balance);
  if (!plan) return [{ n: null, dueDate: ownDue, amount: sh(b), open: sh(Math.max(0, b)) }];
  const total = ag(plan.total);
  const progress = Math.min(total, Math.max(0, total - b));
  let before = 0;
  const out: { n: number | null; dueDate: string | null; amount: number; open: number }[] = [...plan.items].sort((x, y) => x.n - y.n).map((it) => {
    const a = ag(it.amount);
    const covered = Math.min(a, Math.max(0, progress - before));
    before += a;
    return { n: it.n, dueDate: it.dueDate, amount: sh(a), open: sh(a - covered) };
  });
  if (b > total) out.push({ n: null, dueDate: ownDue ?? docDate, amount: sh(b - total), open: sh(b - total) });
  return out;
}

export type LineStatus = 'paid' | 'partial' | 'open' | 'overdue';
export const LINE_STATUS_HE: Record<LineStatus, string> = { paid: 'שולם', partial: 'שולם חלקית', open: 'פתוח', overdue: 'באיחור' };
export function lineStatus(l: Pick<Line, 'amount' | 'open' | 'dueDate'>, today: string): LineStatus {
  if (ag(l.open) <= 0) return 'paid';
  if (l.dueDate && l.dueDate < today) return 'overdue';
  return ag(l.open) < ag(l.amount) ? 'partial' : 'open';
}
/** the line's words: "תשלום 2 מתוך 3", or what is owed beyond the plan */
export const lineLabel = (l: Pick<Line, 'n' | 'ofN' | 'planId'>) =>
  l.n != null ? `תשלום ${l.n} מתוך ${l.ofN ?? '?'}` : l.planId ? 'מעבר לפריסה' : '';
/** the first line still open (by date), of one invoice */
export const nextOpen = (lines: Line[]) => lines.filter((l) => ag(l.open) > 0).sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || (a.n ?? 99) - (b.n ?? 99))[0] ?? null;

/** an invoice's lines grouped, in the order of the next date that is owed */
export function byInvoice(lines: Line[]): { documentId: string; lines: Line[]; open: number; next: Line | null }[] {
  const m = new Map<string, Line[]>();
  for (const l of lines) m.set(l.documentId, [...(m.get(l.documentId) ?? []), l]);
  return [...m].map(([documentId, ls]) => {
    const sorted = ls.sort((a, b) => (a.n ?? 99) - (b.n ?? 99));
    return { documentId, lines: sorted, open: sh(sorted.reduce((a, l) => a + ag(l.open), 0)), next: nextOpen(sorted) };
  });
}

/** the database's refusal in Hebrew (payment_plan_create / payment_plan_cancel) */
export function planErrorHe(e: { message?: string; code?: string } | null | undefined): string {
  const m = String(e?.message ?? '');
  if (m.includes('plan_sum')) return 'סכום התשלומים לא שווה ליתרה של המסמך (אולי נרשם תשלום בינתיים) — טוענים מחדש ובודקים.';
  if (m.includes('plan_exists')) return 'למסמך כבר יש פריסה. "פריסה מחדש" מחליפה אותה.';
  if (m.includes('plan_paid')) return 'המסמך כבר שולם — אין מה לפרוס.';
  if (m.includes('plan_not_invoice')) return 'פריסה אפשרית רק לחשבונית פתוחה (חשבונית מס או חשבונית עסקה) שלא בוטלה.';
  if (m.includes('plan_date')) return 'אחד התאריכים לא תקין: לא בעבר, כל תשלום אחרי הקודם, עד 5 שנים קדימה.';
  if (m.includes('plan_amount') || m.includes('plan_items')) return 'אחד הסכומים לא תקין (גדול מאפס, עד אגורות).';
  if (m.includes('plan_count')) return `פריסה היא בין ${PLAN_MIN} ל-${PLAN_MAX} תשלומים.`;
  if (m.includes('plan_not_found')) return 'המסמך לא נמצא בעסק הזה.';
  if (m.includes('business_locked')) return 'העסק נעול — אי אפשר לשנות כרגע.';
  if (m.includes('not allowed') || e?.code === '42501') return 'אין לך הרשאה לנהל את הכספים של העסק.';
  return 'הפריסה לא נשמרה. נסו שוב.';
}
