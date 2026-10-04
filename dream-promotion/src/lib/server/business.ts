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

/** Server calls that cost money or publish (AI, rendering, posting) answer this for a locked business. */
export const LOCKED = { code: 'business_locked', message: 'העסק נעול. כדי לחדש את השירות פנו למנהל המערכת.' } as const;
/** Scheduled posts of a locked business are cancelled with this reason (they do not come back by themselves). */
export const LOCKED_REASON = 'העסק נעול';

/** Is this user shut out by a lock? The super admin never is; anyone else needs an active business. */
export async function userLocked(userId: string): Promise<boolean> {
  if (await isSuperAdmin(userId)) return false;
  const biz = await businessOf(userId);
  if (!biz) return true; // no business = nothing to spend for
  return !(await businessOpen(biz));
}

/** The business a signed-in user's request works in, or a uuid that matches nothing (no business = no rows). */
export const NO_BUSINESS = '00000000-0000-0000-0000-000000000000';
export async function workBusiness(userId: string): Promise<string> {
  return (await businessOf(userId)) ?? NO_BUSINESS;
}

/** the business this user is working in now (their choice, else their first membership) */
export async function businessOf(userId: string): Promise<string | null> {
  const { data } = await adminDb().rpc('business_for_user', { uid: userId });
  return (data as string | null) ?? null;
}

/**
 * Register-only members ("קופאי/ת", business_members.access = 'register') sell in the register and nothing
 * else: no AI, publishing, rendering or Meta. The database enforces the same (migration 20261004003000).
 */
export const REGISTER_ONLY = { code: 'register_only', message: 'ההרשאה שלך היא לקופה בלבד.' } as const;
export type Access = 'full' | 'register';

/** the access of a member in a business; the super admin, and rows from before 2.50, are 'full' */
export async function memberAccess(userId: string, businessId: string | null): Promise<Access> {
  if (!businessId || await isSuperAdmin(userId)) return 'full';
  const { data, error } = await adminDb().from('business_members').select('access').eq('business_id', businessId).eq('user_id', userId).maybeSingle();
  if (error) return 'full'; // before the migration there is no access column — nobody is register-only yet
  return (data as { access?: string } | null)?.access === 'register' ? 'register' : 'full';
}
export async function registerOnly(userId: string): Promise<boolean> {
  return (await memberAccess(userId, await businessOf(userId))) === 'register';
}

/** one check for routes that spend or publish: a locked business, or a register-only member → the refusal to send */
export async function blockedFor(userId: string): Promise<typeof LOCKED | typeof REGISTER_ONLY | null> {
  if (await userLocked(userId)) return LOCKED;
  if (await registerOnly(userId)) return REGISTER_ONLY;
  return null;
}

/** who gets the business's notifications (a sale, low stock): its full-access members */
export async function businessManagers(businessId: string): Promise<string[]> {
  const db = adminDb();
  const { data, error } = await db.from('business_members').select('user_id, access').eq('business_id', businessId);
  if (error) { // before the migration: the owners
    const { data: owners } = await db.from('business_members').select('user_id').eq('business_id', businessId).eq('role', 'owner');
    return (owners ?? []).map((r: any) => r.user_id);
  }
  return ((data ?? []) as { user_id: string; access?: string }[]).filter((r) => r.access !== 'register').map((r) => r.user_id);
}
