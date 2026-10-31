/** Phone notifications of the calendar (2.112): 15 minutes before — practitioner and owners; the day before at 10:00. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peopleOf, soonAlerts, soonDue, tomorrowAlerts, tomorrowDue, type AlertAppt } from '../src/features/booking/alerts';

const at = (iso: string) => new Date(iso).getTime();
const appt = (o: Partial<AlertAppt>): AlertAppt => ({ id: 'a1', businessId: 'b', start: '2026-10-31T08:15:00Z', name: 'פרלה', service: 'קרבון', staffId: 'gal', status: 'booked', ...o });
const staffUser = new Map<string, string | null>([['gal', 'u-gal'], ['karin', 'u-karin'], ['ghost', null]]);
const owners = new Map([['b', ['u-sagit']]]);

test('15 minutes before: only what starts within them, never one that started or was cancelled', () => {
  const now = at('2026-10-31T08:00:00Z');                      // 10:00 in Israel (winter: +02:00)
  const list = [appt({ id: 'in', start: '2026-10-31T08:15:00Z' }), appt({ id: 'late', start: '2026-10-31T08:16:00Z' }),
    appt({ id: 'started', start: '2026-10-31T07:59:00Z' }), appt({ id: 'gone', status: 'cancelled' }), appt({ id: 'done', status: 'done' })];
  assert.deepEqual(soonDue(list, now).map((a) => a.id), ['in']);
});

test('who: her practitioner and the owners — once each; no practitioner: the owners', () => {
  assert.deepEqual(peopleOf(appt({}), staffUser, owners), ['u-gal', 'u-sagit']);
  assert.deepEqual(peopleOf(appt({ staffId: null }), staffUser, owners), ['u-sagit']);
  assert.deepEqual(peopleOf(appt({ staffId: 'ghost' }), staffUser, owners), ['u-sagit'], 'a practitioner with no account');
  assert.deepEqual(peopleOf(appt({}), staffUser, new Map([['b', ['u-gal']]])), ['u-gal'], 'an owner who is the practitioner: once');
});

test('the words: the hour, how long until it, who and what', () => {
  const [g, s] = soonAlerts([appt({})], at('2026-10-31T08:01:00Z'), staffUser, owners);
  assert.equal(g.title, 'תור ב-10:15 — בעוד 14 דק׳');
  assert.equal(g.body, 'פרלה · קרבון — להכין את הקליניקה');
  assert.deepEqual([g.userId, g.key, s.userId, s.key], ['u-gal', 'soon:a1:u-gal', 'u-sagit', 'soon:a1:u-sagit']);
  assert.equal(g.url, '/appointments?appt=a1');
});

test('the day before: from 10:00 to 20:00 Israel time, one per person and day, with the count', () => {
  assert.equal(tomorrowDue(at('2026-10-31T07:59:00Z')), null, '09:59');
  assert.equal(tomorrowDue(at('2026-10-31T08:00:00Z')), '2026-11-01', '10:00');
  assert.equal(tomorrowDue(at('2026-10-31T17:59:00Z')), '2026-11-01', '19:59');
  assert.equal(tomorrowDue(at('2026-10-31T18:00:00Z')), null, '20:00');
  const list = [appt({ id: 'x' }), appt({ id: 'y', staffId: 'karin' }), appt({ id: 'z', staffId: null }), appt({ id: 'c', status: 'cancelled' })];
  const out = tomorrowAlerts('2026-11-01', list, staffUser, owners);
  const by = Object.fromEntries(out.map((a) => [a.userId, a]));
  assert.equal(by['u-sagit'].title, 'מחר 3 תורים — לשלוח תזכורות');
  assert.equal(by['u-gal'].title, 'מחר תור אחד — לשלוח תזכורת');
  assert.equal(by['u-karin'].key, 'tomorrow:2026-11-01:u-karin');
  assert.equal(by['u-gal'].url, '/appointments?reminders=2026-11-01');
});
