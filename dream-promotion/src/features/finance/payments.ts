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

/** unified-file field 1306: 1 cash, 2 cheque, 3 credit card, 4 bank transfer, 9 other (Bit / PayBox are apps → other) */
export const PAY_METHODS: { id: PayMethod; label: string; icon: string; code: number }[] = [
  { id: 'cash', label: 'מזומן', icon: '💵', code: 1 },
  { id: 'transfer', label: 'העברה בנקאית', icon: '🏦', code: 4 },
  { id: 'card', label: 'כרטיס אשראי', icon: '💳', code: 3 },
  { id: 'bit', label: 'Bit / PayBox', icon: '📱', code: 9 },
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
export function chequeError(c: Cheque | undefined): string | null {
  if (!c || !/^\d{1,10}$/.test(c.number.trim())) return 'מספר הצ׳ק — ספרות בלבד';
  if (c.bank && !/^\d{1,3}$/.test(c.bank.trim())) return 'מספר הבנק — עד 3 ספרות';
  if (c.branch && !/^\d{1,5}$/.test(c.branch.trim())) return 'מספר הסניף — עד 5 ספרות';
  if (c.account && !/^\d{1,15}$/.test(c.account.trim())) return 'מספר החשבון — עד 15 ספרות';
  if (c.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(c.dueDate)) return 'תאריך הפירעון לא תקין';
  return null;
}

/** pct: tax withheld at source — the percent on the customer's certificate (optional) */
export interface PaymentEntry { method: DocPayMethod; amount: number; date: string; cheque?: Cheque; pct?: number | null }
/** a payment as a document stores it (D120): the code for the file, the method itself, a cheque's details, a withholding's percent */
export const toDocPayment = (p: PaymentEntry) => ({
  method: payCode(p.method), amount: Math.round(p.amount * 100) / 100, date: p.date, m: p.method,
  ...(p.method === 'cheque' && p.cheque ? { cheque: { ...p.cheque, bank: p.cheque.bank.trim(), branch: p.cheque.branch.trim(), account: p.cheque.account.trim(), number: p.cheque.number.trim() } } : {}),
  ...(p.method === 'withholding' && p.pct != null ? { pct: Math.round(p.pct * 100) / 100 } : {}),
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
