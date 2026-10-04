/**
 * Payments — how money came in or went out. Recording a payment is NOT processing one: nothing here charges a
 * card or moves money; the business tells the app what it received (or paid), and the app documents it.
 * The ledger (table payments) is written only by the database: receipts, register refunds, credit refunds,
 * expenses and cancellations add rows; a correction is a reversing row, never an edit.
 */
export type PayMethod = 'cash' | 'card' | 'transfer' | 'bit' | 'cheque' | 'other';

/** unified-file field 1306: 1 cash, 2 cheque, 3 credit card, 4 bank transfer, 9 other (Bit / PayBox are apps → other) */
export const PAY_METHODS: { id: PayMethod; label: string; icon: string; code: number }[] = [
  { id: 'cash', label: 'מזומן', icon: '💵', code: 1 },
  { id: 'transfer', label: 'העברה בנקאית', icon: '🏦', code: 4 },
  { id: 'card', label: 'כרטיס אשראי', icon: '💳', code: 3 },
  { id: 'bit', label: 'Bit / PayBox', icon: '📱', code: 9 },
  { id: 'cheque', label: 'צ׳ק', icon: '🧾', code: 2 },
  { id: 'other', label: 'אחר', icon: '•', code: 9 },
];
export const payCode = (m: PayMethod) => PAY_METHODS.find((p) => p.id === m)?.code ?? 9;
export const payLabel = (m: string) => PAY_METHODS.find((p) => p.id === m)?.label ?? 'אחר';
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

export interface PaymentEntry { method: PayMethod; amount: number; date: string; cheque?: Cheque }
/** a payment as a document stores it (D120): the code for the file, the method itself, a cheque's details */
export const toDocPayment = (p: PaymentEntry) => ({
  method: payCode(p.method), amount: Math.round(p.amount * 100) / 100, date: p.date, m: p.method,
  ...(p.method === 'cheque' && p.cheque ? { cheque: { ...p.cheque, bank: p.cheque.bank.trim(), branch: p.cheque.branch.trim(), account: p.cheque.account.trim(), number: p.cheque.number.trim() } } : {}),
});

/** a row of the ledger, for the screens */
export interface LedgerRow {
  id: string; direction: 'in' | 'out'; amount: number; method: PayMethod; paidOn: string;
  source: 'document' | 'refund' | 'credit' | 'expense' | 'cancel' | 'reversal';
  documentId: string | null; appliesTo: string | null; saleId: string | null; refundId: string | null; expenseId: string | null; leadId: string | null;
  note: string; createdAt: string;
}
export const toLedgerRow = (r: any): LedgerRow => ({
  id: r.id, direction: r.direction, amount: Number(r.amount), method: r.method, paidOn: r.paid_on, source: r.source,
  documentId: r.document_id ?? null, appliesTo: r.applies_to ?? null, saleId: r.sale_id ?? null, refundId: r.refund_id ?? null,
  expenseId: r.expense_id ?? null, leadId: r.lead_id ?? null, note: r.note ?? '', createdAt: r.created_at,
});
export const LEDGER_SOURCE_HE: Record<LedgerRow['source'], string> = {
  document: 'קבלה', refund: 'החזר בקופה', credit: 'החזר על זיכוי', expense: 'הוצאה', cancel: 'ביטול קבלה', reversal: 'ביטול הוצאה',
};
/** money in and out of a list of ledger rows (agorot-exact) */
export function ledgerTotals(rows: Pick<LedgerRow, 'direction' | 'amount'>[]) {
  let inA = 0, outA = 0;
  for (const r of rows) { const a = Math.round(r.amount * 100); if (r.direction === 'in') inA += a; else outA += a; }
  return { in: inA / 100, out: outA / 100, net: (inA - outA) / 100 };
}
