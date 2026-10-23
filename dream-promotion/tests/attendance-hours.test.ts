import { test } from 'node:test';
import assert from 'node:assert/strict';
import { israelToIso } from '../src/lib/il-time';
import { holidaysIn } from '../src/features/booking/holidays';
import {
  daysOfMonth, dayType, hm, hoursDec, monthReport, shiftMonth, splitByTiers, type EngineEntry, type Track,
} from '../src/features/attendance/hours-engine';
import { AUTO_BREAK, DEFAULT_RULES, PCT_COLUMNS, RULE_NOTES, ratesValid, rulesOf, type ContractRules } from '../src/features/attendance/overtime-rules';
import { pctColumns } from '../src/features/attendance/hours-engine';
const DAILY = [{ minutes: 120, pct: 125 }, { minutes: null, pct: 150 }];

/** a shift by Israeli wall time: day + "HH:MM" in, day + "HH:MM" out (null = still open) */
const S = (id: string, inDay: string, inT: string, outDay: string | null, outT?: string, extra: Partial<EngineEntry> = {}): EngineEntry =>
  ({ id, clockIn: israelToIso(inDay, inT), clockOut: outDay ? israelToIso(outDay, outT!) : null, ...extra });
const FIVE: Track = { dayMinutes: [516, 516, 516, 516, 516, 0, 0], startTime: '08:00', lateGraceMin: 5 };
const NOW = Date.parse('2026-10-23T09:00:00Z');   // Friday 23.10.2026, noon in Israel
const day = (r: ReturnType<typeof monthReport>, date: string) => r.days.find((d) => d.date === date)!;
const sumPct = (p: Record<number, number>) => Object.values(p).reduce((a, b) => a + b, 0);

test('attendance: every day of the month, in order, with its weekday', () => {
  assert.equal(daysOfMonth('2026-02').length, 28);
  assert.equal(daysOfMonth('2028-02').length, 29);
  const r = monthReport({ month: '2026-09', entries: [], track: FIVE, now: NOW });
  assert.equal(r.days.length, 30);
  assert.equal(r.days[0].date, '2026-09-01'); assert.equal(r.days[0].weekday, 2);
  assert.equal(shiftMonth('2026-01', -1), '2025-12'); assert.equal(shiftMonth('2026-12', 1), '2027-01');
});

test('attendance: a night shift crosses midnight — one shift of the day it started on', () => {
  const r = monthReport({ month: '2026-09', entries: [S('n', '2026-09-03', '22:00', '2026-09-04', '06:00')], track: FIVE, now: NOW });
  const d = day(r, '2026-09-03');
  assert.equal(d.shifts.length, 1); assert.equal(d.worked, 480); assert.equal(d.shifts[0].outNextDay, true);
  assert.equal(d.shifts[0].inTime, '22:00'); assert.equal(d.shifts[0].outTime, '06:00');
  assert.equal(day(r, '2026-09-04').shifts.length, 0);
  assert.equal(day(r, '2026-09-04').status, 'off');          // the Friday after: nothing of its own
});

test('attendance: a shift across the end of the month belongs to the month it started in', () => {
  const e = S('m', '2026-09-30', '22:00', '2026-10-01', '06:00');
  const sep = monthReport({ month: '2026-09', entries: [e], track: FIVE, now: NOW });
  const oct = monthReport({ month: '2026-10', entries: [e], track: FIVE, now: NOW });
  assert.equal(day(sep, '2026-09-30').worked, 480);
  assert.equal(sep.totals.paid, 480);
  assert.equal(oct.totals.paid, 0);
  assert.equal(day(oct, '2026-10-01').shifts.length, 0);
});

test('attendance: summer / winter time — the real hours of the night the clock moves', () => {
  // Israel 2026: summer time starts Friday 27.3 at 02:00 (→ 03:00), ends Sunday 25.10 at 02:00 (→ 01:00)
  const spring = monthReport({ month: '2026-03', entries: [S('s', '2026-03-26', '22:00', '2026-03-27', '06:00')], track: FIVE, now: NOW });
  assert.equal(day(spring, '2026-03-26').worked, 7 * 60, 'the night is an hour shorter');
  const autumn = monthReport({ month: '2026-10', entries: [S('a', '2026-10-24', '22:00', '2026-10-25', '06:00')], track: FIVE, now: Date.parse('2026-11-01T10:00:00Z') });
  assert.equal(day(autumn, '2026-10-24').worked, 9 * 60, 'the night is an hour longer');
  // a day shift on the day itself: as long as the wall clock says
  const d = monthReport({ month: '2026-10', entries: [S('d', '2026-10-25', '08:00', '2026-10-25', '16:00')], track: FIVE, now: Date.parse('2026-11-01T10:00:00Z') });
  assert.equal(day(d, '2026-10-25').worked, 480);
});

test('attendance: a clock-in with no clock-out — red, not paid, counted as open', () => {
  const r = monthReport({ month: '2026-09', entries: [S('o', '2026-09-07', '08:00', null)], track: FIVE, now: NOW });
  const d = day(r, '2026-09-07');
  assert.equal(d.status, 'open'); assert.equal(d.paid, 0); assert.equal(d.shifts[0].open, true);
  assert.equal(r.totals.openShifts, 1); assert.equal(r.totals.workDays, 0);
  // today: "היום", not red
  const t = monthReport({ month: '2026-10', entries: [S('t', '2026-10-23', '08:00', null)], track: FIVE, now: NOW });
  assert.equal(day(t, '2026-10-23').status, 'today');
});

test('attendance: two shifts in a day, and breaks', () => {
  const two = [S('a', '2026-09-08', '08:00', '2026-09-08', '12:00'), S('b', '2026-09-08', '12:30', '2026-09-08', '17:00')];
  const r = monthReport({ month: '2026-09', entries: two, track: FIVE, now: NOW });
  assert.equal(day(r, '2026-09-08').worked, 510); assert.equal(day(r, '2026-09-08').shifts.length, 2);
  // the default: no break taken off
  const one = [S('c', '2026-09-09', '08:00', '2026-09-09', '17:00')];
  assert.equal(day(monthReport({ month: '2026-09', entries: one, track: FIVE, now: NOW }), '2026-09-09').paid, 540);
  // a track with a 30-minute break after 6 hours: off the single shift; not off the day the employee clocked out for it
  const withBreak: Track = { ...FIVE, autoBreakMin: 30, autoBreakAfterMin: 360 };
  assert.equal(day(monthReport({ month: '2026-09', entries: one, track: withBreak, now: NOW }), '2026-09-09').paid, 510);
  assert.equal(day(monthReport({ month: '2026-09', entries: two, track: withBreak, now: NOW }), '2026-09-08').paid, 510);
  // a break of 10 minutes clocked out: 20 more are taken off
  const short = [S('d', '2026-09-10', '08:00', '2026-09-10', '12:00'), S('e', '2026-09-10', '12:10', '2026-09-10', '17:00')];
  assert.equal(day(monthReport({ month: '2026-09', entries: short, track: withBreak, now: NOW }), '2026-09-10').paid, 530 - 20);
  // a short day: no break
  const half = [S('f', '2026-09-13', '08:00', '2026-09-13', '12:00')];
  assert.equal(day(monthReport({ month: '2026-09', entries: half, track: withBreak, now: NOW }), '2026-09-13').paid, 240);
});

test('attendance: overtime after the day\'s standard — 125% for two hours, then 150%', () => {
  assert.deepEqual(splitByTiers(660, 516, 100, DAILY), { 100: 516, 125: 120, 150: 24 });
  assert.deepEqual(splitByTiers(500, 516, 100, DAILY), { 100: 500 });
  assert.deepEqual(splitByTiers(0, 516, 100, DAILY), {});
  const r = monthReport({ month: '2026-09', entries: [S('x', '2026-09-08', '07:00', '2026-09-08', '18:00')], track: FIVE, now: NOW });
  const d = day(r, '2026-09-08');
  assert.equal(d.pct[100], 516); assert.equal(d.pct[125], 120); assert.equal(d.pct[150], 24);
  assert.equal(r.totals.pct[125], 120);
  // a 9-hour track: overtime starts later
  const nine: Track = { dayMinutes: [540, 540, 540, 540, 540, 0, 0] };
  assert.deepEqual(monthReport({ month: '2026-09', entries: [S('y', '2026-09-08', '07:00', '2026-09-08', '18:00')], track: nine, now: NOW }).days[7].pct, { 100: 540, 125: 120 });
});

test('attendance: Saturday and a festival are days of rest — 150%, then their own overtime', () => {
  const sat = monthReport({ month: '2026-09', entries: [S('s', '2026-09-05', '08:00', '2026-09-05', '16:00')], track: FIVE, now: NOW });
  const d = day(sat, '2026-09-05');
  assert.equal(d.type, 'saturday'); assert.equal(d.rest, true); assert.deepEqual(d.pct, { 150: 480 });
  assert.equal(sat.totals.restMinutes, 480);
  const long = monthReport({ month: '2026-09', entries: [S('l', '2026-09-05', '08:00', '2026-09-05', '18:00')], track: FIVE, now: NOW });
  assert.deepEqual(day(long, '2026-09-05').pct, { 150: 516, 175: 84 });
  // a festival on a weekday: Yom Kippur 5787 = Monday 21.9.2026 — no standard, rest
  const kippur = [...holidaysIn('2026-09-01', '2026-09-30')].find(([, l]) => l.some((h) => h.name === 'יום כיפור'))![0];
  assert.equal(kippur, '2026-09-21');
  const k = monthReport({ month: '2026-09', entries: [S('k', kippur, '08:00', kippur, '12:00')], track: FIVE, now: NOW });
  assert.equal(day(k, kippur).type, 'chag'); assert.equal(day(k, kippur).standard, 0); assert.deepEqual(day(k, kippur).pct, { 150: 240 });
  // a festival with no report is not "missing"
  assert.equal(day(monthReport({ month: '2026-09', entries: [], track: FIVE, now: NOW }), kippur).status, 'off');
  // a Friday on a five-day track: not a work day of the track, its hours are regular up to 8.6 (needs confirmation)
  const fri = monthReport({ month: '2026-09', entries: [S('f', '2026-09-04', '08:00', '2026-09-04', '18:00')], track: FIVE, now: NOW });
  assert.equal(day(fri, '2026-09-04').type, 'friday'); assert.equal(day(fri, '2026-09-04').standard, 0);
  assert.deepEqual(day(fri, '2026-09-04').pct, { 100: 516, 125: 84 });
});

test('attendance: the kind of every day by the Hebrew calendar', () => {
  const hol = holidaysIn('2026-09-01', '2026-10-31');
  const t = (d: string) => dayType(d, hol.get(d) ?? []).type;
  assert.equal(t('2026-09-11'), 'erev');     // ערב ראש השנה
  assert.equal(t('2026-09-12'), 'chag');     // ראש השנה (a Saturday too)
  assert.equal(t('2026-09-13'), 'chag');
  assert.equal(t('2026-09-27'), 'chol');     // חול המועד סוכות
  assert.equal(t('2026-10-03'), 'chag');     // שמחת תורה
  assert.equal(t('2026-09-15'), 'weekday');
  assert.equal(t('2026-09-18'), 'friday');
  assert.equal(t('2026-09-19'), 'saturday');
  assert.match(dayType('2026-09-21', hol.get('2026-09-21') ?? []).holiday, /יום כיפור/);
});

test('attendance: missing days are red only on past work days of the track', () => {
  const r = monthReport({ month: '2026-10', entries: [S('a', '2026-10-05', '08:00', '2026-10-05', '16:00')], track: FIVE, now: NOW });
  assert.equal(day(r, '2026-10-05').status, 'ok');
  assert.equal(day(r, '2026-10-06').status, 'missing');      // a Tuesday with no report
  assert.equal(day(r, '2026-10-09').status, 'off');          // Friday
  assert.equal(day(r, '2026-10-10').status, 'off');          // Saturday
  assert.equal(day(r, '2026-10-26').status, 'future');
  assert.equal(day(r, '2026-10-23').status, 'off');          // today is a Friday — not a work day
  // before the employee started: not missing
  const late = monthReport({ month: '2026-10', entries: [], track: FIVE, now: NOW, startDate: '2026-10-20' });
  assert.equal(day(late, '2026-10-19').status, 'off'); assert.equal(day(late, '2026-10-20').status, 'missing');
  assert.equal(late.totals.missingDays, 3);
});

test('attendance: a voided entry is out of the sums, its replacement counts', () => {
  const entries = [
    S('old', '2026-09-08', '08:15', '2026-09-08', '16:00', { voidedAt: '2026-09-09T08:00:00Z' }),
    S('new', '2026-09-08', '08:00', '2026-09-08', '16:00', { replaces: 'old', method: 'manual' }),
  ];
  const r = monthReport({ month: '2026-09', entries, track: FIVE, now: NOW });
  assert.equal(day(r, '2026-09-08').shifts.length, 1); assert.equal(day(r, '2026-09-08').paid, 480);
  assert.equal(day(r, '2026-09-08').shifts[0].corrected, true);
});

test('attendance: how each entry was made — rows from before 5800 by their source', () => {
  const r = monthReport({ month: '2026-09', entries: [
    S('q', '2026-09-08', '08:00', '2026-09-08', '12:00', { source: 'qr' }),
    S('l', '2026-09-09', '08:00', '2026-09-09', '12:00', { source: 'self' }),
    S('n', '2026-09-10', '08:00', '2026-09-10', '12:00', { method: 'nfc', outMethod: 'qr' }),
  ], track: FIVE, now: NOW });
  assert.equal(day(r, '2026-09-08').shifts[0].method, 'qr');
  assert.equal(day(r, '2026-09-09').shifts[0].method, 'link');
  assert.equal(day(r, '2026-09-10').shifts[0].method, 'nfc'); assert.equal(day(r, '2026-09-10').shifts[0].outMethod, 'qr');
});

test('attendance: absences — whole days by kind, hours of one day', () => {
  const r = monthReport({ month: '2026-09', entries: [], track: FIVE, now: NOW, absences: [
    { id: 'v', kind: 'vacation', from: '2026-09-01', to: '2026-09-02', minutes: null, status: 'approved' },
    { id: 's', kind: 'sick', from: '2026-09-03', to: '2026-09-05', minutes: null, status: 'approved' },   // Thu–Sat: one work day
    { id: 'r', kind: 'reserve', from: '2026-09-07', to: '2026-09-07', minutes: null, status: 'cancelled' },
    { id: 'p', kind: 'other', from: '2026-09-08', to: '2026-09-08', minutes: 120, status: 'pending' },
  ] });
  assert.equal(day(r, '2026-09-01').status, 'absence'); assert.equal(day(r, '2026-09-01').absence?.kind, 'vacation');
  assert.equal(r.totals.absenceDays.vacation, 2); assert.equal(r.totals.absenceDays.sick, 1);
  assert.equal(r.totals.absenceDays.reserve, 0); assert.equal(day(r, '2026-09-07').status, 'missing', 'a cancelled absence is not one');
  assert.equal(day(r, '2026-09-08').status, 'missing', 'a waiting absence is not one yet');
  const h = monthReport({ month: '2026-09', entries: [S('w', '2026-09-08', '10:00', '2026-09-08', '16:00')], track: FIVE, now: NOW,
    absences: [{ id: 'p', kind: 'other', from: '2026-09-08', to: '2026-09-08', minutes: 120, status: 'approved' }] });
  assert.equal(h.totals.absenceMinutes.other, 120); assert.equal(day(h, '2026-09-08').status, 'ok');
});

test('attendance: exact to the minute — clock-out minute less clock-in minute, as the screen shows them; never rounded', () => {
  const at = (h: number, m: number, s = 0) => new Date(Date.parse(israelToIso('2026-09-08', '00:00')) + ((h * 60 + m) * 60 + s) * 1000).toISOString();
  // 07:58:40 → 16:03:10 is shown 07:58 → 16:03 = 8:05 — and counted 8:05 (not 8:04:30 rounded either way)
  const one = monthReport({ month: '2026-09', entries: [{ id: 'x', clockIn: at(7, 58, 40), clockOut: at(16, 3, 10) }], track: FIVE, now: NOW });
  assert.equal(day(one, '2026-09-08').worked, 485);
  assert.deepEqual([day(one, '2026-09-08').shifts[0].inTime, day(one, '2026-09-08').shifts[0].outTime], ['07:58', '16:03']);
  // three shifts of 08:00:00 → 08:20:30 each: 20 minutes each as shown — 60, the sum of what the report lists
  const entries: EngineEntry[] = [0, 1, 2].map((i) => ({ id: `r${i}`, clockIn: at(8 + i, 0), clockOut: at(8 + i, 20, 30) }));
  const r = monthReport({ month: '2026-09', entries, track: FIVE, now: NOW });
  assert.equal(day(r, '2026-09-08').worked, 60);
  assert.equal(day(r, '2026-09-08').shifts.reduce((a, x) => a + x.minutes, 0), day(r, '2026-09-08').worked, 'the day = the sum of its shifts');
  const many = monthReport({ month: '2026-09', track: FIVE, now: NOW, entries: [
    S('a', '2026-09-01', '07:03', '2026-09-01', '18:47'), S('b', '2026-09-03', '22:10', '2026-09-04', '06:05'),
    S('c', '2026-09-05', '09:00', '2026-09-05', '19:30'), S('d', '2026-09-21', '08:00', '2026-09-21', '10:00'),
    S('e', '2026-09-30', '23:00', '2026-10-01', '07:00'),
  ] });
  assert.equal(many.days[many.days.length - 1].cumulative, many.totals.paid);
  assert.equal(sumPct(many.totals.pct), many.totals.paid, 'every paid minute has exactly one rate');
  for (const d of many.days) assert.equal(sumPct(d.pct), d.paid, d.date);
  assert.deepEqual(Object.keys(many.totals.pct).map(Number), [...PCT_COLUMNS]);
});

test('attendance: late — after the track\'s start and its grace', () => {
  const r = monthReport({ month: '2026-09', track: FIVE, now: NOW, entries: [
    S('a', '2026-09-08', '08:04', '2026-09-08', '16:00'), S('b', '2026-09-09', '08:20', '2026-09-09', '16:00'),
  ] });
  assert.equal(day(r, '2026-09-08').late, 0); assert.equal(day(r, '2026-09-09').late, 20); assert.equal(r.totals.lateDays, 1);
  // a night shift (22:00) is another shift, not 14 hours late
  const n = monthReport({ month: '2026-09', track: FIVE, now: NOW, entries: [S('n', '2026-09-08', '22:00', '2026-09-09', '06:00')] });
  assert.equal(day(n, '2026-09-08').late, 0);
});

test('attendance: formats for the screen and for payroll', () => {
  assert.equal(hm(425), '7:05'); assert.equal(hm(0), '0:00'); assert.equal(hm(-30), '-0:30');
  assert.equal(hoursDec(425), 7.08); assert.equal(hoursDec(516), 8.6);
});

test('attendance: the rules — the law\'s and the owner\'s defaults, each with its source; a track\'s row read as rules', () => {
  assert.deepEqual([DEFAULT_RULES.tier1Minutes, DEFAULT_RULES.tier1Pct, DEFAULT_RULES.tier2Pct], [120, 125, 150], '125% for two hours, then 150%');
  assert.deepEqual([DEFAULT_RULES.restWeekday, DEFAULT_RULES.restPct, DEFAULT_RULES.independencePct, DEFAULT_RULES.independenceRest], [6, 150, 200, true]);
  assert.equal(DEFAULT_RULES.autoBreakMin, 0, 'the automatic break is the employer\'s button — off');
  assert.deepEqual(AUTO_BREAK, { minutes: 30, afterMinutes: 480 }, 'a work day of more than 8 hours');
  for (const k of ['mode', 'tier1Pct', 'restPct', 'festivalPct', 'independencePct', 'eveMinutes', 'autoBreakMin', 'shiftDay', 'rounding'])
    assert.ok(RULE_NOTES.some((n) => n.key === k), `a note for ${k}`);
  const r = rulesOf({ ot_mode: 'monthly', monthly_minutes: 11160, monthly_tier1_minutes: 600, tier1_pct: 130, rest_weekday: 5, independence_rest: false, eve_minutes: 420 });
  assert.equal(r.mode, 'monthly'); assert.equal(r.monthlyMinutes, 11160); assert.equal(r.tier1Pct, 130); assert.equal(r.tier2Pct, 150);
  assert.equal(r.restWeekday, 5); assert.equal(r.independenceRest, false); assert.equal(r.eveMinutes, 420);
  assert.ok(ratesValid(DEFAULT_RULES)); assert.ok(!ratesValid({ ...DEFAULT_RULES, tier1Pct: 90 })); assert.ok(!ratesValid({ ...DEFAULT_RULES, mode: 'monthly' }), 'monthly needs its hours');
});

const SIX: Track = { dayMinutes: [480, 480, 480, 480, 480, 480, 0] };
const withRules = (t: Track, r: Partial<ContractRules>): Track => ({ ...t, rules: { ...DEFAULT_RULES, ...r } });

test('attendance: a six-day contract — the threshold the employer picks (8:00, 8:40), then 125% / 150%', () => {
  const day10 = [S('a', '2026-09-08', '07:00', '2026-09-08', '17:00')];   // 10 hours on a Tuesday
  const eight = monthReport({ month: '2026-09', entries: day10, track: SIX, now: NOW });
  assert.deepEqual(day(eight, '2026-09-08').pct, { 100: 480, 125: 120 });
  const t840 = monthReport({ month: '2026-09', entries: day10, track: { ...SIX, dayMinutes: SIX.dayMinutes.map((m) => (m ? 520 : 0)) }, now: NOW });
  assert.deepEqual(day(t840, '2026-09-08').pct, { 100: 520, 125: 80 });
  // a Friday is a work day on a six-day track — its own standard, not "off"
  const fri = monthReport({ month: '2026-09', entries: [S('f', '2026-09-04', '08:00', '2026-09-04', '18:00')], track: SIX, now: NOW });
  assert.equal(day(fri, '2026-09-04').standard, 480); assert.deepEqual(day(fri, '2026-09-04').pct, { 100: 480, 125: 120 });
  assert.equal(day(monthReport({ month: '2026-09', entries: [], track: SIX, now: NOW }), '2026-09-11').status, 'missing', 'a Friday with no report on a six-day track is missing');
  // the employer's own rates and length of the first tier
  const own = monthReport({ month: '2026-09', entries: [S('b', '2026-09-08', '06:00', '2026-09-08', '18:00')], track: withRules(SIX, { tier1Minutes: 60, tier1Pct: 130, tier2Pct: 160 }), now: NOW });
  assert.deepEqual(day(own, '2026-09-08').pct, { 100: 480, 130: 60, 160: 180 });
  assert.deepEqual(pctColumns([own]), [100, 125, 130, 150, 160, 175, 200], 'a rate the employer set has its own column');
});

test('attendance: a monthly threshold (186 hours) — overtime once the month passed it, in day order, its 125% share by the contract', () => {
  const track = withRules(SIX, { mode: 'monthly', monthlyMinutes: 186 * 60, monthlyTier1Minutes: 120 });
  // September 2026 has 24 work days on a six-day track (no Saturday, no festival): 8 hours each = 192 — 186 regular, then 2 at 125%, 4 at 150%
  const days = monthReport({ month: '2026-09', entries: [], track: SIX, now: NOW }).days.filter((x) => x.standard > 0).map((x) => x.date);
  assert.equal(days.length, 24);
  const r = monthReport({ month: '2026-09', entries: days.map((d) => S(d, d, '08:00', d, '16:00')), track, now: NOW });
  assert.equal(r.totals.paid, 192 * 60);
  assert.equal(r.totals.pct[100], 186 * 60); assert.equal(r.totals.pct[125], 120); assert.equal(r.totals.pct[150], 240);
  assert.deepEqual(day(r, days[22]).pct, { 100: 480 }, 'day 23: 176 → 184 hours, still regular');
  assert.deepEqual(day(r, days[23]).pct, { 100: 120, 125: 120, 150: 240 }, 'day 24: crosses 186 — then the contract\'s 125% share, then 150%');
  // a long day under the monthly threshold is regular (no daily overtime)
  const one = monthReport({ month: '2026-09', entries: [S('l', '2026-09-08', '06:00', '2026-09-08', '18:00')], track, now: NOW });
  assert.deepEqual(day(one, '2026-09-08').pct, { 100: 720 });
});

test('attendance: rest days — the weekly one at 150%, Independence Day at 200%, a festival; the employer may change each', () => {
  const sat = monthReport({ month: '2026-09', entries: [S('s', '2026-09-05', '08:00', '2026-09-05', '16:00')], track: SIX, now: NOW });
  assert.deepEqual(day(sat, '2026-09-05').pct, { 150: 480 });
  // Independence Day 5787 (spring 2027)
  const indep = [...holidaysIn('2027-04-01', '2027-06-15')].find(([, l]) => l.some((h) => h.name === 'יום העצמאות'))![0];
  const i = monthReport({ month: indep.slice(0, 7), entries: [S('i', indep, '08:00', indep, '14:00')], track: SIX, now: Date.parse('2027-07-01T09:00:00Z') });
  assert.equal(day(i, indep).type, 'national'); assert.equal(day(i, indep).standard, 0); assert.deepEqual(day(i, indep).pct, { 200: 360 });
  const work = monthReport({ month: indep.slice(0, 7), entries: [S('i', indep, '08:00', indep, '14:00')], track: withRules(SIX, { independenceRest: false }), now: Date.parse('2027-07-01T09:00:00Z') });
  assert.deepEqual(day(work, indep).pct, { 100: 360 }, 'not a day of rest in this contract');
  // a contract whose weekly rest day is Friday
  const fri = monthReport({ month: '2026-09', entries: [S('f', '2026-09-04', '08:00', '2026-09-04', '12:00')], track: withRules({ ...SIX, dayMinutes: [480, 480, 480, 480, 480, 0, 480] }, { restWeekday: 5 }), now: NOW });
  assert.deepEqual(day(fri, '2026-09-04').pct, { 150: 240 });
  // a festival at the employer's rate, overtime on a rest day never below the day's own rate
  const k = monthReport({ month: '2026-09', entries: [S('k', '2026-09-21', '06:00', '2026-09-21', '18:00')], track: withRules(SIX, { festivalPct: 200 }), now: NOW });
  assert.deepEqual(day(k, '2026-09-21').pct, { 200: 720 });
});

test('attendance: the eve of a festival — the track\'s day, or the employer\'s hours', () => {
  const eve = '2026-09-20';   // ערב יום כיפור, a Sunday
  const plain = monthReport({ month: '2026-09', entries: [S('e', eve, '08:00', eve, '16:00')], track: SIX, now: NOW });
  assert.equal(day(plain, eve).standard, 480); assert.deepEqual(day(plain, eve).pct, { 100: 480 });
  const short = monthReport({ month: '2026-09', entries: [S('e', eve, '08:00', eve, '16:00')], track: withRules(SIX, { eveMinutes: 360 }), now: NOW });
  assert.equal(day(short, eve).standard, 360); assert.deepEqual(day(short, eve).pct, { 100: 360, 125: 120 });
});

test('attendance: the automatic 30-minute break — the employer\'s button', () => {
  const nine = [S('n', '2026-09-08', '08:00', '2026-09-08', '17:00')];
  assert.equal(day(monthReport({ month: '2026-09', entries: nine, track: SIX, now: NOW }), '2026-09-08').paid, 540, 'off: nothing taken');
  const on = withRules(SIX, { autoBreakMin: AUTO_BREAK.minutes, autoBreakAfterMin: AUTO_BREAK.afterMinutes });
  const d = day(monthReport({ month: '2026-09', entries: nine, track: on, now: NOW }), '2026-09-08');
  assert.equal(d.breakTaken, 30); assert.equal(d.paid, 510); assert.deepEqual(d.pct, { 100: 480, 125: 30 });
  assert.equal(day(monthReport({ month: '2026-09', entries: [S('h', '2026-09-08', '08:00', '2026-09-08', '16:00')], track: on, now: NOW }), '2026-09-08').breakTaken, 0, 'exactly 8 hours: not more than 8');
  assert.equal(day(monthReport({ month: '2026-09', entries: [S('h', '2026-09-08', '08:00', '2026-09-08', '16:01')], track: on, now: NOW }), '2026-09-08').breakTaken, 30, '8:01: more than 8');
  // the employee clocked out for 20 minutes too: 10 more, never 50 in all
  const both = day(monthReport({ month: '2026-09', entries: [S('p', '2026-09-08', '07:00', '2026-09-08', '12:00'), S('q', '2026-09-08', '12:20', '2026-09-08', '17:00')], track: on, now: NOW }), '2026-09-08');
  assert.equal(both.worked, 580); assert.equal(both.breakTaken, 10); assert.equal(both.paid, 570);
  // the button off: the clocked break is the break — nothing more taken off
  assert.equal(day(monthReport({ month: '2026-09', entries: [S('p', '2026-09-08', '07:00', '2026-09-08', '12:00'), S('q', '2026-09-08', '12:20', '2026-09-08', '17:00')], track: SIX, now: NOW }), '2026-09-08').paid, 580);
});

test('attendance: hours only — over the threshold and on days of rest are hours, whatever the recommended rates are', () => {
  const entries = [S('a', '2026-09-08', '07:00', '2026-09-08', '17:00'), S('b', '2026-09-12', '08:00', '2026-09-12', '11:30')];   // Tuesday 10h, Saturday 3:30
  const a = monthReport({ month: '2026-09', entries, track: SIX, now: NOW });
  const b = monthReport({ month: '2026-09', entries, track: withRules(SIX, { tier1Pct: 140, tier2Pct: 175, restPct: 200 }), now: NOW });
  for (const r of [a, b]) {
    assert.equal(r.totals.paid, 810); assert.equal(r.totals.overMinutes, 120, '2 hours over 8:00'); assert.equal(r.totals.restMinutes, 210);
    assert.equal(day(r, '2026-09-08').over, 120); assert.equal(day(r, '2026-09-12').over, 0, 'a day of rest: its hours are rest hours');
  }
  assert.notDeepEqual(a.totals.pct, b.totals.pct, 'only the recommendation follows the settings');
});
