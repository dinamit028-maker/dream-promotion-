/** "משעה עד שעה" (2.110): an appointment's end — its treatment's length by default, another one for this appointment only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apptRange, defaultEnd, lengthProblem, timesProblem } from '../src/features/booking/appt-times';

test('the default end is the treatment\'s length', () => {
  assert.equal(defaultEnd('10:00', 30), '10:30');
  assert.equal(defaultEnd('10:00', 40), '10:40');
  assert.equal(defaultEnd('09:50', 90), '11:20');
  assert.equal(defaultEnd('23:30', 60), '23:59', 'never past the day');
  assert.equal(defaultEnd('', 30), '');
});

test('the hours: an end after the start, the same day', () => {
  assert.equal(timesProblem('10:00', '10:40'), null);
  assert.match(timesProblem('10:00', '10:00')!, /אחרי/);
  assert.match(timesProblem('11:00', '10:00')!, /אחרי/);
  assert.match(timesProblem('10:00', '10:03')!, /5 דקות/);
  assert.match(timesProblem('', '10:00')!, /התחלה/);
  assert.match(timesProblem('10:00', '25:00')!, /עד איזו/);
});

test('in Israel time — summer and winter', () => {
  assert.deepEqual(apptRange('2026-10-18', '10:00', '10:40'), { start: '2026-10-18T07:00:00.000Z', end: '2026-10-18T07:40:00.000Z' });
  assert.deepEqual(apptRange('2026-11-01', '10:00', '10:40'), { start: '2026-11-01T08:00:00.000Z', end: '2026-11-01T08:40:00.000Z' });
});

test('a treatment\'s length', () => {
  assert.equal(lengthProblem(40), null);
  assert.equal(lengthProblem(5), null);
  assert.equal(lengthProblem(480), null);
  for (const m of [0, 4, 481, 12.5, NaN]) assert.ok(lengthProblem(m), String(m));
});

test('how long: a tap sets the end — 11:00 and "שעה וחצי" end at 12:30', async () => {
  const { DURATIONS, durationLabel, lengthOf } = await import('../src/features/booking/appt-times');
  assert.equal(defaultEnd('11:00', 90), '12:30');
  assert.equal(lengthOf('11:00', '12:30'), 90);
  assert.equal(lengthOf('11:00', '10:00'), 0);
  assert.deepEqual([15, 30, 40, 45, 60, 75, 90, 120, 150, 180].map(durationLabel),
    ['רבע שעה', 'חצי שעה', '40 דק׳', '45 דק׳', 'שעה', 'שעה ורבע', 'שעה וחצי', 'שעתיים', 'שעתיים וחצי', '3 שעות']);
  assert.equal(durationLabel(105), 'שעה ו-45 דק׳');
  assert.equal(durationLabel(70), 'שעה ו-10 דק׳');
  assert.ok(DURATIONS.every((m) => m >= 5 && m <= 480));
});
