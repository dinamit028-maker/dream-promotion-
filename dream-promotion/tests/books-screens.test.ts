/**
 * 2.123 — stage 4ד, "הנהלת חשבונות" (the screens of the double-entry books over migration 20261129007200): who sees the area, the
 * chart's rules as gl_account_add / _update check them, the manual entry's live balance in whole agorot (gl_manual_create), the opening
 * balances (gl_opening_balances), the trial balance's grouping under the database's groups, the tables for CSV / PDF, the document
 * references, and the Hebrew of every refusal. The screens are clicked through in tests/e2e/books-screens.e2e.ts. Demo data only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { israelParts } from '../src/lib/il-time';
import {
  SYSTEM_KEYS, accountAddProblems, accountUpdateProblems, balanceSheetTable, bookJournalTable, booksError, booksViews, canDeactivate, canReverseEntry, chartList,
  docRefKey, docRefs, entryBalance, emptyManual, groupTrialBalance, isSystemKey, ledgerTable, manualArgs, manualProblems, openingArgs, openingBalance, openingProblems,
  openingSuppliersReady, originOf, parseAgorot, supplierChoices, profitLossTable, reconDiffers, reconcileTable, refText, reverseProblems, showBooksArea, tbBalanced, toBalanceSheet, toBookJournal, toChart,
  toLedger, toProfitLoss, toReconcile, toTrialBalance, trialBalanceTable, type ChartAccount,
} from '../src/features/finance/ledger';
import { tableCsv, pdfBody } from '../src/features/finance/statements';
import { financeError } from '../src/features/finance/rows';
import { glCustomerKey } from '../src/features/documents/customer-key';
import { toBooksState } from '../src/features/finance/books';
import { FINANCE_SECTIONS, financeHref, sectionOfPath } from '../src/features/finance/routes';
import { BOOKS_LINK, financeGroups } from '../src/features/finance/module';
import { REPORT_PDF_LIMITS, reportPdfInput } from '../src/lib/server/report-pdf';

const START = '2026-12-01';
/** a CSV line as the module writes it (every cell quoted — reports.ts csv) */
const q = (...cells: string[]) => cells.map((c) => `"${c}"`).join(',');
const state = (o: Partial<{ owner: boolean; transactions: number; openingEntered: boolean }> = {}) =>
  ({ startDate: START, started: true, transactions: 0, openingEntered: false, canMoveStart: true, owner: false, ...o });
const CHART: ChartAccount[] = toChart([
  { key: '1100', name: 'קופת מזומן — ראשי', kind: 'asset', tb_code: '1100', tb_name: 'קופות מזומן', parent_key: null, role: 'cash:b', active: true },
  { key: '1300', name: 'לקוחות', kind: 'asset', tb_code: 'CUSTOMERS', tb_name: 'לקוחות', parent_key: null, role: 'customers', active: true },
  { key: '0501234567', name: 'לקוחה דמו', kind: 'asset', tb_code: 'CUSTOMERS', tb_name: 'לקוחות', parent_key: '1300', role: 'customer:0501234567', active: true },
  { key: 'S-000000109', name: 'ספק דמו', kind: 'liability', tb_code: 'SUPPLIERS', tb_name: 'ספקים', parent_key: '2100', role: 'supplier:d:000000109', active: true },
  { key: '2100', name: 'ספקים', kind: 'liability', tb_code: 'SUPPLIERS', tb_name: 'ספקים', parent_key: null, role: 'suppliers', active: true },
  { key: '3100', name: 'יתרות פתיחה', kind: 'equity', tb_code: '3100', tb_name: 'יתרות פתיחה', parent_key: null, role: 'opening', active: true },
  { key: '6112', name: 'עמלות בנק וסליקה', kind: 'expense', tb_code: '6100', tb_name: 'הוצאות', parent_key: null, role: 'expense:fees', active: true },
  { key: '6120', name: 'הדרכות', kind: 'expense', tb_code: '6100', tb_name: 'הוצאות', parent_key: null, role: null, active: true },
  { key: '6121', name: 'ישן', kind: 'expense', tb_code: '6100', tb_name: 'הוצאות', parent_key: null, role: null, active: false },
  { key: 'BANK', name: 'בנק', kind: 'asset', tb_code: 'BANK', tb_name: 'בנק', parent_key: null, role: 'bank', active: true },
  { key: 'x', name: 'שבור', kind: 'nope' },
]);

test('who sees "הנהלת חשבונות": after 7200, the whole of the money, the owner — or anyone once the books have an entry', () => {
  assert.equal(showBooksArea({ ready: false, state: state({ owner: true }), access: 'full' }), false, 'before 7200 — hidden');
  assert.equal(showBooksArea({ ready: true, state: null, access: 'full' }), false);
  assert.equal(showBooksArea({ ready: true, state: state({ owner: true }), access: 'full' }), true, 'the owner — also before the first entry');
  assert.equal(showBooksArea({ ready: true, state: state(), access: 'full' }), false, 'a member, empty books — hidden (answer 13)');
  assert.equal(showBooksArea({ ready: true, state: state({ transactions: 3 }), access: 'full' }), true, 'a member once the books have an entry');
  for (const a of ['register', 'calendar', 'agenda', null]) assert.equal(showBooksArea({ ready: true, state: state({ owner: true, transactions: 9 }), access: a }), false, `never ${a}`);
  assert.deepEqual(booksViews(state()).map((v) => v.id), ['tb', 'ledger', 'journal', 'pnl', 'balance', 'chart', 'reconcile'], 'no owner forms for a member');
  assert.deepEqual(booksViews(state({ owner: true })).map((v) => v.id), ['tb', 'ledger', 'journal', 'pnl', 'balance', 'chart', 'manual', 'opening', 'reconcile']);
  assert.ok(!booksViews(state({ owner: true, openingEntered: true })).some((v) => v.id === 'opening'), 'opening balances — once');
});

test('the address and the menu: /finance/books, in "דוחות ורואה חשבון" only when shown', () => {
  assert.equal(financeHref('books'), '/finance/books');
  assert.equal(sectionOfPath('/finance/books/'), 'books');
  assert.ok(FINANCE_SECTIONS.some((s) => s.id === 'books' && s.label === 'הנהלת חשבונות'));
  const reports = (g: ReturnType<typeof financeGroups>) => g.find((x) => x.id === 'reports')!.links.map((l) => l.href);
  assert.ok(!reports(financeGroups({ cash: false, journal: true })).includes(BOOKS_LINK.href), 'hidden by default');
  assert.deepEqual(reports(financeGroups({ cash: false, journal: true, books: true })), ['/finance/reports', '/finance/accountant', '/finance/journal', '/finance/books']);
  assert.deepEqual(reports(financeGroups({ cash: false, books: true })), ['/finance/reports', '/finance/accountant', '/finance/books']);
});

test('the system\'s keys = the default chart of migration 7100 (gl_chart_default) + 2150 + a location\'s cash / cheques', () => {
  const sql = readFileSync(path.join(__dirname, '../supabase/migrations/20261128007100_books_core.sql'), 'utf8');
  const body = sql.slice(sql.indexOf('create or replace function public.gl_chart_default'), sql.indexOf('create or replace function public.gl_chart_ensure'));
  const keys = [...body.matchAll(/^\s+\('([^']+)', '/gm)].map((m) => m[1]);
  assert.equal(keys.length, 36);
  assert.deepEqual([...SYSTEM_KEYS].sort(), [...keys].sort());
  const more = readFileSync(path.join(__dirname, '../supabase/migrations/20261129007200_books_more.sql'), 'utf8');
  assert.match(more, /p_key = '2150' or p_key ~ '\^\(1100\|1150\)-\[0-9\]\{1,2\}\$'/, 'gl_key_system of 7200 — the same extra keys');
  for (const k of ['2150', '1100-2', '1150-12', '6101', 'BANK']) assert.ok(isSystemKey(k), k);
  for (const k of ['6120', '1100-123', '2151']) assert.ok(!isSystemKey(k), k);
});

test('the chart: who an account is, the list, a new account and an edit by gl_account_add / _update\'s rules', () => {
  assert.equal(CHART.length, 10, 'a row that is not an account is dropped');
  assert.equal(originOf(CHART.find((a) => a.key === '6120')!), 'owner');
  assert.equal(originOf(CHART.find((a) => a.key === '0501234567')!), 'customer');
  assert.equal(originOf(CHART.find((a) => a.key === 'S-000000109')!), 'supplier');
  assert.equal(originOf(CHART.find((a) => a.key === '1100')!), 'system');
  assert.ok(!chartList(CHART).some((a) => a.key === '0501234567' || a.key.startsWith('S-')), 'customers / suppliers only when asked');
  assert.ok(chartList(CHART, '', { parties: true }).some((a) => a.key === 'S-000000109'));
  assert.deepEqual(chartList(CHART, 'דמו').map((a) => a.key), ['0501234567', 'S-000000109'], 'a search finds them');
  assert.ok(canDeactivate(CHART.find((a) => a.key === '6120')!) && canDeactivate(CHART.find((a) => a.key === '0501234567')!));
  assert.ok(!canDeactivate(CHART.find((a) => a.key === '6112')!), 'a system account is never removed (account_system)');
  const draft = { key: '6130', name: 'הדרכות צוות', kind: 'expense' as const, tbCode: '', tbName: '', parentKey: '' };
  assert.deepEqual(accountAddProblems(draft, CHART), []);
  assert.deepEqual(accountAddProblems({ ...draft, key: '6130-1' }, CHART), []);
  assert.match(accountAddProblems({ ...draft, key: '613' }, CHART).join(), /4 ספרות/);
  assert.match(accountAddProblems({ ...draft, key: 'S-12' }, CHART).join(), /4 ספרות/, 'never a supplier\'s key');
  assert.match(accountAddProblems({ ...draft, key: '2150' }, CHART).join(), /שמור/, 'account_reserved');
  assert.match(accountAddProblems({ ...draft, key: '6120' }, CHART).join(), /כבר יש/, 'account_exists');
  assert.match(accountAddProblems({ ...draft, name: '' }, CHART).join(), /שם החשבון/);
  assert.match(accountAddProblems({ ...draft, kind: '' }, CHART).join(), /סוג/);
  assert.match(accountAddProblems({ ...draft, tbName: 'א'.repeat(31) }, CHART).join(), /עד 30/);
  assert.match(accountAddProblems({ ...draft, parentKey: '9999' }, CHART).join(), /לא נמצא/);
  assert.match(accountAddProblems({ ...draft, parentKey: '1100' }, CHART).join(), /מאותו סוג/, 'a parent of another kind');
  assert.match(accountAddProblems({ ...draft, kind: 'liability', parentKey: '2100' }, CHART).join(), /ספקים \(2100\)/);
  assert.deepEqual(accountAddProblems({ ...draft, parentKey: '6120' }, CHART), []);
  const a = CHART.find((x) => x.key === '6120')!;
  assert.deepEqual(accountUpdateProblems(a, { name: 'הדרכות', tbCode: '6100', tbName: 'הוצאות', newKey: '6125' }, CHART), []);
  assert.match(accountUpdateProblems(CHART.find((x) => x.key === '6112')!, { name: '', tbCode: '', tbName: '', newKey: '6130' }, CHART).join(), /אין שינוי/, 'account_key_fixed');
  assert.match(accountUpdateProblems(a, { name: '', tbCode: '', tbName: '', newKey: '6121' }, CHART).join(), /כבר יש/);
});

test('an amount typed: whole agorot, a thousands comma only between groups of three', () => {
  assert.equal(parseAgorot('1,234.5'), 123450);
  assert.equal(parseAgorot('0.1'), 10);
  assert.equal(parseAgorot(' 250 '), 25000);
  assert.equal(parseAgorot('12,34'), null);
  assert.equal(parseAgorot('1.234'), null, 'not to the agora');
  assert.equal(parseAgorot('0'), null);
  assert.equal(parseAgorot('-5'), null, 'a side, never a sign');
  assert.equal(parseAgorot('abc'), null);
});

test('the manual entry: the live balance in agorot, gl_manual_create\'s checks, the arguments', () => {
  // 0.1 + 0.2 = 0.3 — in agorot, never a float
  const lines = [{ account: '6112', side: 'D' as const, amount: '0.1' }, { account: '6120', side: 'D' as const, amount: '0.2' }, { account: 'BANK', side: 'C' as const, amount: '0.3' }];
  assert.deepEqual(entryBalance(lines), { debit: 30, credit: 30, diff: 0, balanced: true });
  assert.deepEqual(entryBalance([{ account: '6112', side: 'D', amount: '10' }, { account: 'BANK', side: 'C', amount: '9.99' }]), { debit: 1000, credit: 999, diff: 1, balanced: false });
  assert.equal(entryBalance([{ account: '', side: 'D', amount: '' }, { account: '', side: 'C', amount: '' }]).balanced, false, 'zero is not balanced');
  const o = { today: '2026-12-10', start: START, lockedUntil: null, chart: CHART };
  const d = { date: '2026-12-10', details: 'עמלה', lines };
  assert.deepEqual(manualProblems(d, o), []);
  assert.deepEqual(manualProblems({ ...d, lines: [...lines, { account: '', side: 'D', amount: '' }] }, o), [], 'a blank line is not sent');
  assert.match(manualProblems({ ...d, date: '2026-12-11' }, o).join(), /היום או לפניו/);
  assert.match(manualProblems({ ...d, date: '2026-11-30' }, o).join(), /01\/12\/2026/, 'manual_before_start');
  assert.match(manualProblems(d, { ...o, lockedUntil: '2026-12-10' }).join(), /סגורים עד 10\/12\/2026/, 'period_locked');
  assert.match(manualProblems({ ...d, details: 'א' }, o).join(), /2 עד 50/);
  assert.match(manualProblems({ ...d, lines: lines.slice(0, 1) }, o).join(), /2 עד 500/);
  assert.match(manualProblems({ ...d, lines: [{ ...lines[0], account: '6121' }, ...lines.slice(1)] }, o).join(), /שאינו פעיל/, 'an inactive account');
  assert.match(manualProblems({ ...d, lines: [{ ...lines[0], amount: '0.105' }, ...lines.slice(1)] }, o).join(), /עד אגורות/);
  assert.match(manualProblems({ ...d, lines: [{ ...lines[0], amount: '0.2' }, ...lines.slice(1)] }, o).join(), /לא מאוזנת/);
  const args = manualArgs('e0000000-0000-4000-8000-000000000001', { ...d, lines: [...lines, { account: ' ', side: 'C', amount: '' }] }, null);
  assert.deepEqual(args.p_lines, [{ account: '6112', side: 'D', amount: 0.1 }, { account: '6120', side: 'D', amount: 0.2 }, { account: 'BANK', side: 'C', amount: 0.3 }]);
  assert.equal(args.p_details, 'עמלה');
  assert.deepEqual(emptyManual('2026-12-01').lines.map((l) => l.side), ['D', 'C']);
});

test('dates by Israel time: a manual entry at 00:30 on the 1st (the books\' first day) is of that day, never UTC\'s day before', () => {
  // 30.11.2026 22:30 UTC = 01.12.2026 00:30 in Israel (winter, +2): today is the books' start day
  const today = israelParts(Date.UTC(2026, 10, 30, 22, 30)).date;
  assert.equal(today, '2026-12-01');
  assert.equal(new Date(Date.UTC(2026, 10, 30, 22, 30)).toISOString().slice(0, 10), '2026-11-30', 'UTC would say the day before');
  const d = { date: today, details: 'פתיחה', lines: [{ account: '6112', side: 'D' as const, amount: '5' }, { account: 'BANK', side: 'C' as const, amount: '5' }] };
  assert.deepEqual(manualProblems(d, { today, start: START, lockedUntil: null, chart: CHART }), []);
  // 02:59 on a month's first day — still that day; 31.12 → 1.1 across the year
  assert.equal(israelParts(Date.UTC(2026, 11, 31, 22, 59)).date, '2027-01-01');
  assert.deepEqual(reverseProblems({ date: '2027-01-01', entryDate: '2026-12-31', today: '2027-01-01', lockedUntil: null, details: '' }), []);
  assert.match(reverseProblems({ date: '2026-12-30', entryDate: '2026-12-31', today: '2027-01-01', lockedUntil: null, details: '' }).join(), /מתאריך הפקודה/);
  assert.match(reverseProblems({ date: '2027-01-01', entryDate: '2026-12-31', today: '2027-01-01', lockedUntil: '2027-01-01', details: '' }).join(), /סגורים/);
  assert.match(reverseProblems({ date: '2027-01-01', entryDate: '2026-12-31', today: '2027-01-01', lockedUntil: null, details: 'א' }).join(), /2 עד 50/);
});

test('the opening balances: an account of the chart or a new customer by its card\'s key; never 3100; never a new supplier ("S-")', () => {
  const key = glCustomerKey('052-0000000', 'לקוחה חדשה');
  assert.equal(key, '052-0000000', 'the customer\'s key as its documents post to it (the phone)');
  const lines = [
    { account: '1100', name: '', side: 'D' as const, amount: '1,000', customer: false },
    { account: key, name: 'לקוחה חדשה', side: 'D' as const, amount: '250.50', customer: true },
    { account: 'S-000000109', name: '', side: 'C' as const, amount: '300', customer: false },
  ];
  assert.deepEqual(openingProblems(lines, CHART), []);
  assert.deepEqual(openingBalance(lines), { debit: 125050, credit: 30000, toOpening: 95050 }, '3100 gets the rest, credit');
  assert.deepEqual(openingArgs(lines, CHART), [{ account: '1100', side: 'D', amount: 1000 }, { account: key, side: 'D', amount: 250.5, name: 'לקוחה חדשה' },
    { account: 'S-000000109', side: 'C', amount: 300 }], 'a name only for an account that is not in the chart yet');
  assert.match(openingProblems([{ ...lines[0], account: '3100' }], CHART).join(), /מתאזן לבד/);
  assert.match(openingProblems([{ ...lines[0], account: 'S-999999999', name: 'ספק חדש', customer: true }], CHART).join(), /לא נמצא/, 'a new supplier — the database refuses (gl_key_reserved)');
  assert.match(openingProblems([{ ...lines[0], account: '9999' }], CHART).join(), /לא נמצא/);
  assert.match(openingProblems([{ ...lines[1], name: '' }], CHART).join(), /לא נמצא/, 'a new customer needs a name');
  assert.match(openingProblems([], CHART).join(), /1 עד 2000/);
  assert.match(openingProblems([{ ...lines[0], amount: '0' }], CHART).join(), /עד אגורות/);
});

const TB = toTrialBalance({
  from: '2026-12-01', to: '2026-12-31',
  accounts: [
    { key: '0501234567', name: 'לקוחה דמו', kind: 'asset', tbCode: 'CUSTOMERS', tbName: 'לקוחות', parentKey: '1300', opening: 0, debit: 590, credit: 590, closing: 0 },
    { key: '1100', name: 'קופת מזומן — ראשי', kind: 'asset', tbCode: '1100', tbName: 'קופות מזומן', parentKey: null, opening: 1000, debit: 590.1, credit: 0, closing: 1590.1 },
    { key: '2200', name: 'מע״מ עסקאות', kind: 'liability', tbCode: '2200', tbName: 'מע״מ עסקאות', parentKey: null, opening: 0, debit: 0, credit: 90.1, closing: -90.1 },
    { key: '3100', name: 'יתרות פתיחה', kind: 'equity', tbCode: '3100', tbName: 'יתרות פתיחה', parentKey: null, opening: -1000, debit: 0, credit: 0, closing: -1000 },
    { key: '4100', name: 'הכנסות משירותים', kind: 'income', tbCode: '4000', tbName: 'הכנסות', parentKey: null, opening: 0, debit: 0, credit: 500, closing: -500 },
  ],
  groups: [
    { tbCode: '1100', tbName: 'קופות מזומן', accounts: 1, opening: 1000, debit: 590.1, credit: 0, closing: 1590.1 },
    { tbCode: '2200', tbName: 'מע״מ עסקאות', accounts: 1, opening: 0, debit: 0, credit: 90.1, closing: -90.1 },
    { tbCode: '3100', tbName: 'יתרות פתיחה', accounts: 1, opening: -1000, debit: 0, credit: 0, closing: -1000 },
    { tbCode: '4000', tbName: 'הכנסות', accounts: 1, opening: 0, debit: 0, credit: 500, closing: -500 },
    { tbCode: 'CUSTOMERS', tbName: 'לקוחות', accounts: 1, opening: 0, debit: 590, credit: 590, closing: 0 },
  ],
  total: { opening: 0, debit: 1180.1, credit: 1180.1, closing: 0 },
});

test('the trial balance: the accounts under the database\'s groups (its totals, never summed here); balanced to the agora', () => {
  const g = groupTrialBalance(TB);
  assert.deepEqual(g.map((x) => x.group.tbCode), ['1100', '2200', '3100', '4000', 'CUSTOMERS'], 'the database\'s order');
  assert.deepEqual(g.find((x) => x.group.tbCode === 'CUSTOMERS')!.accounts.map((a) => a.key), ['0501234567']);
  assert.equal(g.reduce((n, x) => n + x.accounts.length, 0), TB.accounts.length, 'every account once');
  assert.ok(tbBalanced(TB));
  assert.ok(!tbBalanced({ ...TB, total: { ...TB.total, credit: 1180.09 } }), 'an agora apart');
  // an account whose code has no group (never expected) — a group of its own, never lost
  const lost = groupTrialBalance({ ...TB, accounts: [...TB.accounts, { ...TB.accounts[0], key: '?', tbCode: '?', tbName: 'חשבון של סניף אחר', debit: 0.1, credit: 0.2 }] });
  assert.equal(lost.at(-1)!.group.tbCode, '?');
  assert.equal(lost.at(-1)!.group.debit, 0.1);
  const t = trialBalanceTable(TB);
  assert.equal(t.columns.length, 6);
  assert.equal(t.rows.length, TB.accounts.length + TB.groups.length, 'an account row and a subtotal per group');
  assert.deepEqual(t.rows[1], ['1100', 'סה״כ קופות מזומן', 1000, 590.1, 0, 1590.1]);
  const csv = tableCsv(t).split('\r\n');
  assert.equal(csv[0], `\ufeff${q('קוד מאזן', 'חשבון', 'יתרת פתיחה', 'חובה', 'זכות', 'יתרת סגירה')}`);
  assert.equal(csv[1], q('1100', '1100 · קופת מזומן — ראשי', '1000.00', '590.10', '0.00', '1590.10'));
  assert.equal(csv.at(-1), q('', 'סה״כ', '0.00', '1180.10', '1180.10', '0.00'));
  assert.match(t.note!, /מאוזן/);
  const pdf = reportPdfInput(pdfBody(t, 'דצמבר 2026'));
  assert.ok(pdf.ok, 'the PDF route takes it');
  assert.ok(t.columns.length <= REPORT_PDF_LIMITS.columns);
});

test('a ledger: the opening row, the running balance as the database gives it, references of documents', () => {
  const l = toLedger({ account: { key: '1300', name: 'לקוחות', kind: 'asset', tbCode: 'CUSTOMERS', tbName: 'לקוחות', parentKey: null, active: true },
    from: '2026-12-01', to: '2026-12-31', opening: 100, debit: 590, credit: 300, closing: 390,
    lines: [
      { date: '2026-12-02', number: 4, transactionId: 't4', lineNo: 1, account: '0501234567', accountName: 'לקוחה דמו', details: 'חשבונית מס 01000001 — לקוחה דמו', sourceKind: 'document',
        ref1Type: 305, ref1Number: '01000001', side: 'D', debit: 590, credit: 0, balance: 690 },
      { date: '2026-12-03', number: 5, transactionId: 't5', lineNo: 2, account: '0501234567', accountName: 'לקוחה דמו', details: 'קבלה 7', sourceKind: 'document',
        ref1Type: 400, ref1Number: '7', ref2Type: 305, ref2Number: '01000001', side: 'C', debit: 0, credit: 300, balance: 390 },
    ] });
  const t = ledgerTable(l);
  assert.deepEqual(t.columns.map((c) => c.label), ['תאריך', 'פקודה', 'פרטים', 'אסמכתא', 'חשבון', 'חובה', 'זכות', 'יתרה'], 'the account column — lines of accounts under it');
  assert.deepEqual(t.rows[0], ['2026-12-01', null, 'יתרת פתיחה', '', '', null, null, 100]);
  assert.deepEqual(t.rows[1].slice(3), ['חשבונית מס 01000001', '0501234567 · לקוחה דמו', 590, null, 690]);
  assert.deepEqual(t.total, ['', null, 'סה״כ', '', '', 590, 300, 390]);
  assert.equal(tableCsv(t).split('\r\n')[2], q('02/12/2026', '4', 'חשבונית מס 01000001 — לקוחה דמו', 'חשבונית מס 01000001', '0501234567 · לקוחה דמו', '590.00', '', '690.00'));
  assert.deepEqual(docRefs(l.lines), [{ type: 305, number: 1000001 }, { type: 400, number: 7 }], 'each document once');
  assert.equal(docRefKey(305, '01000001'), 'doc:305:1000001');
  assert.equal(docRefKey(null, 'INV-7'), null, 'a supplier\'s number is not ours');
  assert.equal(docRefKey(999, '5'), null);
  assert.equal(refText(null, 'INV-7'), 'INV-7');
  assert.equal(refText(400, '7'), 'קבלה 7');
  const one = ledgerTable({ ...l, account: { ...l.account, key: '0501234567' }, lines: l.lines });
  assert.ok(!one.columns.some((c) => c.label === 'חשבון'), 'one account — no account column');
});

test('the journal, profit and loss, the balance sheet and the reconciliation as tables', () => {
  const j = toBookJournal({ from: '2026-12-01', to: '2026-12-31', count: 2, debit: 690, credit: 690, entries: [
    { id: 'e1', number: 1, date: '2026-12-01', sourceKind: 'opening', details: 'יתרות פתיחה', lines: [{ lineNo: 1, account: '1100', accountName: 'קופה', side: 'D', amount: 100 },
      { lineNo: 2, account: '3100', accountName: 'יתרות פתיחה', side: 'C', amount: 100 }], debit: 100, credit: 100 },
    { id: 'e2', number: 2, date: '2026-12-05', sourceKind: 'manual', details: 'עמלה', reversedBy: null, lines: [{ lineNo: 1, account: '6112', accountName: 'עמלות', side: 'D', amount: 590 },
      { lineNo: 2, account: 'BANK', accountName: 'בנק', side: 'C', amount: 590 }], debit: 590, credit: 590 },
  ] });
  assert.ok(canReverseEntry(j.entries[1]) && !canReverseEntry(j.entries[0]), 'only a manual one');
  assert.ok(!canReverseEntry({ ...j.entries[1], reversedBy: 'e3' }) && !canReverseEntry({ ...j.entries[1], reverses: 'e0' }), 'once; never a reversal');
  const jt = bookJournalTable(j);
  assert.equal(jt.rows.length, 4, 'a row per line');
  assert.deepEqual(jt.rows[1], [null, '', '', '3100 · יתרות פתיחה', null, 100], 'the entry\'s number and details on its first line only');
  assert.deepEqual(jt.total, [null, '', '2 פקודות', '', 690, 690]);
  const p = toProfitLoss({ from: '2026-12-01', to: '2026-12-31', income: { total: 500, accounts: [{ key: '4100', name: 'הכנסות משירותים', tbCode: '4000', tbName: 'הכנסות', amount: 500 }] },
    expenses: { total: 590, accounts: [{ key: '6112', name: 'עמלות', tbCode: '6100', tbName: 'הוצאות', amount: 590 }] }, profit: -90 });
  const pt = profitLossTable(p);
  assert.deepEqual(pt.total, ['', 'הפסד', -90]);
  assert.equal(tableCsv(pt).split('\r\n').at(-1), q('', 'הפסד', '-90.00'));
  const b = toBalanceSheet({ asOf: '2026-12-31', assets: { total: 1000 }, liabilities: { total: 90 }, equity: { total: 1000 }, earnings: -90, liabilitiesAndEquity: 1000, balanced: true });
  const bt = balanceSheetTable(b);
  assert.deepEqual(bt.rows.at(-1), ['', 'רווח (הפסד) שטרם נסגר', -90], 'the earnings line');
  assert.deepEqual(bt.total, ['', 'סה״כ התחייבויות והון', 1000]);
  assert.match(bt.note!, /מאוזן/);
  assert.match(balanceSheetTable({ ...b, balanced: false }).note!, /לא מאוזן/);
  const r = toReconcile({ from: START, to: '2026-12-31', start: START, same: false, rows: [
    { area: 'income', books: 500, explained: 0, source: 500, difference: 0 }, { area: 'cash', books: 100, explained: 0, source: 99.99, difference: 0.01 }] });
  assert.deepEqual(r.rows.map(reconDiffers), [false, true], 'an agora is a difference');
  assert.deepEqual(reconcileTable(r).rows[1], ['מזומן בקופות', 100, 0, 99.99, 0.01]);
});

test('the database\'s refusals in Hebrew — never its amounts or keys', () => {
  const he = (message: string) => financeError({ message, code: '23514' });
  assert.equal(he('manual_unbalanced: הפקודה לא מאוזנת — חובה 100.00 , זכות 99.00'), 'הפקודה לא מאוזנת — סך החובה צריך להיות שווה לסך הזכות.');
  assert.doesNotMatch(he('manual_unbalanced: הפקודה לא מאוזנת — חובה 100.00 , זכות 99.00'), /\d/);
  assert.match(he('account_balance: בחשבון יש יתרה (250.00) — מאפסים'), /מאפסים אותה בפקודה/);
  assert.doesNotMatch(he('account_balance: בחשבון יש יתרה (250.00) — מאפסים'), /250/);
  assert.match(he('account_key_fixed: למפתח של חשבון שיש בו תנועות אין שינוי'), /אין שינוי/);
  assert.match(he('account_key: מפתח חשבון — 4 ספרות'), /4 ספרות/);
  assert.match(he('account_exists: כבר יש חשבון עם המפתח 6120'), /כבר יש חשבון/);
  assert.doesNotMatch(he('account_exists: כבר יש חשבון עם המפתח 6120'), /6120/);
  for (const [code, re] of [['account_parent', /חשבון האב/], ['account_kind', /נכס/], ['account_system', /של המערכת/], ['account_reserved', /שמור/],
    ['manual_date', /התאריך/], ['manual_before_start', /תחילת הספרים/], ['manual_details', /2 עד 50/], ['manual_lines', /500/], ['manual_account', /לוח החשבונות/],
    ['manual_line', /חובה או זכות/], ['manual_amount', /חובה או זכות/], ['manual_reversed', /כבר בוטלה/], ['manual_reverse', /לא מבטלים/],
    ['manual_entry', /רק פקודה ידנית/], ['opening_account', /לא נמצא/], ['opening_line', /חובה או זכות/], ['opening_lines', /2000/],
    ['ledger_account', /לא נמצא/]] as [string, RegExp][]) {
    assert.match(he(`${code}: x`), re, code);
    assert.equal(booksError(`${code}: x`) != null, true, code);
  }
  assert.match(he('opening_done: יתרות הפתיחה כבר נרשמו'), /כבר נרשמו/, 'the existing message stays');
  assert.match(he('books_not_allowed: רק הבעלים רושמים בספרים'), /רק הבעלים/);
  assert.equal(booksError('something else'), null);
});

test('7300 (contract to confirm): a supplier\'s opening line — offered only when the database says so; the suppliers of the expenses once each', () => {
  const base = { startDate: START, started: true, transactions: 0, openingEntered: false, canMoveStart: true, owner: true };
  assert.equal(openingSuppliersReady(toBooksState(base)), false, 'an older database — no supplier picker');
  assert.equal(openingSuppliersReady(toBooksState({ ...base, openingSuppliers: true })), true);
  assert.deepEqual(toBooksState(base), base, 'the state as before when the database does not say it');
  const rows = [
    { supplier_name: 'ספק דמו בע״מ', supplier_dealer: '000000109' }, { supplier_name: 'ספק דמו', supplier_dealer: '000000109' },
    { supplier_name: 'חשמל  דמו', supplier_dealer: '' }, { supplier_name: 'חשמל דמו', supplier_dealer: null }, { supplier_name: '!!!', supplier_dealer: '' },
    { supplier_name: 'Acme', supplier_dealer: '12' },
  ];
  assert.deepEqual(supplierChoices(rows), [{ dealer: '', name: 'חשמל  דמו' }, { dealer: '000000109', name: 'ספק דמו בע״מ' }, { dealer: '', name: 'Acme' }],
    'by dealer number, else the normalized name (as party_key); a dealer that is not 9 digits is none; a name of no letters is left out');
  assert.deepEqual(supplierChoices(rows, '000000'), [{ dealer: '000000109', name: 'ספק דמו בע״מ' }]);
  assert.deepEqual(supplierChoices(rows, 'חשמל').map((x) => x.name), ['חשמל  דמו']);
  const line = { account: '', name: '', side: 'C' as const, amount: '300', customer: false, supplier: { dealer: '000000109', name: 'ספק דמו בע״מ' } };
  assert.deepEqual(openingProblems([line], CHART), []);
  assert.deepEqual(openingArgs([line], CHART), [{ supplier: { dealer: '000000109', name: 'ספק דמו בע״מ' }, side: 'C', amount: 300 }]);
  assert.deepEqual(openingBalance([line]), { debit: 0, credit: 30000, toOpening: -30000 });
  assert.match(openingProblems([{ ...line, supplier: { dealer: '12', name: 'x' } }], CHART).join(), /9 ספרות/);
  assert.match(openingProblems([{ ...line, supplier: { dealer: '', name: '' } }], CHART).join(), /שם או מספר עוסק/);
});
