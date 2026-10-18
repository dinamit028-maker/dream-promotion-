import { addDays } from './calendar';
import { weekdayOf } from './slots';

/**
 * The holidays of Israel on the calendar (2.106): the festivals and their intermediate days, the memorial and independence days,
 * the fasts and the eves of the festivals — computed from the Hebrew calendar every browser has (Intl, calendar 'hebrew'), with
 * the official rules for a day that moves (Yom HaAtzmaut and Yom HaZikaron, Yom HaShoah, a fast that falls on Shabbat). No list to
 * keep up to date and no service. Pure — tests/booking-holidays.test.ts.
 */

/** chag: a festival day (no work); chol: its intermediate days; national / memorial: the state's days; minor: the rest */
export type HolidayKind = 'chag' | 'chol' | 'erev' | 'national' | 'memorial' | 'fast' | 'minor';
export type Holiday = { date: string; name: string; kind: HolidayKind };

type Month = 'tishri' | 'heshvan' | 'kislev' | 'tevet' | 'shevat' | 'adar1' | 'adar2' | 'adar' | 'nisan' | 'iyar' | 'sivan' | 'tamuz' | 'av' | 'elul';
/** the month as the calendar names it (CLDR, English) — Adar I and Adar II in a leap year, Adar in another; spellings vary a little */
const MONTHS: [RegExp, Month][] = [
  [/^tish/, 'tishri'], [/^c?hesh/, 'heshvan'], [/^kis/, 'kislev'], [/^tev/, 'tevet'], [/^sh/, 'shevat'],
  [/^adar (ii|2)$/, 'adar2'], [/^adar (i|1)$/, 'adar1'], [/^adar$/, 'adar'],
  [/^nis/, 'nisan'], [/^iy/, 'iyar'], [/^siv/, 'sivan'], [/^tam/, 'tamuz'], [/^av$/, 'av'], [/^elul/, 'elul'],
];

let format: Intl.DateTimeFormat | null | undefined;
const known = new Map<string, { day: number; month: Month; year: number } | null>();

/** the Hebrew date of a calendar day ("2026-09-12" → 1 Tishri 5787); null where the browser has no Hebrew calendar */
export function hebrewDate(date: string): { day: number; month: Month; year: number } | null {
  if (known.has(date)) return known.get(date)!;
  if (format === undefined) {
    try { format = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); }
    catch { format = null; }
  }
  let out: { day: number; month: Month; year: number } | null = null;
  const at = new Date(`${date}T12:00:00Z`);
  if (format && !Number.isNaN(at.getTime())) {
    const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
    const name = String(parts.month ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const month = MONTHS.find(([re]) => re.test(name))?.[1];
    const day = Number(parts.day), year = Number(parts.year);
    if (month && day && year) out = { day, month, year };
  }
  known.set(date, out);
  return out;
}

/** a Hebrew year with a second Adar (7 of every 19) */
export const leapYear = (year: number) => (7 * year + 1) % 19 < 7;

// Yom HaAtzmaut: 5 Iyar; on a Friday or a Saturday — the Thursday before; on a Monday — the Tuesday (and Yom HaZikaron the day before)
const atzmaut = (weekday: number) => (weekday === 5 ? -1 : weekday === 6 ? -2 : weekday === 1 ? 1 : 0);
const afterShabbat = (weekday: number) => (weekday === 6 ? 1 : 0);

type Rule = { month: Month | 'purim'; day: number; name: string; kind: HolidayKind; days?: number; move?: (weekday: number) => number };
/** 'purim': Adar II in a leap year, Adar in another */
const RULES: Rule[] = [
  { month: 'elul', day: 29, name: 'ערב ראש השנה', kind: 'erev' },
  { month: 'tishri', day: 1, name: 'ראש השנה', kind: 'chag', days: 2 },
  { month: 'tishri', day: 3, name: 'צום גדליה', kind: 'fast', move: afterShabbat },
  { month: 'tishri', day: 9, name: 'ערב יום כיפור', kind: 'erev' },
  { month: 'tishri', day: 10, name: 'יום כיפור', kind: 'chag' },
  { month: 'tishri', day: 14, name: 'ערב סוכות', kind: 'erev' },
  { month: 'tishri', day: 15, name: 'סוכות', kind: 'chag' },
  { month: 'tishri', day: 16, name: 'חול המועד סוכות', kind: 'chol', days: 5 },
  { month: 'tishri', day: 21, name: 'הושענא רבה', kind: 'chol' },
  { month: 'tishri', day: 22, name: 'שמחת תורה', kind: 'chag' },
  { month: 'kislev', day: 25, name: 'חנוכה', kind: 'minor', days: 8 },
  { month: 'tevet', day: 10, name: 'עשרה בטבת', kind: 'fast' },
  { month: 'shevat', day: 15, name: 'ט״ו בשבט', kind: 'minor' },
  { month: 'purim', day: 13, name: 'תענית אסתר', kind: 'fast', move: (w) => (w === 6 ? -2 : 0) },
  { month: 'purim', day: 14, name: 'פורים', kind: 'minor' },
  { month: 'purim', day: 15, name: 'שושן פורים', kind: 'minor' },
  { month: 'nisan', day: 14, name: 'ערב פסח', kind: 'erev' },
  { month: 'nisan', day: 15, name: 'פסח', kind: 'chag' },
  { month: 'nisan', day: 16, name: 'חול המועד פסח', kind: 'chol', days: 5 },
  { month: 'nisan', day: 21, name: 'שביעי של פסח', kind: 'chag' },
  { month: 'nisan', day: 27, name: 'יום השואה', kind: 'memorial', move: (w) => (w === 5 ? -1 : w === 0 ? 1 : 0) },
  { month: 'iyar', day: 5, name: 'יום הזיכרון', kind: 'memorial', move: (w) => atzmaut(w) - 1 },
  { month: 'iyar', day: 5, name: 'יום העצמאות', kind: 'national', move: atzmaut },
  { month: 'iyar', day: 18, name: 'ל״ג בעומר', kind: 'minor' },
  { month: 'iyar', day: 28, name: 'יום ירושלים', kind: 'national' },
  { month: 'sivan', day: 5, name: 'ערב שבועות', kind: 'erev' },
  { month: 'sivan', day: 6, name: 'שבועות', kind: 'chag' },
  { month: 'tamuz', day: 17, name: 'שבעה עשר בתמוז', kind: 'fast', move: afterShabbat },
  { month: 'av', day: 9, name: 'תשעה באב', kind: 'fast', move: afterShabbat },
  { month: 'av', day: 15, name: 'ט״ו באב', kind: 'minor' },
];

const isDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00Z`));

/**
 * The holidays from one calendar day to another (both included), by day in date order. A day that moves is found from its own
 * date — up to three days away (and Hanukkah's eight days from its first), so the days around the range are read too.
 */
export function holidaysIn(from: string, to: string): Map<string, Holiday[]> {
  const out = new Map<string, Holiday[]>();
  if (!isDate(from) || !isDate(to) || from > to) return out;
  for (let d = addDays(from, -10); d <= addDays(to, 3); d = addDays(d, 1)) {
    const h = hebrewDate(d);
    if (!h) return out;
    for (const r of RULES) {
      const month = r.month === 'purim' ? (leapYear(h.year) ? 'adar2' : 'adar') : r.month;
      if (month !== h.month || r.day !== h.day) continue;
      const first = addDays(d, r.move ? r.move(weekdayOf(d)) : 0);
      for (let k = 0; k < (r.days ?? 1); k++) {
        const date = addDays(first, k);
        if (date < from || date > to) continue;
        const list = out.get(date) ?? [];
        list.push({ date, name: r.name, kind: r.kind });
        out.set(date, list);
      }
    }
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** the festival days — no work — from one day to another: the ones "סגירה בחגים" closes */
export const festivalDays = (from: string, to: string): string[] =>
  [...holidaysIn(from, to)].filter(([, list]) => list.some((h) => h.kind === 'chag')).map(([date]) => date).sort();

/** the look of a holiday's name: a festival and the state's days stand out (globals.css .cal-hol — readable on the Friday and
 *  Saturday colours too), a memorial day in bold, the rest quieter */
export const holidayTone = (kind: HolidayKind) =>
  kind === 'chag' || kind === 'national' ? 'cal-hol font-bold' : kind === 'memorial' ? 'font-bold text-ink-2' : 'text-ink-2';
