import { NextResponse } from 'next/server';
import { adminDb } from './admin';
import { isSuperAdmin } from './business';

/**
 * Admins are the super admin (profiles.is_super_admin) and the emails in ADMIN_EMAILS (comma
 * separated), checked on the server for every admin request — the browser cannot make itself an admin.
 */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export async function adminFromRequest(req: Request): Promise<{ id: string; email: string } | null> {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const { data } = await adminDb().auth.getUser(token);
    const email = data.user?.email?.toLowerCase();
    if (!data.user || !email) return null;
    // the platform owner (profiles.is_super_admin — never settable from the browser) or ADMIN_EMAILS
    if (!adminEmails().includes(email) && !(await isSuperAdmin(data.user.id))) return null;
    return { id: data.user.id, email };
  } catch { return null; }
}

/** For admin routes: the admin, or a ready 403. */
export async function requireAdmin(req: Request) {
  const a = await adminFromRequest(req);
  return a ? { admin: a } : { denied: NextResponse.json({ code: 'forbidden', message: 'admins only' }, { status: 403 }) };
}
