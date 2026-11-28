/**
 * Demo data for tests/openformat-books.test.ts (not a test file itself): a fictitious business (dealer 000000109 — demo) with
 * documents before the books' start (the file of such a period must stay byte-identical to the file of 2.123) and the books of
 * a fictitious December 2026. No real business, customer or number.
 */
import type { BranchInfo, Doc } from '../src/features/documents/openformat';

export const biz = { dealerNumber: '000000109', name: 'עסק דמו', street: 'רחוב הדמו', houseNo: '1', city: 'עיר דמו', zip: '1234567' };
export const sw = { regNumber: '00000000', name: 'Dream Promotion', version: '2.124.0', vendorVat: '000000109', vendorName: 'Dream Promotion' };
const line = (name: string, total: number, vatRate = 18, kind: 1 | 2 = 1) => ({ name, qty: 1, unitPriceExVat: total, discountExVat: 0, totalExVat: total, vatRate, kind });

let n = 0;
export const doc = (docType: number, date: string, who: { name: string; phone?: string; dealer?: string; street?: string; city?: string }, total: number, more: Partial<Doc> = {}): Doc => ({
  docType, docNumber: ++n, linkNo: n, issuedAt: `${date}T07:00:00Z`, docDate: date, customerName: who.name, customerPhone: who.phone ?? '',
  customerDealer: who.dealer, customerStreet: who.street ?? '', customerCity: who.city ?? '', issuedBy: '', userId: 'u-demo-1',
  beforeDiscount: total, discount: 0, afterDiscount: total, vatAmount: Math.round(total * 18) / 100, total: Math.round(total * 118) / 100,
  lines: [line('טיפול דמו', total)], payments: docType === 320 || docType === 400 ? [{ method: 1, amount: Math.round(total * 118) / 100, date, m: 'cash' }] : [],
  ...more,
});
export const dana = { name: 'דנה דמו', phone: '050-0000001', street: 'רחוב דמו 1', city: 'עיר דמו' };
export const firm = { name: 'חברת דמו בע"מ', phone: '03-0000002', dealer: '000000117' };

/** November 2026 — before the books (start 1.12.2026): every kind of document the file writes */
export function novemberDocs(): Doc[] {
  n = 0;
  return [
    doc(305, '2026-11-02', firm, 1000), doc(300, '2026-11-03', dana, 500), doc(320, '2026-11-04', dana, 200),
    doc(400, '2026-11-05', firm, 1000, { total: 1180, vatAmount: 0, payments: [{ method: 1, amount: 980, date: '2026-11-05', m: 'cash' }, { method: 9, amount: 200, date: '2026-11-05', m: 'withholding', pct: 20 }] }),
    doc(330, '2026-11-06', firm, 100, { baseDocType: 305, baseDocNumber: 1 }),
    doc(300, '2026-11-07', dana, 40, { cancelled: true }), doc(200, '2026-11-08', dana, 70, { payments: [] }),
    doc(420, '2026-11-09', { name: '' }, 0, { beforeDiscount: 300, afterDiscount: 300, vatAmount: 0, total: 300, lines: [], payments: [{ method: 1, amount: 300, date: '2026-11-09', m: 'cash' }] }),
  ];
}
export const branches: BranchInfo = { perLocation: true, businessId: 'biz-demo', codes: new Map([['biz-demo', '01'], ['loc-2', '02']]) };
