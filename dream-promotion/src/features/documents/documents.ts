import { paymentsOf, type Line, type Method, type Sale } from '@/features/register/money';
import type { Doc, DocLine } from './openformat';

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

/** a document row of the database → the document (server and screen alike) */
export interface DocRow extends Doc { id: string; printCount: number; saleId: string | null; shareToken?: string }
export const toDoc = (r: any): DocRow => ({
  id: r.id, docType: r.doc_type, docNumber: Number(r.doc_number), linkNo: Number(r.link_no), issuedAt: r.issued_at, docDate: r.doc_date,
  customerName: r.customer_name, customerPhone: r.customer_phone, customerDealer: r.customer_dealer, customerStreet: r.customer_street, customerCity: r.customer_city,
  beforeDiscount: Number(r.before_discount), discount: Number(r.discount), afterDiscount: Number(r.after_discount), vatAmount: Number(r.vat_amount), total: Number(r.total),
  baseDocType: r.base_doc_type, baseDocNumber: r.base_doc_number == null ? null : Number(r.base_doc_number), issuedBy: r.issued_by,
  lines: r.lines ?? [], payments: r.payments ?? [], printCount: r.print_count ?? 0, saleId: r.sale_id, shareToken: r.share_token,
});

export function docFromSale(sale: Pick<Sale, 'items' | 'discount' | 'total' | 'vatAmount' | 'vatRate' | 'method' | 'customerName' | 'customerPhone' | 'payments'>
  & Partial<Pick<Sale, 'billingName' | 'customerDealer' | 'customerStreet' | 'customerCity'>> & { paidAt?: string | null },
  o: { licensed: boolean; docDate: string; issuedBy?: string }): Omit<Doc, 'docNumber' | 'linkNo' | 'issuedAt'> {
  const rate = o.licensed ? sale.vatRate : 0;
  const exVat = (grossA: number) => (rate ? Math.round((grossA * 100) / (100 + rate)) : grossA);
  const lines: DocLine[] = sale.items.filter((l: Line) => l.qty > 0).map((l) => {
    const unitA = exVat(ag(l.price));
    const totA = exVat(ag(l.price) * l.qty);
    return { name: l.name, qty: l.qty, unitPriceExVat: sh(unitA), discountExVat: 0, totalExVat: sh(totA), vatRate: rate, kind: 1 };
  });
  const totalA = ag(sale.total), vatA = rate ? ag(sale.vatAmount) : 0;
  const afterA = totalA - vatA;
  let beforeA = lines.reduce((a, l) => a + ag(l.totalExVat), 0);
  if (!sale.discount && lines.length && beforeA !== afterA) { // rounding: the last line absorbs the agora
    const last = lines[lines.length - 1]; last.totalExVat = sh(ag(last.totalExVat) + (afterA - beforeA)); beforeA = afterA;
  }
  return {
    docType: o.licensed ? 320 : 400, docDate: o.docDate, customerName: sale.billingName?.trim() || sale.customerName, customerPhone: sale.customerPhone,
    // an invoice to a business carries its dealer / company number and address (fields 1206–1209 of the unified file)
    customerDealer: sale.customerDealer ?? '', customerStreet: sale.customerStreet ?? '', customerCity: sale.customerCity ?? '',
    beforeDiscount: sh(beforeA), discount: sh(Math.max(0, beforeA - afterA)), afterDiscount: sh(afterA), vatAmount: sh(vatA), total: sh(totalA),
    issuedBy: o.issuedBy ?? '', lines, payments: paymentsOf(sale).map((p) => ({ method: PAY_CODE[p.method], amount: p.amount, date: o.docDate })), // a split sale = one D120 line per payment
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
  const exVat = (grossA: number) => (rate ? Math.round((grossA * 100) / (100 + rate)) : grossA);
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
