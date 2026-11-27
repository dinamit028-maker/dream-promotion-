/**
 * 2.123 — CSV injection: every report file of the money module is made by reports.ts csv(); a text cell that a spreadsheet would run
 * as a formula (= + - @, a tab, a CR at its start) gets a leading apostrophe; numbers — also negative ones, as our money helpers
 * write them — stay numbers. Demo data only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csv, csvSafe } from '../src/features/finance/reports';
import { tableCsv } from '../src/features/finance/statements';

test('a formula in a text cell is neutralized; numbers stay numbers', () => {
  for (const bad of ['=HYPERLINK("http://example.test","לחצו")', '+972501234567', '-cmd', '@SUM(A1)', '\tתו', '\rשורה']) {
    assert.equal(csvSafe(bad), `'${bad}`, JSON.stringify(bad));
  }
  for (const ok of ['-90.00', '1180.10', '0', '-5', 'דנה כהן', '−₪50', '02/12/2026', '', 'a=b']) assert.equal(csvSafe(ok), ok, ok);
  assert.equal(csvSafe(-90), '-90', 'a number is never touched');
  assert.equal(csvSafe(null), '');
});

test('a customer named "=HYPERLINK(...)" in a report file — text in the spreadsheet, the totals as numbers', () => {
  const name = '=HYPERLINK("http://example.test/x","לקוח")';
  const file = tableCsv({ title: 'לפי לקוח', columns: [{ label: 'לקוח', type: 'text' }, { label: 'סכום', type: 'money' }],
    rows: [[name, -90], ['@לקוח', 1180.1]], total: ['סה״כ', 1090.1] });
  const lines = file.split('\r\n');
  assert.equal(lines[1], `"'=HYPERLINK(""http://example.test/x"",""לקוח"")","-90.00"`);
  assert.equal(lines[2], `"'@לקוח","1180.10"`);
  assert.equal(lines[3], '"סה״כ","1090.10"');
  assert.equal(csv(['א'], [['=1+1']]).split('\r\n')[1], `"'=1+1"`);
});

// ---- the register's and the time clock's files (salesCsv, commissionsCsv, reportCsv) — the same rule ------------------------------
import { csvCell } from '../src/lib/csv-safe';
import { salesCsv, type Refund, type Sale } from '../src/features/register/money';
import { commissionsCsv, type CommissionRow } from '../src/features/register/commissions';
import { reportCsv } from '../src/features/timeclock/hours';

/** the quoting before 2.123 — normal data must come out byte for byte the same */
const oldCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const S = (p: Partial<Sale>): Sale => ({ id: 'x', leadId: null, appointmentId: null, customerName: 'דנה', customerPhone: '', items: [{ name: 'לייזר', price: 250, qty: 1 }],
  subtotal: 250, discount: 0, total: 250, vatRate: 18, vatAmount: 38.14, method: 'cash', status: 'paid', note: '', paidAt: '2026-10-05T08:00:00Z', createdAt: '2026-10-05T08:00:00Z', ...p } as Sale);
const R = (p: Partial<Refund>): Refund => ({ id: 'r1', saleId: 'x', items: [], amount: 90, vatAmount: 13.73, method: 'cash', reason: 'לא התאים', employeeName: 'שגית',
  createdAt: '2026-10-05T09:00:00Z', ...p } as Refund);

test('csvCell = the old quoting for every normal cell', () => {
  for (const v of ['דנה כהן', 'קרם ×2', '250.00', '-90.00', 'מזומן', '', null, 30, 8.25, '₪330', '2026-10-05', 'תוקן ידנית', 'a "quote"', '8 ימים']) {
    assert.equal(csvCell(v), oldCell(v), String(v));
  }
});

test('the sales file: normal data byte for byte as before; a formula-looking customer name / note — text', () => {
  const normal = salesCsv([S({})], '2026-10-01', '2026-10-31', [R({})]);
  assert.match(normal, /"2026-10-05","11:00","דנה","לייזר","250\.00","0\.00","250\.00","38\.14","מזומן","שולם","",""/);
  assert.match(normal, /"2026-10-05","12:00","דנה","החזר","","","-90\.00","-13\.73","מזומן","החזר","לא התאים","שגית"/, 'a refund\'s negative amounts stay numbers');
  const bad = salesCsv([S({ customerName: '=HYPERLINK("http://example.test","x")', note: '@cmd' })], '2026-10-01', '2026-10-31');
  assert.match(bad, /"'=HYPERLINK\(""http:\/\/example\.test"",""x""\)"/);
  assert.match(bad, /"'@cmd"/);
});

test('the commissions file: byte for byte as before; a formula-looking employee name — text', () => {
  const row: CommissionRow = { employeeId: 'e1', name: 'שגית', servicePct: 30, productPct: 10, sales: 1, gross: 450, refunds: 90, base: { service: 228.82, product: 76.27 } as any, commission: 76.28 };
  const cells = ['2026-10', 'שגית', 1, '450.00', '90.00', '228.82', 30, '76.27', 10, '76.28'];
  assert.equal(commissionsCsv([row], '2026-10').split('\r\n')[1], cells.map(oldCell).join(','));
  assert.match(commissionsCsv([{ ...row, name: '+972 שגית' }], '2026-10'), /"'\+972 שגית"/);
});

test('the time clock\'s file: as before; a formula-looking employee name / note — text', () => {
  const emps = [{ id: 'e1', name: 'מיכל', phone: '', hourlyRate: 40, active: true, token: 't1' }];
  const E = (o = {}) => ({ id: 'a', employeeId: 'e1', clockIn: '2026-10-05T06:00:00Z', clockOut: '2026-10-05T14:15:00Z', ...o });
  const normal = reportCsv([E({ edited: true })], emps as any, '2026-10-01', '2026-10-31');
  assert.match(normal, /"מיכל","2026-10-05","09:00","17:15","8.25","תוקן ידנית",""/);
  assert.match(normal, /"מיכל","סה״כ","","","8.25","₪330","1 ימים"/);
  const bad = reportCsv([E({ note: '=1+1' })], [{ ...emps[0], name: '-מיכל' }] as any, '2026-10-01', '2026-10-31');
  assert.match(bad, /"'-מיכל","2026-10-05"/);
  assert.match(bad, /"'=1\+1"/);
});

import { csv as attendanceCsv } from '../src/features/attendance/exports';
test('the attendance files: quoted only when needed, as before; the same rule against formulas', () => {
  assert.equal(attendanceCsv([['מיכל', '8:15', 3, 'a,b', 'x"y']]), '\uFEFFמיכל,8:15,3,"a,b","x""y"\r\n', 'normal rows — byte for byte as before');
  assert.equal(attendanceCsv([['=1+1', '@x', '\tתו', '-0:30', '-5']]), '\uFEFF"\'=1+1","\'@x","\'\tתו","\'-0:30",-5\r\n', 'a numeric text stays a number');
});
