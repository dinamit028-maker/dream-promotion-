/**
 * Payments — how money came in or went out. Recording a payment is NOT processing one: nothing here charges a
 * card or moves money; the business tells the app what it received (or paid), and the app documents it.
 * The ledger (table payments) is written only by the database: receipts, register refunds, credit refunds,
 * expenses and cancellations add rows; a correction is a reversing row, never an edit.
 */
export type PayMethod = 'cash' | 'card' | 'transfer' | 'bit' | 'cheque' | 'other';
/**
 * 2.94 (migration 20261011004900): tax a customer withheld at source ("ניכוי במקור") is one more way a receipt is paid — it pays
 * the invoice, but it is not money: the ledger keeps it as 'withholding' and the cash totals leave it out (finance_summary too).
 * Only a receipt issued from the money screens offers it (never the register, an expense or money back).
 */
export type DocPayMethod = PayMethod | 'withholding';
export const WITHHOLDING = { id: 'withholding' as const, label: 'ניכוי במקור', icon: '🧾', code: 9 };

/**
 * unified-file field 1306: 1 cash, 2 cheque, 3 credit card, 4 bank transfer, 9 other (spec 1.31 §4.5, p. 14, field 1306).
 * Bit / PayBox → 4 (bank transfer): the accountant's answer 12 (docs/ita-registration/CPA_ANSWERS_HE.md, 25.11.2026) — the money
 * moves between bank accounts. Before 2.118 it was 9 ("other"): documents issued then keep their 9 (a document is not changed).
 */
export const PAY_METHODS: { id: PayMethod; label: string; icon: string; code: number }[] = [
  { id: 'cash', label: 'מזומן', icon: '💵', code: 1 },
  { id: 'transfer', label: 'העברה בנקאית', icon: '🏦', code: 4 },
  { id: 'card', label: 'כרטיס אשראי', icon: '💳', code: 3 },
  { id: 'bit', label: 'Bit / PayBox', icon: '📱', code: 4 },
  { id: 'cheque', label: 'צ׳ק', icon: '🧾', code: 2 },
  { id: 'other', label: 'אחר', icon: '•', code: 9 },
];
export const payCode = (m: DocPayMethod) => PAY_METHODS.find((p) => p.id === m)?.code ?? 9;
export const payLabel = (m: string) => (m === WITHHOLDING.id ? WITHHOLDING.label : PAY_METHODS.find((p) => p.id === m)?.label ?? 'אחר');
/** a code of the unified file back to a method (documents issued before 2.51 carry only the code) */
export const methodOfCode = (code: number): PayMethod => (code === 1 ? 'cash' : code === 2 ? 'cheque' : code === 3 ? 'card' : code === 4 ? 'transfer' : 'other');

/** a cheque's details — fields 1307–1311 of the unified file */
export interface Cheque { bank: string; branch: string; account: string; number: string; dueDate: string }
export const EMPTY_CHEQUE: Cheque = { bank: '', branch: '', account: '', number: '', dueDate: '' };
/**
 * What is wrong in a cheque's details — one Hebrew line per field, none when fine. From 2.117.4 the bank, the branch and the account
 * are required, as the number always was: in the unified file fields 1307–1310 are "חמ — בהמחאה בלבד" (spec §4.5, p. 14, checked
 * 25.11.2026), and the Tax Authority's simulator (25.11.2026) refused a cheque whose branch was 0 ("ערך השדה לא ולידי / השדה מאופס").
 * So a field of zeros only is missing too. New documents only: a document already issued is not changed.
 */
export function chequeErrors(c: Cheque | undefined): string[] {
  const e: string[] = [];
  const v = (s: string | undefined) => (s ?? '').trim();
  const zeros = (s: string) => /^0+$/.test(s);
  if (!c || !/^\d{1,10}$/.test(v(c.number)) || zeros(v(c.number))) e.push('מספר הצ׳ק — ספרות בלבד');
  const field = (s: string, max: number, name: string) => {
    if (!s || zeros(s)) e.push(`${name} — חובה בצ׳ק`);
    else if (!new RegExp(`^\\d{1,${max}}$`).test(s)) e.push(`${name} — עד ${max} ספרות`);
  };
  field(v(c?.bank), 3, 'מספר הבנק');
  field(v(c?.branch), 5, 'מספר הסניף');
  field(v(c?.account), 15, 'מספר החשבון');
  if (c?.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(c.dueDate)) e.push('תאריך הפירעון לא תקין');
  return e;
}
/** the first of chequeErrors, or null */
export const chequeError = (c: Cheque | undefined): string | null => chequeErrors(c)[0] ?? null;

/**
 * Field 1315 "סוג עסקת האשראי" (spec 1.31 §4.5, p. 14, checked against the official text 25.11.2026): 1 regular, 2 installments,
 * 3 credit, 4 deferred charge, 5 other. The accountant's answer 13 (25.11.2026): asked when the document is issued — so a card
 * payment of a new receipt names it ("cardKind" in the document; migration 6800 refuses a card payment without it, and a kind on
 * any other payment). Documents issued before keep none (the file writes 1 for their card payments, as before — openformat.ts).
 */
export type CardKind = 1 | 2 | 3 | 4 | 5;
export const CARD_KINDS: { id: CardKind; label: string }[] = [
  { id: 1, label: 'רגיל' }, { id: 2, label: 'תשלומים' }, { id: 3, label: 'קרדיט' }, { id: 4, label: 'חיוב נדחה' }, { id: 5, label: 'אחר' },
];
export const isCardKind = (v: unknown): v is CardKind => v === 1 || v === 2 || v === 3 || v === 4 || v === 5;
export const cardKindLabel = (v: unknown) => CARD_KINDS.find((k) => k.id === v)?.label ?? '';

/**
 * 2.121 — a card payment in installments (cardKind 2): how many, and when the first is charged. Stage 4, answer 8
 * (docs/ita-registration/STAGE4_PLAN_HE.md, 26–27.11.2026, the owner with the accountant): the books write a line per installment,
 * each with its own value date — the instructions 1.31, clarification 12 (p. 22): a card deal in 6 installments, a line per
 * installment with its value date (1363). The form asks the number (2–36, required once "תשלומים" is chosen) and, optionally, the
 * first charge's day (from the payment's day to a year after it — 366 days; none = the payment's day). The database checks the
 * same (documents_installments, migration 20261128007100: installments_card_only / installments_count / installments_refund /
 * installments_first_due). A database before 7100 ignores both keys (documents_validate names no list of keys). Money back
 * (a refund receipt) is never in installments — the refund form does not ask (PaymentsEditor installments={false}).
 */
export const INSTALLMENTS_MIN = 2;
export const INSTALLMENTS_MAX = 36;
/** the latest first charge: the payment's day + 366 days (documents_installments: fd > pd + 366 is refused) */
export const FIRST_DUE_DAYS = 366;
export const INSTALLMENTS_MISSING = `בתשלומים — כמה תשלומים (${INSTALLMENTS_MIN} עד ${INSTALLMENTS_MAX})`;
export const FIRST_DUE_BAD = 'מועד החיוב הראשון — מיום התשלום ועד שנה אחריו';
/** a calendar day plus n days (YYYY-MM-DD — calendar arithmetic only, no time of day and no time zone) */
export function addDaysISO(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const isInstallments = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= INSTALLMENTS_MIN && v <= INSTALLMENTS_MAX;
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDaysISO(s, 0) === s;
/** what is wrong in a card payment's installments — Hebrew, none when fine (only a card payment of kind 2 is asked) */
export function installmentsErrors(p: Pick<PaymentEntry, 'method' | 'cardKind' | 'date' | 'installments' | 'firstDue'>): string[] {
  if (p.method !== 'card' || p.cardKind !== 2) return [];
  const e: string[] = [];
  if (!isInstallments(p.installments)) e.push(INSTALLMENTS_MISSING);
  if (p.firstDue) {
    if (!isDay(p.firstDue) || !isDay(p.date) || p.firstDue < p.date || p.firstDue > addDaysISO(p.date, FIRST_DUE_DAYS)) e.push(FIRST_DUE_BAD);
  }
  return e;
}

/** pct: tax withheld at source — the percent on the customer's certificate (optional); cardKind — a card payment's kind (1315);
 *  installments / firstDue (2.121) — a card payment of kind 2: how many, the first charge's day (optional) */
export interface PaymentEntry {
  method: DocPayMethod; amount: number; date: string; cheque?: Cheque; pct?: number | null; cardKind?: CardKind | null;
  installments?: number | null; firstDue?: string | null;
}
/** a payment as a document stores it (D120): the code for the file, the method itself, a cheque's details, a withholding's percent */
export const toDocPayment = (p: PaymentEntry) => ({
  method: payCode(p.method), amount: Math.round(p.amount * 100) / 100, date: p.date, m: p.method,
  ...(p.method === 'cheque' && p.cheque ? { cheque: { ...p.cheque, bank: p.cheque.bank.trim(), branch: p.cheque.branch.trim(), account: p.cheque.account.trim(), number: p.cheque.number.trim() } } : {}),
  ...(p.method === 'withholding' && p.pct != null ? { pct: Math.round(p.pct * 100) / 100 } : {}),
  // 2.118: a card payment's kind (field 1315) — on a card payment only (the database refuses it on any other)
  ...(p.method === 'card' && isCardKind(p.cardKind) ? { cardKind: p.cardKind } : {}),
  // 2.121 (migration 7100, answer 8): installments — a card payment of kind 2 only, a JSON number; the first charge only when given
  ...(p.method === 'card' && p.cardKind === 2 && isInstallments(p.installments) ? { installments: p.installments, ...(p.firstDue && isDay(p.firstDue) ? { firstDue: p.firstDue } : {}) } : {}),
});
/** a withholding's percent: 0–100, up to two decimals, or none — null when fine (the database checks the same) */
export function withholdingPctError(pct: number | null | undefined): string | null {
  if (pct == null) return null;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100 || Math.abs(Math.round(pct * 100) - pct * 100) > 1e-6) return 'אחוז הניכוי במקור: מספר בין 0 ל-100 (עד 2 ספרות אחרי הנקודה)';
  return null;
}
/**
 * the withholding entries of a receipt: each with its percent right, a customer who withheld it, and never all of the payment
 * (the database refuses the same: withholding_pct, withholding_customer, withholding_all) — Hebrew errors, none when fine
 */
export function withholdingErrors(payments: Pick<PaymentEntry, 'method' | 'amount' | 'pct'>[], o: { total: number; customerName: string }): string[] {
  const w = payments.filter((p) => p.method === 'withholding');
  if (!w.length) return [];
  const e: string[] = [];
  for (const p of w) { const x = withholdingPctError(p.pct); if (x) e.push(x); }
  if (!o.customerName.trim()) e.push('ניכוי במקור צריך את שם הלקוח שניכה אותו');
  const wA = w.reduce((a, p) => a + Math.round((p.amount || 0) * 100), 0);
  if (wA >= Math.round(o.total * 100)) e.push('ניכוי במקור הוא חלק מהתשלום — לא כולו');
  return e;
}

/** a row of the ledger, for the screens */
export interface LedgerRow {
  id: string; direction: 'in' | 'out'; amount: number; method: DocPayMethod; paidOn: string;
  source: 'document' | 'refund' | 'credit' | 'expense' | 'cancel' | 'reversal';
  documentId: string | null; appliesTo: string | null; saleId: string | null; refundId: string | null; expenseId: string | null; leadId: string | null;
  note: string; createdAt: string;
  /** tax withheld at source: the percent on the certificate (when the receipt gave one) */
  pct?: number | null;
}
export const toLedgerRow = (r: any): LedgerRow => ({
  id: r.id, direction: r.direction, amount: Number(r.amount), method: r.method, paidOn: r.paid_on, source: r.source,
  documentId: r.document_id ?? null, appliesTo: r.applies_to ?? null, saleId: r.sale_id ?? null, refundId: r.refund_id ?? null,
  expenseId: r.expense_id ?? null, leadId: r.lead_id ?? null, note: r.note ?? '', createdAt: r.created_at,
  pct: r.reference?.pct != null && Number.isFinite(Number(r.reference.pct)) ? Number(r.reference.pct) : null,
});
export const LEDGER_SOURCE_HE: Record<LedgerRow['source'], string> = {
  document: 'קבלה', refund: 'החזר בקופה', credit: 'החזר על זיכוי', expense: 'הוצאה', cancel: 'ביטול קבלה', reversal: 'ביטול הוצאה',
};
/**
 * money in and out of a list of ledger rows (agorot-exact). Tax withheld at source is not money: it stays out of in / out
 * (as finance_summary's cash) and is counted on its own — what the customers withheld, less what a cancelled receipt gave back.
 */
export function ledgerTotals(rows: (Pick<LedgerRow, 'direction' | 'amount'> & { method?: string })[]) {
  let inA = 0, outA = 0, wA = 0;
  for (const r of rows) {
    const a = Math.round(r.amount * 100);
    if (r.method === WITHHOLDING.id) wA += r.direction === 'in' ? a : -a;
    else if (r.direction === 'in') inA += a; else outA += a;
  }
  return { in: inA / 100, out: outA / 100, net: (inA - outA) / 100, withheld: wA / 100 };
}
