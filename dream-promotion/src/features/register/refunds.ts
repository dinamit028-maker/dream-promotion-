import type { Line, Refund, RefundMethod, Sale } from './money';

/**
 * Refunds ("החזר כספי") from the register. Whole agorot throughout.
 * A sale can be refunded in parts — whole, chosen items, or a sum — but never beyond what was paid.
 * Items carry the sale's discount: returning half the items gives back half of what was actually paid.
 * The VAT inside a refund is computed like the sale's: amount × rate / (100 + rate).
 * The database checks the same limit again (inside a lock), so two devices can not over-refund together.
 */
const ag = (n: number) => Math.round((Number(n) || 0) * 100);
const sh = (a: number) => a / 100;

export const toRefund = (r: any): Refund => ({
  id: r.id, saleId: r.sale_id, createdAt: r.created_at, amount: Number(r.amount), vatAmount: Number(r.vat_amount ?? 0),
  method: r.method, items: Array.isArray(r.items) ? r.items : [], restock: Boolean(r.restock), reason: r.reason ?? '', employeeName: r.employee_name ?? '',
});

/** how much was already given back on this sale (₪) */
export const refundedOf = (saleId: string, refunds: Refund[]) => sh(refunds.filter((r) => r.saleId === saleId).reduce((a, r) => a + ag(r.amount), 0));
/** how much can still be given back (₪) */
export const refundLeft = (sale: Pick<Sale, 'id' | 'total'>, refunds: Refund[]) => Math.max(0, sh(ag(sale.total) - ag(refundedOf(sale.id, refunds))));

const sameLine = (a: Line, b: Line) => a.name === b.name && ag(a.price) === ag(b.price) && (a.itemId ?? '') === (b.itemId ?? '');
/** per line of the sale: how many units already came back */
export function returnedQty(sale: Pick<Sale, 'id' | 'items'>, refunds: Refund[]): number[] {
  const back = refunds.filter((r) => r.saleId === sale.id).flatMap((r) => r.items);
  const left = back.map((l) => ({ ...l }));
  return sale.items.map((line) => {
    let n = 0;
    for (const b of left) if (b.qty > 0 && sameLine(line, b)) { const take = Math.min(b.qty, line.qty - n); n += take; b.qty -= take; if (n >= line.qty) break; }
    return n;
  });
}

/** the method money normally goes back by: the sale's own, or the biggest part of a split payment */
export function defaultRefundMethod(sale: Pick<Sale, 'method' | 'payments'>): RefundMethod {
  if (sale.method !== 'split') return sale.method === 'link' ? 'other' : sale.method;
  const biggest = [...(sale.payments ?? [])].sort((a, b) => b.amount - a.amount)[0]?.method;
  return biggest && biggest !== 'link' ? biggest : 'cash';
}

export type RefundRequest = { mode: 'full' } | { mode: 'items'; qty: number[] } | { mode: 'amount'; amount: number };
export type RefundPlan = Omit<Refund, 'id' | 'createdAt'>;
export type RefundError = 'not_paid' | 'nothing_left' | 'too_much' | 'empty';
export const REFUND_ERROR_HE: Record<RefundError, string> = {
  not_paid: 'אפשר להחזיר רק על עסקה ששולמה.',
  nothing_left: 'על העסקה הזו כבר הוחזר כל הסכום.',
  too_much: 'הסכום גדול ממה שנשאר להחזיר על העסקה.',
  empty: 'לא נבחר מה להחזיר.',
};

/** what a refund request gives back: amount, VAT, items (for stock and the credit invoice) */
export function planRefund(sale: Sale, prior: Refund[], req: RefundRequest,
  o: { method: RefundMethod; restock?: boolean; reason?: string; employeeName?: string }): { ok: true; refund: RefundPlan } | { ok: false; error: RefundError } {
  if (sale.status !== 'paid') return { ok: false, error: 'not_paid' };
  const leftA = ag(refundLeft(sale, prior));
  if (leftA <= 0) return { ok: false, error: 'nothing_left' };
  const done = returnedQty(sale, prior);
  const remainingQty = sale.items.map((l, i) => Math.max(0, l.qty - done[i]));

  let amountA: number; let items: Line[];
  if (req.mode === 'full') {
    amountA = leftA;
    items = sale.items.map((l, i) => ({ ...l, qty: remainingQty[i] })).filter((l) => l.qty > 0);
  } else if (req.mode === 'items') {
    const want = sale.items.map((_, i) => Math.max(0, Math.min(remainingQty[i], Math.floor(req.qty[i] ?? 0))));
    items = sale.items.map((l, i) => ({ ...l, qty: want[i] })).filter((l) => l.qty > 0);
    if (!items.length) return { ok: false, error: 'empty' };
    const allBack = want.every((q, i) => q === remainingQty[i]);
    // the sale's discount applies to what comes back: gross × (paid / before discount)
    const grossA = items.reduce((a, l) => a + ag(l.price) * l.qty, 0);
    const subA = ag(sale.subtotal);
    amountA = allBack ? leftA : Math.min(leftA, subA ? Math.round((grossA * ag(sale.total)) / subA) : grossA);
  } else {
    amountA = ag(req.amount);
    items = [];
    if (amountA <= 0) return { ok: false, error: 'empty' };
    if (amountA > leftA) return { ok: false, error: 'too_much' };
  }
  if (amountA <= 0) return { ok: false, error: 'empty' };
  const rate = Number(sale.vatRate) || 0;
  const vatA = rate ? Math.round((amountA * rate) / (100 + rate)) : 0;
  return {
    ok: true,
    refund: {
      saleId: sale.id, amount: sh(amountA), vatAmount: sh(vatA), method: o.method, items,
      restock: Boolean(o.restock) && items.some((l) => l.itemId), reason: (o.reason ?? '').trim().slice(0, 200), employeeName: o.employeeName ?? '',
    },
  };
}

/** "החזר ₪120 · מזומן · 2 פריטים" — the line on the sale and in the customer's history */
export function refundSummary(r: Pick<Refund, 'amount' | 'items'> & { methodLabel: string }) {
  const n = r.items.reduce((a, l) => a + l.qty, 0);
  return `החזר ${'₪'}${r.amount.toLocaleString('he-IL', { maximumFractionDigits: 2 })} · ${r.methodLabel}${n ? ` · ${n === 1 ? 'פריט אחד' : `${n} פריטים`}` : ''}`;
}
