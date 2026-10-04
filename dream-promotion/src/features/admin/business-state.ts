/**
 * The super admin's view of one business (admin → "עסקים"). Pure — shared by the server and the screen.
 * Same rule as the database's business_is_active(): status 'active' AND (no paid_until OR today in
 * Israel <= paid_until + grace_days). Dates are calendar dates in Israel, YYYY-MM-DD.
 */
export type BizState = 'active' | 'locked' | 'expired';
export interface BizTerms { status: string; paid_until: string | null; grace_days: number | null }

/** today in Israel, YYYY-MM-DD */
export const todayIL = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((+new Date(`${b}T12:00:00Z`) - +new Date(`${a}T12:00:00Z`)) / 864e5);

/** one calendar month later; the 31st becomes the month's last day (31.1 → 28.2 / 29.2) */
export function addMonth(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // last day of the next month
  const t = new Date(Date.UTC(y, m, Math.min(day, last), 12));
  return t.toISOString().slice(0, 10);
}

/**
 * "הארך חודש": a month from the later of today and the current paid_until — an expired business
 * opens at once (a month from today), a paid one keeps its remaining days. No limit (null) stays null.
 */
export function extendMonth(paidUntil: string | null, now = new Date()): string | null {
  if (!paidUntil) return null;
  const today = todayIL(now);
  return addMonth(paidUntil >= today ? paidUntil : today);
}

export interface BizView {
  state: BizState;
  /** last day it is open (paid_until + grace days), null = no limit */
  lastDay: string | null;
  /** days until lastDay (0 = today is the last day), null = no limit */
  daysLeft: number | null;
  /** active and ending within 7 days */
  endingSoon: boolean;
}

export function bizView(b: BizTerms, now = new Date()): BizView {
  const today = todayIL(now);
  const lastDay = b.paid_until ? addDays(b.paid_until, Math.max(0, b.grace_days ?? 0)) : null;
  const daysLeft = lastDay ? daysBetween(today, lastDay) : null;
  const state: BizState = b.status !== 'active' ? 'locked' : daysLeft != null && daysLeft < 0 ? 'expired' : 'active';
  return { state, lastDay, daysLeft, endingSoon: state === 'active' && daysLeft != null && daysLeft <= 7 };
}

export const STATE_HE: Record<BizState, string> = { active: 'פעיל', locked: 'נעול', expired: 'פג תוקף' };

/** a URL-safe id for a new business (latin letters, digits, dashes — same check as the database) */
export const validSlug = (s: string) => /^[a-z0-9][a-z0-9-]{1,40}$/.test(s);
