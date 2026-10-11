/**
 * 2.97 (T7 of docs/FINANCE_ADDITIONS_HE.md): the customer's money on their card — what a payment link may be sent for, and the
 * open payments of their plans.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkTargets, planRows } from '../src/features/finance/card-money';
import type { Receivable } from '../src/features/finance/receivables';
import type { Line } from '../src/features/finance/plans';

const recv = (o: Partial<Receivable>): Receivable => ({ id: 'r', docType: 305, docNumber: 1, docDate: '2026-10-01', dueDate: null, customerName: 'נועה לוי',
  customerPhone: '0521112233', customerEmail: 'noa@example.com', leadId: 'L', total: 1180, credited: 0, paid: 0, balance: 1180, cancelled: false, shareToken: '', ...o });
const line = (o: Partial<Line>): Line => ({ documentId: 'D', leadId: 'L', docType: 305, docNumber: 7, docDate: '2026-10-01', customerName: 'נועה', customerPhone: '',
  customerEmail: '', shareToken: '', docBalance: 900, planId: 'P', itemId: 'i', n: 1, ofN: 3, dueDate: '2026-10-05', amount: 300, open: 300, ...o });

test('a link from the card: the open invoices (what is left of them) by date, then the accepted quotes — nothing paid, cancelled or not accepted', () => {
  const t = linkTargets([
    recv({ id: 'a', docNumber: 3, docDate: '2026-10-05', balance: 590 }),
    recv({ id: 'b', docNumber: 2, docDate: '2026-09-01', dueDate: '2026-09-30', balance: 1180 }),
    recv({ id: 'paid', docNumber: 4, balance: 0 }),
    recv({ id: 'credit', docNumber: 5, balance: -10 }),
    recv({ id: 'gone', docNumber: 6, balance: 500, cancelled: true }),
    recv({ id: 'tx', docType: 300, docNumber: 1, docDate: '2026-10-07', balance: 0.004 }),
  ], [
    { id: 'q1', number: 3, status: 'accepted', total: 590, customerName: 'נועה לוי', customerPhone: '052', customerEmail: '' },
    { id: 'q2', number: 4, status: 'sent', total: 118 },
    { id: 'q3', number: 5, status: 'accepted', total: 0 },
  ]);
  assert.deepEqual(t.map((x) => [x.kind, x.id, x.label, x.owed]), [
    ['document', 'b', 'חשבונית מס 2', 1180], ['document', 'a', 'חשבונית מס 3', 590], ['quote', 'q1', 'הצעת מחיר 3', 590],
  ]);
  assert.deepEqual(t[0].customer, { name: 'נועה לוי', phone: '0521112233', email: 'noa@example.com' }, 'the invoice\'s own customer details');
  assert.deepEqual(t[2].customer, { name: 'נועה לוי', phone: '052', email: '' });
  assert.deepEqual(linkTargets([], []), [], 'nothing owed: no link');
});

test('a plan\'s open payments on the card: by date, late ones marked; an invoice without a plan is not one, nor a paid payment', () => {
  const rows = planRows([
    line({ itemId: 'i2', n: 2, dueDate: '2026-11-05', open: 300 }),
    line({ itemId: 'i1', n: 1, dueDate: '2026-10-05', open: 120 }),
    line({ itemId: 'i3', n: 3, dueDate: '2026-12-05', open: 0 }),
    line({ planId: null, itemId: null, n: null, ofN: null, documentId: 'E', docNumber: 9, dueDate: '2026-09-01', open: 500 }),
    line({ documentId: 'F', docType: 300, docNumber: 2, itemId: null, n: null, ofN: null, dueDate: '2026-10-20', open: 80 }),
  ], '2026-10-11');
  assert.deepEqual(rows.map((r) => [r.label, r.dueDate, r.open, r.late]), [
    ['חשבונית מס 7 · תשלום 1 מתוך 3', '2026-10-05', 120, true],
    ['חשבונית עסקה 2 · מעבר לפריסה', '2026-10-20', 80, false],
    ['חשבונית מס 7 · תשלום 2 מתוך 3', '2026-11-05', 300, false],
  ]);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, 'a key per payment');
  assert.equal(planRows([line({ dueDate: '2026-10-11' })], '2026-10-11')[0].late, false, 'due today is not late');
});
