import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { israelToIso } from '../src/lib/il-time';
import { parseXlsx } from '../src/features/finance/bank';
import { hm as hmOf, monthReport, type EngineEntry, type Track } from '../src/features/attendance/hours-engine';
import { AID_NOTE, csv, monthLabel, monthPdfBody, monthSheet, payrollCsv, payrollHeader, payrollPdfBody, summarySheet, xlsx } from '../src/features/attendance/exports';
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
  assert.equal(b.columns[8].label, 'מעבר לתקן');
  assert.match(b.note, /בימי מנוחה וחג: 8:00/);
  assert.match(b.note, /המלצה לפי הגדרות המסלול: 100% 16:36 · 125% 2:00 · 150% 8:24/, 'the rates — a recommendation, marked so');
  assert.ok(b.note.includes(AID_NOTE));
  assert.equal(b.total[6], '27:00'); assert.equal(b.total[8], '2:24');
  assert.equal(reportPdfInput(b).ok, true, 'within the PDF route\'s limits');
});

test('attendance exports: the month for Excel — the hours, then every rate marked a recommendation', () => {
  const rows = monthSheet(report, dana);
  const head = rows[2];
  assert.deepEqual(head.slice(0, 4), ['תאריך', 'יום', 'סוג יום', 'שעות תקן']);
  assert.deepEqual(head.slice(8, 12), ['סה״כ יומי', 'מצטבר', 'מעבר לתקן', 'סטטוס']);
  assert.ok(head.includes('125% (המלצה)')); assert.ok(!head.some((h) => /טיוטה/.test(String(h))));
  const first = rows[3];
  assert.equal(first[8], '11:00'); assert.equal(first[10], '2:24');
  assert.equal(first[head.indexOf('125% (המלצה)')], '2:00'); assert.equal(first[head.indexOf('150% (המלצה)')], '0:24', 'H:MM — exact, never a rounded decimal');
  assert.equal(rows[3 + 30][8], '27:00', 'the total'); assert.equal(rows[3 + 30][10], '2:24');
  assert.equal(rows[rows.length - 1][0], AID_NOTE, 'an aid to the accountant — the pay is theirs');
});

test('attendance exports: the payroll report — hours, never waiting for anyone; the rates marked a recommendation', () => {
  const file = payrollCsv([{ employee: dana, report }]);
  assert.ok(file.startsWith('\uFEFF'));
  const [head, row] = file.slice(1).trim().split('\r\n').map((l) => l.split(','));
  assert.deepEqual(head, payrollHeader([100, 125, 150, 175, 200]));
  assert.deepEqual(head.slice(0, 8), ['מספר עובד', 'שם', 'ת.ז', 'ימי עבודה', 'סה״כ שעות', 'שעות תקן', 'מעבר לתקן', 'בימי מנוחה וחג']);
  const v = (k: string) => row[head.indexOf(k)];
  assert.equal(v('מספר עובד'), '101'); assert.equal(v('ימי עבודה'), '3');
  assert.equal(v('סה״כ שעות'), '27:00'); assert.equal(v('מעבר לתקן'), '2:24'); assert.equal(v('בימי מנוחה וחג'), '8:00'); assert.equal(v('ימי חופשה'), '2');
  assert.equal(v('100% (המלצה)'), '16:36'); assert.equal(v('125% (המלצה)'), '2:00'); assert.equal(v('150% (המלצה)'), '8:24');
  const pdf = payrollPdfBody([{ employee: dana, report }], '2026-09', 'מסעדת הים');
  assert.deepEqual(pdf.columns.map((c) => c.label), ['מספר', 'שם', 'ימים', 'סה״כ שעות', 'תקן', 'מעבר לתקן', 'מנוחה וחג', 'היעדרות', 'חסרים']);
  assert.deepEqual(pdf.rows[0], ['101', 'דנה כהן', '3', '27:00', hmOf(report.totals.standard), '2:24', '8:00', '2', String(report.totals.missingDays)]);
  assert.match(pdf.note, /דנה כהן: חופשה 2/);
  assert.match(pdf.note, /דנה כהן — המלצה לפי הגדרות המסלול: 100% 16:36 · 125% 2:00 · 150% 8:24/);
  assert.ok(pdf.note.includes(AID_NOTE));
  assert.equal(reportPdfInput(pdf).ok, true);
  // an employer's own rate: in the recommendation, never a column of the hours
  const many = { ...report, totals: { ...report.totals, pct: { ...report.totals.pct, 130: 60 } } };
  const p2 = payrollPdfBody([{ employee: dana, report: many }], '2026-09', '');
  assert.equal(p2.columns.length, 9); assert.match(p2.note, /130% 1:00/);
  assert.ok(payrollHeader([100, 125, 130, 150]).includes('130% (המלצה)'));
  assert.equal(reportPdfInput(p2).ok, true);
});

test('attendance exports: CSV cells — quotes, and a formula never runs in Excel', () => {
  assert.equal(csv([['a,b', 'x"y', '=1+1', 3.5]]), '﻿"a,b","x""y","\'=1+1",3.5\r\n');
});

test('attendance exports: the summary of all employees, and a real xlsx (read back, right to left)', async () => {
  const s = summarySheet([{ employee: dana, report }], '2026-09');
  assert.equal(s[0][0], 'סיכום נוכחות — ספטמבר 2026'); assert.equal(s[3][4], '27:00');
  const bytes = await xlsx([{ name: 'סיכום', rows: s }, { name: 'דנה/כהן?', rows: monthSheet(report, dana) }]);
  const zip = await JSZip.loadAsync(bytes);
  assert.match(await zip.file('xl/worksheets/sheet1.xml')!.async('string'), /rightToLeft="1"/);
  assert.match(await zip.file('xl/workbook.xml')!.async('string'), /name="דנה כהן"/);
  const grid = await parseXlsx(bytes);
  assert.equal(grid[0][0], 'סיכום נוכחות — ספטמבר 2026');
  assert.equal(grid.find((r) => r[1] === 'דנה כהן')![4], '27:00');
  assert.equal(monthLabel('2026-01'), 'ינואר 2026');
});

test('attendance exports: file names — the title, the month, safe on every system', async () => {
  const { fileName } = await import('../src/features/attendance/exports');
  assert.equal(fileName('נוכחות-דנה כהן', '2026-09', 'xlsx'), 'נוכחות-דנה-כהן-2026-09.xlsx');
  assert.equal(fileName('a/b:c', '2026-09', 'pdf'), 'a-b-c-2026-09.pdf');
});
