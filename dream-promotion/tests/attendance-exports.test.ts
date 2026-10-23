import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { israelToIso } from '../src/lib/il-time';
import { parseXlsx } from '../src/features/finance/bank';
import { monthReport, type EngineEntry, type Track } from '../src/features/attendance/hours-engine';
import { DRAFT_NOTE, PAYROLL_HEADER, csv, monthLabel, monthPdfBody, monthSheet, payrollCsv, summarySheet, xlsx } from '../src/features/attendance/exports';
import { reportPdfInput } from '../src/lib/server/report-pdf';

const FIVE: Track = { dayMinutes: [516, 516, 516, 516, 516, 0, 0] };
const S = (d: string, a: string, od: string, b: string): EngineEntry => ({ id: `${d}${a}`, clockIn: israelToIso(d, a), clockOut: israelToIso(od, b), method: 'qr' });
const NOW = Date.parse('2026-10-23T09:00:00Z');
const report = monthReport({ month: '2026-09', track: FIVE, now: NOW, entries: [
  S('2026-09-01', '07:00', '2026-09-01', '18:00'),      // 11h: 8.6 + 2 + 0.4
  S('2026-09-03', '22:00', '2026-09-04', '06:00'),      // a night
  S('2026-09-05', '08:00', '2026-09-05', '16:00'),      // Saturday
], absences: [{ id: 'v', kind: 'vacation', from: '2026-09-08', to: '2026-09-09', minutes: null, status: 'approved' }] });
const dana = { id: 'e', name: 'דנה כהן', code: '101', department: 'מטבח', title: 'טבחית', idNumber: '123456782' };

test('attendance exports: the month for the PDF — every day, 10 columns, the server accepts it as is', () => {
  const b = monthPdfBody(report, dana, 'מסעדת הים');
  assert.equal(b.columns.length, 10); assert.equal(b.rows.length, 30);
  assert.deepEqual(b.rows[0].slice(0, 9), ['01/09/2026', 'שלישי', 'חול', '8:36', '07:00', '18:00', '11:00', '11:00', '2:24']);
  assert.equal(b.rows[2][5], '06:00+1', 'a clock-out the next day');
  assert.equal(b.rows[7][9], 'חופשה');
  assert.match(b.note, /טיוטה/);
  assert.equal(b.total[6], '27:00');
  assert.equal(reportPdfInput(b).ok, true, 'within the PDF route\'s limits');
});

test('attendance exports: the month for Excel — hours as numbers, every rate, the draft note', () => {
  const rows = monthSheet(report, dana);
  const head = rows[2];
  assert.deepEqual(head.slice(0, 4), ['תאריך', 'יום', 'סוג יום', 'שעות תקן']);
  assert.ok(head.includes('125% (טיוטה)'));
  const first = rows[3];
  assert.equal(first[8], 11); assert.equal(first[head.indexOf('125% (טיוטה)')], 2); assert.equal(first[head.indexOf('150% (טיוטה)')], 0.4);
  assert.equal(rows[3 + 30][8], 27, 'the total');
  assert.equal(rows[rows.length - 1][0], DRAFT_NOTE);
});

test('attendance exports: the payroll file — refused until the overtime rules are confirmed; its standard columns', () => {
  assert.equal(payrollCsv([{ employee: dana, report }]), null);
  const file = payrollCsv([{ employee: dana, report }], { confirmed: true })!;
  assert.ok(file.startsWith('﻿'));
  const [head, row] = file.slice(1).trim().split('\r\n').map((l) => l.split(','));
  assert.deepEqual(head, PAYROLL_HEADER);
  assert.deepEqual(head.slice(0, 7), ['מספר עובד', 'שם', 'ת.ז', 'ימי עבודה', 'שעות רגילות', '125%', '150%']);
  const v = (k: string) => row[head.indexOf(k)];
  assert.equal(v('מספר עובד'), '101'); assert.equal(v('ימי עבודה'), '3');
  assert.equal(v('שעות רגילות'), String(Math.round(((516 + 480) / 60) * 100) / 100));
  assert.equal(v('125%'), '2'); assert.equal(v('150%'), String(Math.round(((24 + 480) / 60) * 100) / 100));
  assert.equal(v('שעות בימי מנוחה'), '8'); assert.equal(v('ימי חופשה'), '2');
});

test('attendance exports: CSV cells — quotes, and a formula never runs in Excel', () => {
  assert.equal(csv([['a,b', 'x"y', '=1+1', 3.5]]), '﻿"a,b","x""y","\'=1+1",3.5\r\n');
});

test('attendance exports: the summary of all employees, and a real xlsx (read back, right to left)', async () => {
  const s = summarySheet([{ employee: dana, report }], '2026-09');
  assert.equal(s[0][0], 'סיכום נוכחות — ספטמבר 2026'); assert.equal(s[3][4], 27);
  const bytes = await xlsx([{ name: 'סיכום', rows: s }, { name: 'דנה/כהן?', rows: monthSheet(report, dana) }]);
  const zip = await JSZip.loadAsync(bytes);
  assert.match(await zip.file('xl/worksheets/sheet1.xml')!.async('string'), /rightToLeft="1"/);
  assert.match(await zip.file('xl/workbook.xml')!.async('string'), /name="דנה כהן"/);
  const grid = await parseXlsx(bytes);
  assert.equal(grid[0][0], 'סיכום נוכחות — ספטמבר 2026');
  assert.equal(grid.find((r) => r[1] === 'דנה כהן')![4], '27');
  assert.equal(monthLabel('2026-01'), 'ינואר 2026');
});

test('attendance exports: file names — the title, the month, safe on every system', async () => {
  const { fileName } = await import('../src/features/attendance/exports');
  assert.equal(fileName('נוכחות-דנה כהן', '2026-09', 'xlsx'), 'נוכחות-דנה-כהן-2026-09.xlsx');
  assert.equal(fileName('a/b:c', '2026-09', 'pdf'), 'a-b-c-2026-09.pdf');
});
