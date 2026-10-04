import { israelParts } from '@/lib/il-time';

/**
 * Register math — whole agorot internally, so 0.1 + 0.2 never becomes 0.30000000000000004.
 * Prices are VAT-inclusive (as customers see them in Israel). A licensed dealer's VAT is the part of
 * the total that is tax: total × rate / (100 + rate). An exempt dealer charges no VAT.
 */
export type Method = 'cash' | 'transfer' | 'bit' | 'card' | 'link' | 'other' | 'split';
export interface Pay { method: Exclude<Method, 'split'>; amount: number }
export const METHODS: { id: Method; label: string; icon: string }[] = [
  { id: 'cash', label: 'מזומן', icon: '💵' }, { id: 'bit', label: 'Bit / PayBox', icon: '📱' },
  { id: 'transfer', label: 'העברה', icon: '🏦' }, { id: 'card', label: 'אשראי (מסוף)', icon: '💳' },
  { id: 'link', label: 'קישור תשלום', icon: '🔗' }, { id: 'other', label: 'אחר', icon: '•' },
];
export const methodLabelAll = (m: Method) => (m === 'split' ? 'פיצול תשלום' : methodLabel(m));
export const methodLabel = (m: Method) => (m === 'split' ? 'פיצול תשלום' : METHODS.find((x) => x.id === m)?.label ?? m);

export type ItemKind = 'service' | 'product' | 'package' | 'other';
/** a cart / sale line; itemId + kind (from 2.50) tie it to the price list — stock and commissions use them */
export interface Line { name: string; price: number; qty: number; itemId?: string; kind?: ItemKind }
export interface Sale {
  id: string; leadId: string | null; appointmentId: string | null; customerName: string; customerPhone: string;
  items: Line[]; subtotal: number; discount: number; total: number; vatRate: number; vatAmount: number;
  method: Method; status: 'paid' | 'pending' | 'cancelled'; note: string; paidAt: string | null; createdAt: string;
  /** split payments (method = 'split'); otherwise empty */
  payments?: Pay[]; employeeId?: string | null; employeeName?: string;
  /** an invoice to a business: the name on the document, its dealer / company number and address */
  billingName?: string; customerDealer?: string; customerStreet?: string; customerCity?: string;
}

/** money paid back on a sale ("החזר"). Recorded once, never edited; reports count it on the day it was made. */
export type RefundMethod = Exclude<Method, 'split' | 'link'>;
export interface Refund {
  id: string; saleId: string; createdAt: string; amount: number; vatAmount: number; method: RefundMethod;
  /** what came back (empty = an amount only) */
  items: Line[]; restock: boolean; reason: string; employeeName: string;
}
export const refundDay = (r: Pick<Refund, 'createdAt'>) => israelParts(new Date(r.createdAt)).date;
/** the payments of a sale — a split sale lists them, a single-method sale is one payment of the total */
export const paymentsOf = (s: Pick<Sale, 'method' | 'total' | 'payments'>): Pay[] =>
  s.method === 'split' && s.payments?.length ? s.payments : [{ method: (s.method === 'split' ? 'other' : s.method) as Pay['method'], amount: s.total }];
/** how much is still to be covered in a split payment (agorot-exact) */
export const remaining = (total: number, pays: { amount: number }[]) => (ag(total) - pays.reduce((a, p) => a + ag(p.amount || 0), 0)) / 100;

const ag = (n: number) => Math.round((Number(n) || 0) * 100);
const sh = (a: number) => a / 100;
export const ils = (n: number) => `₪${(Math.round(n * 100) / 100).toLocaleString('he-IL', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** totals of a sale; discount as a sum (₪) or a percent, never more than the subtotal */
export function computeSale(lines: Line[], discount: { kind: 'sum' | 'percent'; value: number }, vat: { type: 'exempt' | 'licensed'; rate: number }) {
  const subA = lines.reduce((a, l) => a + ag(l.price) * Math.max(0, Math.floor(l.qty || 0)), 0);
  const dRaw = discount.kind === 'percent' ? Math.round(subA * Math.min(100, Math.max(0, discount.value)) / 100) : ag(Math.max(0, discount.value));
  const discA = Math.min(subA, dRaw);
  const totA = subA - discA;
  const rate = vat.type === 'licensed' ? vat.rate : 0;
  const vatA = rate ? Math.round((totA * rate) / (100 + rate)) : 0;
  return { subtotal: sh(subA), discount: sh(discA), total: sh(totA), vatRate: rate, vatAmount: sh(vatA), beforeVat: sh(totA - vatA) };
}

export const saleDay = (s: Pick<Sale, 'createdAt' | 'paidAt'>) => israelParts(new Date(s.paidAt ?? s.createdAt)).date;

/**
 * The day / month summary: paid totals by method, VAT, open (pending) sums — and refunds.
 * A refund counts on the day it was made (not the day of the sale): `total` stays the sales made,
 * `net` = sales − refunds, and each method shows what stayed after money went back that way.
 */
export function summarize(sales: Sale[], fromDay: string, toDay: string, refunds: Refund[] = []) {
  const inRange = sales.filter((s) => s.status !== 'cancelled' && saleDay(s) >= fromDay && saleDay(s) <= toDay);
  const paid = inRange.filter((s) => s.status === 'paid');
  const back = refunds.filter((r) => refundDay(r) >= fromDay && refundDay(r) <= toDay);
  const byMethod = new Map<Method, { count: number; totalA: number; refundedA: number }>();
  const slot = (m: Method) => byMethod.get(m) ?? { count: 0, totalA: 0, refundedA: 0 };
  for (const s of paid) for (const p of paymentsOf(s)) { const m = slot(p.method); m.count++; m.totalA += ag(p.amount); byMethod.set(p.method, m); }
  for (const r of back) { const m = slot(r.method); m.refundedA += ag(r.amount); byMethod.set(r.method, m); }
  const totalA = paid.reduce((a, s) => a + ag(s.total), 0);
  const vatA = paid.reduce((a, s) => a + ag(s.vatAmount), 0);
  const refundsA = back.reduce((a, r) => a + ag(r.amount), 0);
  const refundVatA = back.reduce((a, r) => a + ag(r.vatAmount), 0);
  return {
    count: paid.length,
    total: sh(totalA),
    vat: sh(vatA - refundVatA),
    discounts: sh(paid.reduce((a, s) => a + ag(s.discount), 0)),
    refunds: sh(refundsA), refundCount: back.length, net: sh(totalA - refundsA),
    byMethod: [...byMethod.entries()].map(([method, v]) => ({ method, count: v.count, total: sh(v.totalA - v.refundedA), refunded: sh(v.refundedA) }))
      .sort((a, b) => b.total - a.total),
    pendingCount: inRange.filter((s) => s.status === 'pending').length,
    pendingTotal: sh(inRange.filter((s) => s.status === 'pending').reduce((a, s) => a + ag(s.total), 0)),
  };
}

/** CSV for the accountant (UTF-8 BOM): every sale, and every refund as a negative row on the day it was made. */
export function salesCsv(sales: Sale[], fromDay: string, toDay: string, refunds: Refund[] = []) {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const st = { paid: 'שולם', pending: 'ממתין לתשלום', cancelled: 'בוטל' } as const;
  const items = (ls: Line[]) => ls.map((l) => `${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''}`).join(' + ');
  const saleRows = sales.filter((s) => saleDay(s) >= fromDay && saleDay(s) <= toDay)
    .map((s) => ({ at: s.createdAt, cells: [saleDay(s), israelParts(new Date(s.paidAt ?? s.createdAt)).time, s.customerName, items(s.items),
      s.subtotal.toFixed(2), s.discount.toFixed(2), s.total.toFixed(2), s.vatAmount.toFixed(2),
      s.method === 'split' ? paymentsOf(s).map((p) => `${methodLabel(p.method)} ${p.amount}`).join(' + ') : methodLabel(s.method), st[s.status], s.note, s.employeeName ?? ''] }));
  const byId = new Map(sales.map((s) => [s.id, s]));
  const refundRows = refunds.filter((r) => refundDay(r) >= fromDay && refundDay(r) <= toDay)
    .map((r) => ({ at: r.createdAt, cells: [refundDay(r), israelParts(new Date(r.createdAt)).time, byId.get(r.saleId)?.customerName ?? '',
      `החזר${r.items.length ? `: ${items(r.items)}` : ''}`, '', '', (-r.amount).toFixed(2), (-r.vatAmount).toFixed(2), methodLabel(r.method), 'החזר', r.reason, r.employeeName] }));
  const rows = [...saleRows, ...refundRows].sort((a, b) => a.at.localeCompare(b.at)).map((r) => r.cells.map(esc).join(','));
  return '\uFEFF' + ['תאריך,שעה,לקוח,פריטים,לפני הנחה,הנחה,סה״כ,מתוכו מע״מ,אמצעי תשלום,סטטוס,הערה,מוכר/מטפל', ...rows].join('\r\n');
}

/** WhatsApp text asking the customer to pay, with the business's payment link */
export const payRequestText = (p: { name: string; total: number; items: string; business: string; link: string }) =>
  `היי ${p.name.split(' ')[0] || ''}, תודה שבחרת ב${p.business}! 🙏\nלתשלום על ${p.items}: ${ils(p.total)}\n${p.link}`;

/** best sellers by quantity in the last N days (for the "הכי נמכרים" category) */
export function topSellers(sales: Sale[], days = 90, limit = 12, now = Date.now()) {
  const since = new Date(now - days * 864e5).toISOString();
  const qty = new Map<string, number>();
  for (const s of sales) if (s.status === 'paid' && (s.paidAt ?? s.createdAt) >= since) for (const l of s.items) qty.set(l.name, (qty.get(l.name) ?? 0) + l.qty);
  return [...qty.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name]) => name);
}
/** what the cashier needs about a customer — nothing more */
export function customerSnapshot(leadId: string, sales: Sale[]) {
  const mine = sales.filter((s) => s.leadId === leadId && s.status === 'paid').sort((a, b) => (b.paidAt ?? b.createdAt).localeCompare(a.paidAt ?? a.createdAt));
  return { lastPurchase: mine[0] ?? null, purchases: mine.length, spent: mine.reduce((a, s) => a + ag(s.total), 0) / 100 };
}
