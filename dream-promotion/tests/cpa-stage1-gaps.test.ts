/**
 * Gaps found by QA of 2.118.0 (stage 1 of the accountant's answers), in addition to tests/cpa-rules-stage1.test.ts:
 *  - the date rule at every hour of the Israeli day around midnight (00:00–03:00, winter and summer, DST switch days): the Israeli
 *    day is accepted, the UTC day — when it differs — is refused
 *  - a refund receipt can never exceed the receipt: agorot-exact, floating-point sums (0.1 + 0.2), many partial refunds, a refund of a refund
 *  - an old database (no kind column / no deductions column): card payments of the code still carry their kind and a business without a
 *    deductions file keeps 0 in field 1016, an invalid one too
 * Demo data only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { israelParts } from '../src/lib/il-time';
import { docFromSale, isRefundReceipt, refundLeft, refundReceiptFor } from '../src/features/documents/documents';
import { deductionsFileField, type Doc } from '../src/features/documents/openformat';
import { composeDocument, composeRefundReceipt, docDateErrors, docInvariants } from '../src/features/finance/compose';

const line = { name: 'טיפול', qty: 1, unitPriceExVat: 200, discountExVat: 0, totalExVat: 200, vatRate: 0, kind: 1 as const };
const receipt = (total: number, n = 1): Doc => ({
  docType: 400, docNumber: n, docDate: '2026-11-25', customerName: 'לקוחה דמו', customerPhone: '', customerDealer: '', customerStreet: '', customerCity: '',
  beforeDiscount: total, discount: 0, afterDiscount: total, vatAmount: 0, total, issuedBy: '', lines: [{ ...line, unitPriceExVat: total, totalExVat: total }],
  payments: [{ method: 1, amount: total, date: '2026-11-25', m: 'cash' }],
} as any);
const today = '2026-11-25';
const refundDoc = (base: Doc, amount: number) => ({ docType: 400, total: -amount, baseDocType: 400, baseDocNumber: base.docNumber });

test('midnight edge: every 10 minutes from 21:00 UTC to 02:00 UTC, winter, summer and the DST switch days — the Israeli day passes, the UTC day does not (when they differ)', () => {
  const base = { docType: 305, entity: 'licensed_dealer' as const, vatRate: 18, pricesIncludeVat: true, lines: [{ name: 'טיפול', qty: 1, unitPrice: 118 }], customer: { name: 'לקוחה דמו' } };
  for (const day of ['2026-01-15', '2026-07-15', '2026-03-26', '2026-03-27', '2026-10-24', '2026-10-25', '2026-12-31', '2026-02-28']) {
    for (let m = -180; m <= 300; m += 10) {   // 21:00 of `day` (UTC) … 05:00 next day
      const at = Date.parse(`${day}T21:00:00Z`) + m * 60_000 + 180 * 60_000;
      const il = israelParts(at).date;
      const utc = new Date(at).toISOString().slice(0, 10);
      const now = { ...base, docDate: il, today: il };
      assert.ok(composeDocument(now).ok, `${new Date(at).toISOString()}: Israel's day ${il} is accepted`);
      assert.deepEqual(docDateErrors(il, il), []);
      if (utc !== il) {
        const r = composeDocument({ ...base, docDate: utc, today: il });
        assert.ok(!r.ok, `${new Date(at).toISOString()}: the UTC day ${utc} is refused when Israel is on ${il}`);
        // UTC day is behind Israel's (21:00–24:00 UTC) → "the day of issue" message; never "in the future"
        assert.ok(utc < il && /יום ההפקה/.test(r.ok ? '' : r.errors.join()));
      }
      // yesterday (Israel) is always refused; tomorrow (Israel) too
      assert.ok(!composeDocument({ ...base, docDate: new Date(Date.parse(`${il}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10), today: il }).ok);
      assert.ok(!composeDocument({ ...base, docDate: new Date(Date.parse(`${il}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10), today: il }).ok);
    }
  }
});

test('a refund receipt never exceeds the receipt — one agora over is refused, sums are agorot-exact (0.1 + 0.2), partial refunds add up to exactly the total', () => {
  const base = receipt(0.3);
  const pay = (amount: number) => [{ method: 'cash' as const, amount, date: today }];
  assert.ok(composeRefundReceipt(base, { entity: 'exempt_dealer', left: 0.3, payments: [...pay(0.1), ...pay(0.2)], docDate: today, today }).ok, '0.1 + 0.2 is exactly 0.30');
  assert.ok(!composeRefundReceipt(base, { entity: 'exempt_dealer', left: 0.3, payments: pay(0.31), docDate: today, today }).ok, 'one agora over');
  assert.ok(!composeRefundReceipt(base, { entity: 'exempt_dealer', left: 0.3, payments: [...pay(0.1), ...pay(0.21)], docDate: today, today }).ok);
  // 7 partial refunds (6 x 33.33 + 50.02) on 250 → left is agorot-exact, never negative
  const big = receipt(250);
  const done: any[] = [];
  let left = refundLeft(big, done);
  assert.equal(left, 250);
  for (const a of [33.33, 33.33, 33.33, 33.33, 33.33, 33.33, 50.02]) {
    const r = composeRefundReceipt(big, { entity: 'exempt_dealer', left, payments: pay(a), docDate: today, today });
    assert.ok(r.ok, `refund of ${a} with ${left} left`);
    done.push(refundDoc(big, a)); left = refundLeft(big, done);
  }
  assert.equal(left, 0, 'all given back, to the agora');
  assert.ok(!composeRefundReceipt(big, { entity: 'exempt_dealer', left, payments: pay(0.01), docDate: today, today }).ok, 'nothing left: even an agora is refused');
  // refundLeft counts only refund receipts of THIS receipt number, never another's, and never below zero even with an over-refunded history
  assert.equal(refundLeft(big, [refundDoc(receipt(250, 2), 100)]), 250);
  assert.equal(refundLeft(big, [refundDoc(big, 300)]), 0);
});

test('a refund receipt is not a base for another refund, and a negative receipt can not be refunded; builders throw on non-positive input', () => {
  const base = receipt(100);
  const neg = refundReceiptFor(base, { payments: [{ method: 1, amount: 40 }], docDate: today }) as any;
  assert.ok(isRefundReceipt(neg));
  assert.equal(refundLeft({ ...neg, docNumber: 2 }, []), 0, 'a negative receipt has nothing to refund');
  assert.throws(() => refundReceiptFor({ ...neg, docNumber: 2 }, { payments: [{ method: 1, amount: 10 }], docDate: today }));
  assert.throws(() => refundReceiptFor(base, { payments: [{ method: 1, amount: -10 }], docDate: today }), 'a payment below zero is the builder\'s own job');
  assert.throws(() => refundReceiptFor(base, { payments: [{ method: 1, amount: 0 }], docDate: today }));
  assert.ok(!composeRefundReceipt({ ...neg, docNumber: 2 }, { entity: 'exempt_dealer', left: 40, payments: [{ method: 'cash', amount: 10, date: today }], docDate: today, today }).ok);
  assert.ok(!composeRefundReceipt(base, { entity: 'licensed_dealer', left: 100, payments: [{ method: 'cash', amount: 10, date: today }], docDate: today, today }).ok, 'a VAT business credits (330)');
  assert.ok(!composeRefundReceipt(base, { entity: 'exempt_dealer', left: 100, payments: [{ method: 'withholding', amount: 10, date: today, pct: 5 }], docDate: today, today }).ok);
  // invariants: payments above zero on a refund receipt, or a refund receipt with VAT / a discount, are caught
  assert.deepEqual(docInvariants(neg as any, 0), []);
  assert.ok(docInvariants({ ...neg, payments: [{ ...neg.payments[0], amount: 40 }] } as any, 0).length > 0);
  assert.ok(docInvariants({ ...neg, vatAmount: 1, total: -39 } as any, 0).length > 0);
});

test('old database: the code sends a card kind in every card payment of a sale; an old DB ignores it. No deductions column → field 1016 stays 0', () => {
  const sale = { items: [{ name: 'קרם', price: 100, qty: 1 }], discount: 0, total: 100, vatAmount: 0, vatRate: 0, method: 'card' as const, customerName: 'x', customerPhone: '', payments: [] };
  const d = docFromSale(sale as any, { licensed: false, docDate: today });
  assert.deepEqual(d.payments.map((p: any) => [p.method, p.cardKind]), [[3, 1]]);
  const cash = docFromSale({ ...sale, method: 'cash' } as any, { licensed: false, docDate: today });
  assert.ok(cash.payments.every((p: any) => !('cardKind' in p)), 'no kind on cash');
  const split = docFromSale({ ...sale, method: 'split', payments: [{ method: 'card', amount: 60 }, { method: 'cash', amount: 40 }] } as any, { licensed: false, docDate: today });
  assert.deepEqual(split.payments.map((p: any) => [p.method, p.cardKind ?? null]), [[3, 1], [1, null]]);
  // an old register_settings row (no deductions_file column) → undefined / null / '' / not 9 digits / spaces: always 0
  for (const v of [undefined, null, '', '  ', '12345', '1234567890', 'abcdefghi', '0000000 26']) assert.equal(deductionsFileField({ deductionsFile: v as any }), 0, `"${v}"`);
  assert.equal(deductionsFileField({ deductionsFile: ' 000000026 ' }), '000000026');
  assert.equal(deductionsFileField({} as any), 0);
});
