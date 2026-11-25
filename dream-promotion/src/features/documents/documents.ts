import { paymentsOf, type Line, type Method, type Sale } from '@/features/register/money';
import { txKind, type Doc, type DocLine } from './openformat';
import { netOfGross } from '@/features/finance/vat';
import { withSerials } from '@/features/catalog/serials';

/**
 * From a paid sale to a legal document. Prices in the register are VAT-inclusive; documents show the
 * amounts before VAT, the VAT, and the total (spec fields 1219–1223 / 1265–1268), in whole agorot.
 *   licensed dealer → 320 "חשבונית מס / קבלה"     exempt dealer → 400 "קבלה"
 *   correction of a 320 → 330 "חשבונית מס זיכוי" pointing to the original (1256/1257)
 */
export const DOC_LABEL: Record<number, string> = { 300: 'חשבונית עסקה', 305: 'חשבונית מס', 320: 'חשבונית מס / קבלה', 330: 'חשבונית מס זיכוי', 400: 'קבלה',
  // 2.95 (T10): for a business that sells products — the unified file's codes
  100: 'הזמנה', 200: 'תעודת משלוח', 210: 'תעודת החזרה' };
/** the total's name on a printed document — 2.118: a refund receipt (a 400 below zero, new) "סה״כ הוחזר"; every other as before */
export const totalLabel = (t: number, total = 0) =>
  t === 400 && total < 0 ? 'סה״כ הוחזר'
    : t === 330 ? 'סה״כ זיכוי' : t === 400 || t === 320 ? 'סה״כ שולם' : t === 100 ? 'סה״כ הזמנה' : t === 200 ? 'סה״כ' : t === 210 ? 'סה״כ החזרה' : 'סה״כ לתשלום';
/** a delivery note's last line: who received the goods (signed on paper) */
export const RECEIVED_LINE = 'קיבלתי את הסחורה המפורטת לעיל — שם: ____________________   חתימה: ____________________';
/** the line on a document naming the document it stands on (fields 1256/1257): a credit invoice's invoice, an invoice's delivery note / order */
export function baseDocLine(d: { docType: number; baseDocType?: number | null; baseDocNumber?: number | null }): string {
  if (!d.baseDocNumber || !d.baseDocType) return '';
  const what = `${DOC_LABEL[d.baseDocType] ?? 'מסמך'} מס׳ ${d.baseDocNumber}`;
  return d.docType === 330 ? `זיכוי עבור ${what}` : d.docType === 210 ? `החזרה על ${what}`
    : d.docType === 400 && d.baseDocType === 400 ? `החזר כספי על ${what}` : `על פי ${what}`;   // 2.118: a refund receipt (new only)
}
/**
 * register payment method → spec field 1306 (1 cash, 2 cheque, 3 credit card, 4 bank transfer, 9 other — §4.5, p. 14).
 * Bit / PayBox → 4 from 2.118 (the accountant's answer 12, 25.11.2026; before — 9). A payment link stays 9 (not answered).
 */
export const PAY_CODE: Record<Method, number> = { cash: 1, card: 3, transfer: 4, bit: 4, link: 9, other: 9, split: 9 };
export const PAY_LABEL: Record<number, string> = { 1: 'מזומן', 2: 'המחאה', 3: 'כרטיס אשראי', 4: 'העברה בנקאית', 9: 'אחר' };
const CARD_KIND_HE: Record<number, string> = { 2: 'תשלומים', 3: 'קרדיט', 4: 'חיוב נדחה', 5: 'אחר' };
/**
 * a payment's line on a printed receipt: its method — tax withheld at source by its name and percent (2.94), not "אחר".
 * 2.118, new documents only (an issued document prints as it always did): Bit with code 4 — "Bit / PayBox" (not "העברה בנקאית";
 * an older one, code 9, stays "אחר"); a card payment whose kind is not regular — its kind next to it.
 */
export const docPayLabel = (p: { method: number; m?: string; pct?: number | null; cardKind?: number }) =>
  p.m === 'withholding' ? `ניכוי במקור${p.pct != null && Number.isFinite(Number(p.pct)) ? ` (${Number(p.pct)}%)` : ''}`
    : p.m === 'bit' && p.method === 4 ? 'Bit / PayBox'
    : p.method === 3 && p.cardKind != null && CARD_KIND_HE[p.cardKind] ? `${PAY_LABEL[3]} (${CARD_KIND_HE[p.cardKind]})`
    : PAY_LABEL[p.method] ?? 'אחר';

const ag = (n: number) => Math.round(n * 100);
const sh = (a: number) => a / 100;

/**
 * Who issued a document, as it was on the day (documents.issuer, taken by the database at issue time — 2.51).
 * Documents issued before 2.51 have none: they are shown with the business's details of today, as before.
 */
export interface Issuer {
  name: string; tradingName?: string; entityType?: string; dealerNumber: string; companyNumber?: string; street?: string; houseNo?: string; city?: string; zip?: string;
  phone?: string; email?: string; bankName?: string; bankBranch?: string; bankAccount?: string; note?: string; vatRate?: number;
  /** 2.91 (T12א): the location it was issued in — taken only when the business had more than one active location */
  location?: { name: string; address?: string; phone?: string } | null;
}
/** the issuer's location line on a document ("סניף: …"), or nothing (one location) */
export const issuerLocationLine = (i: Pick<Issuer, 'location'>) =>
  i.location?.name ? `סניף: ${[i.location.name, i.location.address, i.location.phone].filter(Boolean).join(' · ')}` : '';
/** a document row of the database → the document (server and screen alike) */
export interface DocRow extends Doc {
  id: string; printCount: number; saleId: string | null; shareToken?: string;
  /** 2.51 */
  leadId?: string | null; dueDate?: string | null; notes?: string; customerEmail?: string; issuer?: Issuer | null; source?: string | null;
  paidDocumentId?: string | null; quoteId?: string | null; refundId?: string | null;
  /** 2.91 (T12א): the location it was issued in (none = the main one, or before locations) */
  locationId?: string | null;
}
/** the issuer to print: the document's own snapshot, else (before 2.51) the business as it is today */
export function issuerFor(d: { issuer?: Issuer | null }, fallback: { name: string; dealerNumber: string; companyNumber?: string; street?: string; houseNo?: string; city?: string; zip?: string; entityType?: string }): Issuer {
  if (d.issuer && d.issuer.dealerNumber) return d.issuer;
  return { name: fallback.name, dealerNumber: fallback.dealerNumber, companyNumber: fallback.companyNumber, street: fallback.street, houseNo: fallback.houseNo,
    city: fallback.city, zip: fallback.zip, entityType: fallback.entityType };
}
export const toDoc = (r: any): DocRow => ({
  id: r.id, docType: r.doc_type, docNumber: Number(r.doc_number), linkNo: Number(r.link_no), issuedAt: r.issued_at, docDate: r.doc_date,
  customerName: r.customer_name, customerPhone: r.customer_phone, customerDealer: r.customer_dealer, customerStreet: r.customer_street, customerCity: r.customer_city,
  beforeDiscount: Number(r.before_discount), discount: Number(r.discount), afterDiscount: Number(r.after_discount), vatAmount: Number(r.vat_amount), total: Number(r.total),
  baseDocType: r.base_doc_type, baseDocNumber: r.base_doc_number == null ? null : Number(r.base_doc_number), issuedBy: r.issued_by,
  lines: r.lines ?? [], payments: r.payments ?? [], printCount: r.print_count ?? 0, saleId: r.sale_id, shareToken: r.share_token,
  leadId: r.lead_id ?? null, dueDate: r.due_date ?? null, notes: r.notes ?? '', customerEmail: r.customer_email ?? '', issuer: r.issuer ?? null, source: r.source ?? null,
  paidDocumentId: r.paid_document_id ?? null, quoteId: r.quote_id ?? null, refundId: r.refund_id ?? null, locationId: r.location_id ?? null,
  userId: r.user_id ?? null,
});

export function docFromSale(sale: Pick<Sale, 'items' | 'discount' | 'total' | 'vatAmount' | 'vatRate' | 'method' | 'customerName' | 'customerPhone' | 'payments'>
  & Partial<Pick<Sale, 'billingName' | 'customerDealer' | 'customerStreet' | 'customerCity'>> & { paidAt?: string | null },
  o: { licensed: boolean; docDate: string; issuedBy?: string; cardKind?: number }): Omit<Doc, 'docNumber' | 'linkNo' | 'issuedAt'> {
  const rate = o.licensed ? sale.vatRate : 0;
  const exVat = (grossA: number) => netOfGross(grossA, rate);   // the VAT engine (finance/vat.ts)
  const lines: DocLine[] = sale.items.filter((l: Line) => l.qty > 0).map((l) => {
    const unitA = exVat(ag(l.price));
    const totA = exVat(ag(l.price) * l.qty);
    // a unit sold by number names it on the document (2.93); kind — field 1258 by the price list's kind (txKind, 2.117)
    return { name: withSerials(l.name, l.serials), qty: l.qty, unitPriceExVat: sh(unitA), discountExVat: 0, totalExVat: sh(totA), vatRate: rate, kind: txKind(l) };
  });
  const totalA = ag(sale.total), vatA = rate ? ag(sale.vatAmount) : 0;
  const afterA = totalA - vatA;
  let beforeA = lines.reduce((a, l) => a + ag(l.totalExVat), 0);
  // rounding: the last line absorbs the agora — also when a tiny discount left the lines below the amount after it
  // (before 2.51 that case gave "before discount" < "after discount"; the database now refuses such a document)
  if (lines.length && beforeA !== afterA && (!sale.discount || beforeA < afterA)) {
    const last = lines[lines.length - 1]; last.totalExVat = sh(ag(last.totalExVat) + (afterA - beforeA)); beforeA = afterA;
  }
  return {
    docType: o.licensed ? 320 : 400, docDate: o.docDate, customerName: sale.billingName?.trim() || sale.customerName, customerPhone: sale.customerPhone,
    // an invoice to a business carries its dealer / company number and address (fields 1206–1209 of the unified file)
    customerDealer: sale.customerDealer ?? '', customerStreet: sale.customerStreet ?? '', customerCity: sale.customerCity ?? '',
    beforeDiscount: sh(beforeA), discount: sh(Math.max(0, beforeA - afterA)), afterDiscount: sh(afterA), vatAmount: sh(vatA), total: sh(totalA),
    // a split sale = one D120 line per payment; m keeps Bit / link for the ledger. 2.118: a card payment names its kind (field 1315,
    // the accountant's answer 13) — the register and an online order charge once on the terminal / the payment page, so "regular"
    // (1) unless the caller knows otherwise (o.cardKind)
    issuedBy: o.issuedBy ?? '', lines, payments: paymentsOf(sale).map((p) => ({ method: PAY_CODE[p.method], amount: p.amount, date: o.docDate, m: p.method,
      ...(p.method === 'card' ? { cardKind: o.cardKind ?? 1 } : {}) })),
  };
}

/** a credit invoice cancels a tax invoice/receipt (the original stays, unchanged, forever) */
export function creditFor(d: Doc, docDate: string): Omit<Doc, 'docNumber' | 'linkNo' | 'issuedAt'> {
  if (d.docType !== 320 && d.docType !== 305) throw new Error('credit invoices are issued for tax invoices only');
  return { ...d, docType: 330, docDate, baseDocType: d.docType, baseDocNumber: d.docNumber, payments: [] };
}

/**
 * The credit invoice (330) of a refund. The whole remaining amount of a document = an exact mirror of it;
 * part of it = the returned items (their share of the sale's discount included), or one line for a sum.
 * Amounts are agorot-exact: the lines add up to the refund before VAT, the VAT is the refund's VAT.
 */
export function creditForRefund(orig: Doc, refund: { amount: number; vatAmount: number; items: Line[] },
  sale: Pick<Sale, 'subtotal' | 'total'>, docDate: string): Omit<Doc, 'docNumber' | 'linkNo' | 'issuedAt'> {
  if (orig.docType !== 320 && orig.docType !== 305) throw new Error('credit invoices are issued for tax invoices only');
  if (ag(refund.amount) === ag(orig.total)) return creditFor(orig, docDate);
  const rate = orig.lines[0]?.vatRate ?? 0;
  const afterA = ag(refund.amount) - ag(refund.vatAmount);
  const exVat = (grossA: number) => netOfGross(grossA, rate);
  const factor = ag(sale.subtotal) ? ag(sale.total) / ag(sale.subtotal) : 1;
  const lines: DocLine[] = refund.items.length
    ? refund.items.map((l) => {
      const totA = exVat(Math.round(ag(l.price) * l.qty * factor));
      return { name: withSerials(l.name, l.serials), qty: l.qty, unitPriceExVat: sh(Math.round(totA / l.qty)), discountExVat: 0, totalExVat: sh(totA), vatRate: rate, kind: txKind(l) };
    })
    : [{ name: `החזר חלקי — ${DOC_LABEL[orig.docType]} מס׳ ${orig.docNumber}`, qty: 1, unitPriceExVat: sh(afterA), discountExVat: 0, totalExVat: sh(afterA), vatRate: rate, kind: 1 as const }];
  const sumA = lines.reduce((a, l) => a + ag(l.totalExVat), 0);
  if (sumA !== afterA) { const last = lines[lines.length - 1]; last.totalExVat = sh(ag(last.totalExVat) + (afterA - sumA)); } // the last line absorbs the agora
  return {
    docType: 330, docDate, customerName: orig.customerName, customerPhone: orig.customerPhone, customerDealer: orig.customerDealer,
    customerStreet: orig.customerStreet, customerCity: orig.customerCity,
    beforeDiscount: sh(afterA), discount: 0, afterDiscount: sh(afterA), vatAmount: refund.vatAmount, total: refund.amount,
    baseDocType: orig.docType, baseDocNumber: orig.docNumber, issuedBy: orig.issuedBy ?? '', lines, payments: [],
  };
}

/**
 * 2.118 — an exempt dealer's refund (the accountant's answer 15, docs/ita-registration/CPA_ANSWERS_HE.md, 25.11.2026): a receipt
 * (400) below zero on the receipt it refunds (base 400 + its number — the fields a credit invoice uses, 1256/1257), checked by the
 * database (documents_validate of migration 6800: an exempt dealer only, never beyond the receipt, payments below zero that add up).
 * No discount, no VAT: before = after = the total, below zero. The lines: one line of the sum, or the given lines (their totals
 * below zero; "restock" only when the money screens give it back without a register refund). Payments come in above zero (as
 * the money went back) and are written below zero; a card refund names its kind, as any card payment (default — the kind of the
 * receipt's own card payment, else regular). Throws on anything the database would refuse — the caller checks first (refundLeft).
 */
export interface RefundPay { method: number; amount: number; m?: string; cardKind?: number }
export function refundReceiptFor(base: Pick<Doc, 'docType' | 'docNumber' | 'total' | 'customerName' | 'customerPhone' | 'customerDealer' | 'customerStreet' | 'customerCity' | 'payments'>,
  o: { payments: RefundPay[]; docDate: string; lines?: DocLine[]; issuedBy?: string; notes?: string }): Omit<Doc, 'docNumber' | 'linkNo' | 'issuedAt'> & { notes?: string } {
  if (base.docType !== 400 || !(ag(base.total) > 0)) throw new Error('a refund receipt refunds a receipt (400) above zero');
  const pays = o.payments.filter((p) => ag(p.amount) !== 0);
  if (!pays.length || pays.some((p) => !(ag(p.amount) > 0) || !Number.isInteger(p.method) || p.method < 1 || p.method > 9 || p.m === 'withholding')) {
    throw new Error('a refund receipt gives money back: each payment above zero, a method 1–9, never tax withheld');
  }
  const amountA = pays.reduce((a, p) => a + ag(p.amount), 0);
  const baseCard = base.payments.find((p) => p.method === 3)?.cardKind;
  const lines: DocLine[] = o.lines?.length
    ? o.lines.map((l) => ({ ...l, unitPriceExVat: -Math.abs(l.unitPriceExVat), totalExVat: -Math.abs(l.totalExVat), discountExVat: 0, vatRate: 0 }))
    : [{ name: `החזר כספי — קבלה מס׳ ${base.docNumber}`, qty: 1, unitPriceExVat: -sh(amountA), discountExVat: 0, totalExVat: -sh(amountA), vatRate: 0, kind: 1 }];
  const linesA = lines.reduce((a, l) => a + ag(l.totalExVat), 0);
  if (linesA !== -amountA) { const last = lines[lines.length - 1]; last.totalExVat = sh(ag(last.totalExVat) + (-amountA - linesA)); } // the last line absorbs the agora
  return {
    docType: 400, docDate: o.docDate, customerName: base.customerName, customerPhone: base.customerPhone ?? '', customerDealer: base.customerDealer ?? '',
    customerStreet: base.customerStreet ?? '', customerCity: base.customerCity ?? '',
    beforeDiscount: -sh(amountA), discount: 0, afterDiscount: -sh(amountA), vatAmount: 0, total: -sh(amountA),
    baseDocType: 400, baseDocNumber: base.docNumber, issuedBy: o.issuedBy ?? '', lines,
    payments: pays.map((p) => ({ method: p.method, amount: -sh(ag(p.amount)), date: o.docDate, ...(p.m ? { m: p.m } : {}),
      ...(p.method === 3 ? { cardKind: [1, 2, 3, 4, 5].includes(Number(p.cardKind)) ? Number(p.cardKind) : [1, 2, 3, 4, 5].includes(Number(baseCard)) ? Number(baseCard) : 1 } : {}) })),
    ...(o.notes ? { notes: o.notes } : {}),
  };
}
/**
 * The refund receipt of a register's / an order's refund (sale_refunds — refund_id) for an exempt dealer: the money that went back,
 * by the refund's own method, on the sale's receipt. The returned items as lines (their share of the sale's discount included,
 * no VAT — an exempt dealer), or one line for a sum; never "restock" (the refund moves its own stock). Agorot-exact.
 */
export function refundReceiptForRefund(orig: Doc, refund: { amount: number; method: Method; items: Line[] }, sale: Pick<Sale, 'subtotal' | 'total'>, docDate: string) {
  const amountA = ag(refund.amount);
  const factor = ag(sale.subtotal) ? ag(sale.total) / ag(sale.subtotal) : 1;
  const lines: DocLine[] | undefined = refund.items.length
    ? refund.items.filter((l) => l.qty > 0).map((l) => {
      const totA = Math.round(ag(l.price) * l.qty * factor);
      return { name: withSerials(l.name, l.serials), qty: l.qty, unitPriceExVat: sh(Math.round(totA / l.qty)), discountExVat: 0, totalExVat: sh(totA), vatRate: 0, kind: txKind(l) };
    })
    : undefined;
  return refundReceiptFor(orig, { payments: [{ method: PAY_CODE[refund.method], amount: sh(amountA), m: refund.method }], docDate, lines, issuedBy: orig.issuedBy ?? '' });
}
/** what is left to refund on a receipt: its total less the refund receipts on it (agorot-exact, never below zero) */
export function refundLeft(base: Pick<Doc, 'docType' | 'docNumber' | 'total'>, docs: Pick<Doc, 'docType' | 'total' | 'baseDocType' | 'baseDocNumber'>[]): number {
  if (base.docType !== 400 || !(ag(base.total) > 0)) return 0;
  const doneA = docs.filter((d) => d.docType === 400 && ag(d.total) < 0 && d.baseDocType === 400 && Number(d.baseDocNumber) === base.docNumber)
    .reduce((a, d) => a - ag(d.total), 0);
  return sh(Math.max(0, ag(base.total) - doneA));
}
export const isRefundReceipt = (d: Pick<Doc, 'docType' | 'total'>) => d.docType === 400 && ag(d.total) < 0;

/** how much of each document was already credited (sum of its 330s), keyed "type:number" */
export function creditedTotals(docs: Pick<Doc, 'docType' | 'total' | 'baseDocType' | 'baseDocNumber'>[]) {
  const m = new Map<string, number>();
  for (const d of docs) if (d.docType === 330 && d.baseDocNumber != null) {
    const k = `${d.baseDocType}:${d.baseDocNumber}`; m.set(k, sh(ag(m.get(k) ?? 0) + ag(d.total)));
  }
  return m;
}
