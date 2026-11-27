import { test } from 'node:test';
import assert from 'node:assert/strict';
import { israelToIso } from '../src/lib/il-time';
import { monthReport, type EngineEntry, type Track } from '../src/features/attendance/hours-engine';
import { csv, monthSheet, summarySheet } from '../src/features/attendance/exports';

// QA 2.123: the attendance CSV of a real month — byte for byte what the pre-2.123 cell rule wrote (demo data only)
const oldCell = (v: string | number) => (typeof v === 'number' ? String(v) : /[",\r\n]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);
const oldCsv = (rows: (string | number)[][]) => '﻿' + rows.map((r) => r.map(oldCell).join(',')).join('\r\n') + '\r\n';
const FIVE: Track = { dayMinutes: [516, 516, 516, 516, 516, 0, 0] };
const S = (d: string, a: string, od: string, b: string): EngineEntry => ({ id: `${d}${a}`, clockIn: israelToIso(d, a), clockOut: israelToIso(od, b), method: 'qr' });
const report = monthReport({ month: '2026-09', track: FIVE, now: Date.parse('2026-10-23T09:00:00Z'), entries: [
  S('2026-09-01', '07:00', '2026-09-01', '18:00'), S('2026-09-03', '22:00', '2026-09-04', '06:00'), S('2026-09-05', '08:00', '2026-09-05', '16:00'),
], absences: [{ id: 'v', kind: 'vacation', from: '2026-09-08', to: '2026-09-09', minutes: null, status: 'approved' }] });
const emp = { id: 'e', name: 'דנה כהן', code: '101', department: 'מטבח', title: 'טבחית', idNumber: '000000018' };

test('qa: attendance month + summary CSV identical to the old rule for normal rows', () => {
  const rows = monthSheet(report, emp);
  assert.equal(csv(rows), oldCsv(rows));
  const sum = summarySheet([{ employee: emp, report }], '2026-09');
  assert.equal(csv(sum), oldCsv(sum));
});
