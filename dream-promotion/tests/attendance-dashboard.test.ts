import { test } from 'node:test';
import assert from 'node:assert/strict';
import { israelToIso } from '../src/lib/il-time';
import { monthReport, type EngineEntry, type Track } from '../src/features/attendance/hours-engine';
import { dailyStatus, monthlyStatus } from '../src/features/attendance/dashboard';

const FIVE: Track = { dayMinutes: [516, 516, 516, 516, 516, 0, 0], startTime: '08:00', lateGraceMin: 0 };
const S = (d: string, a: string, b: string | null): EngineEntry => ({ id: `${d}${a}`, clockIn: israelToIso(d, a), clockOut: b ? israelToIso(d, b) : null });
const NOW = Date.parse('2026-10-22T10:00:00Z');   // Thursday 22.10.2026, 13:00 in Israel
const person = (id: string, entries: EngineEntry[], active = true, absences: any[] = []) =>
  ({ employee: { id, active }, report: monthReport({ month: '2026-10', entries, absences, track: FIVE, now: NOW }) });

test('attendance dashboard: today — working, reported, not reported, absent, late, forgot to clock out', () => {
  const list = [
    person('working', [S('2026-10-22', '08:00', null)]),
    person('reported', [S('2026-10-22', '06:00', '12:00')]),
    person('late', [S('2026-10-22', '08:30', '12:30')]),
    person('nothing', []),
    person('absent', [], true, [{ id: 'a', kind: 'sick', from: '2026-10-22', to: '2026-10-22', minutes: null, status: 'approved' }]),
    person('forgot', [S('2026-10-20', '08:00', null)]),
    person('gone', [], false),
  ];
  const d = dailyStatus(list, '2026-10-22');
  const ids = (k: keyof typeof d) => d[k].map((e) => e.id).sort();
  assert.deepEqual(ids('working'), ['working']);
  assert.deepEqual(ids('reported'), ['late', 'reported']);
  assert.deepEqual(ids('notReported'), ['forgot', 'nothing']);
  assert.deepEqual(ids('absent'), ['absent']);
  assert.deepEqual(ids('late'), ['late', 'working'].filter((x) => x === 'late'));
  assert.deepEqual(ids('openOld'), ['forgot']);
});

test('attendance dashboard: the month — the share of missing work days up to today, hours, active / inactive', () => {
  // October 2026 up to the 22nd: work days of the track (Sun–Thu) that are not festivals: 4.10 is Sunday after Simchat Torah …
  const full = person('full', []);
  const expected = full.report.days.filter((x) => x.date < '2026-10-22' && x.standard > 0).length;
  const m = monthlyStatus([full, person('one', [S('2026-10-05', '08:00', '16:00')]), person('gone', [], false)], '2026-10-22');
  assert.equal(m.expectedDays, expected * 2);
  assert.equal(m.missingDays, expected * 2 - 1);
  assert.equal(m.missingPct, Math.round(((expected * 2 - 1) / (expected * 2)) * 1000) / 10);
  assert.equal(m.paid, 480); assert.equal(m.active, 2); assert.equal(m.inactive, 1);
  assert.equal(monthlyStatus([], '2026-10-22').missingPct, 0);
});
