/** The unified-structure files — exact record lengths and field positions from spec v1.31. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A000, A100, AMT, C100, D110, D120, N, SUM, X, Z900, buildOpenFormat, docTypeReport, toIso88598, type Doc } from '../src/features/documents/openformat';
import { creditFor, docFromSale } from '../src/features/documents/documents';

const biz = { dealerNumber: '515123456', companyNumber: '515123456', name: 'SaGabot בע"מ', street: 'איינשטיין', houseNo: '40', city: 'תל אביב', zip: '6910101' };
const sw = { regNumber: '00000000', name: 'Dream Promotion', version: '2.36.0', vendorVat: '123456782', vendorName: 'Dream Promotion' };
const col = (s: string, from: number, to: number) => s.slice(from - 1, to); // spec columns are 1-based, inclusive

const sale = { items: [{ name: 'לייזר פנים', price: 250, qty: 1 }, { name: 'קרם', price: 89.9, qty: 2 }], discount: 0, total: 429.8, vatAmount: 65.56, vatRate: 18, method: 'card' as const, customerName: 'דנה כהן', customerPhone: '052-1112233' };
const doc: Doc = { ...docFromSale(sale, { licensed: true, docDate: '2026-10-05', issuedBy: 'aviv' }), docNumber: 17, linkNo: 42, issuedAt: '2026-10-05T07:30:00Z' };

test('format helpers (spec 2.3)', () => {
  assert.equal(N(1234, 6), '001234'); assert.equal(X('אבג', 5), 'אבג  ');
  assert.equal(AMT(1245.65, 5), '+0124565'); assert.equal(AMT(-12345.65, 5), '-1234565'); assert.equal(AMT(1245, 5), '+0124500');
  assert.deepEqual([...toIso88598('Aא ת')], [0x41, 0xe0, 0x20, 0xfa]);
});

test('document from a sale: amounts before VAT, VAT, total — consistent to the agora', () => {
  assert.equal(doc.docType, 320);
  assert.equal(doc.total, 429.8); assert.equal(doc.vatAmount, 65.56); assert.equal(doc.afterDiscount, 364.24);
  assert.equal(Math.round(doc.lines.reduce((a, l) => a + l.totalExVat, 0) * 100), Math.round(doc.beforeDiscount * 100));
  assert.equal(doc.beforeDiscount, doc.afterDiscount, 'no discount → before = after');
  assert.equal(doc.payments[0].method, 3, 'card → 3');
  assert.equal(docFromSale({ ...sale, vatAmount: 0, vatRate: 0 }, { licensed: false, docDate: '2026-10-05' }).docType, 400, 'exempt dealer → receipt');
  const cr = creditFor(doc, '2026-10-06');
  assert.equal(cr.docType, 330); assert.equal(cr.baseDocType, 320); assert.equal(cr.baseDocNumber, 17);
});

test('record lengths are exact (spec 2.5 table)', () => {
  assert.equal(A100(1, biz, '123456789012345').length, 95);
  assert.equal(Z900(9, biz, '123456789012345', 9).length, 110);
  assert.equal(C100(2, biz, doc).length, 444);
  assert.equal(D110(3, biz, doc, doc.lines[0], 1).length, 339);
  assert.equal(D120(4, biz, doc, doc.payments[0], 1).length, 222);
  assert.equal(SUM('C100', 5).length, 19);
  assert.equal(A000(biz, sw, { id: '123456789012345', totalRecords: 9, path: 'OPENFRMT\\51512345.26\\10051030', from: '2026-01-01', to: '2026-12-31', startedAt: '2026-10-05T07:30:00Z' }).length, 466);
});

test('key field positions (spec 4.3–4.5, 3.1)', () => {
  const c = C100(2, biz, doc);
  assert.equal(col(c, 1, 4), 'C100'); assert.equal(col(c, 14, 22), '515123456'); assert.equal(col(c, 23, 25), '320');
  assert.equal(col(c, 26, 45).trim(), '17'); assert.equal(col(c, 46, 53), '20261005'); assert.equal(col(c, 54, 57), '1030', 'issue time in Israel (UTC+3)');
  assert.equal(col(c, 288, 302), '+00000000036424'); assert.equal(col(c, 333, 347), '+00000000006556'); assert.equal(col(c, 348, 362), '+00000000042980');
  assert.equal(col(c, 401, 408), '20261005'); assert.equal(col(c, 425, 431), '0000042');
  const d = D110(3, biz, doc, doc.lines[1], 2);
  assert.equal(col(d, 46, 49), '0002'); assert.equal(col(d, 94, 123).trim(), 'קרם'); assert.equal(col(d, 224, 240), '+0000000000020000', 'quantity 2 with 4 decimals');
  assert.equal(col(d, 286, 289), '1800'); assert.equal(col(d, 305, 311), '0000042');
  const r = D120(4, biz, doc, doc.payments[0], 1);
  assert.equal(col(r, 50, 50), '3'); assert.equal(col(r, 104, 118), '+00000000042980'); assert.equal(col(r, 148, 155), '20261005');
  const ini = A000(biz, sw, { id: '123456789012345', totalRecords: 9, path: 'x', from: '2026-01-01', to: '2026-12-31', startedAt: '2026-10-05T07:30:00Z' });
  assert.equal(col(ini, 25, 33), '515123456'); assert.equal(col(ini, 49, 56), '&OF1.31&'); assert.equal(col(ini, 134, 134), '2');
  assert.equal(col(ini, 367, 374), '20260101'); assert.equal(col(ini, 396, 396), '1'); assert.equal(col(ini, 417, 419), 'ILS');
});

test('whole export: record numbers, totals, folder name, doc-type report', () => {
  const docs = [doc, { ...doc, docNumber: 18, linkNo: 43 }, { ...doc, docType: 330, docNumber: 1, linkNo: 44, payments: [], baseDocType: 320, baseDocNumber: 17 }];
  const f = buildOpenFormat(biz, sw, docs, { from: '2026-10-01', to: '2026-10-31', startedAt: '2026-10-05T07:30:00Z', id: '123456789012345' });
  const lines = f.bkmv.trimEnd().split('\r\n');
  assert.equal(lines.length, f.totalRecords);
  lines.forEach((l, i) => assert.equal(Number(col(l, 5, 13)), i + 1, 'running record number (field 2)'));
  assert.equal(Number(col(lines.at(-1)!, 46, 60)), lines.length, 'Z900 total includes opening and closing');
  assert.deepEqual(f.counts, { A100: 1, C100: 3, D110: 6, D120: 2, Z900: 1 });
  assert.equal(f.dir, 'OPENFRMT\\51512345.26\\10051030');
  assert.ok(f.bkmv.endsWith('\r\n') && f.ini.split('\r\n').filter(Boolean).length === 4, 'A000 + 3 summaries');
  const rep = docTypeReport(docs, '2026-10-01', '2026-10-31');
  assert.equal(rep.find((x) => x.code === 320)!.count, 2); assert.equal(rep.find((x) => x.code === 320)!.total, 859.6);
  assert.equal(rep.find((x) => x.code === 305)!.count, 0, 'types not handled are reported as 0');
});
