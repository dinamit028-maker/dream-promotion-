import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalHours, hhmm, minutesOf, monthRange, newToken, reportCsv, totals } from '../src/features/timeclock/hours';

const emps = [
  { id: 'e1', name: 'מיכל', phone: '', hourlyRate: 40, active: true, token: 't1' },
  { id: 'e2', name: 'רון', phone: '', hourlyRate: null, active: true, token: 't2' },
];
const E = (id: string, emp: string, i: string, o: string | null, extra = {}) => ({ id, employeeId: emp, clockIn: i, clockOut: o, ...extra });

test('time clock: minutes, formats, month range', () => {
  assert.equal(minutesOf({ clockIn: '2026-10-05T06:00:00Z', clockOut: '2026-10-05T14:30:00Z' }), 510);
  assert.equal(hhmm(425), '7:05'); assert.equal(decimalHours(425), 7.08);
  assert.deepEqual(monthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  assert.ok(newToken().length >= 30 && newToken() !== newToken());
});

test('time clock: totals, pay, open shifts, night shift, long days', () => {
  const entries = [
    E('a', 'e1', '2026-10-05T06:00:00Z', '2026-10-05T14:00:00Z'),          // 8h, Oct 5
    E('b', 'e1', '2026-10-06T06:00:00Z', '2026-10-06T16:30:00Z'),          // 10.5h → long day
    E('c', 'e1', '2026-10-07T19:00:00Z', '2026-10-08T03:00:00Z'),          // night 22:00–06:00 Israel = Oct 7
    E('d', 'e1', '2026-10-09T06:00:00Z', null),                            // still open
    E('e', 'e1', '2026-09-30T06:00:00Z', '2026-09-30T14:00:00Z'),          // previous month
    E('f', 'e2', '2026-10-05T07:00:00Z', '2026-10-05T11:00:00Z'),
  ];
  const [m, r] = totals(entries, emps, '2026-10-01', '2026-10-31');
  assert.equal(m.minutes, (8 + 10.5 + 8) * 60);
  assert.equal(m.days, 3); assert.equal(m.shifts, 3); assert.equal(m.open, 1);
  assert.deepEqual(m.longDays, ['2026-10-06']);
  assert.equal(m.pay, 26.5 * 40);
  assert.equal(r.minutes, 240); assert.equal(r.pay, null, 'no rate → no pay figure');
});

test('time clock: CSV for Excel', () => {
  const csv = reportCsv([E('a', 'e1', '2026-10-05T06:00:00Z', '2026-10-05T14:15:00Z', { edited: true })], emps, '2026-10-01', '2026-10-31');
  assert.ok(csv.startsWith('\uFEFF'), 'BOM for Hebrew in Excel');
  assert.match(csv, /"מיכל","2026-10-05","09:00","17:15","8.25","תוקן ידנית"/);
  assert.match(csv, /"מיכל","סה״כ","","","8.25","₪330"/);
});

import { distanceMeters, newSiteCode } from '../src/features/timeclock/hours';
test('time clock: location lock distance and site codes', () => {
  const clinic = { lat: 32.1133, lng: 34.8044 };
  assert.ok(distanceMeters(clinic, clinic) === 0);
  const d = distanceMeters(clinic, { lat: 32.1142, lng: 34.8044 }); // ~100 m north
  assert.ok(d > 90 && d < 110, `~100m, got ${d}`);
  assert.ok(distanceMeters(clinic, { lat: 32.0853, lng: 34.7818 }) > 3000, 'Tel Aviv center is far');
  const c = newSiteCode(); assert.match(c, /^[A-Za-z0-9_-]{16,64}$/); assert.notEqual(c, newSiteCode());
});
