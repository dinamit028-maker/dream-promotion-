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

export function docFromSale(sale: Pick<Sale, 'items' | 'discount' | 'total' | 'vatAmount' | 'vatRate' | 'method' | 'customerName' | 'customerPhone' | 'payments'> & { paidAt?: string | null },
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
    docType: o.licensed ? 320 : 400, docDate: o.docDate, customerName: sale.customerName, customerPhone: sale.customerPhone,
    beforeDiscount: sh(beforeA), discount: sh(Math.max(0, beforeA - afterA)), afterDiscount: sh(afterA), vatAmount: sh(vatA), total: sh(totalA),
    issuedBy: o.issuedBy ?? '', lines, payments: paymentsOf(sale).map((p) => ({ method: PAY_CODE[p.method], amount: p.amount, date: o.docDate })), // a split sale = one D120 line per payment
  };
}

/** a credit invoice cancels a tax invoice/receipt (the original stays, unchanged, forever) */
export function creditFor(d: Doc, docDate: string): Omit<Doc, 'docNumber' | 'linkNo' | 'issuedAt'> {
  if (d.docType !== 320 && d.docType !== 305) throw new Error('credit invoices are issued for tax invoices only');
  return { ...d, docType: 330, docDate, baseDocType: d.docType, baseDocNumber: d.docNumber, payments: [] };
}
