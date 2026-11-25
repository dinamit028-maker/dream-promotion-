import { isRefundReceipt, refundLeft, refundReceiptFor, refundReceiptForRefund } from '@/features/documents/documents';
import type { Doc } from '@/features/documents/openformat';
import type { Line, Method, Sale } from '@/features/register/money';

/**
 * 2.118 — the refund receipts of a register / an online sale of an exempt dealer (the accountant's answers 8 and 15), in one place:
 * the register (RegisterScreen — cancel a sale, "החזר כספי") issues them right away, and the receipt's own view (DocView) completes
 * one that did not go out then (the database refused it before migration 6800, or the answer was lost). Every one has a fixed key,
 * so issuing it again can never make a second one:
 *   a cancelled sale                cancel:<sale>      what is left on the receipt, as it was paid; the sale; no "restock"
 *   a refund (sale_refunds row)     refund:<refund id> the refund's amount, method and items; with refund_id (money / stock: the refund's)
 */
type Base = Pick<Doc, 'docType' | 'docNumber' | 'total' | 'customerName' | 'customerPhone' | 'customerDealer' | 'customerStreet' | 'customerCity' | 'payments' | 'issuedBy'>;
type Follower = Pick<Doc, 'docType' | 'total' | 'baseDocType' | 'baseDocNumber'> & { refundId?: string | null; saleId?: string | null };
export const CANCEL_NOTE = 'המכירה בוטלה בקופה (נרשמה בטעות)';

/** the refund receipt of a cancelled sale: what is left on its receipt — the receipt's own payments when all of it is left */
export function cancelReceiptDoc(receipt: Base, docs: Follower[], docDate: string) {
  const left = refundLeft(receipt, docs);
  if (left <= 0) return null;
  const all = refundReceiptFor(receipt, { payments: receipt.payments.filter((p) => p.m !== 'withholding' && p.amount > 0)
    .map((p) => ({ method: p.method, amount: p.amount, m: p.m, cardKind: p.cardKind })), docDate, notes: CANCEL_NOTE });
  if (Math.round(-all.total * 100) === Math.round(left * 100)) return all;
  // refunded in part before: one payment of what is left, by the receipt's first method
  const p = receipt.payments[0];
  return refundReceiptFor(receipt, { payments: [{ method: p?.method ?? 1, amount: left, m: p?.m, cardKind: p?.cardKind }], docDate, notes: CANCEL_NOTE });
}

/** the refund receipt of a refund — never beyond what is left on the receipt (null: it would be) */
export function refundReceiptDoc(receipt: Base, docs: Follower[], refund: { amount: number; method: Method; items: Line[] }, sale: Pick<Sale, 'subtotal' | 'total'>, docDate: string) {
  if (Math.round(refundLeft(receipt, docs) * 100) < Math.round(refund.amount * 100)) return null;
  return refundReceiptForRefund({ ...receipt, issuedBy: receipt.issuedBy ?? '' } as Doc, refund, sale, docDate);
}

/**
 * what is still missing on a sale's receipt: the refunds with no refund receipt, and a cancelled sale whose receipt was neither
 * refunded (cancel:<sale>) nor marked "בוטל" before 6800 (cancelled — the caller's)
 */
export function missingSaleReceipts(o: { saleStatus: string | null; refunds: { id: string }[]; docs: Follower[]; receiptCancelled: boolean }) {
  const back = o.docs.filter((d) => isRefundReceipt(d));
  const refunds = o.refunds.filter((r) => !back.some((d) => d.refundId === r.id));
  const cancel = o.saleStatus === 'cancelled' && !o.receiptCancelled && !back.some((d) => !d.refundId);
  return { refunds, cancel };
}
