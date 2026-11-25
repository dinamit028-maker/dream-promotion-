/**
 * The Tax Authority's simulator on the sample of 2.117.0 (25.11.2026): every D110 of a receipt (400) was refused ("לא נמצאה
 * רשומת כותרת מסמך", field 1250). A receipt is C100 + D120 only (spec §4.5, p. 14, the example) — the file, not the document.
 * Demo data only (fictitious numbers).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C100, NO_D110, buildOpenFormat, docTypeReport, type Doc } from '../src/features/documents/openformat';

const biz = { dealerNumber: '000000109', name: 'עסק דמו' };
const sw = { regNumber: '00000000', name: 'Dream Promotion', version: '2.117.4', vendorVat: '000000109', vendorName: 'Dream Promotion' };
const at = { from: '2026-11-01', to: '2026-11-30', startedAt: '2026-11-25T08:00:00Z', id: '123456789012345' };
const col = (s: string, from: number, to: number) => s.slice(from - 1, to);
const line = (name: string, total: number, vatRate = 18) => ({ name, qty: 1, unitPriceExVat: total, discountExVat: 0, totalExVat: total, vatRate, kind: 1 as const });

const receipt: Doc = {
  docType: 400, docNumber: 1, linkNo: 10, issuedAt: '2026-11-10T09:00:00Z', docDate: '2026-11-10', customerName: 'לקוח דמו', issuedBy: '',
  beforeDiscount: 500, discount: 0, afterDiscount: 500, vatAmount: 0, total: 500, lines: [line('תשלום עבור חשבונית מס מס׳ 3', 500, 0)],
  payments: [{ method: 1, amount: 200, date: '2026-11-10', m: 'cash' }, { method: 2, amount: 300, date: '2026-11-10', m: 'cheque', cheque: { bank: '12', branch: '345', account: '000000000000678', number: '1001' } }],
};
const invoice: Doc = {
  ...receipt, docType: 320, docNumber: 7, linkNo: 11, beforeDiscount: 200, afterDiscount: 200, vatAmount: 36, total: 236,
  lines: [line('טיפול', 120), line('קרם', 80)], payments: [{ method: 3, amount: 236, date: '2026-11-10', m: 'card' }],
};
const taxInvoice: Doc = { ...invoice, docType: 305, docNumber: 4, linkNo: 12, payments: [] };

test('a receipt (400) is C100 + D120 only — no D110; a 320 keeps D110 and D120; a 305 D110 only', () => {
  assert.ok(NO_D110.has(400) && NO_D110.has(420) && !NO_D110.has(320) && !NO_D110.has(330));
  const f = buildOpenFormat(biz, sw, [receipt, invoice, taxInvoice], at);
  const recs = f.bkmv.split('\r\n').filter(Boolean);
  const of = (code: string, type: string) => recs.filter((l) => l.startsWith(code) && col(l, 23, 25) === type).length;
  assert.deepEqual([of('C100', '400'), of('D110', '400'), of('D120', '400')], [1, 0, 2]);
  assert.deepEqual([of('C100', '320'), of('D110', '320'), of('D120', '320')], [1, 2, 1]);
  assert.deepEqual([of('C100', '305'), of('D110', '305'), of('D120', '305')], [1, 2, 0]);
  assert.deepEqual(f.counts, { A100: 1, C100: 3, D110: 4, D120: 3, Z900: 1 });
  recs.forEach((l, i) => assert.equal(Number(col(l, 5, 13)), i + 1, 'record numbers still run 1..n'));
  assert.equal(Number(col(recs.at(-1)!, 46, 60)), recs.length, 'Z900 total');
  assert.ok(f.ini.includes('D110' + '4'.padStart(15, '0')) && f.ini.includes('D120' + '3'.padStart(15, '0')));
});

test('only receipts: no D110 at all — no D110 summary in INI; the receipt\'s C100 is the same as before; the document keeps its lines', () => {
  const before = structuredClone(receipt);
  const f = buildOpenFormat(biz, sw, [receipt], at);
  assert.deepEqual(receipt, before);
  assert.equal((f.counts as Record<string, number>).D110, 0);
  assert.ok(!f.ini.includes('D110'), 'no summary line for a record type that is not in the file (§2.5ב)');
  const c = f.bkmv.split('\r\n').find((l) => l.startsWith('C100'))!;
  assert.equal(c, C100(2, biz, receipt), 'C100 written exactly as before');
  assert.equal(col(c, 288, 302), '+00000000050000'); assert.equal(col(c, 348, 362), '+00000000050000');
  const pay = f.bkmv.split('\r\n').filter((l) => l.startsWith('D120')).reduce((a, l) => a + Number(col(l, 105, 118)), 0);
  assert.equal(pay, 50000, 'Σ 1312 = 1223 (the simulator\'s check for 400)');
});

test('the simulator\'s other check stays: for 300 / 305 / 320 / 330, 1219 = Σ 1267 of the D110 lines; the printout unchanged', () => {
  const credit: Doc = { ...taxInvoice, docType: 330, docNumber: 2, linkNo: 13, baseDocType: 305, baseDocNumber: 4 };
  const docs = [receipt, invoice, taxInvoice, credit, { ...invoice, docType: 300, docNumber: 5, linkNo: 14, payments: [] }];
  const recs = buildOpenFormat(biz, sw, docs, at).bkmv.split('\r\n').filter(Boolean);
  for (const t of ['300', '305', '320', '330']) {
    const h = recs.filter((l) => l.startsWith('C100') && col(l, 23, 25) === t).reduce((a, l) => a + Number(col(l, 289, 302)), 0);
    const d = recs.filter((l) => l.startsWith('D110') && col(l, 23, 25) === t).reduce((a, l) => a + Number(col(l, 272, 285)), 0);
    assert.equal(d, h, t);
  }
  assert.equal(docTypeReport(docs, at.from, at.to).find((r) => r.code === 400)!.total, 500);
});
