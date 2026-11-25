/** 2.117.4 — a cheque's bank, branch and account are required (fields 1307–1310, "חמ — בהמחאה בלבד", spec §4.5 p. 14; the simulator
 *  refused a branch of 0, 25.11.2026). New documents only. Demo numbers only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chequeErrors, EMPTY_CHEQUE } from '../src/features/finance/payments';
import { composeDocument } from '../src/features/finance/compose';
import { D120, type Doc } from '../src/features/documents/openformat';

const full = { bank: '12', branch: '345', account: '678', number: '1001', dueDate: '2026-12-01' };

test('each missing field has its own Hebrew line; zeros only count as missing; a full cheque is fine', () => {
  assert.deepEqual(chequeErrors(full), []);
  assert.deepEqual(chequeErrors({ ...EMPTY_CHEQUE }), ['מספר הצ׳ק — ספרות בלבד', 'מספר הבנק — חובה בצ׳ק', 'מספר הסניף — חובה בצ׳ק', 'מספר החשבון — חובה בצ׳ק']);
  assert.deepEqual(chequeErrors({ ...full, branch: '000' }), ['מספר הסניף — חובה בצ׳ק']);
  assert.deepEqual(chequeErrors({ ...full, account: '' }), ['מספר החשבון — חובה בצ׳ק']);
  assert.deepEqual(chequeErrors({ ...full, bank: '1234', branch: '123456' }), ['מספר הבנק — עד 3 ספרות', 'מספר הסניף — עד 5 ספרות']);
  assert.deepEqual(chequeErrors(undefined).length, 4);
});

test('a receipt with a cheque without a branch is not issued — every missing field is listed', () => {
  const base = { docType: 400, entity: 'exempt_dealer' as const, vatRate: 0, pricesIncludeVat: true, lines: [{ name: 'שירות', qty: 1, unitPrice: 100 }],
    customer: { name: 'לקוח דמו' }, docDate: '2026-11-25', today: '2026-11-25' };
  const bad = composeDocument({ ...base, payments: [{ method: 'cheque', amount: 100, date: '2026-11-25', cheque: { ...full, branch: '', account: '' } }] });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.errors.includes('מספר הסניף — חובה בצ׳ק') && bad.errors.includes('מספר החשבון — חובה בצ׳ק'));
  const ok = composeDocument({ ...base, payments: [{ method: 'cheque', amount: 100, date: '2026-11-25', cheque: full }] });
  assert.ok(ok.ok);
});

test('a document already issued with a cheque without a branch is written as it is (never changed)', () => {
  const old: Doc = { docType: 400, docNumber: 3, linkNo: 3, issuedAt: '2026-10-01T09:00:00Z', docDate: '2026-10-01', customerName: 'לקוח דמו',
    beforeDiscount: 100, discount: 0, afterDiscount: 100, vatAmount: 0, total: 100, lines: [],
    payments: [{ method: 2, amount: 100, date: '2026-10-01', m: 'cheque', cheque: { number: '5' } }] };
  const r = D120(2, { dealerNumber: '000000109', name: 'עסק דמו' }, old, old.payments[0], 1);
  assert.equal(r.length, 222); assert.equal(r.slice(60, 70), '0000000000', '1308 as the document has it');
});
