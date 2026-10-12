import type { DocLine } from '@/features/documents/openformat';
import { DOC_LABEL } from '@/features/documents/documents';
import { israelParts } from '@/lib/il-time';
import { chargesVat, type EntityType } from './rules';
import { paymentErrors, type ComposeResult, type NewDoc } from './compose';
import { toDocPayment, type PaymentEntry } from './payments';

/**
 * An order, a delivery note and a return note (2.95, migration 20261011005000 — docs/FINANCE_ADDITIONS_HE.md T10): documents of
 * the one documents table (the unified file's codes 100, 200, 210), for a business that turned on "selling products" (a clinic
 * never sees them). An order moves nothing; a delivery note takes the goods out; the invoice made from it in one click names it
 * (fields 1256/1257) and takes nothing again; a return note — made from a delivery note, before it is invoiced — brings back at
 * most what went out. The database refuses anything else (d_documents_goods); this module builds the documents made from another
 * one, to the agora, the way the database checks them.
 */
export const GOODS_TYPES = [100, 200, 210] as const;
/** the goods documents issued from the composer (a return note is made from its delivery note only) */
export const GOODS_COMPOSE = [100, 200];
export const isGoods = (t: number) => (GOODS_TYPES as readonly number[]).includes(t);

/** what may be made from a document: an order → a delivery note or an invoice; a delivery note → an invoice or a return note */
export function madeFrom(baseType: number, entity: EntityType): number[] {
  const invoices = chargesVat(entity) ? [305, 320] : [300];
  if (baseType === 100) return [200, ...invoices];
  if (baseType === 200) return [...invoices, 210];
  return [];
}

type Lines = { lines: DocLine[] };
const keyOf = (l: DocLine) => (l.itemId ? `i:${l.itemId}:${l.variantId ?? ''}` : `n:${l.name.trim()}`);
/**
 * What is left of each line of a document after the documents made from it took their share — a product by its item (and size /
 * colour), any other line by its name; each taken quantity from the first line of its kind on.
 */
export function leftOf(base: Lines, taken: Lines[]): number[] {
  const left = base.lines.map((l) => l.qty);
  for (const d of taken) for (const t of d.lines) {
    let q = t.qty;
    base.lines.forEach((l, i) => {
      if (q <= 0 || keyOf(l) !== keyOf(t)) return;
      const k = Math.min(left[i], q); left[i] = Math.round((left[i] - k) * 1000) / 1000; q = Math.round((q - k) * 1000) / 1000;
    });
  }
  return left;
}

const ag = (n: number) => Math.round(n * 100);
const sh = (a: number) => a / 100;
const todayIL = () => israelParts(Date.now()).date;

export interface BaseDoc {
  docType: number; docNumber: number; customerName: string; customerPhone?: string; customerDealer?: string; customerStreet?: string; customerCity?: string;
  customerEmail?: string; lines: DocLine[]; beforeDiscount: number; discount: number; afterDiscount: number; vatAmount: number; total: number;
}
/**
 * A document made from an order or a delivery note: the chosen quantity of each of its lines. All of it → its lines, discount and
 * VAT exactly; part of it → each line's share (agorot), the discount's share, and the VAT of what is left at the rate of the day.
 * Never more than is left (the database checks it too, for products). An invoice-receipt (320) says how it was paid.
 */
export function docFromBase(base: BaseDoc, take: number[], o: {
  docType: number; entity: EntityType; vatRate: number; docDate: string; today?: string; left?: number[]; dueDate?: string | null;
  payments?: PaymentEntry[]; notes?: string;
}): ComposeResult {
  const today = o.today ?? todayIL();
  const errors: string[] = [];
  if (!madeFrom(base.docType, o.entity).includes(o.docType)) errors.push(`${DOC_LABEL[o.docType] ?? 'המסמך'} לא מופק מ${DOC_LABEL[base.docType] ?? 'המסמך הזה'}`);
  const left = o.left ?? base.lines.map((l) => l.qty);
  const bad = take.some((t, i) => !Number.isFinite(t) || t < 0 || t > (left[i] ?? 0) + 1e-9) || take.length !== base.lines.length;
  if (bad) errors.push('הכמות בכל שורה — בין 0 למה שנשאר');
  const rows = base.lines.map((l, i) => ({ l, t: take[i] ?? 0 })).filter((x) => x.t > 0);
  if (!rows.length) errors.push('בוחרים לפחות שורה אחת');
  const full = !bad && base.lines.every((l, i) => (take[i] ?? 0) === l.qty);
  const rate = chargesVat(o.entity) && o.docType !== 400 ? o.vatRate : 0;
  const baseRate = base.lines.find((l) => Number.isFinite(l.vatRate))?.vatRate ?? 0;
  const lines: DocLine[] = rows.map(({ l, t }) => {
    const totA = t === l.qty ? ag(l.totalExVat) : Math.round((ag(l.totalExVat) * t) / l.qty);
    return { name: l.name, qty: t, unitPriceExVat: sh(Math.round(totA / t)), discountExVat: 0, totalExVat: sh(totA), vatRate: rate, kind: l.kind ?? 1,
      ...(l.itemId ? { itemId: l.itemId, ...(l.variantId ? { variantId: l.variantId } : {}) } : {}) };
  });
  const beforeA = lines.reduce((a, l) => a + ag(l.totalExVat), 0);
  const discA = full ? ag(base.discount) : ag(base.beforeDiscount) > 0 ? Math.round((ag(base.discount) * beforeA) / ag(base.beforeDiscount)) : 0;
  const afterA = beforeA - Math.min(discA, beforeA);
  const vatA = full && rate === baseRate ? ag(base.vatAmount) : Math.round((afterA * rate) / 100);
  const totalA = afterA + vatA;
  if (rows.length && totalA <= 0) errors.push('הסכום חייב להיות גדול מאפס');
  const receipt = o.docType === 320 || o.docType === 400;
  if (receipt && totalA > 0) errors.push(...paymentErrors(o.payments ?? [], totalA, today));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.docDate) || o.docDate > today) errors.push('תאריך המסמך לא יכול להיות בעתיד');
  if ((o.docType === 305 || o.docType === 300) && o.dueDate && o.dueDate < o.docDate) errors.push('מועד התשלום לפני תאריך המסמך');
  if ((o.notes ?? '').length > 1000) errors.push('ההערות ארוכות מדי (עד 1,000 תווים)');
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  const doc: NewDoc = {
    docType: o.docType, docDate: o.docDate, customerName: base.customerName, customerPhone: base.customerPhone ?? '', customerDealer: base.customerDealer ?? '',
    customerStreet: base.customerStreet ?? '', customerCity: base.customerCity ?? '', customerEmail: base.customerEmail ?? '',
    beforeDiscount: sh(beforeA), discount: sh(beforeA - afterA), afterDiscount: sh(afterA), vatAmount: sh(vatA), total: sh(totalA),
    baseDocType: base.docType, baseDocNumber: base.docNumber, issuedBy: '', lines, payments: receipt ? (o.payments ?? []).map(toDocPayment) : [],
    dueDate: o.docType === 305 || o.docType === 300 ? o.dueDate || null : null, notes: (o.notes ?? '').trim(),
  };
  return { ok: true, doc, totals: { subtotal: sh(beforeA), discount: sh(beforeA - afterA), beforeDiscount: sh(beforeA), discountExVat: sh(beforeA - afterA),
    afterDiscount: sh(afterA), vatRate: rate, vatAmount: sh(vatA), total: sh(totalA) } };
}

/** where a goods document stands, for its pills: made from it (and how much is left), cancelled */
export interface GoodsState { invoices: { docType: number; docNumber: number }[]; deliveries: { docNumber: number }[]; returns: { docNumber: number }[]; left: number[] }
export function goodsState(base: Lines & { docType: number }, followers: (Lines & { docType: number; docNumber: number; cancelled?: boolean })[]): GoodsState {
  const live = followers.filter((f) => !f.cancelled);
  const invoices = live.filter((f) => [300, 305, 320].includes(f.docType)).map((f) => ({ docType: f.docType, docNumber: f.docNumber }));
  const deliveries = live.filter((f) => f.docType === 200).map((f) => ({ docNumber: f.docNumber }));
  const returns = live.filter((f) => f.docType === 210).map((f) => ({ docNumber: f.docNumber }));
  // an order: what its delivery notes and invoices took; a delivery note: what came back on its return notes
  const takers = base.docType === 100 ? live.filter((f) => f.docType === 200 || [300, 305, 320].includes(f.docType)) : live.filter((f) => f.docType === 210);
  return { invoices, deliveries, returns, left: leftOf(base, takers) };
}
