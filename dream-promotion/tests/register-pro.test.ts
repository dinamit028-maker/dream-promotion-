/**
 * Register 2.50: refunds (whole / items / sum, never beyond what was paid), their place in the reports and
 * the close of day, the credit invoice of a refund, stock, commissions and the business-invoice form.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salesCsv, summarize, type Refund, type Sale } from '../src/features/register/money';
import { defaultRefundMethod, planRefund, refundLeft, refundedOf, returnedQty } from '../src/features/register/refunds';
import { cashIn, daySummary, expectedCash } from '../src/features/register/shift';
import { creditForRefund, creditedTotals, docFromSale } from '../src/features/documents/documents';
import { applyStock, lowStockList, planAdjust, stockDeltas, stockLevel, stockText } from '../src/features/register/stock';
import { cleanPct, commissionReport, commissionsCsv } from '../src/features/register/commissions';
import { billingColumns, billingError, validIsraeliId } from '../src/features/register/billing';

const DAY = '2026-10-05';
const S = (p: Partial<Sale> = {}): Sale => ({
  id: 's1', leadId: null, appointmentId: null, customerName: 'דנה', customerPhone: '',
  items: [{ name: 'לייזר', price: 300, qty: 1, itemId: 'svc', kind: 'service' }, { name: 'קרם', price: 100, qty: 2, itemId: 'cream', kind: 'product' }],
  subtotal: 500, discount: 50, total: 450, vatRate: 18, vatAmount: 68.64, method: 'cash', status: 'paid', note: '',
  paidAt: `${DAY}T08:00:00Z`, createdAt: `${DAY}T08:00:00Z`, employeeId: 'E1', employeeName: 'שגית', ...p,
});
const R = (p: Partial<Refund> = {}): Refund => ({ id: 'r1', saleId: 's1', createdAt: `${DAY}T10:00:00Z`, amount: 90, vatAmount: 13.73, method: 'cash', items: [], restock: false, reason: '', employeeName: '', ...p });

// ---------------------------------------------------------------- refunds --
test('refund: whole sale gives back exactly what was paid, VAT inside it', () => {
  const r = planRefund(S(), [], { mode: 'full' }, { method: 'cash', restock: true });
  assert.ok(r.ok);
  assert.equal(r.refund.amount, 450);
  assert.equal(r.refund.vatAmount, 68.64, '450 × 18/118');
  assert.deepEqual(r.refund.items.map((l) => [l.name, l.qty]), [['לייזר', 1], ['קרם', 2]]);
  assert.equal(r.refund.restock, true, 'items with a price-list link can go back to stock');
});

test('refund: chosen items carry their share of the discount; never more than is left', () => {
  const one = planRefund(S(), [], { mode: 'items', qty: [0, 1] }, { method: 'cash' });
  assert.ok(one.ok);
  assert.equal(one.refund.amount, 90, 'a ₪100 cream in a sale with 10% off came to ₪90');
  assert.equal(one.refund.vatAmount, 13.73);
  const prior = [R({ amount: 90, items: [{ name: 'קרם', price: 100, qty: 1, itemId: 'cream', kind: 'product' }] })];
  assert.deepEqual(returnedQty(S(), prior), [0, 1]);
  assert.equal(refundLeft(S(), prior), 360);
  const again = planRefund(S(), prior, { mode: 'items', qty: [0, 5] }, { method: 'cash' });
  assert.ok(again.ok);
  assert.equal(again.refund.items[0].qty, 1, 'only the one cream that was not returned yet');
  const rest = planRefund(S(), prior, { mode: 'items', qty: [1, 1] }, { method: 'cash' });
  assert.ok(rest.ok);
  assert.equal(rest.refund.amount, 360, 'everything that is left — the rounding never leaves an agora behind');
  assert.equal(refundedOf('s1', prior), 90);
});

test('refund: a sum, and the refusals', () => {
  const sum = planRefund(S(), [], { mode: 'amount', amount: 120.5 }, { method: 'card', reason: '  לא הייתה מרוצה  ' });
  assert.ok(sum.ok);
  assert.deepEqual([sum.refund.amount, sum.refund.items.length, sum.refund.restock, sum.refund.reason], [120.5, 0, false, 'לא הייתה מרוצה']);
  assert.deepEqual(planRefund(S(), [], { mode: 'amount', amount: 451 }, { method: 'cash' }), { ok: false, error: 'too_much' });
  assert.deepEqual(planRefund(S(), [], { mode: 'amount', amount: 0 }, { method: 'cash' }), { ok: false, error: 'empty' });
  assert.deepEqual(planRefund(S(), [], { mode: 'items', qty: [0, 0] }, { method: 'cash' }), { ok: false, error: 'empty' });
  assert.deepEqual(planRefund(S({ status: 'pending' }), [], { mode: 'full' }, { method: 'cash' }), { ok: false, error: 'not_paid' });
  assert.deepEqual(planRefund(S(), [R({ amount: 450 })], { mode: 'full' }, { method: 'cash' }), { ok: false, error: 'nothing_left' });
  const exempt = planRefund(S({ vatRate: 0, vatAmount: 0 }), [], { mode: 'full' }, { method: 'cash' });
  assert.ok(exempt.ok); assert.equal(exempt.refund.vatAmount, 0, 'an exempt dealer has no VAT to give back');
});

test('refund: money goes back the way it came', () => {
  assert.equal(defaultRefundMethod(S({ method: 'bit' })), 'bit');
  assert.equal(defaultRefundMethod(S({ method: 'split', payments: [{ method: 'cash', amount: 100 }, { method: 'card', amount: 350 }] })), 'card');
  assert.equal(defaultRefundMethod(S({ method: 'link' })), 'other');
});

test('reports: refunds count on the day they are made, by method; net and VAT go down', () => {
  const sales = [S(), S({ id: 's2', method: 'card', total: 200, subtotal: 200, discount: 0, vatAmount: 30.51, items: [{ name: 'פנים', price: 200, qty: 1 }] })];
  const refunds = [R(), R({ id: 'r2', saleId: 's2', method: 'card', amount: 200, vatAmount: 30.51, createdAt: '2026-10-06T08:00:00Z' })];
  const today = summarize(sales, DAY, DAY, refunds);
  assert.deepEqual([today.total, today.refunds, today.net, today.refundCount], [650, 90, 560, 1]);
  assert.equal(today.vat, 85.42, '68.64 + 30.51 − 13.73');
  assert.deepEqual(today.byMethod.map((m) => [m.method, m.total, m.refunded]), [['cash', 360, 90], ['card', 200, 0]]);
  const next = summarize(sales, '2026-10-06', '2026-10-06', refunds);
  assert.deepEqual([next.total, next.refunds, next.net], [0, 200, -200], 'a refund the next day lowers that day');
  assert.deepEqual(summarize(sales, DAY, DAY).refunds, 0, 'without refunds nothing changes');
  const csv = salesCsv(sales, DAY, '2026-10-06', refunds);
  assert.match(csv, /"-90\.00","-13\.73","מזומן","החזר"/);
  assert.equal(csv.split('\r\n').length, 5, 'header + 2 sales + 2 refunds');
});

test('close of day: cash refunds leave the drawer the day they are made', () => {
  const sales = [S()];
  assert.equal(cashIn(sales, DAY, [R()]), 360);
  assert.equal(expectedCash(500, sales, DAY, [R(), R({ id: 'r9', method: 'card', amount: 50 })]), 860, 'a card refund does not touch the drawer');
  const d = daySummary({ sales, docs: [], day: DAY, openingCash: 500, refunds: [R()] });
  assert.deepEqual([d.cashIn, d.cashRefunds, d.expectedCash, d.net], [360, 90, 860, 360]);
});

// ---------------------------------------------------------------- credit invoice of a refund --
test('credit invoice of a refund: part = the returned items, agorot-exact; whole = mirror of the original', () => {
  const sale = S();
  const orig = { ...docFromSale(sale, { licensed: true, docDate: DAY }), docNumber: 7, linkNo: 1, issuedAt: `${DAY}T08:00:00Z` };
  const part = planRefund(sale, [], { mode: 'items', qty: [0, 1] }, { method: 'cash' });
  assert.ok(part.ok);
  const c = creditForRefund(orig, part.refund, sale, DAY);
  assert.deepEqual([c.docType, c.baseDocType, c.baseDocNumber, c.total, c.vatAmount], [330, 320, 7, 90, 13.73]);
  assert.equal(c.afterDiscount, 76.27);
  assert.equal(Math.round(c.lines.reduce((a, l) => a + l.totalExVat, 0) * 100), 7627, 'lines add up to the amount before VAT');
  assert.deepEqual(c.payments, []);
  const sum = creditForRefund(orig, { amount: 50, vatAmount: 7.63, items: [] }, sale, DAY);
  assert.match(sum.lines[0].name, /החזר חלקי — חשבונית מס \/ קבלה מס׳ 7/);
  assert.equal(sum.lines[0].totalExVat, 42.37);
  const whole = creditForRefund(orig, { amount: 450, vatAmount: 68.64, items: sale.items }, sale, DAY);
  assert.deepEqual([whole.total, whole.lines.length, whole.discount], [450, 2, orig.discount], 'the whole document = its mirror');
  assert.throws(() => creditForRefund({ ...orig, docType: 400 }, part.refund, sale, DAY), /tax invoices only/);
  const credited = creditedTotals([{ docType: 330, total: 90, baseDocType: 320, baseDocNumber: 7 }, { docType: 330, total: 50, baseDocType: 320, baseDocNumber: 7 }, { docType: 320, total: 450, baseDocType: null, baseDocNumber: null }]);
  assert.equal(credited.get('320:7'), 140);
});

test('a business invoice: the document carries the name, number and address', () => {
  const d = docFromSale(S({ billingName: 'סלון דנה בע״מ', customerDealer: '520013954', customerStreet: 'הרצל 5', customerCity: 'חולון' }), { licensed: true, docDate: DAY });
  assert.deepEqual([d.customerName, d.customerDealer, d.customerStreet, d.customerCity], ['סלון דנה בע״מ', '520013954', 'הרצל 5', 'חולון']);
  assert.equal(docFromSale(S(), { licensed: true, docDate: DAY }).customerName, 'דנה', 'no business details = the customer, as before');
});

// ---------------------------------------------------------------- stock --
test('stock: a sale takes units out, a return puts them back, alerts by threshold', () => {
  const items = [
    { id: 'cream', name: 'קרם', trackStock: true, stockQty: 3, lowStock: 2 },
    { id: 'svc', name: 'לייזר', trackStock: false, stockQty: 0, lowStock: 0 },
    { id: 'oil', name: 'שמן', trackStock: true, stockQty: 10, lowStock: 2 },
  ];
  const lines = [{ itemId: 'cream', qty: 2 }, { itemId: 'svc', qty: 1 }, { itemId: 'cream', qty: 1 }, { qty: 4 }];
  assert.deepEqual([...stockDeltas(lines).entries()], [['cream', 3], ['svc', 1]], 'free amounts have no item');
  const after = applyStock(items, lines);
  assert.deepEqual(after.map((i) => i.stockQty), [0, 0, 10], 'an item without stock tracking never moves');
  assert.deepEqual(applyStock(after, [{ itemId: 'cream', qty: 1 }], -1).map((i) => i.stockQty), [1, 0, 10]);
  assert.equal(stockLevel(after[0]), 'out'); assert.equal(stockLevel({ trackStock: true, stockQty: 2, lowStock: 2 }), 'low'); assert.equal(stockLevel(items[1]), 'ok');
  assert.deepEqual(lowStockList([...after, { id: 'x', name: 'מסכה', trackStock: true, stockQty: 1, lowStock: 3 }]).map((i) => i.name), ['קרם', 'מסכה']);
  assert.equal(stockText({ trackStock: true, stockQty: -1, lowStock: 2 }), 'חסר במלאי (-1)');
  assert.equal(stockText({ trackStock: true, stockQty: 1, lowStock: 2 }), 'נשארה יחידה אחת');
  assert.equal(stockText({ trackStock: true, stockQty: 9, lowStock: 2 }), 'במלאי 9');
  assert.deepEqual(planAdjust(3, 'add', 12), { ok: true, delta: 12, after: 15 });
  assert.deepEqual(planAdjust(3, 'set', 1), { ok: true, delta: -2, after: 1 });
  assert.equal(planAdjust(3, 'add', 0).ok, false); assert.equal(planAdjust(3, 'set', -1).ok, false); assert.equal(planAdjust(3, 'set', 1.5).ok, false);
});

// ---------------------------------------------------------------- commissions --
test('commissions: before VAT, after discount, split treatments / products, refunds of the month taken off', () => {
  const emps = [{ id: 'E1', name: 'שגית', servicePct: 30, productPct: 10 }, { id: 'E2', name: 'נועה', servicePct: 20, productPct: 5 }];
  const sales = [
    S(),                                                                                    // 450 incl. VAT → 381.36 before VAT
    S({ id: 's2', employeeId: 'E2', employeeName: 'נועה', items: [{ name: 'קרם', price: 118, qty: 1, kind: 'product' }], subtotal: 118, discount: 0, total: 118, vatAmount: 18 }),
    S({ id: 's3', employeeId: null, employeeName: '', total: 59, subtotal: 59, discount: 0, vatAmount: 9, items: [{ name: 'גבות', price: 59, qty: 1 }] }),
    S({ id: 's4', paidAt: '2026-09-30T08:00:00Z', createdAt: '2026-09-30T08:00:00Z' }),  // September — not this month
    S({ id: 's5', status: 'pending', paidAt: null }),                                        // not paid
  ];
  const rep = commissionReport(sales, [R({ amount: 90, vatAmount: 13.73, items: [{ name: 'קרם', price: 100, qty: 1, kind: 'product' }] })], emps, '2026-10');
  const sagit = rep.rows.find((r) => r.employeeId === 'E1')!;
  // 381.36 split by gross 300 : 200 → 228.82 treatments, 152.54 products; minus the returned cream 76.27
  assert.deepEqual(sagit.base, { service: 228.82, product: 76.27 });
  assert.equal(sagit.commission, 76.28, '30% × 228.82 = 68.65, 10% × 76.27 = 7.63 (each part rounded to the agora)');
  assert.deepEqual([sagit.sales, sagit.gross, sagit.refunds], [1, 450, 90]);
  const noa = rep.rows.find((r) => r.employeeId === 'E2')!;
  assert.deepEqual([noa.base.product, noa.commission], [100, 5]);
  const none = rep.rows.find((r) => r.employeeId === null)!;
  assert.deepEqual([none.name, none.commission, none.base.service], ['ללא מוכר/ת', 0, 50]);
  assert.equal(rep.rows[rep.rows.length - 1].employeeId, null, 'sales without a seller come last');
  assert.deepEqual(rep.totals, { sales: 3, gross: 627, refunds: 90, commission: 81.28 });
  assert.match(commissionsCsv(rep.rows, '2026-10'), /"2026-10","שגית","1","450\.00","90\.00","228\.82","30","76\.27","10","76\.28"/);
  assert.deepEqual([cleanPct('12.345'), cleanPct(150), cleanPct(-3), cleanPct('x')], [12.35, 100, 0, 0]);
});

test('commissions: lines saved before 2.50 (no kind) are resolved by the price list', () => {
  const sale = S({ items: [{ name: 'קרם', price: 118, qty: 1 }], subtotal: 118, discount: 0, total: 118, vatAmount: 18 });
  const rep = commissionReport([sale], [], [{ id: 'E1', name: 'שגית', servicePct: 30, productPct: 10 }], '2026-10', (l) => (l.name === 'קרם' ? 'product' : l.kind));
  assert.deepEqual(rep.rows[0].base, { service: 0, product: 100 });
  assert.equal(rep.rows[0].commission, 10);
});

// ---------------------------------------------------------------- business invoice --
test('dealer / company number: 9 digits with the Israeli check digit', () => {
  assert.ok(validIsraeliId('520013954'), 'a real company number (ח.פ)');
  assert.ok(validIsraeliId('000000018'));
  assert.ok(!validIsraeliId('520013955'), 'one digit off');
  assert.ok(!validIsraeliId('000000000'));
  assert.ok(!validIsraeliId('1234567890'));
  assert.equal(billingError({ name: 'סלון', dealer: '520013954', street: '', city: '' }), null);
  assert.match(billingError({ name: '', dealer: '520013954', street: '', city: '' })!, /שם/);
  assert.match(billingError({ name: 'סלון', dealer: '5200', street: '', city: '' })!, /9 ספרות/);
  assert.match(billingError({ name: 'סלון', dealer: '520013955', street: '', city: '' })!, /לא תקין/);
  assert.deepEqual(billingColumns({ name: ' סלון ', dealer: '52-0013954', street: 'הרצל 5', city: 'חולון' }),
    { billing_name: 'סלון', customer_dealer: '520013954', customer_street: 'הרצל 5', customer_city: 'חולון' });
  assert.deepEqual(billingColumns(null), { billing_name: '', customer_dealer: '', customer_street: '', customer_city: '' });
});
