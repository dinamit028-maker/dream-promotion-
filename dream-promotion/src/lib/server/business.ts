import { adminDb } from './admin';

/**
 * Multi-business access on the server (the service role bypasses RLS, so every route checks here).
 * Mirrors the SQL functions of stage 4: a super admin may use any business, locked or not; a member
 * only an active one (status 'active' and, when paid_until is set, today <= paid_until + grace_days).
 */
export interface BusinessRow { id: string; status: string; paid_until: string | null; grace_days: number | null }

/** today in Israel, YYYY-MM-DD — payment dates are calendar dates in Israel */
const todayIL = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);

export function businessIsActive(b: Pick<BusinessRow, 'status' | 'paid_until' | 'grace_days'>, now = new Date()) {
  if (b.status !== 'active') return false;
  if (!b.paid_until) return true;
  const last = new Date(`${b.paid_until}T12:00:00Z`);
  last.setUTCDate(last.getUTCDate() + Math.max(0, b.grace_days ?? 0));
  return todayIL(now) <= last.toISOString().slice(0, 10);
}

export async function isSuperAdmin(userId: string): Promise<boolean> {
  const { data } = await adminDb().from('profiles').select('is_super_admin').eq('id', userId).maybeSingle();
  return Boolean(data?.is_super_admin);
}

export async function canUseBusiness(userId: string, businessId: string | null): Promise<boolean> {
  if (await isSuperAdmin(userId)) return true;
  if (!businessId) return false;
  const db = adminDb();
  const [{ data: m }, { data: b }] = await Promise.all([
    db.from('business_members').select('role').eq('business_id', businessId).eq('user_id', userId).maybeSingle(),
    db.from('businesses').select('status, paid_until, grace_days').eq('id', businessId).maybeSingle(),
  ]);
  return Boolean(m && b && businessIsActive(b));
}

/** Public pages (booking, a shared document, the employee clock) answer "השירות אינו זמין" for a locked business. */
export const UNAVAILABLE = { code: 'unavailable', message: 'השירות אינו זמין' } as const;

/** Is the business behind a public page open? business_id is NOT NULL on every business table since stage 2. */
export async function businessOpen(businessId: string | null | undefined): Promise<boolean> {
  if (!businessId) return true; // rows from before stage 2 (tests only — the column is required in the database)
  const { data } = await adminDb().from('businesses').select('status, paid_until, grace_days').eq('id', businessId).maybeSingle();
  return Boolean(data && businessIsActive(data as BusinessRow));
}

/** the business this user is working in now (their choice, else their first membership) */
export async function businessOf(userId: string): Promise<string | null> {
  const { data } = await adminDb().rpc('business_for_user', { uid: userId });
  return (data as string | null) ?? null;
}
