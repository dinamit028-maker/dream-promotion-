/**
 * B110 (§4.7, p. 16) — one account per customer key of the file, built from the documents (the owner of the system, 25.11.2026,
 * option א; for the accountant's approval). Demo data only (fictitious numbers).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { B110, B110_CODE, accountsOf, buildOpenFormat, customerKeyField, type Doc } from '../src/features/documents/openformat';

const biz = { dealerNumber: '000000109', name: 'עסק דמו' };
const sw = { regNumber: '00000000', name: 'Dream Promotion', version: '2.117.4', vendorVat: '000000109', vendorName: 'Dream Promotion' };
const at = { from: '2026-11-01', to: '2026-11-30', startedAt: '2026-11-25T08:00:00Z', id: '123456789012345' };
const col = (s: string, from: number, to: number) => s.slice(from - 1, to);
const amt = (s: string) => Number(s.slice(1)) * (s[0] === '-' ? -1 : 1) / 100;
const line = (total: number, vatRate = 18) => ({ name: 'שורה', qty: 1, unitPriceExVat: total, discountExVat: 0, totalExVat: total, vatRate, kind: 1 as const });

let n = 0;
const doc = (docType: number, who: { name: string; phone?: string; street?: string; city?: string }, total: number, more: Partial<Doc> = {}): Doc => ({
  docType, docNumber: ++n, linkNo: n, issuedAt: '2026-11-10T09:00:00Z', docDate: '2026-11-10', customerName: who.name, customerPhone: who.phone ?? '',
  customerStreet: who.street ?? '', customerCity: who.city ?? '', issuedBy: '',
  beforeDiscount: total, discount: 0, afterDiscount: total, vatAmount: 0, total, lines: [line(total, 0)],
  payments: docType === 400 || docType === 320 ? [{ method: 1, amount: total, date: '2026-11-10', m: 'cash' }] : [], ...more,
});
const dana = { name: 'דנה דמו', phone: '050-0000001', street: 'רחוב דמו 1', city: 'עיר דמו' };
const yossi = { name: 'יוסי דמו', phone: '050-0000002' };
const docs: Doc[] = [
  doc(305, dana, 1000), doc(300, dana, 500), doc(320, dana, 236),
  doc(400, dana, 1250, { payments: [{ method: 1, amount: 1000, date: '2026-11-10', m: 'cash' }, { method: 9, amount: 250, date: '2026-11-10', m: 'withholding', pct: 20 }] }),
  doc(330, dana, 100, { baseDocType: 305, baseDocNumber: 1 }),
  doc(400, dana, 40, { cancelled: true }),                        // cancelled — not counted
  doc(200, dana, 70),                                             // a delivery note charges nothing
  doc(305, yossi, 300), doc(400, yossi, 300),
  doc(400, { name: 'לקוח מזדמן' }, 50),                            // no phone: the key is the name
];

test('B110 is 376 long, its fields in the spec\'s columns; 1403 = the C100\'s 1225 exactly', () => {
  const [a] = accountsOf(docs);
  const r = B110(2, biz, a);
  assert.equal(r.length, 376);
  assert.equal(col(r, 1, 4), 'B110'); assert.equal(col(r, 5, 13), '000000002'); assert.equal(col(r, 14, 22), '000000109');
  assert.equal(col(r, 23, 37), customerKeyField(docs[0]), '1403 = 1225');
  assert.equal(col(r, 38, 87).trimEnd(), 'דנה דמו');                        // 1404
  assert.equal(col(r, 88, 102).trimEnd(), B110_CODE); assert.equal(col(r, 103, 132).trimEnd(), 'לקוחות'); // 1405, 1406
  assert.equal(col(r, 133, 182).trimEnd(), 'רחוב דמו 1'); assert.equal(col(r, 193, 222).trimEnd(), 'עיר דמו'); // 1407, 1409
  assert.equal(col(r, 278, 292), '+00000000000000', '1414 opening 0');
  assert.equal(col(r, 323, 326), '0000'); assert.equal(col(r, 327, 335), '000000000', '1419 0 (1013 = 0)');
  assert.equal(col(r, 336, 342), ' '.repeat(7), '1421 empty');
});

test('B110 amounts from the documents: debit 300 / 305 / 320; credit 400 (1223 + 1224), 320, 330; cancelled and 200 left out', () => {
  const acc = accountsOf(docs);
  assert.equal(acc.length, 3, 'each customer once');
  const dana_ = acc.find((a) => a.name === 'דנה דמו')!;
  assert.equal(dana_.debitA, (1000 + 500 + 236) * 100);
  assert.equal(dana_.creditA, (236 + 1250 + 100) * 100, '320 paid, 400 = 1000 money + 250 withheld, 330');
  const r = B110(2, biz, dana_);
  assert.equal(amt(col(r, 293, 307)), 1736); assert.equal(amt(col(r, 308, 322)), 1586);
  const y = acc.find((a) => a.name === 'יוסי דמו')!;
  assert.deepEqual([y.debitA, y.creditA], [30000, 30000]);
  assert.deepEqual([acc[2].debitA, acc[2].creditA, acc[2].name], [0, 5000, 'לקוח מזדמן']);
});

test('the whole file: one B110 per key used in C100 1225, each key once, before the documents; INI B110 summary and 1002', () => {
  const f = buildOpenFormat(biz, sw, docs, at);
  const recs = f.bkmv.split('\r\n').filter(Boolean);
  const b110 = recs.filter((l) => l.startsWith('B110'));
  const keys1225 = new Set(recs.filter((l) => l.startsWith('C100')).map((l) => col(l, 375, 389)));
  const keys1403 = b110.map((l) => col(l, 23, 37));
  assert.equal(new Set(keys1403).size, keys1403.length, '1403 unique');
  assert.deepEqual(new Set(keys1403), keys1225, 'every 1225 has its B110, and no other');
  assert.ok(b110.every((l) => l.length === 376));
  assert.deepEqual(recs.slice(1, 4).map((l) => l.slice(0, 4)), ['B110', 'B110', 'B110'], 'after A100');
  recs.forEach((l, i) => assert.equal(Number(col(l, 5, 13)), i + 1));
  assert.equal((f.counts as Record<string, number>).B110, 3);
  const ini = f.ini.split('\r\n').filter(Boolean);
  assert.ok(ini.includes('B110' + '3'.padStart(15, '0')), 'INI summary B110');
  assert.equal(Number(col(ini[0], 10, 24)), recs.length, '1002 = all the records');
  assert.equal(Number(col(recs.at(-1)!, 46, 60)), recs.length, 'Z900');
  assert.equal(col(ini[0], 185, 185), '0', '1013 stays 0');
});

test('two keys cut to the same 15 characters are one account (1403 must be unique)', () => {
  const long = (s: string) => doc(305, { name: `לקוח עם שם ארוך מאוד ${s}` }, 10);
  const acc = accountsOf([long('א'), long('ב')]);
  assert.equal(acc.length, 1);
  assert.equal(acc[0].debitA, 2000);
});

test('no documents in the period — no B110', () => {
  const f = buildOpenFormat(biz, sw, docs, { ...at, from: '2027-01-01', to: '2027-01-31' });
  assert.ok(!f.bkmv.includes('B110') && !f.ini.includes('B110'));
});
