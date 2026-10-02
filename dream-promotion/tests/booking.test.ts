import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeSlots, isFree, openDays, weekdayOf, icsFile } from '../src/features/booking/slots';

const rules = {
  hours: { '0': [['09:00', '12:00']], '1': [['09:00', '12:00'], ['16:00', '18:00']], '5': [['09:00', '11:00']] } as any,
  slotMinutes: 30, minNoticeMinutes: 120, maxDaysAhead: 14, closedDates: ['2026-10-13'],
};
const now = new Date('2026-10-04T06:00:00Z').getTime(); // Sunday 09:00 in Israel (summer, UTC+3)

test('booking: slots inside opening hours, step and duration', () => {
  assert.equal(weekdayOf('2026-10-05'), 1); // Monday
  const mon = freeSlots('2026-10-05', 30, rules, [], now);
  assert.deepEqual(mon.map((s) => s.time), ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '16:00', '16:30', '17:00', '17:30']);
  assert.equal(mon[0].start, '2026-10-05T06:00:00.000Z', 'Israel 09:00 = 06:00 UTC in summer');
  const long = freeSlots('2026-10-05', 90, rules, [], now);
  assert.deepEqual(long.map((s) => s.time), ['09:00', '09:30', '10:00', '10:30', '16:00', '16:30'], 'a 90-minute service must fit before closing');
});

test('booking: minimum notice, closed days, past and too-far dates', () => {
  // today (Sunday) at 09:00 with 2 hours notice → first slot 11:00
  assert.deepEqual(freeSlots('2026-10-04', 30, rules, [], now).map((s) => s.time), ['11:00', '11:30']);
  assert.deepEqual(freeSlots('2026-10-06', 30, rules, [], now), [], 'Tuesday has no hours');
  assert.deepEqual(freeSlots('2026-10-13', 30, rules, [], now), [], 'closed date');
  assert.deepEqual(freeSlots('2026-10-03', 30, rules, [], now), [], 'the past');
  assert.deepEqual(freeSlots('2026-11-30', 30, rules, [], now), [], 'beyond max days ahead');
});

test('booking: existing appointments block overlapping slots only', () => {
  const busy = [{ start: '2026-10-05T07:00:00.000Z', end: '2026-10-05T07:30:00.000Z' }]; // 10:00–10:30 Israel
  const t = freeSlots('2026-10-05', 60, rules, busy, now).map((s) => s.time);
  assert.ok(!t.includes('09:30') && !t.includes('10:00'), '60-min slots touching 10:00–10:30 are gone');
  assert.ok(t.includes('09:00') && t.includes('10:30'), 'back-to-back is fine');
  assert.ok(isFree('2026-10-05T07:30:00.000Z', 30, rules, busy, now));
  assert.ok(!isFree('2026-10-05T07:15:00.000Z', 30, rules, busy, now), 'off-grid time is refused');
});

test('booking: winter time and open-days list', () => {
  const winter = freeSlots('2026-11-01', 30, { ...rules, maxDaysAhead: 60 }, [], now); // Sunday, winter (UTC+2)
  assert.equal(winter[0].start, '2026-11-01T07:00:00.000Z');
  const days = openDays(rules, now);
  assert.ok(days.includes('2026-10-05') && !days.includes('2026-10-06') && !days.includes('2026-10-13'));
  assert.match(icsFile({ uid: 'x', start: winter[0].start, end: winter[0].end, title: 'תור' }), /DTSTART:20261101T070000Z/);
});
