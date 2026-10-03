/** Close of day: expected cash in the drawer, the difference, the day's document numbers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Sale } from '../src/features/register/money';
import { cashDifference, cashIn, daySummary, docRanges, expectedCash, shiftDay } from '../src/features/register/shift';

const DAY = '2026-10-05';
const S = (p: Partial<Sale> & { cashReceived?: number; changeGiven?: number }): Sale => ({ id: 'x', leadId: null, appointmentId: null, customerName: 'דנה', customerPhone: '',
  items: [{ name: 'לייזר', price: 250, qty: 1 }], subtotal: 250, discount: 0, total: 250, vatRate: 18, vatAmount: 38.14, method: 'cash', status: 'paid', note: '',
  paidAt: '2026-10-05T08:00:00Z', createdAt: '2026-10-05T08:00:00Z', ...p });

test('close of day: cash in = today\'s cash after change, split cash part included', () => {
  const sales = [
    S({ id: 'a', total: 350, cashReceived: 400, changeGiven: 50 }),                  // paid 400, got 50 back → 350 stays
    S({ id: 'b', method: 'split', total: 1000, payments: [{ method: 'card', amount: 600 }, { method: 'cash', amount: 400 }] }),
    S({ id: 'c', method: 'bit', total: 120 }),                                        // not cash
    S({ id: 'd', status: 'pending', paidAt: null, total: 90 }),                       // not paid yet
    S({ id: 'e', status: 'cancelled', total: 70 }),                                   // cancelled
    S({ id: 'f', total: 60, paidAt: '2026-10-05T21:30:00Z', createdAt: '2026-10-05T21:30:00Z' }), // 00:30 Israel → Oct 6
    S({ id: 'g', total: 45, createdAt: '2026-10-04T08:00:00Z', paidAt: '2026-10-05T09:00:00Z' }),  // pending yesterday, paid in cash today
  ];
  assert.equal(cashIn(sales, DAY), 795, '350 + 400 + 45');
  assert.equal(cashIn(sales, '2026-10-06'), 60, 'after-midnight cash belongs to the next Israeli day');
  assert.equal(expectedCash(500, sales, DAY), 1295, 'opening 500 + 795');
  assert.equal(expectedCash(0, [], DAY), 0, 'empty day');
});

test('close of day: agorot-exact, no float drift', () => {
  const sales = [S({ id: 'a', total: 0.1 }), S({ id: 'b', total: 0.2 }), S({ id: 'c', method: 'split', total: 100, payments: [{ method: 'bit', amount: 99.99 }, { method: 'cash', amount: 0.01 }] })];
  assert.equal(cashIn(sales, DAY), 0.31);
  assert.equal(expectedCash(100.1, sales, DAY), 100.41);
  assert.deepEqual(cashDifference(0.3, 0.1 + 0.2), { difference: 0, kind: 'even' }, '0.1 + 0.2 is 0.30, not 0.30000000000000004');
});

test('close of day: difference — short, over, even', () => {
  assert.deepEqual(cashDifference(1290, 1295), { difference: -5, kind: 'short' });
  assert.deepEqual(cashDifference(1300.5, 1295), { difference: 5.5, kind: 'over' });
  assert.deepEqual(cashDifference(1295, 1295), { difference: 0, kind: 'even' });
  assert.deepEqual(cashDifference(1294.99, 1295), { difference: -0.01, kind: 'short' }, 'one agora counts');
});

test('close of day: document number ranges by Israeli day, per type', () => {
  const docs = [
    { docType: 320, docNumber: 12, issuedAt: '2026-10-05T07:00:00Z' }, { docType: 320, docNumber: 14, issuedAt: '2026-10-05T15:00:00Z' },
    { docType: 320, docNumber: 13, issuedAt: '2026-10-05T11:00:00Z' }, { docType: 330, docNumber: 3, issuedAt: '2026-10-05T12:00:00Z' },
    { docType: 320, docNumber: 11, issuedAt: '2026-10-04T20:59:00Z' }, // 23:59 Israel, Oct 4
    { docType: 320, docNumber: 15, issuedAt: '2026-10-05T21:01:00Z' }, // 00:01 Israel, Oct 6
  ];
  assert.deepEqual(docRanges(docs, DAY), [{ docType: 320, from: 12, to: 14, count: 3 }, { docType: 330, from: 3, to: 3, count: 1 }]);
  assert.deepEqual(docRanges([], DAY), []);
});

test('close of day: the full summary and the shift\'s day', () => {
  const sales = [S({ id: 'a', total: 200, vatAmount: 30.51 }), S({ id: 'b', method: 'card', total: 100, vatAmount: 15.25 }), S({ id: 'c', status: 'pending', paidAt: null, total: 80 })];
  const d = daySummary({ sales, docs: [{ docType: 320, docNumber: 1, issuedAt: '2026-10-05T08:00:00Z' }], day: DAY, openingCash: 300 });
  assert.equal(d.count, 2); assert.equal(d.total, 300); assert.equal(d.vat, 45.76);
  assert.equal(d.cashIn, 200); assert.equal(d.expectedCash, 500);
  assert.equal(d.pendingCount, 1); assert.equal(d.pendingTotal, 80);
  assert.deepEqual(d.docs, [{ docType: 320, from: 1, to: 1, count: 1 }]);
  assert.equal(shiftDay({ openedAt: '2026-10-05T21:30:00Z' }), '2026-10-06', 'opened 00:30 Israel time');
});
