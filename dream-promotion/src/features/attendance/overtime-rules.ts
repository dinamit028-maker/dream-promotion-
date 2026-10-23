/**
 * The overtime rules of the attendance module — the ONLY place they are read (docs/ATTENDANCE_PLAN_HE.md; tests/attendance-hours.test.ts).
 * The owner of the system decided (23.10.2026): every employer sets the rules of each hours track ("מסלול הסכם") for themselves —
 * the system is open; the defaults below are the law's and the owner's:
 *   - the threshold: by day (after the day's standard: 8:00, 8:36, 8:40 or anything) or by month (e.g. 186 hours a month);
 *   - then 125% for two hours, then 150% (the Hours of Work and Rest Law);
 *   - the weekly rest day (Saturday): 150%; a festival: 150%; Independence Day: a day of rest, 200%;
 *   - the eve of a festival, an automatic 30-minute break: the employer's choice (off by default).
 * The same columns are in work_tracks (migration 5800). A track's rules count only after the employer confirmed them
 * (rules_confirmed_at): until then overtime is a draft, the payroll report waits and the month does not close.
 */
export type RuleSource = 'law' | 'owner' | 'employer';

export interface Tier {
  /** how many minutes of this tier (null = the rest) */
  minutes: number | null;
  /** the rate, in percent of the hourly wage */
  pct: number;
}

/** a track's rules, as the hours engine uses them */
export interface ContractRules {
  mode: 'daily' | 'monthly';
  /** monthly: the month's minutes before overtime (186 hours = 11160) */
  monthlyMinutes: number | null;
  /** monthly: how many of the overtime minutes of the month are at tier 1 (the rest at tier 2) */
  monthlyTier1Minutes: number | null;
  tier1Minutes: number;
  tier1Pct: number;
  tier2Pct: number;
  /** the weekly rest day (0 = Sunday … 6 = Saturday) */
  restWeekday: number;
  restPct: number;
  restTier1Pct: number;
  restTier2Pct: number;
  festivalPct: number;
  independenceRest: boolean;
  independencePct: number;
  /** the standard of an eve of a festival: null = the track's day as it is */
  eveMinutes: number | null;
  /** an automatic unpaid break: minutes, off a day of at least `autoBreakAfterMin` (0 = none) */
  autoBreakMin: number;
  autoBreakAfterMin: number;
}

export const DEFAULT_RULES: ContractRules = {
  mode: 'daily', monthlyMinutes: null, monthlyTier1Minutes: null,
  tier1Minutes: 120, tier1Pct: 125, tier2Pct: 150,
  restWeekday: 6, restPct: 150, restTier1Pct: 175, restTier2Pct: 200,
  festivalPct: 150, independenceRest: true, independencePct: 200,
  eveMinutes: null, autoBreakMin: 0, autoBreakAfterMin: 0,
};

/** the automatic break of the employer's button (the owner of the system, 23.10.2026): 30 minutes, off a day of 6 hours or more */
export const AUTO_BREAK = { minutes: 30, afterMinutes: 360 } as const;

/** a track's row (or the snapshot a closed month keeps) → its rules; a missing value = the default */
export function rulesOf(r: Record<string, any> | null | undefined): ContractRules {
  if (!r) return DEFAULT_RULES;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const nn = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const pick = (camel: string, snake: string) => (r[camel] !== undefined ? r[camel] : r[snake]);
  return {
    mode: pick('mode', 'ot_mode') === 'monthly' ? 'monthly' : 'daily',
    monthlyMinutes: nn(pick('monthlyMinutes', 'monthly_minutes')), monthlyTier1Minutes: nn(pick('monthlyTier1Minutes', 'monthly_tier1_minutes')),
    tier1Minutes: n(pick('tier1Minutes', 'tier1_minutes'), 120), tier1Pct: n(pick('tier1Pct', 'tier1_pct'), 125), tier2Pct: n(pick('tier2Pct', 'tier2_pct'), 150),
    restWeekday: n(pick('restWeekday', 'rest_weekday'), 6), restPct: n(pick('restPct', 'rest_pct'), 150),
    restTier1Pct: n(pick('restTier1Pct', 'rest_tier1_pct'), 175), restTier2Pct: n(pick('restTier2Pct', 'rest_tier2_pct'), 200),
    festivalPct: n(pick('festivalPct', 'festival_pct'), 150), independenceRest: pick('independenceRest', 'independence_rest') !== false,
    independencePct: n(pick('independencePct', 'independence_pct'), 200), eveMinutes: nn(pick('eveMinutes', 'eve_minutes')),
    autoBreakMin: n(pick('autoBreakMin', 'auto_break_min'), 0), autoBreakAfterMin: n(pick('autoBreakAfterMin', 'auto_break_after_min'), 0),
  };
}

/** what each rule is, in Hebrew, and where its default comes from — shown in the settings */
export const RULE_NOTES: { key: keyof ContractRules | 'shiftDay' | 'rounding'; text: string; source: RuleSource }[] = [
  { key: 'mode', text: 'שעות נוספות אחרי שעות התקן של היום (8:00, 8:36, 8:40 או כל מספר), או אחרי סף חודשי (למשל 186 שעות) — לפי חוזה העבודה', source: 'employer' },
  { key: 'tier1Pct', text: 'אחרי הסף: השעתיים הראשונות ב-125%, ומשם 150%', source: 'law' },
  { key: 'restPct', text: 'עבודה ביום המנוחה השבועי (שבת): 150%', source: 'law' },
  { key: 'restTier1Pct', text: 'שעות נוספות ביום המנוחה: שעתיים ב-175%, ומשם 200% (ניתן לשינוי)', source: 'employer' },
  { key: 'festivalPct', text: 'חג (לפי לוח השנה העברי, יום אחד בישראל): יום מנוחה, 150%', source: 'law' },
  { key: 'independencePct', text: 'יום העצמאות: יום מנוחה, עבודה בו 200%', source: 'owner' },
  { key: 'eveMinutes', text: 'ערב חג: שעות התקן של המסלול, או מספר שעות אחר שהמעסיק קובע', source: 'employer' },
  { key: 'autoBreakMin', text: 'הפסקה אוטומטית של 30 דקות (כפתור של המעסיק). החוק מחייב רישום כניסה ויציאה — ההפסקה לא מחליפה אותו', source: 'employer' },
  { key: 'shiftDay', text: 'משמרת שייכת כולה ליום (ולחודש) שבו התחילה, גם כשהיא חוצה חצות', source: 'owner' },
  { key: 'rounding', text: 'בלי עיגול: הדקות כפי שנרשמו', source: 'owner' },
];

/** the rates that appear in reports, in order */
export const PCT_COLUMNS = [100, 125, 150, 175, 200] as const;
/** a rate a track may set (the database checks the same: 100–400) */
export const ratesValid = (r: ContractRules) =>
  [r.tier1Pct, r.tier2Pct, r.restPct, r.restTier1Pct, r.restTier2Pct, r.festivalPct, r.independencePct].every((p) => Number.isInteger(p) && p >= 100 && p <= 400)
  && (r.mode === 'daily' || (r.monthlyMinutes != null && r.monthlyMinutes >= 60 && r.monthlyTier1Minutes != null && r.monthlyTier1Minutes >= 0));
