/**
 * 2.121 — the books (double entry, stage 4ב — migration 20261128007100; docs/ita-registration/STAGE4_PLAN_HE.md, answers 13 / 14
 * of 26–27.11.2026): what the money settings show of them — read only (the screens of the books are stage 4ד). Plain functions:
 * the state as the database gives it (gl_books_state), and the owner's move of the start date (gl_books_start_set — the 1st of a
 * month, up to next month, only while nothing was posted; the database checks all of it again, and the closed periods).
 */
export interface BooksState {
  /** the 1st of the month the books start from (YYYY-MM-DD) — nothing posts before it */
  startDate: string;
  /** today (Israel time) is on or after the start date */
  started: boolean;
  /** the entries written so far (the running number — gl_books.last_tx_no) */
  transactions: number;
  openingEntered: boolean;
  /** nothing was posted yet — the owner may still move the start date */
  canMoveStart: boolean;
  /** journal_writer(): the business's owner (role owner, full access, every location) */
  owner: boolean;
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** gl_books_state()'s answer → the state; null when it is not one (never a guess) */
export function toBooksState(v: unknown): BooksState | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r.startDate !== 'string' || !DAY.test(r.startDate)) return null;
  const n = Number(r.transactions);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return { startDate: r.startDate, started: r.started === true, transactions: n, openingEntered: r.openingEntered === true,
    canMoveStart: r.canMoveStart === true, owner: r.owner === true };
}
/** the card is the owner's only, and only once the migration is in the database (state) */
export const showBooks = (s: BooksState | null): s is BooksState => Boolean(s && s.owner);

/** 'YYYY-MM' of a day; the 1st of a 'YYYY-MM' */
export const monthOf = (day: string) => day.slice(0, 7);
export const firstOf = (month: string) => `${month}-01`;
/** the month after a 'YYYY-MM' */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
/** the latest start the database allows: the 1st of next month (Israel time — today is todayIL()) */
export const latestStart = (today: string) => firstOf(nextMonth(monthOf(today)));
export const EARLIEST_START = '2000-01-01';
/**
 * what is wrong with a new start month ('YYYY-MM' — the value of a month field), Hebrew, null when fine. The same rule as
 * gl_books_start_set ('books_start_date'): the 1st of a month, from 2000, up to the 1st of next month. A closed period is the
 * database's to refuse (period_locked) — it is not known here.
 */
export function startMonthProblem(month: string, today: string, current: string): string | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return 'בוחרים חודש';
  const day = firstOf(month);
  if (day < EARLIEST_START) return 'תחילת הספרים — משנת 2000';
  if (day > latestStart(today)) return 'תחילת הספרים — לכל המאוחר החודש הבא';
  if (day === current) return 'זה כבר תאריך ההתחלה';
  return null;
}
/** what the owner reads before confirming a move (the in-page confirmation) */
export const startMoveExplain = (day: string, today: string, current: string = day): string[] => [
  `הספרים יתחילו ב-${day.split('-').reverse().join('/')}. מסמכים, תשלומים והפקדות מהיום הזה והלאה יירשמו בספרים (פקודה לכל אחד), לפי הסדר.`,
  day <= today ? 'מה שכבר הופק מאז נרשם עכשיו — מיד אחרי האישור.' : 'עד היום הזה לא נרשם כלום.',
  'אחרי שנרשמה הפקודה הראשונה אי אפשר להזיז את התאריך יותר.',
  ...(day < current ? [`שימו לב: במסמכים מ-${day.split('-').reverse().join('/')} ואילך מפתח הלקוח בקובץ לרשות המסים (שדה 1225) נכתב לפי הספרים. אצל לקוח שהמפתח שלו נראה כמו חשבון של המערכת (4 ספרות או BANK) או מתחיל ברווח — המפתח ישתנה. אם קובץ של החודשים האלה כבר נמסר לרשות המסים או לרואה החשבון, כדאי לבדוק איתו לפני שמזיזים.`] : []),
  'יתרות הפתיחה (לפי רואה החשבון) נרשמות בתאריך ההתחלה — הטופס יגיע בשלב הבא.',
];

/** the trial balance's last date for "now" (entries are dated up to today; a far date keeps a late one in) */
export const SUSPENSE_TO = '2999-12-31';
/** gl_trial_balance rows → the balance of the suspense account (key 9100, debit positive); null when the rows are not rows */
export function suspenseOf(rows: unknown): number | null {
  if (!Array.isArray(rows)) return null;
  let a = 0;
  for (const r of rows as Record<string, unknown>[]) if (r?.key === '9100') a += Math.round(Number(r.closing) * 100) || 0;
  return a / 100;
}
const cnt = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
/** gl_replay's answer → what it posted, what failed, what it skipped (failed for good today — retry false), what is left (null —
 *  the database did not say: it posted all it could) */
export function replayLeft(v: unknown): { posted: number; failed: number; skipped: number; left: number | null } {
  const r = (v ?? {}) as Record<string, unknown>;
  return { posted: cnt(r.posted), failed: cnt(r.failed), skipped: cnt(r.skipped), left: r.left == null ? null : cnt(r.left) };
}
/** what the owner reads after "לרשום עכשיו" (or after a moved start) */
export function replayMessage(r: { posted: number; failed: number; skipped?: number; left: number | null }): string {
  const done = r.posted === 1 ? 'נרשמה פקודה אחת.' : r.posted ? `נרשמו ${r.posted} פקודות.` : 'לא נרשם דבר חדש.';
  const skippedN = r.skipped ?? 0;
  const rest = r.left && r.left > skippedN ? ` עוד ${r.left - skippedN} יירשמו הלילה, לבד.` : '';
  const bad = r.failed ? ` ${r.failed} לא נרשמו גם הפעם — נשארים ב"ממתינים לרישום".` : '';
  const skipped = skippedN ? ` ${skippedN} נכשלו היום ויטופלו מחר, או בלחיצה על "לרשום עכשיו".` : '';
  return done + rest + bad + skipped;
}
