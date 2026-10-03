import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSale, salesCsv, summarize, type Sale } from '../src/features/register/money';

const lic = { type: 'licensed' as const, rate: 18 }, ex = { type: 'exempt' as const, rate: 18 };

test('register: totals, discount and VAT in agorot', () => {
  const r = computeSale([{ name: 'לייזר', price: 250, qty: 1 }, { name: 'קרם', price: 89.9, qty: 2 }], { kind: 'sum', value: 0 }, lic);
  assert.equal(r.subtotal, 429.8); assert.equal(r.total, 429.8);
  assert.equal(r.vatAmount, 65.56, '429.80 × 18/118'); assert.equal(r.beforeVat, 364.24);
  assert.equal(computeSale([{ name: 'x', price: 0.1, qty: 1 }, { name: 'y', price: 0.2, qty: 1 }], { kind: 'sum', value: 0 }, ex).total, 0.3, 'no float drift');
  const d = computeSale([{ name: 'x', price: 200, qty: 1 }], { kind: 'percent', value: 10 }, lic);
  assert.equal(d.discount, 20); assert.equal(d.total, 180); assert.equal(d.vatAmount, 27.46);
  assert.equal(computeSale([{ name: 'x', price: 50, qty: 1 }], { kind: 'sum', value: 80 }, lic).total, 0, 'discount never exceeds the subtotal');
  assert.equal(computeSale([{ name: 'x', price: 100, qty: 1 }], { kind: 'sum', value: 0 }, ex).vatAmount, 0, 'exempt dealer: no VAT');
  assert.equal(computeSale([{ name: 'x', price: 100, qty: -2 }], { kind: 'sum', value: 0 }, lic).total, 0, 'negative quantities ignored');
});

const S = (p: Partial<Sale>): Sale => ({ id: 'x', leadId: null, appointmentId: null, customerName: 'דנה', customerPhone: '', items: [{ name: 'לייזר', price: 250, qty: 1 }],
  subtotal: 250, discount: 0, total: 250, vatRate: 18, vatAmount: 38.14, method: 'cash', status: 'paid', note: '', paidAt: '2026-10-05T08:00:00Z', createdAt: '2026-10-05T08:00:00Z', ...p });

test('register: day summary by method, pending and cancelled', () => {
  const sales = [S({}), S({ id: 'b', method: 'bit', total: 100, vatAmount: 15.25 }), S({ id: 'c', status: 'pending', total: 300, paidAt: null }),
    S({ id: 'd', status: 'cancelled' }), S({ id: 'e', paidAt: '2026-10-06T08:00:00Z', createdAt: '2026-10-06T08:00:00Z' }),
    S({ id: 'f', paidAt: '2026-10-05T21:30:00Z', createdAt: '2026-10-05T21:30:00Z' })]; // 00:30 Israel → Oct 6
  const d = summarize(sales, '2026-10-05', '2026-10-05');
  assert.equal(d.count, 2); assert.equal(d.total, 350); assert.equal(d.vat, 53.39);
  assert.deepEqual(d.byMethod.map((m) => m.method), ['cash', 'bit']);
  assert.equal(d.pendingCount, 1); assert.equal(d.pendingTotal, 300);
  assert.equal(summarize(sales, '2026-10-06', '2026-10-06').count, 2, 'after-midnight sale belongs to the Israeli day');
});

test('register: CSV for the accountant', () => {
  const csv = salesCsv([S({ items: [{ name: 'קרם', price: 50, qty: 2 }], subtotal: 100, discount: 10, total: 90, vatAmount: 13.73, method: 'bit' })], '2026-10-01', '2026-10-31');
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"2026-10-05","11:00","דנה","קרם ×2","100.00","10.00","90.00","13.73","Bit \/ PayBox","שולם"/);
});

import { customerSnapshot, paymentsOf, remaining, topSellers } from '../src/features/register/money';
import { docFromSale } from '../src/features/documents/documents';
test('POS: split payments in reports and on the document', () => {
  const split = S({ id: 'sp', total: 1000, vatAmount: 152.54, method: 'split', payments: [{ method: 'card', amount: 600 }, { method: 'cash', amount: 400 }] });
  assert.equal(remaining(1000, [{ amount: 600 }, { amount: 399.99 }]), 0.01);
  assert.equal(remaining(0.3, [{ amount: 0.1 }, { amount: 0.2 }]), 0, 'agorot-exact');
  const d = summarize([split, S({ id: 'c', total: 100 })], '2026-10-05', '2026-10-05');
  assert.deepEqual(d.byMethod.map((m) => [m.method, m.total]), [['card', 600], ['cash', 500]], 'split amounts land in their own methods');
  assert.equal(d.total, 1100);
  assert.deepEqual(paymentsOf(S({ method: 'bit', total: 90 })), [{ method: 'bit', amount: 90 }]);
  const doc = docFromSale({ ...split, items: [{ name: 'חבילה', price: 1000, qty: 1 }], vatRate: 18 }, { licensed: true, docDate: '2026-10-05' });
  assert.deepEqual(doc.payments.map((p) => [p.method, p.amount]), [[3, 600], [1, 400]], 'document: one receipt line per payment (card 3, cash 1)');
});
test('POS: best sellers and customer snapshot', () => {
  const sales = [S({ id: '1', leadId: 'L', items: [{ name: 'לייזר', price: 250, qty: 1 }] }), S({ id: '2', leadId: 'L', items: [{ name: 'קרם', price: 50, qty: 3 }], paidAt: '2026-10-06T08:00:00Z' }),
    S({ id: '3', items: [{ name: 'לייזר', price: 250, qty: 1 }], status: 'cancelled' })];
  assert.deepEqual(topSellers(sales, 90, 12, new Date('2026-10-07').getTime()), ['קרם', 'לייזר'], 'by quantity, cancelled ignored');
  const snap = customerSnapshot('L', sales);
  assert.equal(snap.purchases, 2); assert.equal(snap.lastPurchase!.id, '2'); assert.equal(snap.spent, 500);
});
