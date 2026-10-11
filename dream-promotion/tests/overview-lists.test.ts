/**
 * 2.97 (T7 of docs/FINANCE_ADDITIONS_HE.md): the overview leads to a list — each card's list is filtered by the card's own rules,
 * and its number is the card's. The examples mirror finance_summary() (20261011005100) and receivable_lines (20261010004400).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocationMissingDocs, cardTarget, daysBehind, draftsTotal, expenseCostA, expensesCost, overdueDocs, periodFromQuery, weekCharges,
} from '../src/features/finance/overview-lists';
import type { Line } from '../src/features/finance/plans';

const TODAY = '2026-10-11';
const line = (o: Partial<Line>): Line => ({ documentId: 'A', leadId: 'L', docType: 305, docNumber: 7, docDate: '2026-09-01', customerName: 'נועה', customerPhone: '052',
  customerEmail: '', shareToken: 't', docBalance: 900, planId: null, itemId: null, n: null, ofN: null, dueDate: '2026-09-30', amount: 900, open: 900, ...o });

test('every card leads to its list, for the same period', () => {
  const p = { from: '2026-09-01', to: '2026-09-30' };
  assert.deepEqual(cardTarget('income', p, { reports: true }), { section: 'reports', params: { view: 'customers', from: '2026-09-01', to: '2026-09-30' } });
  assert.deepEqual(cardTarget('income', p, { reports: false }), { section: 'income', params: p }, 'before the reports (4900): the income screen');
  assert.deepEqual(cardTarget('expenses', p, { reports: true }), { section: 'expenses', params: { show: 'confirmed', ...p } });
  assert.deepEqual(cardTarget('profit', p, { reports: true }), { section: 'reports', params: { view: 'summary', ...p } });
  assert.deepEqual(cardTarget('vat', p, { reports: false }), { section: 'reports', params: { view: 'summary', ...p } });
  assert.deepEqual(cardTarget('cash', p, { reports: true }), { section: 'income', params: p });
  assert.deepEqual(cardTarget('nodoc', p, { reports: true }), { section: 'income', params: p });
  assert.deepEqual(cardTarget('open', p, { reports: true }), { section: 'receivables', params: {} }, 'what is owed now — no period');
  assert.deepEqual(cardTarget('overdue', p, { reports: true }), { section: 'receivables', params: { show: 'overdue' } });
  assert.deepEqual(cardTarget('pending', p, { reports: true }), { section: 'receivables', params: { show: 'pending' } });
  assert.deepEqual(cardTarget('week', p, { reports: true }), { section: 'recurring', params: { show: 'week' } });
  assert.deepEqual(cardTarget('drafts', p, { reports: true }), { section: 'expenses', params: { show: 'drafts' } }, 'drafts of any date');
  assert.deepEqual(cardTarget('allocation', p, { reports: true }), { section: 'documents', params: { show: 'allocation', ...p } });
});

test('a period in the address: by its name when it is one, else a range; nothing wrong passes', () => {
  const q = (s: string) => periodFromQuery(new URLSearchParams(s));
  assert.deepEqual(q('from=2026-10-01&to=2026-10-31'), { from: '2026-10-01', to: '2026-10-31', label: 'אוקטובר 2026', kind: 'month' });
  assert.deepEqual(q('from=2026-09-01&to=2026-10-31'), { from: '2026-09-01', to: '2026-10-31', label: 'ספטמבר–אוקטובר 2026', kind: 'bimonth' });
  assert.deepEqual(q('from=2026-01-01&to=2026-12-31'), { from: '2026-01-01', to: '2026-12-31', label: '2026', kind: 'year' });
  assert.deepEqual(q('from=2026-10-05&to=2026-10-11'), { from: '2026-10-05', to: '2026-10-11', label: 'טווח', kind: 'custom' });
  assert.equal(q(''), null);
  assert.equal(q('from=2026-10-11&to=2026-10-01'), null, 'backwards');
  assert.equal(q('from=2026-13-01&to=2026-13-02'), null, 'no such month');
  assert.equal(q('from=2000-01-01&to=2026-01-01'), null, 'longer than the money summary takes');
  assert.equal(q('from=2026-10-01&to=2026-10-31%27'), null, 'nothing but a date');
});

test('late: by the lines, as finance_summary — a plan\'s payments past their date, an invoice without a plan by its own date', () => {
  const r = overdueDocs([
    line({ documentId: 'A', docNumber: 7, dueDate: '2026-09-30', open: 900 }),                                   // no plan, 11 days late
    line({ documentId: 'B', docNumber: 8, planId: 'P', itemId: 'b1', n: 1, ofN: 3, dueDate: '2026-10-01', amount: 300, open: 120, docBalance: 720 }),
    line({ documentId: 'B', docNumber: 8, planId: 'P', itemId: 'b2', n: 2, ofN: 3, dueDate: '2026-10-10', amount: 300, open: 300, docBalance: 720 }),
    line({ documentId: 'B', docNumber: 8, planId: 'P', itemId: 'b3', n: 3, ofN: 3, dueDate: '2026-11-01', amount: 300, open: 300, docBalance: 720 }), // ahead
    line({ documentId: 'C', docNumber: 9, dueDate: TODAY, open: 50 }),                                           // due today: not late
    line({ documentId: 'D', docNumber: 10, dueDate: null, open: 70 }),                                           // no date: never late
    line({ documentId: 'E', docNumber: 11, dueDate: '2026-08-01', open: 0 }),                                    // paid
  ], TODAY);
  assert.equal(r.total, 1320, 'the summary\'s overdue: ₪900 + ₪120 + ₪300');
  assert.equal(r.count, 2, 'its overdueCount: two invoices');
  assert.deepEqual(r.docs.map((d) => [d.documentId, d.late, d.balance, d.since, d.lines.length]), [['A', 900, 900, '2026-09-30', 1], ['B', 420, 720, '2026-10-01', 2]]);
  assert.equal(daysBehind('2026-09-30', TODAY), 11);
  assert.deepEqual(overdueDocs([], TODAY), { docs: [], total: 0, count: 0 });
  assert.equal(overdueDocs([line({ open: 0.1 }), line({ documentId: 'X', open: 0.2 })], TODAY).total, 0.3, 'in agorot');
});

test('the expenses card and its list: the cost as the summary counts it (VAT not offset in), credit notes take off, manual entries added', () => {
  const e = (o: Partial<{ status: string; amountBeforeVat: number; vatAmount: number; vatDeductiblePct: number; supplierDocType: string; total: number }>) =>
    ({ status: 'confirmed', amountBeforeVat: 100, vatAmount: 18, vatDeductiblePct: 100, supplierDocType: 'tax_invoice', total: 118, ...o });
  assert.equal(expenseCostA(e({}), true), 10000, 'VAT fully offset: ₪100');
  assert.equal(expenseCostA(e({ vatDeductiblePct: 66.67 }), true), 10600, 'two thirds offset: ₪100 + ₪6 (18 × 33.33% = 5.9994 → 6.00)');
  assert.equal(expenseCostA(e({ vatDeductiblePct: 25 }), true), 11350, 'a quarter: ₪100 + ₪13.50');
  assert.equal(expenseCostA(e({}), false), 11800, 'an exempt business offsets nothing: the whole of it');
  assert.equal(expenseCostA(e({ supplierDocType: 'credit' }), true), -10000, 'a credit note');
  assert.equal(expenseCostA(e({ amountBeforeVat: 33.33, vatAmount: 6, vatDeductiblePct: 50, total: 39.33 }), true), 3633, '₪33.33 + ₪3');
  const list = [e({}), e({ vatDeductiblePct: 25 }), e({ supplierDocType: 'credit', amountBeforeVat: 50, vatAmount: 9, total: 59 }), e({ status: 'draft' }), e({ status: 'void' })];
  assert.deepEqual(expensesCost(list, true), { count: 3, cost: 163.5, manual: 0, total: 163.5 }, 'only the confirmed: 100 + 113.50 − 50');
  assert.deepEqual(expensesCost(list, true, 40.25), { count: 3, cost: 163.5, manual: 40.25, total: 203.75 }, 'and the manual expense entries (5100)');
  assert.deepEqual(draftsTotal(list), { count: 1, total: 118 }, 'drafts: their sum as typed');
  assert.deepEqual(draftsTotal([e({ status: 'draft' }), e({ status: 'draft', supplierDocType: 'credit', total: 18 })]), { count: 2, total: 100 });
});

test('the week\'s charges: active plans due by six days from today — a late one not made yet too; paused, ended or past their end: not', () => {
  const p = (id: string, nextDate: string, o: Partial<{ status: 'active' | 'paused' | 'ended'; endDate: string | null; amount: number }> = {}) =>
    ({ id, status: 'active' as const, nextDate, endDate: null, amount: 100, ...o });
  const w = weekCharges([
    p('a', '2026-10-11'), p('b', '2026-10-17', { amount: 250.5 }), p('c', '2026-10-18'), p('d', '2026-10-09', { amount: 40 }),
    p('e', '2026-10-12', { status: 'paused' }), p('f', '2026-10-12', { status: 'ended' }), p('g', '2026-10-13', { endDate: '2026-10-12' }),
    p('h', '2026-10-13', { endDate: '2026-10-13' }),
  ], TODAY);
  assert.deepEqual(w.plans.map((x) => x.id), ['d', 'a', 'h', 'b'], 'by date');
  assert.equal(w.total, 490.5);
  assert.equal(w.count, 4);
  assert.equal(w.until, '2026-10-17');
});

test('invoices above the threshold without an allocation number: as finance_summary counts them', () => {
  const rules = [{ effectiveFrom: '2026-01-01', thresholdBeforeVat: 10000 }, { effectiveFrom: '2026-06-01', thresholdBeforeVat: 5000 }];
  const d = (id: string, o: Partial<{ docType: number; docDate: string; afterDiscount: number; customerDealer: string; issuer: { entityType?: string } | null }> = {}) =>
    ({ id, docType: 305, docDate: '2026-10-01', afterDiscount: 6000, customerDealer: '514000004', issuer: null, ...o });
  const docs = [
    d('a'), d('b', { docType: 320 }), d('c', { afterDiscount: 5000 }), d('d', { customerDealer: '' }), d('e', { docType: 300 }),
    d('f', { docDate: '2026-05-31' }), d('g', { docDate: '2026-05-31', afterDiscount: 10000.01 }), d('h', { issuer: { entityType: 'exempt_dealer' } }),
    d('i'), d('j'), d('k', { docDate: '2025-12-31' }),
  ];
  const allocations = [{ documentId: 'i', status: 'approved', isTest: false }, { documentId: 'j', status: 'approved', isTest: true }, { documentId: 'a', status: 'failed', isTest: false }];
  assert.deepEqual(allocationMissingDocs(docs, rules, allocations, 'company').map((x) => x.id), ['a', 'b', 'g', 'j'],
    'above the threshold of its date, to a dealer, a VAT issuer, no real number (a test one is none)');
  assert.deepEqual(allocationMissingDocs(docs, rules, [], 'exempt_dealer').map((x) => x.id), [], 'an exempt business issues no tax invoices');
});
