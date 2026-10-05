import { adminDb, userFromRequest } from './admin';
import { LOCKED, REGISTER_ONLY, VIEW_ONLY, businessOf, canUseBusiness, isSuperAdmin, memberAccess } from './business';

/**
 * Money routes on the server (service role — row-level security does not apply, so the same rules are checked here):
 * a signed-in user, the business they work in now, accessible (active, or the super admin), never a cashier, and its
 * money open to them — a member of the business, or a super admin with an open, unexpired access grant (finance_access_grants).
 * The business always comes from the server (business_for_user), never from the request body.
 */
export type FinanceCaller = { ok: true; userId: string; businessId: string; member: boolean } | { ok: false; status: number; body: { code: string; message: string } };
/** write: a route that changes something or spends (a viewer may only read) */
export async function financeCaller(req: Request, opts: { write?: boolean } = {}): Promise<FinanceCaller> {
  const userId = await userFromRequest(req);
  if (!userId) return { ok: false, status: 401, body: { code: 'unauthorized', message: 'צריך להתחבר.' } };
  const businessId = await businessOf(userId);
  if (!businessId) return { ok: false, status: 403, body: { code: 'no_business', message: 'אין עסק פעיל לחשבון הזה.' } };
  if (!(await canUseBusiness(userId, businessId))) return { ok: false, status: 403, body: LOCKED };
  if ((await memberAccess(userId, businessId)) === 'register') return { ok: false, status: 403, body: REGISTER_ONLY };
  const db = adminDb();
  const { data: m } = await db.from('business_members').select('user_id, role').eq('business_id', businessId).eq('user_id', userId).maybeSingle();
  if (m && opts.write && (m as { role?: string }).role === 'viewer') return { ok: false, status: 403, body: VIEW_ONLY };
  if (m) return { ok: true, userId, businessId, member: true };
  if (await isSuperAdmin(userId)) {
    const { data: g } = await db.from('finance_access_grants').select('id').eq('business_id', businessId).eq('user_id', userId).is('revoked_at', null)
      .gt('expires_at', new Date().toISOString()).limit(1);
    if (g && g.length) return { ok: true, userId, businessId, member: false };
  }
  return { ok: false, status: 403, body: { code: 'finance_closed', message: 'הנתונים הכספיים של העסק הזה סגורים. מנהל-על פותח גישה זמנית עם סיבה במסך הכספים.' } };
}
