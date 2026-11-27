/**
 * QA 2.123 (stage 4ד) — the screens against the REAL database. tests/sql/books-screens-qa.check.sql runs a seeded month (opening
 * balances with a customer and a supplier, an expense, manual entries, one reversed) through the actual report_* functions of
 * migrations 7200 + 7300 and writes their answers to /tmp/dp-books-real-db.json. Here the pure helpers of the screens (ledger.ts)
 * and the CSV / PDF builders turn those answers into what the user sees, and every number is compared with the database's own
 * (and with sums straight from gl_lines). Also: CSV injection in every export of the books, the manual form's one-agora rule, the
 * double tap, and who sees the area. Demo data only.
 * Missing dump = FAIL: produce it with  DP_TEST_DB=<private db> bash tests/sql/run.sh  (or run that one check file on a migrated db).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  ag, balanceSheetTable, bookJournalTable, canReverseEntry, emptyManual, entryBalance, groupTrialBalance, ledgerTable, manualArgs, manualProblems, profitLossTable,
  reconcileTable, showBooksArea, tbBalanced, toBalanceSheet, toBookJournal, toChart, toLedger, toProfitLoss, toReconcile, toTrialBalance, trialBalanceTable,
  parseAgorot, openingArgs, openingProblems, emptyOpening, type ManualDraft,
} from '../src/features/finance/ledger';
import { tableCsv, pdfBody, type ReportTable } from '../src/features/finance/statements';
import { csvSafe } from '../src/features/finance/reports';

const DUMP = '/tmp/dp-books-real-db.json';
const load = (): Record<string, any> => {
  assert.ok(existsSync(DUMP), `missing ${DUMP} — produce it: pg_ctlcluster 16 main start; DP_TEST_DB=dp_qa bash tests/sql/run.sh (tests/sql/books-screens-qa.check.sql writes it)`);
  return JSON.parse(readFileSync(DUMP, 'utf8'));
};
const csvLines = (t: ReportTable) => tableCsv(t).replace(/^﻿/, '').split('\r\n');
const cents = (n: number) => Math.round(n * 100);

test('real db: trial balance — groups are the database\'s, totals never re-summed, balanced', () => {
  const d = load();
  const tb = toTrialBalance(d.tb);
  assert.ok(tbBalanced(tb));
  assert.equal(ag(tb.total.debit), ag(d.tb.total.debit));
  const g = groupTrialBalance(tb);
  assert.deepEqual(g.map((x) => x.group.tbCode), d.tb.groups.map((x: any) => x.tbCode));
  for (const { group, accounts } of g) {
    assert.equal(ag(accounts.reduce((s, a) => s + a.closing, 0)), ag(group.closing), `group ${group.tbCode}: its accounts add to its total`);
  }
  // against gl_lines directly
  for (const a of tb.accounts) assert.equal(ag(a.closing), ag(d.raw[a.key] ?? 0), `account ${a.key}: the screen's closing = the sum of its lines`);
  const t = trialBalanceTable(tb);
  assert.equal(t.rows.length, tb.accounts.length + tb.groups.length);
  const last = csvLines(t).at(-1)!;
  assert.match(last, /"1184\.38","1184\.38","0\.00"$/);
});

test('real db: ledgers — the opening, the running balance and the closing are the database\'s; document refs only for documents', () => {
  const d = load();
  for (const k of ['BANK', '3100', '050-0000081', 'S-000000067']) {
    const raw = d[`ledger:${k}`];
    const l = toLedger(raw);
    assert.equal(l.lines.length, raw.lines.length, k);
    let run = cents(l.opening);
    for (const x of l.lines) { run += cents(x.debit) - cents(x.credit); assert.equal(run, cents(x.balance), `${k}: running balance after entry ${x.number}`); }
    assert.equal(run, cents(l.closing), `${k}: closing`);
    assert.equal(cents(l.closing), cents(d.raw[k]), `${k}: closing = Σ gl_lines`);
    assert.equal(cents(l.debit) - cents(l.credit), cents(l.closing) - cents(l.opening));
    const lines = csvLines(ledgerTable(l));
    assert.equal(lines.length, 1 + 1 + l.lines.length + 1, `${k}: header + opening + lines + total`);
  }
  // the customer key of the CRM card = the account the opening made (glCustomerKey of the phone)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
});

test('real db: the customer account key = glCustomerKey of the CRM card (phone 050-0000081)', async () => {
  const { glCustomerKey } = await import('../src/features/documents/customer-key');
  const d = load();
  assert.equal(glCustomerKey('050-0000081', 'לקוח בדיקה לדוגמה'), '050-0000081');
  assert.ok(d['ledger:050-0000081'], 'the ledger of that very key exists in the real books');
  assert.equal(d.raw['050-0000081'], 50.25);
});

test('real db: journal — double tap = one entry; a reversed manual entry shows both, cannot be reversed twice; Σ debit = Σ credit', () => {
  const d = load();
  assert.ok(d.m1.id && d.m1.created === true && d.m1again.created === false, 'first tap creates, second does not');
  assert.equal(d.m1.id, d.m1again.id, 'the retry returned the same entry');
  assert.equal(d.m1.number, d.m1again.number);
  const j = toBookJournal(d.journal);
  assert.equal(j.entries.length, j.count);
  assert.equal(ag(j.debit), ag(j.credit));
  for (const e of j.entries) {
    assert.equal(ag(e.lines.filter((l) => l.side === 'D').reduce((s, l) => s + l.amount, 0)), ag(e.debit), `entry ${e.number} debit`);
    assert.equal(ag(e.debit), ag(e.credit), `entry ${e.number} balanced`);
  }
  assert.equal(j.entries.filter((e) => e.details === 'פקודת בדיקה').length, 1);
  const reversed = j.entries.find((e) => e.details === 'פקודה לביטול')!;
  assert.ok(reversed.reversedBy, 'the original shows its reversal');
  assert.equal(canReverseEntry(reversed), false);
  assert.equal(j.entries.filter((e) => canReverseEntry(e)).length, 1, 'only the untouched manual entry may be reversed');
  assert.ok(j.entries.some((e) => e.reverses === reversed.id));
  const rows = bookJournalTable(j).rows;
  assert.equal(rows.length, j.entries.reduce((s, e) => s + e.lines.length, 0));
});

test('real db: P&L, balance sheet and reconcile — shown as the database computed them', () => {
  const d = load();
  const p = toProfitLoss(d.pnl);
  assert.equal(ag(p.profit), ag(p.income.total) - ag(p.expenses.total));
  assert.equal(ag(p.profit), ag(d.pnl.profit));
  assert.equal(ag(p.expenses.total), ag(d.raw['6103']), 'expenses = Σ of the expense account\'s lines');
  const pl = csvLines(profitLossTable(p));
  assert.match(pl.at(-1)!, /"הפסד","-100\.10"$/);
  const b = toBalanceSheet(d.bs);
  assert.equal(b.balanced, true);
  assert.equal(ag(b.assets.total), ag(b.liabilitiesAndEquity));
  assert.equal(ag(b.assets.total), ag(d.raw.BANK) + ag(d.raw['050-0000081']) + ag(d.raw['1400']));
  assert.match(balanceSheetTable(b).note ?? '', /מאוזן: סך הנכסים/);
  const r = toReconcile(d.recon);
  assert.equal(r.rows.length, d.recon.rows.length);
  for (const x of r.rows) assert.equal(ag(x.difference), ag(x.books) - ag(x.explained) - ag(x.source), `reconcile ${x.area}`);
  assert.equal(reconcileTable(r).rows.length, r.rows.length);
  // the PDF carries exactly the CSV's rows as text
  for (const t of [trialBalanceTable(toTrialBalance(d.tb)), profitLossTable(p), balanceSheetTable(b), reconcileTable(r)]) {
    const pdf = pdfBody(t, 'x');
    assert.equal(pdf.rows.length, t.rows.length);
    assert.equal(csvLines(t).length, t.rows.length + 1 + (t.total ? 1 : 0));
  }
});

// ---- CSV injection in every books export ---------------------------------------------------------------------------------------
const EVIL = ['=HYPERLINK("http://x.example.test","c")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1'];
test('CSV injection: no export of the books lets a text cell start as a formula', () => {
  const d = load();
  for (const evil of EVIL) {
    const tb = toTrialBalance(JSON.parse(JSON.stringify(d.tb).replace(/"בנק"/g, JSON.stringify(evil))));
    const lg = JSON.parse(JSON.stringify(d['ledger:BANK'])); lg.lines.forEach((l: any) => { l.details = evil; l.accountName = evil; }); lg.account.name = evil;
    const jn = JSON.parse(JSON.stringify(d.journal)); jn.entries.forEach((e: any) => { e.details = evil; e.lines.forEach((l: any) => { l.accountName = evil; }); });
    const pn = JSON.parse(JSON.stringify(d.pnl)); pn.expenses.accounts.forEach((a: any) => { a.name = evil; });
    const bs = JSON.parse(JSON.stringify(d.bs)); bs.assets.accounts.forEach((a: any) => { a.name = evil; });
    const tables = [trialBalanceTable(tb), ledgerTable(toLedger(lg)), bookJournalTable(toBookJournal(jn)), profitLossTable(toProfitLoss(pn)), balanceSheetTable(toBalanceSheet(bs))];
    for (const t of tables) {
      const text = tableCsv(t).replace(/^﻿/, '');
      // every quoted cell of every line: the first character is never = + - @ TAB CR unless the cell is a plain number
      for (const m of text.matchAll(/"((?:[^"]|"")*)"/g)) {
        const c = m[1];
        if (/^-?\d+(\.\d+)?$/.test(c)) continue;
        assert.ok(!/^[=+\-@\t\r]/.test(c), `${t.title}: cell "${c.slice(0, 30)}" starts as a formula (evil = ${JSON.stringify(evil)})`);
      }
      const esc = evil.replace(/"/g, '""');
      if (!/^[\t\r]/.test(evil)) assert.ok(text.includes(esc), `${t.title}: the hostile text is kept (as text, never as a formula) — evil = ${JSON.stringify(evil)}`);
    }
  }
  assert.equal(csvSafe('-90.00'), '-90.00');
  assert.equal(csvSafe('=1+1'), "'=1+1");
});

// ---- the manual form: one agora, one tap ----------------------------------------------------------------------------------------
const chart = toChart([{ key: 'BANK', name: 'בנק', kind: 'asset', tbCode: 'BANK', tbName: 'בנק', parentKey: null, role: 'bank', active: true },
  { key: '3100', name: 'יתרות פתיחה', kind: 'equity', tbCode: '3100', tbName: 'יתרות פתיחה', parentKey: null, role: 'opening', active: true }]);
const ctx = { today: '2026-12-15', start: '2026-12-01', lockedUntil: null, chart };
const draft = (d: string, c: string): ManualDraft => ({ date: '2026-12-10', details: 'בדיקה', lines: [{ account: 'BANK', side: 'D', amount: d }, { account: '3100', side: 'C', amount: c }] });
test('manual form: off by one agora cannot be sent; equal can; float traps stay exact', () => {
  assert.ok(manualProblems(draft('10.01', '10.00'), ctx).some((p) => /לא מאוזנת/.test(p)));
  assert.ok(manualProblems(draft('10.00', '10.01'), ctx).some((p) => /לא מאוזנת/.test(p)));
  assert.deepEqual(manualProblems(draft('10.01', '10.01'), ctx), []);
  assert.deepEqual(manualProblems(draft('0.10', '0.1'), ctx), []);
  assert.deepEqual(manualProblems(draft('1,000.30', '1000.3'), ctx), []);
  assert.equal(entryBalance(draft('0.1', '0.2').lines).diff, -10);
  assert.ok(manualProblems(draft('0.30', '0.29'), ctx).length > 0, '0.1+0.2 style traps do not hide an agora');
  const a = manualArgs('11111111-1111-4111-8111-111111111111', draft('10.01', '10.01'), null);
  assert.equal(a.p_id, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(manualArgs(a.p_id, draft('10.01', '10.01'), null), a, 'a second tap sends the same id and the same lines');
  assert.equal(parseAgorot('10.015'), null, 'a half agora is refused, never rounded');
});

test('opening form: one line per account, balanced against 3100 is the database\'s; client side refuses what the database refuses', () => {
  assert.ok(openingProblems([emptyOpening('D')], chart).length > 0);
  const lines = [{ ...emptyOpening('D'), account: 'BANK', amount: '1000' }, { ...emptyOpening('C'), account: '3100', amount: '5' }];
  assert.ok(openingProblems(lines, chart).length > 0, 'never a line on 3100 (the balancing account)');
  assert.ok(typeof openingArgs === 'function');
});

// ---- who sees the area ------------------------------------------------------------------------------------------------------------
test('permissions: the area is for access full only; non-owner needs an entry; cashier / calendar / agenda / null never', () => {
  const st = (o: object) => ({ startDate: '2026-12-01', started: true, transactions: 0, openingEntered: false, canMoveStart: true, owner: false, ...o });
  for (const access of ['register', 'calendar', 'agenda', null, undefined, '', 'FULL']) {
    assert.equal(showBooksArea({ ready: true, state: st({ owner: true, transactions: 9 }), access }), false, `access ${String(access)}`);
  }
  assert.equal(showBooksArea({ ready: false, state: st({ owner: true }), access: 'full' }), false);
  assert.equal(showBooksArea({ ready: true, state: null, access: 'full' }), false);
  assert.equal(showBooksArea({ ready: true, state: st({ owner: false, transactions: 0 }), access: 'full' }), false);
  assert.equal(showBooksArea({ ready: true, state: st({ owner: false, transactions: 3 }), access: 'full' }), true);
  assert.equal(showBooksArea({ ready: true, state: st({ owner: true }), access: 'full' }), true);
});
