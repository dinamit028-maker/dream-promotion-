import { paymentsOf, type Line, type Method, type Sale } from '@/features/register/money';
import type { Doc, DocLine } from './openformat';
import { netOfGross } from '@/features/finance/vat';

/**
 * From a paid sale to a legal document. Prices in the register are VAT-inclusive; documents show the
 * amounts before VAT, the VAT, and the total (spec fields 1219–1223 / 1265–1268), in whole agorot.
 *   licensed dealer → 320 "חשבונית מס / קבלה"     exempt dealer → 400 "קבלה"
 *   correction of a 320 → 330 "חשבונית מס זיכוי" pointing to the original (1256/1257)
 */
export const DOC_LABEL: Record<number, string> = { 300: 'חשבונית עסקה', 305: 'חשבונית מס', 320: 'חשבונית מס / קבלה', 330: 'חשבונית מס זיכוי', 400: 'קבלה' };
/** register payment method → spec field 1306 (1 cash, 2 cheque, 3 credit card, 4 bank transfer, 9 other) */
export const PAY_CODE: Record<Method, number> = { cash: 1, card: 3, transfer: 4, bit: 9, link: 9, other: 9, split: 9 };
export const PAY_LABEL: Record<number, string> = { 1: 'מזומן', 2: 'המחאה', 3: 'כרטיס אשראי', 4: 'העברה בנקאית', 9: 'אחר' };

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
});

export function docFromSale(sale: Pick<Sale, 'items' | 'discount' | 'total' | 'vatAmount' | 'vatRate' | 'method' | 'customerName' | 'customerPhone' | 'payments'>
  & Partial<Pick<Sale, 'billingName' | 'customerDealer' | 'customerStreet' | 'customerCity'>> & { paidAt?: string | null },
  o: { licensed: boolean; docDate: string; issuedBy?: string }): Omit<Doc, 'docNumber' | 'linkNo' | 'issuedAt'> {
  const rate = o.licensed ? sale.vatRate : 0;
  const exVat = (grossA: number) => netOfGross(grossA, rate);   // the VAT engine (finance/vat.ts)
  const lines: DocLine[] = sale.items.filter((l: Line) => l.qty > 0).map((l) => {
    const unitA = exVat(ag(l.price));
    const totA = exVat(ag(l.price) * l.qty);
    return { name: l.name, qty: l.qty, unitPriceExVat: sh(unitA), discountExVat: 0, totalExVat: sh(totA), vatRate: rate, kind: 1 };
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
    issuedBy: o.issuedBy ?? '', lines, payments: paymentsOf(sale).map((p) => ({ method: PAY_CODE[p.method], amount: p.amount, date: o.docDate, m: p.method })), // a split sale = one D120 line per payment; m keeps Bit / link for the ledger
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
      return { name: l.name, qty: l.qty, unitPriceExVat: sh(Math.round(totA / l.qty)), discountExVat: 0, totalExVat: sh(totA), vatRate: rate, kind: 1 as const };
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

/** how much of each document was already credited (sum of its 330s), keyed "type:number" */
export function creditedTotals(docs: Pick<Doc, 'docType' | 'total' | 'baseDocType' | 'baseDocNumber'>[]) {
  const m = new Map<string, number>();
  for (const d of docs) if (d.docType === 330 && d.baseDocNumber != null) {
    const k = `${d.baseDocType}:${d.baseDocNumber}`; m.set(k, sh(ag(m.get(k) ?? 0) + ag(d.total)));
  }
  return m;
}
