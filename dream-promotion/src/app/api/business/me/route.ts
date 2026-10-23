import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { businessOf, isSuperAdmin, memberAccess } from '@/lib/server/business';
import { bizView } from '@/features/admin/business-state';

export const runtime = 'nodejs';

/** what the business bought (2.107, migration 5800 — before it, and for no business: everything, as before) */
export const ALL_MODULES = ['dream', 'attendance'] as const;
async function businessModules(id: string | null): Promise<string[]> {
  if (!id) return [...ALL_MODULES];
  const { data, error } = await adminDb().from('businesses').select('modules').eq('id', id).maybeSingle();
  const m = !error && Array.isArray((data as any)?.modules) ? ((data as any).modules as string[]).filter((x) => (ALL_MODULES as readonly string[]).includes(x)) : [];
  return m.length ? m : [...ALL_MODULES];
}
export const dynamic = 'force-dynamic';

/**
 * The business this user works in now, and the ones they may switch to.
 *  GET  → { business, businesses[], superAdmin, access, modules } — drives the "העסק נעול" banner, the business switcher
 *         and the register-only screen of a cashier (access 'register')
 *  POST { id } → work in that business from now on (super admin: any; others: one they are a member of).
 *        Row-level security then shows only that business's data (migration 20261004002500).
 */
export async function GET(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const db = adminDb();
  const [superAdmin, id] = await Promise.all([isSuperAdmin(userId), businessOf(userId)]);
  let list;
  if (superAdmin) list = (await db.from('businesses').select('id, name, status, paid_until, grace_days').order('name')).data ?? [];
  else {
    const { data: m } = await db.from('business_members').select('business_id').eq('user_id', userId);
    const ids = (m ?? []).map((r) => r.business_id);
    list = ids.length ? (await db.from('businesses').select('id, name, status, paid_until, grace_days').in('id', ids).order('name')).data ?? [] : [];
  }
  const businesses = list.map((b) => { const v = bizView(b); return { id: b.id, name: b.name, state: v.state, lastDay: v.lastDay, daysLeft: v.daysLeft }; });
  const access = superAdmin ? 'full' : await memberAccess(userId, id);
  return NextResponse.json({ business: businesses.find((b) => b.id === id) ?? null, businesses, superAdmin, access, modules: await businessModules(id) });
}

export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const id = String((await req.json().catch(() => ({}))).id ?? '');
  const db = adminDb();
  const [superAdmin, { data: member }, { data: biz }] = await Promise.all([
    isSuperAdmin(userId),
    db.from('business_members').select('role').eq('business_id', id).eq('user_id', userId).maybeSingle(),
    db.from('businesses').select('id').eq('id', id).maybeSingle(),
  ]);
  if (!biz || (!superAdmin && !member)) return NextResponse.json({ code: 'forbidden', message: 'אין גישה לעסק הזה' }, { status: 403 });
  const { error } = await db.from('profiles').update({ current_business_id: id }).eq('id', userId);
  if (error) return NextResponse.json({ code: 'db', message: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
