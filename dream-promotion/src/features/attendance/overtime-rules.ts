/**
 * The overtime rules of the attendance module — the ONLY place they are written (docs/ATTENDANCE_PLAN_HE.md). The hours engine
 * (hours-engine.ts) reads them; tests/attendance-hours.test.ts checks each one.
 *
 * Every rule says where it comes from: 'law' — the Hours of Work and Rest Law as we read it; 'needs_confirmation' — a choice that
 * the owner of the system has NOT confirmed yet (the questions in docs/ATTENDANCE_PLAN_HE.md, §החלטות שעוד פתוחות). Until
 * OVERTIME_CONFIRMED is true the screens show the 125% / 150% columns as a draft and the payroll file is not produced.
 * Changing a rule = changing it here, its note, and its test — nowhere else.
 */
export type RuleSource = 'law' | 'needs_confirmation';

export interface Tier {
  /** how many minutes of this tier (null = the rest of the day) */
  minutes: number | null;
  /** the rate, in percent of the hourly wage */
  pct: number;
}

export interface OvertimeRules {
  /** after the employee's standard day (their track): the overtime tiers */
  dailyTiers: Tier[];
  /** a work day that is not a work day on the employee's track (e.g. a Friday on a five-day track): its threshold, in minutes */
  offTrackDayMinutes: number;
  /** a day of rest (Saturday, a festival): the rate of its hours up to restDayMinutes */
  restDayPct: number;
  /** a day of rest: how many minutes before its own overtime tiers */
  restDayMinutes: number;
  /** a day of rest: its overtime tiers */
  restDayTiers: Tier[];
  /** which days are days of rest */
  restOnSaturday: boolean;
  restOnFestival: boolean;
  restOnIndependenceDay: boolean;
  /** the standard of an eve of a festival: the track's day (null) or these minutes */
  eveMinutes: number | null;
  /** a weekly threshold (minutes) beyond which hours are overtime even when no day passed its own; null = none */
  weeklyMinutes: number | null;
  /** a shift belongs to the day it started on (and to that day's month) — the clock's rule since 2.0 */
  shiftDay: 'start';
  /** minutes are counted as they are — no rounding */
  rounding: 'none';
}

export const OVERTIME_RULES: OvertimeRules = {
  dailyTiers: [{ minutes: 120, pct: 125 }, { minutes: null, pct: 150 }],
  offTrackDayMinutes: 516,
  restDayPct: 150,
  restDayMinutes: 516,
  restDayTiers: [{ minutes: 120, pct: 175 }, { minutes: null, pct: 200 }],
  restOnSaturday: true,
  restOnFestival: true,
  restOnIndependenceDay: true,
  eveMinutes: null,
  weeklyMinutes: null,
  shiftDay: 'start',
  rounding: 'none',
};

/** what each rule is, in Hebrew, and where it comes from — shown in the settings and next to the draft columns */
export const RULE_NOTES: { key: keyof OvertimeRules; text: string; source: RuleSource }[] = [
  { key: 'dailyTiers', text: 'אחרי שעות התקן של היום: השעתיים הראשונות ב-125%, ומשם 150%', source: 'law' },
  { key: 'restDayPct', text: 'עבודה ביום מנוחה (שבת, חג): 150%', source: 'law' },
  { key: 'restOnSaturday', text: 'שבת היא יום מנוחה (לפי היום שבו המשמרת התחילה)', source: 'needs_confirmation' },
  { key: 'restOnFestival', text: 'חג (לפי לוח השנה העברי, יום אחד בישראל) הוא יום מנוחה', source: 'law' },
  { key: 'restOnIndependenceDay', text: 'יום העצמאות הוא יום מנוחה', source: 'needs_confirmation' },
  { key: 'restDayMinutes', text: 'ביום מנוחה: 8.6 שעות ב-150%, ואז שעות נוספות', source: 'needs_confirmation' },
  { key: 'restDayTiers', text: 'שעות נוספות ביום מנוחה: שעתיים ב-175%, ומשם 200%', source: 'needs_confirmation' },
  { key: 'offTrackDayMinutes', text: 'יום עבודה שאינו במסלול (למשל שישי במסלול של 5 ימים): 8.6 שעות רגילות, ואז שעות נוספות', source: 'needs_confirmation' },
  { key: 'eveMinutes', text: 'ערב חג: שעות התקן של המסלול (בלי קיצור)', source: 'needs_confirmation' },
  { key: 'weeklyMinutes', text: 'אין סף שבועי — רק סף יומי', source: 'needs_confirmation' },
  { key: 'shiftDay', text: 'משמרת שייכת כולה ליום (ולחודש) שבו התחילה, גם כשהיא חוצה חצות', source: 'needs_confirmation' },
  { key: 'rounding', text: 'בלי עיגול: הדקות כפי שהן', source: 'needs_confirmation' },
];

/** true only after the owner of the system confirmed every rule marked needs_confirmation (and this line was changed) */
export const OVERTIME_CONFIRMED = false;

/** the rates that appear in reports and in the payroll file, in order */
export const PCT_COLUMNS = [100, 125, 150, 175, 200] as const;
