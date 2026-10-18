/**
 * The holidays of Israel on the calendar (2.106): the Hebrew date from the calendar every browser has, a whole year day by day
 * (5787 — autumn 2026 to autumn 2027), dates already published (5785, 5786), the rules every year keeps over twenty years (the
 * days a festival never falls on, the days between festivals), each day that moves — every case at least once — and a range of
 * any size reads the same days.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { festivalDays, hebrewDate, holidaysIn, holidayTone, leapYear, type HolidayKind } from '../src/features/booking/holidays';
import { addDays } from '../src/features/booking/calendar';
import { weekdayOf } from '../src/features/booking/slots';

const [SUN, MON, TUE, WED, THU, FRI, SAT] = [0, 1, 2, 3, 4, 5, 6];

const flat = (from: string, to: string) => [...holidaysIn(from, to)].flatMap(([date, list]) => list.map((h) => [date, h.name, h.kind]));
const span = (from: string, n: number, name: string, kind: HolidayKind) => Array.from({ length: n }, (_, k) => [addDays(from, k), name, kind]);

test('the Hebrew date: from the calendar every browser has (Intl, calendar "hebrew")', () => {
  assert.deepEqual(hebrewDate('2026-09-11'), { day: 29, month: 'elul', year: 5786 });
  assert.deepEqual(hebrewDate('2026-09-12'), { day: 1, month: 'tishri', year: 5787 });
  assert.deepEqual(hebrewDate('2026-11-11'), { day: 1, month: 'kislev', year: 5787 });
  assert.deepEqual(hebrewDate('2027-02-08'), { day: 1, month: 'adar1', year: 5787 });
  assert.deepEqual(hebrewDate('2027-03-23'), { day: 14, month: 'adar2', year: 5787 });
  assert.deepEqual(hebrewDate('2028-03-12'), { day: 14, month: 'adar', year: 5788 });
  assert.deepEqual(hebrewDate('2027-04-22'), { day: 15, month: 'nisan', year: 5787 });
  assert.equal(hebrewDate('2026-13-01'), null, 'not a date: nothing, never a crash');
  for (const [year, leap] of [[5784, true], [5785, false], [5786, false], [5787, true], [5788, false], [5790, true]] as const) assert.equal(leapYear(year), leap, String(year));
});

test('a whole year, day by day: 5787 (from the eve of Rosh Hashana 2026 to the eve of the next)', () => {
  assert.deepEqual(flat('2026-09-11', '2027-10-01'), [
    ['2026-09-11', 'ערב ראש השנה', 'erev'],
    ['2026-09-12', 'ראש השנה', 'chag'],
    ['2026-09-13', 'ראש השנה', 'chag'],
    ['2026-09-14', 'צום גדליה', 'fast'],
    ['2026-09-20', 'ערב יום כיפור', 'erev'],
    ['2026-09-21', 'יום כיפור', 'chag'],
    ['2026-09-25', 'ערב סוכות', 'erev'],
    ['2026-09-26', 'סוכות', 'chag'],
    ...span('2026-09-27', 5, 'חול המועד סוכות', 'chol'),
    ['2026-10-02', 'הושענא רבה', 'chol'],
    ['2026-10-03', 'שמחת תורה', 'chag'],
    ...span('2026-12-05', 8, 'חנוכה', 'minor'),
    ['2026-12-20', 'עשרה בטבת', 'fast'],
    ['2027-01-23', 'ט״ו בשבט', 'minor'],
    ['2027-03-22', 'תענית אסתר', 'fast'],
    ['2027-03-23', 'פורים', 'minor'],
    ['2027-03-24', 'שושן פורים', 'minor'],
    ['2027-04-21', 'ערב פסח', 'erev'],
    ['2027-04-22', 'פסח', 'chag'],
    ...span('2027-04-23', 5, 'חול המועד פסח', 'chol'),
    ['2027-04-28', 'שביעי של פסח', 'chag'],
    ['2027-05-04', 'יום השואה', 'memorial'],
    ['2027-05-11', 'יום הזיכרון', 'memorial'],
    ['2027-05-12', 'יום העצמאות', 'national'],
    ['2027-05-25', 'ל״ג בעומר', 'minor'],
    ['2027-06-04', 'יום ירושלים', 'national'],
    ['2027-06-10', 'ערב שבועות', 'erev'],
    ['2027-06-11', 'שבועות', 'chag'],
    ['2027-07-22', 'שבעה עשר בתמוז', 'fast'],
    ['2027-08-12', 'תשעה באב', 'fast'],
    ['2027-08-18', 'ט״ו באב', 'minor'],
    ['2027-10-01', 'ערב ראש השנה', 'erev'],
  ]);
});

test('dates already published: 5785 and 5786 — with the days that moved (a fast on Shabbat, Yom HaAtzmaut on a Saturday)', () => {
  const all = holidaysIn('2024-10-01', '2026-08-31');
  const on = (date: string) => (all.get(date) ?? []).map((h) => h.name);
  const known: [string, string][] = [
    ['2024-10-03', 'ראש השנה'], ['2024-10-04', 'ראש השנה'], ['2024-10-06', 'צום גדליה'], ['2024-10-12', 'יום כיפור'], ['2024-10-17', 'סוכות'],
    ['2024-10-24', 'שמחת תורה'], ['2024-12-26', 'חנוכה'], ['2025-01-10', 'עשרה בטבת'], ['2025-03-13', 'תענית אסתר'], ['2025-03-14', 'פורים'],
    ['2025-04-13', 'פסח'], ['2025-04-19', 'שביעי של פסח'], ['2025-04-24', 'יום השואה'], ['2025-04-30', 'יום הזיכרון'], ['2025-05-01', 'יום העצמאות'],
    ['2025-05-26', 'יום ירושלים'], ['2025-06-02', 'שבועות'], ['2025-07-13', 'שבעה עשר בתמוז'], ['2025-08-03', 'תשעה באב'],
    ['2025-09-23', 'ראש השנה'], ['2025-09-24', 'ראש השנה'], ['2025-09-25', 'צום גדליה'], ['2025-10-02', 'יום כיפור'], ['2025-10-07', 'סוכות'],
    ['2025-10-14', 'שמחת תורה'], ['2025-12-15', 'חנוכה'], ['2025-12-30', 'עשרה בטבת'], ['2026-03-03', 'פורים'], ['2026-04-02', 'פסח'],
    ['2026-04-14', 'יום השואה'], ['2026-04-21', 'יום הזיכרון'], ['2026-04-22', 'יום העצמאות'], ['2026-05-22', 'שבועות'], ['2026-07-23', 'תשעה באב'],
  ];
  for (const [date, name] of known) assert.deepEqual(on(date), [name], date);
  assert.deepEqual(on('2025-05-03'), [], 'Yom HaAtzmaut 5785 fell on a Saturday: it was on the Thursday');
  assert.deepEqual(on('2024-10-05'), [], 'the fast of Gedaliah fell on Shabbat: it was on the Sunday');
});

test('twenty years of rules: the days a festival never falls on, the days between festivals, the days that move', () => {
  const all = holidaysIn('2025-01-01', '2046-12-31');
  const dates = (name: string) => [...all].filter(([, list]) => list.some((h) => h.name === name)).map(([date]) => date);
  const firsts = (name: string) => { const list = dates(name); return list.filter((d) => !list.includes(addDays(d, -1))); };
  const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const weekdays = (list: string[]) => new Set(list.map(weekdayOf));
  const not = (list: string[], banned: number[], what: string) => { for (const d of list) assert.ok(!banned.includes(weekdayOf(d)), `${what}: ${d}`); };

  const rh = firsts('ראש השנה'), yk = dates('יום כיפור'), sukkot = dates('סוכות'), pesach = dates('פסח');
  assert.equal(rh.length, 22);
  not(rh, [SUN, WED, FRI], 'Rosh Hashana');
  not(yk, [FRI, SUN], 'Yom Kippur');
  not(pesach, [MON, WED, FRI], 'Pesach');
  not(dates('שבועות'), [TUE, THU, SAT], 'Shavuot');
  not(dates('פורים'), [MON, WED, SAT], 'Purim');
  rh.forEach((d, i) => {
    assert.ok(dates('ראש השנה').includes(addDays(d, 1)), `two days: ${d}`);
    assert.equal(dates('ערב ראש השנה')[i], addDays(d, -1));
    assert.equal(yk[i], addDays(d, 9));
    assert.equal(dates('ערב יום כיפור')[i], addDays(d, 8));
    assert.equal(sukkot[i], addDays(d, 14));
    assert.equal(dates('הושענא רבה')[i], addDays(d, 20));
    assert.equal(dates('שמחת תורה')[i], addDays(d, 21));
  });
  pesach.forEach((d, i) => {
    assert.equal(dates('ערב פסח')[i], addDays(d, -1));
    assert.equal(dates('שביעי של פסח')[i], addDays(d, 6));
    assert.equal(dates('ל״ג בעומר')[i], addDays(d, 33));
    assert.equal(dates('יום ירושלים')[i], addDays(d, 43));
    assert.equal(dates('שבועות')[i], addDays(d, 50), 'fifty days of the Omer');
    assert.equal(dates('ערב שבועות')[i], addDays(d, 49));
  });
  assert.equal(dates('חול המועד סוכות').length, 5 * sukkot.length);
  assert.equal(dates('חול המועד פסח').length, 5 * pesach.length);
  // Hanukkah: eight days in a row (the ones the twenty years cut — 1.1.2025 is its seventh day — aside)
  const hanukkah = firsts('חנוכה').filter((d) => d > '2025-01-01' && addDays(d, 7) <= '2046-12-31');
  assert.ok(hanukkah.length >= 21);
  for (const d of hanukkah) {
    for (let k = 0; k < 8; k++) assert.ok(dates('חנוכה').includes(addDays(d, k)), `eight days: ${d}`);
    assert.ok(!dates('חנוכה').includes(addDays(d, 8)), `not nine: ${d}`);
  }

  // the state's days: Yom HaAtzmaut on a Tuesday, a Wednesday or a Thursday — never next to Shabbat; Yom HaZikaron the day before it
  const atzmaut = dates('יום העצמאות'), zikaron = dates('יום הזיכרון'), shoah = dates('יום השואה');
  assert.deepEqual(weekdays(atzmaut), new Set([TUE, WED, THU]));
  atzmaut.forEach((d, i) => { assert.equal(zikaron[i], addDays(d, -1)); assert.ok([18, 19, 20, 21].includes(days(pesach[i], d)), d); });
  assert.deepEqual(weekdays(shoah), new Set([MON, TUE, THU]), 'never on a Friday or a Sunday (next to Shabbat)');
  // the fasts: never on Shabbat; the tenth of Tevet stays on a Friday
  for (const [date, list] of all) if (list.some((h) => h.kind === 'fast')) assert.notEqual(weekdayOf(date), SAT, date);
  assert.ok(dates('עשרה בטבת').some((d) => weekdayOf(d) === FRI));
  dates('תענית אסתר').forEach((d, i) => assert.equal(d, addDays(dates('פורים')[i], weekdayOf(dates('פורים')[i]) === SUN ? -3 : -1), d));

  // each day that moves, every way it moves, at least once in these twenty years (by the Hebrew date it ends on)
  const onHebrew = (name: string) => new Set(dates(name).map((d) => hebrewDate(d)!.day));
  assert.deepEqual(onHebrew('יום העצמאות'), new Set([3, 4, 5, 6]), '5 Iyar; on a Saturday — 3; on a Friday — 4; on a Monday — 6');
  assert.deepEqual(onHebrew('יום הזיכרון'), new Set([2, 3, 4, 5]));
  assert.deepEqual(onHebrew('יום השואה'), new Set([26, 27, 28]), '27 Nisan; on a Friday — 26; on a Sunday — 28');
  assert.deepEqual(onHebrew('צום גדליה'), new Set([3, 4]));
  assert.deepEqual(onHebrew('שבעה עשר בתמוז'), new Set([17, 18]));
  assert.deepEqual(onHebrew('תשעה באב'), new Set([9, 10]));
  assert.deepEqual(onHebrew('תענית אסתר'), new Set([11, 13]), 'on Shabbat — the Thursday before');
  assert.deepEqual(onHebrew('עשרה בטבת'), new Set([10]), 'never moves');

  // a second Adar exactly in the years the rule says
  const withAdar1 = new Set([...Array(8100).keys()].map((k) => hebrewDate(addDays('2025-01-01', k))).filter((h) => h?.month === 'adar1').map((h) => h!.year));
  for (let year = 5786; year <= 5806; year++) assert.equal(withAdar1.has(year), leapYear(year), String(year));
});

test('a range of any size reads the same days — a week, one day, a day moved from outside it, Hanukkah begun before it', () => {
  const all = holidaysIn('2024-12-01', '2029-12-31');
  const slice = (from: string, to: string) => [...all].filter(([d]) => d >= from && d <= to);
  for (let d = '2024-12-29'; d <= '2029-12-23'; d = addDays(d, 7)) assert.deepEqual([...holidaysIn(d, addDays(d, 6))], slice(d, addDays(d, 6)), d);
  for (const [from, to] of [['2025-04-20', '2025-05-05'], ['2028-03-05', '2028-05-05'], ['2029-04-10', '2029-04-22'], ['2026-12-01', '2026-12-31']]) {
    for (let d = from; d <= to; d = addDays(d, 1)) assert.deepEqual([...holidaysIn(d, d)], slice(d, d), d);
  }
  assert.deepEqual(flat('2026-12-11', '2026-12-12'), span('2026-12-11', 2, 'חנוכה', 'minor'), 'the last days of Hanukkah');
  assert.deepEqual(flat('2025-04-30', '2025-04-30'), [['2025-04-30', 'יום הזיכרון', 'memorial']], 'moved three days back from 5 Iyar');
  assert.equal(holidaysIn('', '2026-01-01').size, 0);
  assert.equal(holidaysIn('2026-13-01', '2027-01-01').size, 0);
  assert.equal(holidaysIn('2027-01-01', '2026-01-01').size, 0, 'backwards: nothing');
});

test('"סגירה בחגים": the festival days of the coming year, nothing else', () => {
  assert.deepEqual(festivalDays('2026-09-11', '2027-10-01'), ['2026-09-12', '2026-09-13', '2026-09-21', '2026-09-26', '2026-10-03', '2027-04-22', '2027-04-28', '2027-06-11']);
  assert.deepEqual(festivalDays('2026-10-18', addDays('2026-10-18', 365)), ['2027-04-22', '2027-04-28', '2027-06-11', '2027-10-02', '2027-10-03', '2027-10-11', '2027-10-16']);
  assert.deepEqual(festivalDays('2027-05-01', '2027-05-31'), [], 'Yom HaAtzmaut is not a festival here — a business decides by itself');
  assert.equal(holidayTone('chag'), 'cal-hol font-bold');
  assert.equal(holidayTone('national'), 'cal-hol font-bold');
  assert.equal(holidayTone('memorial'), 'font-bold text-ink-2');
  assert.equal(holidayTone('erev'), 'text-ink-2');
});
