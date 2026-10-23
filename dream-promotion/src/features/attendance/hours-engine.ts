import { israelParts } from '@/lib/il-time';
import { holidaysIn, type Holiday } from '@/features/booking/holidays';
import { PCT_COLUMNS, rulesOf, type ContractRules, type Tier } from './overtime-rules';

/**
 * The hours of an employee's month — the one calculation behind the monthly report, the dashboard, the Excel / PDF and the
 * payroll file (tests/attendance-hours.test.ts). Pure: entries in, rows out.
 *   - a moment is exact (UTC); its day is the Israeli calendar day — so summer / winter time changes a night by an hour, never
 *     the sums of a day by a wrong one;
 *   - hours only (the owner of the system, 23.10.2026): the result is the hours — daily, cumulative, over the threshold, on days of
 *     rest, missing. The split by rates (pct) is a recommendation by the track's settings (rulesOf — the employer's own; a closed
 *     month — the ones it was closed with): the accountant and the employer decide the pay, never the system;
 *   - a shift belongs to the day it started on, a night shift is one shift of that day;
 *   - a voided entry is out of every sum (it is shown in the history only); an open one (no clock-out) is "חסר יציאה" — red,
 *     and not paid until it is closed;
 *   - exact to the minute (the owner of the system, 23.10.2026: not more, not less): a shift = its clock-out minute less its
 *     clock-in minute, as the screen shows them (07:58 → 16:03 = 8:05) — never rounded; the month = the sum of the days, so the
 *     report's column "מצטבר" ends on the month's total exactly.
 */
export type Method = 'link' | 'qr' | 'nfc' | 'gps' | 'manual' | 'request' | 'import';
export interface EngineEntry {
  id: string;
  clockIn: string;
  clockOut: string | null;
  method?: Method | null;
  outMethod?: Method | null;
  /** the old screen's / clock's source, for rows before migration 5800 (method is empty there) */
  source?: 'self' | 'manual' | 'qr' | string;
  voidedAt?: string | null;
  replaces?: string | null;
  inLat?: number | null; inLng?: number | null; outLat?: number | null; outLng?: number | null;
  note?: string;
}
export type AbsenceKind = 'vacation' | 'sick' | 'reserve' | 'other';
export interface EngineAbsence { id: string; kind: AbsenceKind; from: string; to: string; minutes: number | null; status: string }
export interface Track {
  /** standard minutes per weekday, Sunday first */
  dayMinutes: number[];
  startTime?: string | null;
  lateGraceMin?: number;
  autoBreakMin?: number;
  autoBreakAfterMin?: number;
  /** the track's settings for the recommended split by rates (the employer's; missing = the defaults of overtime-rules.ts) */
  rules?: Partial<ContractRules>;
}
/** a track that is not set: no standard (every day off the track) */
export const NO_TRACK: Track = { dayMinutes: [0, 0, 0, 0, 0, 0, 0] };

export type DayType = 'weekday' | 'friday' | 'saturday' | 'erev' | 'chag' | 'chol' | 'national';
export interface ShiftRow {
  id: string;
  in: string; out: string | null;
  inTime: string; outTime: string | null;
  /** the clock-out is on another calendar day (a night shift) */
  outNextDay: boolean;
  minutes: number;
  method: Method; outMethod: Method | null;
  inPlace: { lat: number; lng: number } | null; outPlace: { lat: number; lng: number } | null;
  corrected: boolean;
  open: boolean;
}
export type DayStatus = 'ok' | 'missing' | 'open' | 'absence' | 'off' | 'future' | 'today';
export interface DayRow {
  date: string;
  weekday: number;
  type: DayType;
  holiday: string;
  rest: boolean;
  standard: number;
  shifts: ShiftRow[];
  worked: number;
  breakTaken: number;
  paid: number;
  cumulative: number;
  standardCumulative: number;
  /** the minutes over the threshold, on a day that is not a day of rest (hours — not a rate) */
  over: number;
  /** the recommended split of the paid minutes by rate (100 = regular) — a recommendation for the accountant, never a ruling */
  pct: Record<number, number>;
  absence: { id: string; kind: AbsenceKind; minutes: number | null } | null;
  late: number;
  status: DayStatus;
}
export interface MonthTotals {
  workDays: number;
  paid: number;
  standard: number;
  /** the minutes over the threshold on days that are not days of rest; the minutes on days of rest (festivals included) */
  overMinutes: number;
  pct: Record<number, number>;
  restMinutes: number;
  absenceDays: Record<AbsenceKind, number>;
  absenceMinutes: Record<AbsenceKind, number>;
  missingDays: number;
  openShifts: number;
  lateDays: number;
}
export interface MonthReport {
  month: string; days: DayRow[]; totals: MonthTotals;
  /** the settings the recommended split was computed by */
  rules: ContractRules;
}
/** the rates of some reports, in order: the usual ones, and any other rate an employer set that has minutes */
export function pctColumns(reports: Pick<MonthReport, 'totals'>[]): number[] {
  const used = new Set<number>(PCT_COLUMNS);
  for (const r of reports) for (const [p, m] of Object.entries(r.totals.pct)) if (m > 0) used.add(+p);
  return [...used].sort((a, b) => a - b);
}

const MIN = 60_000;
/** a moment's whole minute (the seconds dropped) — the minute the screen shows */
const minuteOf = (ms: number) => Math.floor(ms / MIN);
/** "late" only within this many minutes after the track's start (a flag on the screen — never in the pay) */
export const LATE_WINDOW_MIN = 240;

export const addDay = (date: string, n = 1) => {
  const t = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) + n * 864e5;
  return new Date(t).toISOString().slice(0, 10);
};
export const weekdayOfDate = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
export const daysOfMonth = (month: string) => {
  const out: string[] = [];
  for (let d = `${month}-01`; d.slice(0, 7) === month; d = addDay(d)) out.push(d);
  return out;
};
/** the month before / after "YYYY-MM" */
export const shiftMonth = (month: string, n: number) => {
  const y = +month.slice(0, 4), m = +month.slice(5, 7) - 1 + n;
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 7);
};
export const dayOfIso = (iso: string) => israelParts(new Date(iso)).date;
export const methodOf = (e: Pick<EngineEntry, 'method' | 'source'>): Method =>
  (e.method ?? (e.source === 'qr' ? 'qr' : e.source === 'manual' ? 'manual' : 'link')) as Method;

/** the kind of a calendar day, by the Hebrew calendar (holidays.ts) and the week */
export function dayType(date: string, holidays: Holiday[]): { type: DayType; holiday: string } {
  const pick = (k: Holiday['kind']) => holidays.find((h) => h.kind === k);
  const chag = pick('chag'), chol = pick('chol'), erev = pick('erev');
  const atzmaut = holidays.find((h) => h.kind === 'national' && h.name === 'יום העצמאות');
  const names = holidays.map((h) => h.name).join(' · ');
  if (chag) return { type: 'chag', holiday: names };
  if (atzmaut) return { type: 'national', holiday: names };
  if (chol) return { type: 'chol', holiday: names };
  if (erev) return { type: 'erev', holiday: names };
  const w = weekdayOfDate(date);
  return { type: w === 6 ? 'saturday' : w === 5 ? 'friday' : 'weekday', holiday: names };
}

/** a day of rest: a festival, Independence Day (when the track says so), the weekly rest day — and its rate */
export function restOf(type: DayType, weekday: number, rules: ContractRules): number | null {
  if (type === 'chag') return rules.festivalPct;
  if (type === 'national' && rules.independenceRest) return rules.independencePct;
  if (weekday === rules.restWeekday) return rules.restPct;
  return null;
}

/** minutes split by tiers: [100% up to the threshold, then each tier] */
export function splitByTiers(minutes: number, threshold: number, basePct: number, tiers: Tier[]): Record<number, number> {
  const out: Record<number, number> = {};
  const add = (pct: number, m: number) => { if (m > 0) out[pct] = (out[pct] ?? 0) + m; };
  const base = Math.min(minutes, Math.max(0, threshold));
  add(basePct, base);
  let left = minutes - base;
  for (const t of tiers) {
    if (left <= 0) break;
    const m = t.minutes == null ? left : Math.min(left, t.minutes);
    add(t.pct, m); left -= m;
  }
  if (left > 0) add(tiers.length ? tiers[tiers.length - 1].pct : basePct, left);
  return out;
}

export interface MonthInput {
  month: string;
  entries: EngineEntry[];
  absences?: EngineAbsence[];
  track?: Track | null;
  /** rules instead of the track's (tests) */
  rules?: ContractRules;
  /** now — days after it are "future", today is "today" (default: Date.now()) */
  now?: number;
  /** the employee's first / last day (days outside are "off") */
  startDate?: string | null;
  endDate?: string | null;
}

export function monthReport(input: MonthInput): MonthReport {
  const track = input.track ?? NO_TRACK;
  const rules = input.rules ?? rulesOf({ ...(track.rules ?? {}), autoBreakMin: track.autoBreakMin ?? track.rules?.autoBreakMin, autoBreakAfterMin: track.autoBreakAfterMin ?? track.rules?.autoBreakAfterMin });
  // the threshold of a day that is not a work day of the track, and of a day of rest: the track's longest day (8 hours without one)
  const longest = Math.max(0, ...track.dayMinutes) || 480;
  const dailyTiers: Tier[] = [{ minutes: rules.tier1Minutes, pct: rules.tier1Pct }, { minutes: null, pct: rules.tier2Pct }];
  // monthly mode: the work days' minutes so far, and the overtime minutes at tier 1 so far
  let monthWork = 0, monthTier1 = 0;
  const now = input.now ?? Date.now();
  const today = israelParts(now).date;
  const days = daysOfMonth(input.month);
  const holidays = holidaysIn(days[0], days[days.length - 1]);
  const live = input.entries.filter((e) => !e.voidedAt);
  const byDay = new Map<string, EngineEntry[]>();
  for (const e of live) {
    const d = dayOfIso(e.clockIn);
    if (d.slice(0, 7) !== input.month) continue;
    byDay.set(d, [...(byDay.get(d) ?? []), e]);
  }
  const absences = (input.absences ?? []).filter((a) => a.status === 'approved');
  const pctZero = () => Object.fromEntries(PCT_COLUMNS.map((p) => [p, 0])) as Record<number, number>;
  const kinds: AbsenceKind[] = ['vacation', 'sick', 'reserve', 'other'];
  const totals: MonthTotals = {
    workDays: 0, paid: 0, standard: 0, overMinutes: 0, pct: pctZero(), restMinutes: 0,
    absenceDays: Object.fromEntries(kinds.map((k) => [k, 0])) as Record<AbsenceKind, number>,
    absenceMinutes: Object.fromEntries(kinds.map((k) => [k, 0])) as Record<AbsenceKind, number>,
    missingDays: 0, openShifts: 0, lateDays: 0,
  };
  let cumulative = 0, standardCumulative = 0;
  const rows: DayRow[] = days.map((date) => {
    const weekday = weekdayOfDate(date);
    const { type, holiday } = dayType(date, holidays.get(date) ?? []);
    const restPct = restOf(type, weekday, rules);
    const rest = restPct != null;
    const employed = (!input.startDate || date >= input.startDate) && (!input.endDate || date <= input.endDate);
    const trackMinutes = track.dayMinutes[weekday] ?? 0;
    const standard = !employed || type === 'chag' || (type === 'national' && rules.independenceRest) ? 0
      : type === 'erev' && rules.eveMinutes != null && trackMinutes > 0 ? rules.eveMinutes : trackMinutes;

    const list = (byDay.get(date) ?? []).slice().sort((a, b) => a.clockIn.localeCompare(b.clockIn));
    let worked = 0, gaps = 0, lastOut: number | null = null;
    const shifts: ShiftRow[] = list.map((e) => {
      const a = +new Date(e.clockIn), b = e.clockOut ? +new Date(e.clockOut) : null;
      const mins = b != null ? Math.max(0, minuteOf(b) - minuteOf(a)) : 0;
      worked += mins;
      if (lastOut != null && a > lastOut) gaps += Math.max(0, minuteOf(a) - minuteOf(lastOut));
      if (b != null) lastOut = b;
      const pi = israelParts(a), po = b != null ? israelParts(b) : null;
      const place = (lat?: number | null, lng?: number | null) => (lat != null && lng != null ? { lat, lng } : null);
      return {
        id: e.id, in: e.clockIn, out: e.clockOut, inTime: pi.time, outTime: po?.time ?? null, outNextDay: Boolean(po && po.date !== pi.date),
        minutes: mins, method: methodOf(e), outMethod: e.clockOut ? ((e.outMethod ?? methodOf(e)) as Method) : null,
        inPlace: place(e.inLat, e.inLng), outPlace: place(e.outLat, e.outLng), corrected: Boolean(e.replaces) || methodOf(e) === 'manual' || methodOf(e) === 'request',
        open: !e.clockOut,
      };
    });
    // an unpaid break: taken off a long enough day, less the breaks the employee clocked out for
    const breakMin = rules.autoBreakMin;
    // (the employer's button: a day of MORE than autoBreakAfterMin; a break the employee already clocked out for counts towards it)
    const breakTaken = breakMin > 0 && worked > rules.autoBreakAfterMin ? Math.max(0, Math.min(worked, breakMin - gaps)) : 0;
    const paid = worked - breakTaken;

    let pct: Record<number, number>;
    if (rest) {
      // a day of rest: its rate up to a day's length, then its own overtime (never below the day's rate)
      pct = splitByTiers(paid, longest, restPct, [{ minutes: rules.tier1Minutes, pct: Math.max(restPct, rules.restTier1Pct) },
        { minutes: null, pct: Math.max(restPct, rules.restTier2Pct) }]);
    } else if (rules.mode === 'monthly' && rules.monthlyMinutes != null) {
      // by month: regular until the month's threshold, then tier 1 for its share of the month, then tier 2 — in day order
      const regular = Math.max(0, Math.min(paid, rules.monthlyMinutes - monthWork));
      const over = paid - regular;
      const t1 = Math.max(0, Math.min(over, (rules.monthlyTier1Minutes ?? 0) - monthTier1));
      pct = {};
      if (regular) pct[100] = regular;
      if (t1) pct[rules.tier1Pct] = (pct[rules.tier1Pct] ?? 0) + t1;
      if (over - t1) pct[rules.tier2Pct] = (pct[rules.tier2Pct] ?? 0) + over - t1;
      monthWork += paid; monthTier1 += t1;
    } else {
      pct = splitByTiers(paid, standard > 0 ? standard : longest, 100, dailyTiers);
    }

    const abs = employed ? absences.find((x) => x.from <= date && x.to >= date) : undefined;
    const open = shifts.some((s) => s.open);
    const first = shifts[0];
    let late = 0;
    if (first && track.startTime && standard > 0) {
      const [h, m] = track.startTime.split(':').map(Number);
      const [fh, fm] = first.inTime.split(':').map(Number);
      const d = fh * 60 + fm - (h * 60 + m);
      // a shift that starts hours after the track's start is another shift (an evening, a night) — not a late one
      late = d > (track.lateGraceMin ?? 0) && d <= LATE_WINDOW_MIN ? d : 0;
    }
    const status: DayStatus = open ? (date === today ? 'today' : 'open')
      : shifts.length ? 'ok'
      : abs ? 'absence'
      : date > today ? 'future'
      : standard > 0 && date < today ? 'missing'
      : date === today && standard > 0 ? 'today'
      : 'off';

    cumulative += paid; standardCumulative += standard;
    totals.paid += paid; totals.standard += standard;
    for (const [p, m] of Object.entries(pct)) totals.pct[+p] = (totals.pct[+p] ?? 0) + m;
    // over the threshold = what the split put above the regular rate (the same minutes, whatever the rates are)
    const over = rest ? 0 : paid - (pct[100] ?? 0);
    totals.overMinutes += over;
    if (rest) totals.restMinutes += paid;
    if (shifts.some((s) => !s.open)) totals.workDays += 1;
    if (status === 'missing') totals.missingDays += 1;
    if (status === 'open') totals.openShifts += shifts.filter((s) => s.open).length;
    if (late > 0) totals.lateDays += 1;
    if (abs && (!shifts.length || abs.minutes != null)) {
      if (abs.minutes == null) totals.absenceDays[abs.kind] += standard > 0 ? 1 : 0;
      else totals.absenceMinutes[abs.kind] += abs.minutes;
    }
    return {
      date, weekday, type, holiday, rest, standard, shifts, worked, breakTaken, paid, cumulative, standardCumulative, over, pct,
      absence: abs ? { id: abs.id, kind: abs.kind, minutes: abs.minutes } : null, late, status,
    };
  });
  return { month: input.month, days: rows, totals, rules };
}

/** 7:05 */
export const hm = (min: number) => `${min < 0 ? '-' : ''}${Math.floor(Math.abs(min) / 60)}:${String(Math.abs(min) % 60).padStart(2, '0')}`;
/** 7.08 — hours with two decimals (rounded: for a chart, never for a file — files carry H:MM, exact) */
export const hoursDec = (min: number) => Math.round((min / 60) * 100) / 100;

export const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const DAY_TYPE_LABEL: Record<DayType, string> = {
  weekday: 'חול', friday: 'שישי', saturday: 'שבת', erev: 'ערב חג', chag: 'חג', chol: 'חול המועד', national: 'יום העצמאות',
};
export const METHOD_LABEL: Record<Method, string> = {
  link: 'קישור', qr: 'QR', nfc: 'NFC', gps: 'GPS', manual: 'ידני', request: 'בקשה', import: 'ייבוא',
};
export const ABSENCE_LABEL: Record<AbsenceKind, string> = { vacation: 'חופשה', sick: 'מחלה', reserve: 'מילואים', other: 'אחר' };
export const STATUS_LABEL: Record<DayStatus, string> = {
  ok: 'דווח', missing: 'חסר דיווח', open: 'חסרה יציאה', absence: 'היעדרות', off: '', future: '', today: 'היום',
};
