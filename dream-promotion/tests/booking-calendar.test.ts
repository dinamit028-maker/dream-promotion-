/**
 * The appointments calendar (2.105, migration 5700): a practitioner's colour (the same list as the database's), the days of a
 * day / week / month in Israel time (also on the night the clock moves), where an appointment sits on its day, appointments at
 * the same hour side by side, and what each line of the history says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CALENDAR_COLORS, addDays, apptColor, apptCount, closedDay, dayOf, eventLine, eventWhen, eventWho, hourSpan, minuteOfDay, monthCells, place, placeLanes,
  practitioners, shiftDate, shortDay, staffColor, viewDays, viewRange, viewTitle, weekStart, weekendTone, type CalStaff,
} from '../src/features/booking/calendar';

test('the colours: the same list as the database\'s check (migration 5700)', () => {
  const sql = readFileSync(join(__dirname, '../supabase/migrations/20261018005700_appointment_staff.sql'), 'utf8');
  const m = sql.match(/lead_staff_color_check\s+check \(color in \(([^)]*)\)\)/);
  assert.ok(m, 'the check is in the migration');
  const inSql = m![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(inSql, CALENDAR_COLORS.map((c) => c.key), 'change both together');
  assert.equal(new Set(CALENDAR_COLORS.map((c) => c.label)).size, CALENDAR_COLORS.length);
});

test('a practitioner\'s colour: hers; else one nobody has, by her place; no practitioner: none', () => {
  const staff: CalStaff[] = [
    { id: 'sagit', name: 'שגית פרץ', color: 'yellow', practitioner: true, memberUserId: 'u1', active: true },
    { id: 'karin', name: 'קרין בן ניזרי', color: 'pink', practitioner: true, memberUserId: null, active: true },
    { id: 'gal', name: 'גל שחר', color: '', practitioner: true, memberUserId: null, active: true },
    { id: 'noa', name: 'נועה', color: '', practitioner: true, memberUserId: null, active: true },
    { id: 'aviv', name: 'אביב', color: '', practitioner: false, memberUserId: null, active: true },
    { id: 'gone', name: 'עזבה', color: 'violet', practitioner: true, memberUserId: null, active: false },
  ];
  assert.equal(staffColor(staff, 'sagit'), 'yellow');
  assert.equal(staffColor(staff, 'karin'), 'pink');
  // gal and noa have none: the first colours nobody took (pink, yellow and violet are taken)
  assert.equal(staffColor(staff, 'gal'), 'turquoise');
  assert.equal(staffColor(staff, 'noa'), 'orange');
  assert.equal(staffColor(staff, null), 'none');
  assert.equal(staffColor(staff, 'unknown'), 'turquoise', 'an id the team does not know: still a colour, never a crash');
  assert.deepEqual(practitioners(staff).map((s) => s.id), ['sagit', 'karin', 'gal', 'noa'], 'marked and active, in the team\'s order');
  // an appointment with none: waiting for one where there are practitioners; the app's own colour where there are none
  assert.equal(apptColor(staff, null), 'none');
  assert.equal(apptColor(staff, 'karin'), 'pink');
  assert.equal(apptColor(staff.filter((s) => !s.practitioner || !s.active), null), 'plain', 'no practitioner on the team');
  assert.equal(apptColor([], null), 'plain', 'no team at all (or before migration 5700)');
});

test('the days: a week from Sunday, the month in whole weeks, and the next / previous', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(weekStart('2026-10-18'), '2026-10-18', '18.10.2026 is a Sunday');
  assert.equal(weekStart('2026-10-24'), '2026-10-18');
  assert.deepEqual(viewDays('week', '2026-10-21'), ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
  // October 2026: the 1st is a Thursday, the 31st a Saturday — five weeks
  const oct = monthCells('2026-10-18');
  assert.deepEqual([oct.length, oct[0].date, oct[0].inMonth, oct[4].date, oct[4].inMonth, oct[34].date], [35, '2026-09-27', false, '2026-10-01', true, '2026-10-31']);
  // August 2026: the 1st is a Saturday — six weeks
  const aug = monthCells('2026-08-10');
  assert.deepEqual([aug.length, aug[6].date, aug[41].date], [42, '2026-08-01', '2026-09-05']);
  assert.equal(shiftDate('day', '2026-10-18', 1), '2026-10-19');
  assert.equal(shiftDate('week', '2026-10-18', -1), '2026-10-11');
  assert.equal(shiftDate('month', '2026-01-31', 1), '2026-02-28', 'a month keeps its day where it can');
  assert.equal(shiftDate('month', '2026-03-15', -1), '2026-02-15');
  assert.equal(shiftDate('month', '2026-12-05', 1), '2027-01-05');
  assert.equal(shortDay('2026-10-18'), 'א׳ 18.10');
});

test('what a view loads: from midnight to midnight in Israel — 25 hours on the night the clock goes back', () => {
  const day = viewRange('day', '2026-10-18', '2026-10-18');
  assert.deepEqual(day, { from: '2026-10-17T21:00:00.000Z', to: '2026-10-18T21:00:00.000Z' });
  const back = viewRange('day', '2026-10-25', '2026-10-18');
  assert.equal((Date.parse(back.to) - Date.parse(back.from)) / 3600e3, 25, 'summer time ends on 25.10.2026');
  const week = viewRange('week', '2026-10-21', '2026-10-18');
  assert.deepEqual([week.from, week.to], ['2026-10-17T21:00:00.000Z', '2026-10-24T21:00:00.000Z']);
  const month = viewRange('month', '2026-10-05', '2026-10-18');
  assert.equal(month.from, '2026-09-26T21:00:00.000Z', 'the grid\'s first Sunday');
  const list = viewRange('list', '2026-01-01', '2026-10-18', true);
  assert.equal(list.from, '2026-09-17T21:00:00.000Z', 'the list: 30 days back when asked');
});

test('the titles', () => {
  assert.equal(viewTitle('day', '2026-10-18'), 'יום ראשון, 18 באוקטובר');
  assert.equal(viewTitle('week', '2026-10-21'), '18–24 באוקטובר 2026');
  assert.equal(viewTitle('week', '2026-10-01'), '27 בספטמבר – 3 באוקטובר 2026');
  assert.equal(viewTitle('month', '2026-10-18'), 'אוקטובר 2026');
  assert.deepEqual([apptCount(0), apptCount(1), apptCount(2), apptCount(16)], ['אין תורים', 'תור אחד', '2 תורים', '16 תורים']);
});

test('where an appointment sits: Israel time, the opening hours widened to every appointment', () => {
  assert.equal(minuteOfDay('2026-10-18T07:30:00Z'), 10 * 60 + 30, 'UTC+3 in October (before the 25th)');
  assert.equal(minuteOfDay('2026-10-26T07:30:00Z'), 9 * 60 + 30, 'UTC+2 after it');
  assert.equal(dayOf('2026-10-18T22:30:00Z'), '2026-10-19', 'past midnight in Israel: the next day');
  const hours = { 0: [['09:00', '19:00']], 1: [['10:00', '13:00'], ['16:00', '20:30']] } as any;
  assert.deepEqual(hourSpan(hours, ['2026-10-18'], []), { from: 540, to: 1140 });
  assert.deepEqual(hourSpan(hours, ['2026-10-18', '2026-10-19'], []), { from: 540, to: 21 * 60 }, 'a week: the widest — 20:30 shows to 21:00');
  const early = { start: '2026-10-18T04:30:00Z', end: '2026-10-18T05:00:00Z' }; // 07:30–08:00
  assert.deepEqual(hourSpan(hours, ['2026-10-18'], [early]), { from: 420, to: 1140 }, 'an appointment before opening: shown');
  assert.deepEqual(hourSpan(hours, ['2026-10-20'], [early]), { from: 480, to: 1200 }, 'nothing open, nothing on the day: 08:00–20:00');
  assert.deepEqual(place({ start: '2026-10-18T07:00:00Z', end: '2026-10-18T08:00:00Z' }, { from: 480, to: 1200 }), { top: 120, height: 60 });
  assert.deepEqual(place({ start: '2026-10-18T19:30:00Z', end: '2026-10-18T22:00:00Z' }, { from: 480, to: 1380 }), { top: 870, height: 30 },
    '22:30 to 01:00: cut at the last hour shown (23:00), never past midnight');
});

test('appointments at the same hour side by side; one after another — the whole width', () => {
  const at = (h: number, m: number, minutes: number, id: string) => {
    const s = Date.UTC(2026, 9, 18, h - 3, m);
    return { id, start: new Date(s).toISOString(), end: new Date(s + minutes * 60e3).toISOString() };
  };
  const placed = placeLanes([at(10, 0, 60, 'a'), at(10, 30, 60, 'b'), at(10, 15, 30, 'c'), at(12, 0, 30, 'd'), at(11, 0, 30, 'e')]);
  const by = Object.fromEntries(placed.map((p) => [p.item.id, [p.lane, p.lanes]]));
  assert.deepEqual(by.a, [0, 3]);
  assert.deepEqual(by.c, [1, 3], '10:15 next to 10:00');
  assert.deepEqual(by.b, [2, 3]);
  assert.deepEqual(by.e, [0, 3], '11:00: the first lane is free again, still the same group (b runs to 11:30)');
  assert.deepEqual(by.d, [0, 1], '12:00: alone');
});

test('the history: each line about the appointment — the same whoever did it', () => {
  const ev = (kind: any, before: any, after: any) => eventLine({ kind, before, after });
  assert.equal(ev('created', {}, { staff: 'קרין בן ניזרי', source: 'manual' }), 'נקבע התור אצל קרין בן ניזרי');
  assert.equal(ev('created', {}, { staff: null, source: 'manual' }), 'נקבע התור');
  assert.equal(ev('created', {}, { source: 'public' }), 'נקבע בדף ההזמנות');
  assert.equal(ev('moved', { start: '2026-10-18T08:00:00Z' }, { start: '2026-10-18T10:00:00Z' }), 'הוזז מ-11:00 ל-13:00');
  assert.equal(ev('moved', { start: '2026-10-18T08:00:00Z' }, { start: '2026-10-19T06:00:00Z' }), 'הוזז מ-א׳ 18.10 11:00 ל-ב׳ 19.10 09:00');
  assert.equal(ev('staff', { staff: 'גל שחר' }, { staff: 'קרין בן ניזרי' }), 'הועבר מגל שחר לקרין בן ניזרי');
  assert.equal(ev('staff', { staff: null }, { staff: 'שגית פרץ' }), 'שובץ אצל שגית פרץ');
  assert.equal(ev('staff', { staff: 'שגית פרץ' }, { staff: null }), 'השיבוץ אצל שגית פרץ בוטל');
  assert.equal(ev('status', { status: 'booked' }, { status: 'confirmed' }), 'התור אושר');
  assert.equal(ev('status', { status: 'confirmed' }, { status: 'done' }), 'סומן: הגיע/ה');
  assert.equal(ev('status', { status: 'booked' }, { status: 'cancelled' }), 'התור בוטל');
  assert.equal(ev('edited', { note: '', service_id: 'x' }, { note: 'צבע 2', service_id: 'y', service_name: 'מיקרובליידינג' }), 'עודכנו: ההערה, השירות');
  assert.equal(eventWho({ actorName: 'שגית פרץ', kind: 'moved', after: {} }), 'שגית פרץ');
  assert.equal(eventWho({ actorName: '', kind: 'created', after: { source: 'public' } }), 'דף ההזמנות');
  assert.equal(eventWho({ actorName: '', kind: 'status', after: {} }), 'המערכת');
  assert.equal(eventWhen('2026-10-18T05:52:00Z'), '18.10, 08:52');
});

test('2.106: Friday and Saturday a colour each (a date or a weekday); a closed day — no hours on its weekday, or one of the closed days', () => {
  assert.deepEqual(['2026-10-18', '2026-10-22', '2026-10-23', '2026-10-24'].map(weekendTone), ['', '', 'cal-fri', 'cal-sat']);
  assert.deepEqual([0, 4, 5, 6].map(weekendTone), ['', '', 'cal-fri', 'cal-sat']);
  const hours = { 0: [['09:00', '17:00']], 5: [['09:00', '13:00']] } as Record<string, [string, string][]>;
  assert.equal(closedDay(hours, [], '2026-10-18'), false, 'a Sunday with hours');
  assert.equal(closedDay(hours, [], '2026-10-24'), true, 'a Saturday with none');
  assert.equal(closedDay(hours, ['2026-10-23'], '2026-10-23'), true, 'a Friday with hours, closed that day');
  assert.equal(closedDay(hours, ['2026-10-23'], '2026-10-30'), false, 'the next Friday is open');
});
