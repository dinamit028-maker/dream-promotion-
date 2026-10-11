/**
 * The money desks, deposits, cheques and the bank's reconciliation (2.95, docs/FINANCE_ADDITIONS_HE.md T9): reading the database's
 * answers, what a deposit may not be, a cheque's due day, the report of the cheques deposited; reading a file of the bank (CSV in
 * UTF-8 or Windows-1255, Excel, the HTML "xls"), finding its columns, its amounts and days; and the suggestions — by amount to the
 * agora and by date, each line and each receipt once. The database keeps the same rules (tests/sql/cash-bank.check.sql).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  DESK_METHODS, chequeDue, chequesTable, depositErrors, depositTotal, deskValue, toChequeBook, toDeposits, toDesks,
} from '../src/features/finance/desks';
import {
  chosenGap, decodeText, detectColumns, fileSummary, parseAmount, parseCsv, parseDate, parseHtmlTable, parseXlsx, readBankFile, suggest, toBankBook,
  toBankLines, toCandidates, type BankLine, type DepositCard, type PayCard,
} from '../src/features/finance/bank';
import { tableCsv } from '../src/features/finance/statements';
import { financeError } from '../src/features/finance/rows';

test('the desks: every method in order, whatever the database left out; the cash and cheques as the database says', () => {
  const d = toDesks({ methods: [{ method: 'bit', in: 118, out: 0, count: 1 }, { method: 'cash', in: '790', out: 118, count: 3 }], cash: 672,
    cheques: { count: 3, total: 2200, dueCount: 2, dueTotal: 1700 }, deposits: { count: 0, total: 0 }, remindDays: 3, today: '2026-10-11' });
  assert.deepEqual(d.methods.map((m) => m.method), DESK_METHODS);
  assert.deepEqual(d.methods.map((m) => m.in), [790, 0, 0, 0, 118, 0]);
  assert.equal(deskValue(d, 'cash').value, 672, 'the cash desk: what it holds now');
  assert.match(deskValue(d, 'cash').sub, /נכנס ₪790/);
  assert.equal(deskValue(d, 'cheque').value, 2200, 'cheques: what is in the drawer');
  assert.match(deskValue(d, 'cheque').sub, /3 צ׳קים · 2 לפירעון בקרוב/);
  assert.equal(deskValue(d, 'bit').value, 118, 'the rest: what came in in the period');
  assert.equal(deskValue(d, 'other').sub, 'אין תנועות');
  const empty = toDesks(null);
  assert.equal(empty.cash, 0); assert.equal(empty.remindDays, 3); assert.equal(empty.methods.length, 6);
});

test('a cheque\'s day: past it, within the reminder\'s days, later — or none written', () => {
  assert.equal(chequeDue('2026-10-10', '2026-10-11', 3), 'overdue');
  assert.equal(chequeDue('2026-10-11', '2026-10-11', 3), 'soon', 'today is soon');
  assert.equal(chequeDue('2026-10-14', '2026-10-11', 3), 'soon', 'the last day of the window');
  assert.equal(chequeDue('2026-10-15', '2026-10-11', 3), 'later');
  assert.equal(chequeDue('2026-10-12', '2026-10-11', 0), 'later', '0 days: only overdue counts');
  assert.equal(chequeDue(null, '2026-10-11', 3), 'none');
  assert.equal(chequeDue('soon', '2026-10-11', 3), 'none');
  assert.equal(chequeDue('2026-11-01', '2026-10-30', 3), 'soon', 'across a month');
});

test('a deposit: cash never more than the desk holds, agorot only, something to deposit, today or before', () => {
  const ok = { cash: 400, cheques: 1, desk: 472, date: '2026-10-11', today: '2026-10-11' };
  assert.deepEqual(depositErrors(ok), []);
  assert.match(depositErrors({ ...ok, cash: 472.01 }).join(), /רשומים רק ₪472/, 'one agora over');
  assert.deepEqual(depositErrors({ ...ok, cash: 472 }), [], 'all of it');
  assert.match(depositErrors({ ...ok, cash: 10.555 }).join(), /עד אגורות/);
  assert.match(depositErrors({ ...ok, cash: -1 }).join(), /מספר חיובי/);
  assert.match(depositErrors({ ...ok, cash: 0, cheques: 0 }).join(), /מה מפקידים/);
  assert.deepEqual(depositErrors({ ...ok, cash: 0, cheques: 2 }), [], 'cheques only');
  assert.match(depositErrors({ ...ok, cheques: 201 }).join(), /עד 200/);
  assert.match(depositErrors({ ...ok, date: '2026-10-12' }).join(), /היום או לפני/);
  assert.match(depositErrors({ ...ok, desk: -50, cash: 1 }).join(), /רשומים רק ₪0/, 'a desk below zero holds nothing to deposit');
  assert.equal(depositTotal(0.1, [{ amount: 0.2 }]), 0.3, 'to the agora');
  assert.equal(depositTotal(400, [{ amount: 1000 }, { amount: 500.5 }]), 1900.5);
});

test('the cheque book, the deposits and the report of the cheques deposited', () => {
  const b = toChequeBook({
    drawer: [{ id: 'c3', amount: '500.00', paidOn: '2026-10-11', number: '1002', bank: '10', dueDate: '2026-10-31', docType: 400, docNumber: 3, customer: 'גלית', location: 'L1', matched: false, deposit: null }],
    deposited: [{ id: 'c1', amount: 1000, number: '1001', bank: '12', branch: '600', account: '', dueDate: '2026-10-13', docType: 400, docNumber: 2, customer: 'בני',
      deposit: { id: 'd1', number: 1, date: '2026-10-11' } }],
  });
  assert.equal(b.drawer[0].amount, 500); assert.equal(b.drawer[0].deposit, null); assert.equal(b.deposited[0].deposit?.number, 1);
  assert.deepEqual(toChequeBook(null), { drawer: [], deposited: [] });
  const t = chequesTable(b.deposited);
  assert.deepEqual(t.rows[0], ['2026-10-11', 1, '1001', '12', '600', '', '2026-10-13', 'בני', '400-2', 1000]);
  assert.deepEqual(t.total, ['סה״כ', null, '', '', '', '', '', '1 צ׳קים', '', 1000]);
  assert.ok(tableCsv(t).includes('"11/10/2026","1","1001","12","600","","13/10/2026","בני","400-2","1000.00"'), 'the CSV: days as days, money as numbers');
  assert.equal(chequesTable([]).total, null, 'nothing deposited: no total line');
  const deps = toDeposits([{ id: 'd2', number: 2, date: '2026-10-11', cash: 200, cheques: 700, total: 900, status: 'cancelled', cancelReason: 'בטעות', matched: false,
    items: [{ payment: 'p8', amount: 700, number: '2001', bank: '11', dueDate: null, customer: 'זיו', docType: 400, docNumber: 8 }] }, { id: 'x' }]);
  assert.equal(deps[0].status, 'cancelled'); assert.equal(deps[0].items[0].customer, 'זיו');
  assert.equal(deps[1].status, 'active', 'anything else is active'); assert.deepEqual(deps[1].items, []);
  assert.deepEqual(toDeposits(null), []);
});

test('amounts as the banks write them', () => {
  const cases: [string, number | null][] = [
    ['1,234.56', 1234.56], ['-1,234.56', -1234.56], ['1,234.56-', -1234.56], ['(1,234.56)', -1234.56], ['₪ 1,234.56', 1234.56], ['1.234,56', 1234.56],
    ['12,50', 12.5], ['+50', 50], ['‏-50', -50], ['0', 0], ['100 ש"ח', 100], ['1,000', 1000], ['', null], ['abc', null], ['12.3.4', null], ['--5', null],
  ];
  for (const [s, n] of cases) assert.equal(parseAmount(s), n, s);
  assert.equal(parseAmount('354.555'), 354.56, 'rounded to the agora');
});

test('days as the banks write them — and only real days', () => {
  const cases: [string, string | null][] = [
    ['31/12/2026', '2026-12-31'], ['31.12.26', '2026-12-31'], ['1-2-2026', '2026-02-01'], ['2026-02-28', '2026-02-28'], ['2026-10-11T10:00:00', '2026-10-11'],
    ['01/10/2026 13:45', '2026-10-01'], ['30/02/2026', null], ['2026-02-30', null], ['46022', '2025-12-31'], ['46023.5', '2026-01-01'], ['13/13/2026', null],
    ['', null], ['אתמול', null], ['1999-12-31', null], ['12345', null],
  ];
  for (const [s, d] of cases) assert.equal(parseDate(s), d, s);
});

test('CSV: the separator the header uses, quotes as Excel writes them, empty rows out', () => {
  assert.deepEqual(parseCsv('a,b,c\r\n1,"2,5","say ""hi"""\r\n\r\n4,5,6\n'), [['a', 'b', 'c'], ['1', '2,5', 'say "hi"'], ['4', '5', '6']]);
  assert.deepEqual(parseCsv('תאריך;סכום\n01/10/2026;1.234,56'), [['תאריך', 'סכום'], ['01/10/2026', '1.234,56']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\n"line\nbreak",2'), [['a', 'b'], ['line\nbreak', '2']], 'a new line inside quotes stays in the cell');
});

test('the text of a file: UTF-8 (with its mark), else the Windows-1255 Hebrew of the banks', () => {
  const he = (s: string) => Array.from(s, (c) => (c >= 'א' && c <= 'ת' ? c.charCodeAt(0) - 0x5d0 + 0xe0 : c.charCodeAt(0)));
  assert.equal(decodeText(new Uint8Array(he('תאריך,סכום\r\n'))), 'תאריך,סכום\r\n', 'Windows-1255');
  assert.equal(decodeText(new TextEncoder().encode('﻿תאריך')), 'תאריך', 'UTF-8 with its mark');
  assert.equal(decodeText(new TextEncoder().encode('תאריך')), 'תאריך');
});

test('the columns: found by their names under the bank\'s title rows — debit and credit, or one signed amount', () => {
  const g = parseCsv([
    'בנק לאומי לישראל', 'חשבון 800-12345', '',
    'תאריך,תאריך ערך,תיאור,אסמכתא,חובה,זכות,יתרה בש"ח',
    '01/10/2026,02/10/2026,העברה מדנה,111,,236.00,"1,236.00"',
    '02/10/2026,02/10/2026,ספק ציוד,222,354.00,,882.00',
    'סה"כ,,,,354.00,236.00,',
    '03/10/2026,03/10/2026,עמלה,,"12.50",,869.50',
  ].join('\n'));
  const m = detectColumns(g)!;
  assert.deepEqual(m, { header: 2, date: 0, description: 2, reference: 3, amount: -1, debit: 4, credit: 5, balance: 6 }, 'the day, not the value day');
  const r = toBankLines(g, m);
  assert.deepEqual(r.lines, [
    { date: '2026-10-01', amount: 236, description: 'העברה מדנה', reference: '111', balance: 1236 },
    { date: '2026-10-02', amount: -354, description: 'ספק ציוד', reference: '222', balance: 882 },
    { date: '2026-10-03', amount: -12.5, description: 'עמלה', reference: '', balance: 869.5 },
  ]);
  assert.equal(r.skipped, 1, 'the total row');
  assert.deepEqual(fileSummary(r.lines), { count: 3, from: '2026-10-01', to: '2026-10-03', in: 236, out: 366.5 });
  const en = detectColumns([['Date', 'Description', 'Amount', 'Balance'], ['2026-10-01', 'x', '-5', '10']])!;
  assert.deepEqual([en.date, en.description, en.amount, en.balance], [0, 1, 2, 3]);
  const pre = detectColumns([['תאריך התנועה בבנק', 'פרטי הפעולה', 'סכום בש"ח']])!;
  assert.deepEqual([pre.date, pre.description, pre.amount], [0, 1, 2], 'a header that starts with a name');
  assert.equal(detectColumns([['א', 'ב'], ['1', '2']]), null, 'no day and no amount: the owner points at the columns');
});

test('an Excel file (xlsx): its first sheet, shared texts, numbers and day numbers', async () => {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="תנועות" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/sharedStrings.xml', '<sst><si><t>תאריך</t></si><si><t>תיאור</t></si><si><t>סכום</t></si><si><r><t>העברה </t></r><r><t>מדנה &amp; בנה</t></r></si></sst>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
    + '<row r="2"><c r="A2"><v>46296</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>236.5</v></c></row>'
    + '<row r="3"><c r="A3" t="inlineStr"><is><t>02/10/2026</t></is></c><c r="C3"><v>-354</v></c></row>'
    + '</sheetData></worksheet>');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const g = await parseXlsx(bytes);
  assert.deepEqual(g, [['תאריך', 'תיאור', 'סכום'], ['46296', 'העברה מדנה & בנה', '236.5'], ['02/10/2026', '', '-354']]);
  const r = await readBankFile('x.xlsx', bytes);
  assert.ok(r.ok && r.kind === 'xlsx');
  const lines = toBankLines(g, detectColumns(g)!).lines;
  assert.deepEqual(lines.map((l) => [l.date, l.amount, l.description]), [['2026-10-01', 236.5, 'העברה מדנה & בנה'], ['2026-10-02', -354, '']]);
});

test('the HTML "xls" some banks send, and the files that are not read', async () => {
  const html = '<html><body><table><tr><th>תאריך</th><th>תיאור&nbsp;התנועה</th><th>זכות</th><th>חובה</th></tr>'
    + '<tr><td>01/10/2026</td><td>הפקדה <b>במזומן</b> &amp; צ׳ק</td><td>1,472.00</td><td></td></tr></table></body></html>';
  const g = parseHtmlTable(html);
  assert.deepEqual(g, [['תאריך', 'תיאור התנועה', 'זכות', 'חובה'], ['01/10/2026', 'הפקדה במזומן & צ׳ק', '1,472.00', '']]);
  const r = await readBankFile('tnuot.xls', new TextEncoder().encode(html));
  assert.ok(r.ok && r.kind === 'html');
  assert.deepEqual(toBankLines(g, detectColumns(g)!).lines[0].amount, 1472);
  const old = await readBankFile('old.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]));
  assert.ok(!old.ok && /xlsx|CSV/.test(old.error), 'an old Excel file: save it as xlsx or CSV');
  const pdf = await readBankFile('x.pdf', new TextEncoder().encode('%PDF-1.4'));
  assert.ok(!pdf.ok && /PDF/.test(pdf.error));
  assert.ok(!(await readBankFile('x.csv', new Uint8Array())).ok, 'an empty file');
  assert.ok(!(await readBankFile('x.xlsx', new Uint8Array([0x50, 0x4b, 1, 2]))).ok, 'a broken Excel file is said so, not thrown');
});

const line = (id: string, date: string, amount: number, status: BankLine['status'] = 'open'): BankLine =>
  ({ id, date, description: id, reference: '', amount, balance: null, status, note: '', account: '', statement: 's', matches: [] });
const pay = (id: string, paidOn: string, amount: number, direction: 'in' | 'out' = 'in'): PayCard =>
  ({ id, direction, amount, method: 'transfer', paidOn, source: 'document', docType: 400, docNumber: 1, customer: '', expenseNumber: null, supplier: '', note: '', cheque: null });
const dep = (id: string, date: string, total: number): DepositCard => ({ id, number: 1, date, cash: total, cheques: 0, total, count: 0 });

test('the suggestions: the same amount to the agora, a few days apart, the closest first, each line and each receipt once', () => {
  const lines = [line('L1', '2026-10-05', 236), line('L2', '2026-10-06', 236), line('L3', '2026-10-06', -354), line('L4', '2026-10-07', 1472),
    line('L5', '2026-10-07', 100, 'matched'), line('L6', '2026-10-20', 99.99), line('L7', '2026-10-07', 500)];
  const c = { payments: [pay('P1', '2026-10-06', 236), pay('P2', '2026-10-01', 236), pay('E1', '2026-10-05', 354, 'out'), pay('P3', '2026-10-07', 354),
    pay('P4', '2026-10-07', 100), pay('P5', '2026-10-20', 100), pay('P6', '2026-10-30', 500)], deposits: [dep('D1', '2026-10-06', 1472), dep('D2', '2026-10-07', 500)] };
  const s = suggest(lines, c);
  assert.deepEqual(s.get('L2'), { lineId: 'L2', kind: 'payment', id: 'P1', days: 0 }, 'the same day wins the receipt');
  assert.deepEqual(s.get('L1'), { lineId: 'L1', kind: 'payment', id: 'P2', days: 4 }, 'the other line takes the other receipt');
  assert.equal(s.get('L3')?.id, 'E1', 'money out meets a payment out — never a receipt of the same amount');
  assert.deepEqual(s.get('L4'), { lineId: 'L4', kind: 'deposit', id: 'D1', days: 1 }, 'a deposit');
  assert.equal(s.has('L5'), false, 'a matched line is not suggested');
  assert.equal(s.has('L6'), false, 'an agora apart is not the same');
  assert.equal(s.get('L7')?.id, 'D2', 'the deposit of the same day, not the receipt 23 days away');
  assert.equal(suggest([line('L8', '2026-10-01', 100)], { payments: [pay('P9', '2026-10-09', 100)], deposits: [] }).size, 0, 'more than 7 days apart');
  assert.equal(suggest([line('L8', '2026-10-01', 100)], { payments: [pay('P9', '2026-10-09', 100)], deposits: [] }, 10).size, 1, 'unless the window is wider');
  assert.equal(suggest([line('L9', '2026-10-01', -100)], { payments: [], deposits: [dep('D9', '2026-10-01', 100)] }).size, 0, 'a deposit never on money out');
});

test('what the owner chose for a line, against it; the book and the candidates as the database says', () => {
  assert.equal(chosenGap({ amount: 418 }, [{ amount: 118 }, { amount: 300 }]), null, 'two receipts, one line');
  assert.equal(chosenGap({ amount: -354 }, [{ amount: 354 }]), null, 'money out: its size');
  assert.equal(chosenGap({ amount: 418 }, [{ amount: 118 }]), 300, 'still missing');
  assert.equal(chosenGap({ amount: 0.3 }, [{ amount: 0.1 }, { amount: 0.2 }]), null, 'to the agora');
  const b = toBankBook({ lines: [{ id: 'l', date: '2026-10-01', description: 'x', amount: '418.00', status: 'matched', matches: [
    { id: 'm1', amount: 118, payment: { id: 'p', direction: 'in', amount: 118, method: 'bit', paidOn: '2026-10-01', source: 'document', docType: 400, docNumber: 6, customer: 'הדר' } },
    { id: 'm2', amount: 900, deposit: { id: 'd', number: 2, date: '2026-10-01', cash: 200, cheques: 700 } }] }, { id: 'z', status: 'weird' }], statements: [{ id: 's', file: 'f.csv', total: 10, added: 9 }] });
  assert.equal(b.lines[0].amount, 418); assert.equal(b.lines[0].matches[0].payment?.customer, 'הדר'); assert.equal(b.lines[0].matches[1].deposit?.number, 2);
  assert.equal(b.lines[1].status, 'open', 'anything else is open'); assert.equal(b.statements[0].added, 9);
  assert.deepEqual(toCandidates(null), { payments: [], deposits: [] });
  assert.equal(toCandidates({ deposits: [{ id: 'd', number: 3, cash: 472, cheques: 1000 }] }).deposits[0].total, 1472, 'a deposit\'s total is its cash and cheques');
});

test('the cheques\' reminder: one notification a business — one cheque by its number, several by count — and nothing before the migration', async () => {
  const { chequePush, chequeRemindersCron } = await import('../src/lib/server/cash');
  const one = chequePush({ business: 'b1', count: 1, total: 1000, firstDue: '2026-10-13', cheques: [{ number: '1001', amount: 1000, due: '2026-10-13', customer: 'בני' }] });
  assert.equal(one.title, 'צ׳קים לפירעון');
  assert.equal(one.body, 'צ׳ק 1001 של בני · ₪1,000 · לפירעון 13/10 — להפקיד');
  assert.equal(one.url, '/finance/cash?tab=cheques'); assert.equal(one.tag, 'cheques:b1');
  const many = chequePush({ business: 'b1', count: 2, total: 330, firstDue: '2026-10-06', cheques: [] });
  assert.equal(many.body, '2 צ׳קים · ₪330 · הראשון לפירעון 06/10 — להפקיד');
  const calls: string[] = [];
  const db = (rpc: { data: unknown; error: unknown }) => ({
    rpc: async (fn: string) => { calls.push(fn); return rpc; },
    from: () => ({ select: () => ({ eq: async () => ({ data: [{ user_id: 'u1', access: 'full' }, { user_id: 'k1', access: 'register' }], error: null }) }) }),
  });
  (globalThis as any).__DP_TEST_ADMIN_DB__ = db({ data: null, error: { message: 'Could not find the function public.cheque_reminders_claim in the schema cache' } });
  assert.equal(await chequeRemindersCron(), null, 'before migration 5000: nothing, and no error');
  (globalThis as any).__DP_TEST_ADMIN_DB__ = db({ data: [{ business: 'b1', count: 2, total: 330, firstDue: '2026-10-06', cheques: [] }, { business: 'b2', count: 1, total: 60, firstDue: '2026-10-12', cheques: [] }], error: null });
  assert.deepEqual(await chequeRemindersCron(), { businesses: 2, cheques: 3, sent: 0 }, 'two businesses, three cheques (no phone is subscribed here)');
  (globalThis as any).__DP_TEST_ADMIN_DB__ = db({ data: null, error: { message: 'boom' } });
  await assert.rejects(() => chequeRemindersCron(), /boom/, 'another failure is said');
  delete (globalThis as any).__DP_TEST_ADMIN_DB__;
  assert.deepEqual(calls, ['cheque_reminders_claim', 'cheque_reminders_claim', 'cheque_reminders_claim']);
});

test('every refusal of the desks, the deposits, the bank and the goods documents says its own thing in Hebrew', () => {
  // the database's own words (migration 20261011005000) → what the screen says; each one its own sentence
  const said: [string, RegExp][] = [
    ['deposit_cheques: up to 200 cheques in a deposit', /עד 200 צ׳קים/],
    ['deposit_cheque: a cheque received on a receipt of the business', /רק צ׳ק שהתקבל בקבלה/],
    ['deposit_cheque_taken: a cheque is no longer in the drawer (deposited, matched to the bank or its receipt cancelled)', /כבר לא בקופה/],
    ["deposit_cheque_location: the cheques of the deposit's location", /של אותו סניף/],
    ['deposit_cash_over: the cash desk holds 72.00', /רשומים רק ₪72\./],
    ['deposit_cash: an amount of money', /סכום המזומן לא תקין/],
    ['deposit_empty: cash or cheques to deposit', /מה מפקידים/],
    ['deposit_date: a deposit is dated today or before', /היום או לפני/],
    ['deposit_matched: the bank already matched this deposit — undo that match first', /כבר הותאמה לבנק/],
    ['deposit_location: a location of the business', /בוחרים סניף/],
    ['bank_lines: 1 to 5,000 lines in a file', /עד 5,000 שורות/],
    ['bank_lines: each line has a date, an amount (not zero) and its text', /שורות הקובץ לא תקינות/],
    ['bank_lines: a list of lines', /שורות הקובץ לא תקינות/],
    ['bank_line_closed: the line is already matched or handled', /כבר הותאמה או טופלה/],
    ['bank_line_not_matched: the line is not matched', /כבר לא במצב הזה/],
    ['bank_match_sum: the chosen add up to 118.00 but the line is 418.00', /לא שווה לשורה/],
    ['bank_match_sign: money that came in meets a line of money in; money paid, a line of money out', /לשורת זכות/],
    ['bank_match_items: one to 50 receipts, payments or deposits', /בין 1 ל-50/],
    ['bank_match_item: only money that went through the bank (cash and deposited cheques meet it in their deposit)', /רק כסף שעבר בבנק/],
    ['bank_match_item: a cancelled deposit', /הפקדה שבוטלה/],
    ['bank_match_taken: one of them is already matched to another line', /כבר הותאם לשורה אחרת/],
    ["not allowed: the bank is the whole business's", /רק למי שרואה את כל הסניפים/],
    ['not allowed: this location is not yours', /הסניף הזה לא שלך/],
    ['reason_required: a reason or a note, two letters at least', /סיבה או הערה/],
    ['goods_off: orders, delivery notes and return notes are for a business that sells products (turned on in the settings)', /מכירת מוצרים/],
    ['goods_return_base: a return note is made from a delivery note', /מתוך תעודת המשלוח/],
    ['goods_base_receipt: a receipt for an invoice is not made from an order or a delivery note', /קבלה על חשבונית לא מופקת/],
    ['goods_base_missing: the order / delivery note was not found in this business', /לא נמצאה בעסק/],
    ['goods_base_cancelled: the order / delivery note was cancelled', /בוטלה — לא מפיקים/],
    ['goods_invoiced: the delivery note was already invoiced', /כבר חויבה בחשבונית/],
    ['goods_over_delivery: more than the delivery note left (קרם)', /יותר ממה שנשאר בתעודת המשלוח \(קרם\)/],
    ['cancel_has_followers: its delivery note was invoiced', /ההחזרה נשארת/],
    ['cancel_has_followers: a document was made from it — cancel that one first', /הופק ממנו מסמך/],
  ];
  for (const [message, hebrew] of said) assert.match(financeError({ message }), hebrew, message);
  // a document's own "lines:" still says what it said
  assert.match(financeError({ message: 'lines: the lines add up to 100 but the document says 118' }), /הסכומים במסמך/);
});
