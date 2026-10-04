import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { businessOf, isSuperAdmin } from '@/lib/server/business';
import { bizView } from '@/features/admin/business-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The business this user works in now and whether it is open — drives the "העסק נעול" banner. */
export async function GET(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const [superAdmin, id] = await Promise.all([isSuperAdmin(userId), businessOf(userId)]);
  if (!id) return NextResponse.json({ business: null, superAdmin });
  const { data: b } = await adminDb().from('businesses').select('id, name, status, paid_until, grace_days').eq('id', id).maybeSingle();
  if (!b) return NextResponse.json({ business: null, superAdmin });
  const v = bizView(b);
  return NextResponse.json({ business: { id: b.id, name: b.name, state: v.state, lastDay: v.lastDay, daysLeft: v.daysLeft }, superAdmin });
}
