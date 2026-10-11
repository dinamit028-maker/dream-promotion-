/**
 * An order, a delivery note and a return note (2.95, docs/FINANCE_ADDITIONS_HE.md T10): the documents made from them — all of it
 * exactly as it was, part of it to the agora — what is left of each line, where a document stands, the line naming its base on the
 * printed document, the composer's rules, and the unified file (the type of each, and the base in fields 1256/1257).
 * The database checks the same (tests/sql/cash-bank.check.sql).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docFromBase, goodsState, isGoods, leftOf, madeFrom, type BaseDoc } from '../src/features/finance/goods';
import { composeDocument, docInvariants } from '../src/features/finance/compose';
import { DOC_INFO, goodsDocTypes } from '../src/features/finance/rules';
import { DOC_LABEL, baseDocLine, totalLabel } from '../src/features/documents/documents';
import { DOC_TYPES, buildOpenFormat, type Doc, type DocLine } from '../src/features/documents/openformat';

const L = (name: string, qty: number, total: number, more: Partial<DocLine> = {}): DocLine =>
  ({ name, qty, unitPriceExVat: Math.round((total / qty) * 100) / 100, discountExVat: 0, totalExVat: total, vatRate: 18, kind: 1, ...more });
/** a delivery note of a VAT shop: 3 creams (VAT-inclusive ₪100 each → 254.24 before VAT), a robe of size M, wrapping; ₪20 off */
const DN: BaseDoc = {
  docType: 200, docNumber: 7, customerName: 'דנה כהן', customerPhone: '0501234567', customerDealer: '', lines: [
    L('קרם', 3, 254.24, { itemId: 'cream' }), L('חלוק', 1, 169.49, { itemId: 'robe', variantId: 'M' }), L('אריזה', 1, 8.47),
  ], beforeDiscount: 432.2, discount: 16.95, afterDiscount: 415.25, vatAmount: 74.75, total: 490,
};
const opts = { entity: 'company' as const, vatRate: 18, docDate: '2026-10-11', today: '2026-10-11' };

test('what is made from what: an order → a delivery note or an invoice; a delivery note → an invoice or a return note', () => {
  assert.deepEqual(madeFrom(100, 'company'), [200, 305, 320]);
  assert.deepEqual(madeFrom(200, 'company'), [305, 320, 210]);
  assert.deepEqual(madeFrom(200, 'exempt_dealer'), [300, 210], 'an exempt dealer invoices with a transaction invoice');
  assert.deepEqual(madeFrom(210, 'company'), [], 'nothing from a return note');
  assert.deepEqual(madeFrom(305, 'company'), [], 'nor from an invoice (a credit invoice has its own way)');
  assert.ok(isGoods(100) && isGoods(200) && isGoods(210) && !isGoods(305));
});

test('the invoice in one click: all of the delivery note — its lines, discount, VAT and total exactly, naming it', () => {
  const r = docFromBase(DN, [3, 1, 1], { ...opts, docType: 305, dueDate: '2026-11-10' });
  assert.ok(r.ok);
  const d = r.doc;
  assert.deepEqual([d.beforeDiscount, d.discount, d.afterDiscount, d.vatAmount, d.total], [432.2, 16.95, 415.25, 74.75, 490], 'the same money to the agora');
  assert.equal(d.baseDocType, 200); assert.equal(d.baseDocNumber, 7);
  assert.deepEqual(d.lines.map((l) => [l.name, l.qty, l.totalExVat, l.itemId ?? null, l.variantId ?? null]),
    [['קרם', 3, 254.24, 'cream', null], ['חלוק', 1, 169.49, 'robe', 'M'], ['אריזה', 1, 8.47, null, null]]);
  assert.equal(d.customerName, 'דנה כהן'); assert.equal(d.dueDate, '2026-11-10'); assert.deepEqual(d.payments, []);
  assert.deepEqual(docInvariants(d, 18), [], 'what the database checks holds');
});

test('part of it: each line\'s share, the discount\'s share, the VAT of what is left — to the agora', () => {
  const r = docFromBase(DN, [2, 0, 1], { ...opts, docType: 305 });
  assert.ok(r.ok);
  const d = r.doc;
  assert.deepEqual(d.lines.map((l) => [l.name, l.qty, l.totalExVat]), [['קרם', 2, 169.49], ['אריזה', 1, 8.47]], 'two creams of three: 254.24 × 2/3');
  assert.equal(d.beforeDiscount, 177.96);
  assert.equal(d.discount, 6.98, 'the discount\'s share: 16.95 × 177.96 / 432.20');
  assert.equal(d.afterDiscount, 170.98); assert.equal(d.vatAmount, 30.78); assert.equal(d.total, 201.76);
  assert.deepEqual(docInvariants(d, 18), []);
  const ret = docFromBase(DN, [1, 1, 0], { ...opts, docType: 210 });
  assert.ok(ret.ok && ret.doc.docType === 210 && ret.doc.baseDocType === 200 && ret.doc.payments.length === 0, 'a return note: no payments, its base');
  assert.deepEqual(docInvariants(ret.ok ? ret.doc : ({} as any), 18), []);
});

test('what is left on a delivery note after its return notes — a product by item and size, any other line by its name', () => {
  const back = [{ lines: [L('קרם', 1, 84.75, { itemId: 'cream' })] }, { lines: [L('חלוק', 1, 169.49, { itemId: 'robe', variantId: 'L' })] }, { lines: [L('אריזה', 1, 8.47)] }];
  assert.deepEqual(leftOf(DN, back), [2, 1, 0], 'a robe of another size did not come back from this note');
  assert.deepEqual(leftOf(DN, []), [3, 1, 1]);
  const r = docFromBase(DN, [2, 1, 1], { ...opts, docType: 305, left: [2, 1, 0] });
  assert.ok(!r.ok && /בין 0 למה שנשאר/.test(r.errors.join()), 'never more than is left');
  const ok = docFromBase(DN, [2, 1, 0], { ...opts, docType: 320, left: [2, 1, 0], payments: [{ method: 'card', amount: 0, date: '2026-10-11' }] });
  assert.ok(!ok.ok && /סכום/.test(ok.errors.join()), 'an invoice-receipt says how it was paid — all of it');
  const half = docFromBase(DN, [2, 1, 0], { ...opts, docType: 305, left: [2, 1, 0] });
  assert.ok(half.ok);
  const paid = docFromBase(DN, [2, 1, 0], { ...opts, docType: 320, left: [2, 1, 0], payments: [{ method: 'card', amount: half.ok ? half.doc.total : 0, date: '2026-10-11' }] });
  assert.ok(paid.ok && paid.doc.payments[0].method === 3, 'paid by card: field 1306 = 3');
});

test('what a base document may not make, and an exempt dealer\'s documents (no VAT)', () => {
  assert.ok(!docFromBase({ ...DN, docType: 100 }, [1, 0, 0], { ...opts, docType: 210 }).ok, 'no return note from an order');
  assert.ok(!docFromBase(DN, [0, 0, 0], { ...opts, docType: 305 }).ok, 'nothing chosen');
  assert.ok(!docFromBase(DN, [1, 0, 0], { ...opts, docType: 305, docDate: '2026-10-12' }).ok, 'not dated tomorrow');
  assert.ok(!docFromBase(DN, [1, 0, 0], { ...opts, docType: 305, dueDate: '2026-10-01' }).ok, 'not due before it is issued');
  const ex = docFromBase({ ...DN, lines: DN.lines.map((l) => ({ ...l, vatRate: 0 })), vatAmount: 0, total: 415.25 }, [3, 1, 1],
    { ...opts, entity: 'exempt_dealer', docType: 300 });
  assert.ok(ex.ok && ex.doc.vatAmount === 0 && ex.doc.total === 415.25 && ex.doc.lines.every((l) => l.vatRate === 0));
  const rate = docFromBase(DN, [3, 1, 1], { ...opts, docType: 305, vatRate: 17 });
  assert.ok(rate.ok && rate.doc.vatAmount === 70.59, 'the rate changed since the note: the VAT of the day (415.25 × 17%)');
});

test('where an order and a delivery note stand: what was made from them, what is left (a cancelled one does not count)', () => {
  const order = { docType: 100, lines: [L('קרם', 5, 423.73, { itemId: 'cream' })] };
  const s = goodsState(order, [
    { docType: 200, docNumber: 1, lines: [L('קרם', 2, 169.49, { itemId: 'cream' })] },
    { docType: 200, docNumber: 2, lines: [L('קרם', 1, 84.75, { itemId: 'cream' })], cancelled: true },
    { docType: 305, docNumber: 9, lines: [L('קרם', 1, 84.75, { itemId: 'cream' })] },
  ]);
  assert.deepEqual(s.left, [2], 'five ordered, two delivered, one invoiced from the order');
  assert.deepEqual(s.deliveries, [{ docNumber: 1 }]); assert.deepEqual(s.invoices, [{ docType: 305, docNumber: 9 }]);
  const n = goodsState({ docType: 200, lines: DN.lines }, [{ docType: 210, docNumber: 4, lines: [L('קרם', 1, 84.75, { itemId: 'cream' })] }]);
  assert.deepEqual(n.left, [2, 1, 1]); assert.deepEqual(n.returns, [{ docNumber: 4 }]); assert.deepEqual(n.invoices, []);
});

test('the printed document names its base; the totals have the right name; the labels and the composer', () => {
  assert.equal(baseDocLine({ docType: 330, baseDocType: 305, baseDocNumber: 12 }), 'זיכוי עבור חשבונית מס מס׳ 12');
  assert.equal(baseDocLine({ docType: 305, baseDocType: 200, baseDocNumber: 7 }), 'על פי תעודת משלוח מס׳ 7');
  assert.equal(baseDocLine({ docType: 200, baseDocType: 100, baseDocNumber: 3 }), 'על פי הזמנה מס׳ 3');
  assert.equal(baseDocLine({ docType: 210, baseDocType: 200, baseDocNumber: 7 }), 'החזרה על תעודת משלוח מס׳ 7');
  assert.equal(baseDocLine({ docType: 305 }), '');
  assert.deepEqual([totalLabel(100), totalLabel(200), totalLabel(210), totalLabel(305), totalLabel(330), totalLabel(320)],
    ['סה״כ הזמנה', 'סה״כ', 'סה״כ החזרה', 'סה״כ לתשלום', 'סה״כ זיכוי', 'סה״כ שולם']);
  for (const t of [100, 200, 210]) { assert.equal(DOC_LABEL[t], DOC_TYPES[t], `${t}: the unified file's own name`); assert.equal(DOC_INFO[t].tax, false); }
  assert.deepEqual(goodsDocTypes(true), [100, 200]); assert.deepEqual(goodsDocTypes(false), []);
  const input = { entity: 'company' as const, vatRate: 18, pricesIncludeVat: true, lines: [{ name: 'קרם', qty: 2, unitPrice: 100, itemId: 'cream' }],
    customer: { name: 'דנה' }, docDate: '2026-10-11', today: '2026-10-11' };
  assert.ok(!composeDocument({ ...input, docType: 200 }).ok, 'off: no delivery note');
  const dn = composeDocument({ ...input, docType: 200, goods: true });
  assert.ok(dn.ok && dn.doc.vatAmount === 30.51 && dn.doc.total === 200 && dn.doc.payments.length === 0 && dn.doc.dueDate === null, 'a delivery note: VAT shown, no payments');
  assert.ok(!composeDocument({ ...input, docType: 200, goods: true, customer: { name: '' } }).ok, 'a delivery note names its customer');
  assert.ok(!composeDocument({ ...input, docType: 210, goods: true }).ok, 'a return note is made from its delivery note only');
});

test('the unified file: a delivery note is type 200, an order 100, a return note 210 — and an invoice names its note (1256/1257)', () => {
  const doc = (docType: number, docNumber: number, base: [number, number] | null): Doc => ({
    docType, docNumber, linkNo: docNumber, issuedAt: '2026-10-11T08:00:00Z', docDate: '2026-10-11', customerName: 'דנה', beforeDiscount: 100, discount: 0, afterDiscount: 100,
    vatAmount: 18, total: 118, baseDocType: base?.[0] ?? null, baseDocNumber: base?.[1] ?? null, lines: [L('קרם', 1, 100, { itemId: 'cream' })], payments: [],
  });
  const f = buildOpenFormat({ dealerNumber: '514000004', name: 'חנות' }, { regNumber: '0', name: 'Dream', version: '2.95', vendorVat: '0', vendorName: 'Dream' },
    [doc(100, 1, null), doc(200, 1, [100, 1]), doc(210, 1, [200, 1]), doc(305, 1, [200, 1])], { from: '2026-10-01', to: '2026-10-31', startedAt: '2026-10-11T08:00:00Z', id: '123456789012345' });
  const recs = f.bkmv.split('\r\n').filter(Boolean);
  assert.deepEqual(recs.filter((r) => r.startsWith('C100')).map((r) => r.slice(22, 25)), ['100', '200', '210', '305'], 'each in its own type');
  const d110 = recs.filter((r) => r.startsWith('D110'));
  assert.deepEqual(d110.map((r) => [r.slice(22, 25), r.slice(49, 52), r.slice(52, 72).trim()]),
    [['100', '000', ''], ['200', '100', '1'], ['210', '200', '1'], ['305', '200', '1']], 'the base of each line: fields 1256 / 1257');
  assert.equal((f.counts as Record<string, number>).D120, 0, 'no payments on any of them');
});
