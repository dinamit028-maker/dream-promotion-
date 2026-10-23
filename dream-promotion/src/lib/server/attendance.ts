import { adminDb, userFromRequest } from './admin';
import { businessIsActive, isSuperAdmin, workBusiness, NO_BUSINESS } from './business';

/**
 * The attendance module on the server (2.107; the service role passes row-level security, so every route checks here). The same
 * rules as att_role() / has_module() of migration 5800 — attRoleOf is that function, in TS (tests/attendance-server.test.ts).
 */
export type AttRole = 'admin' | 'approver' | 'payroll' | 'viewer' | 'none';
export interface MemberRow { role: string; access?: string | null; attendance_role?: string | null }

export function attRoleOf(m: MemberRow | null, superAdmin: boolean): AttRole {
  if (superAdmin) return 'admin';
  if (!m || m.access === 'register') return 'none';
  if (m.attendance_role === 'admin' || m.attendance_role === 'approver' || m.attendance_role === 'payroll') return m.attendance_role;
  return m.role === 'owner' || m.role === 'editor' ? 'admin' : 'viewer';
}

export type AttCaller = { ok: true; userId: string; businessId: string; role: AttRole } | { ok: false; status: number; body: { code: string; message: string } };
/** a signed-in member of the business worked in now, with the attendance module, and at least `need` */
export async function attendanceCaller(req: Request, need: 'read' | 'admin' = 'read'): Promise<AttCaller> {
  const userId = await userFromRequest(req);
  if (!userId) return { ok: false, status: 401, body: { code: 'no_session', message: 'צריך להתחבר מחדש.' } };
  const businessId = await workBusiness(userId);
  if (businessId === NO_BUSINESS) return { ok: false, status: 403, body: { code: 'no_business', message: 'אין עסק לחשבון הזה.' } };
  const db = adminDb();
  const [superAdmin, { data: member }, { data: biz, error }] = await Promise.all([
    isSuperAdmin(userId),
    db.from('business_members').select('role, access, attendance_role').eq('business_id', businessId).eq('user_id', userId).maybeSingle(),
    db.from('businesses').select('status, paid_until, grace_days, modules').eq('id', businessId).maybeSingle(),
  ]);
  if (error || !biz) return { ok: false, status: 503, body: { code: 'not_ready', message: 'צריך להריץ את מיגרציה 20261023005800 (נוכחות ועובדים).' } };
  if (!superAdmin && !businessIsActive(biz as any)) return { ok: false, status: 403, body: { code: 'business_locked', message: 'העסק נעול.' } };
  if (!((biz as any).modules ?? []).includes('attendance')) return { ok: false, status: 403, body: { code: 'no_module', message: 'נוכחות ועובדים לא כלולה בחבילה של העסק.' } };
  const role = attRoleOf(member as MemberRow | null, superAdmin);
  if (role === 'none' || (need === 'admin' && role !== 'admin')) return { ok: false, status: 403, body: { code: 'forbidden', message: 'אין לך הרשאה לפעולה הזו.' } };
  return { ok: true, userId, businessId, role };
}
