import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { checkMetaAccount, metaAccount } from '@/lib/server/meta';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Live check of every Instagram / Facebook connection: does Meta still accept the stored token?
 * "Connected" in the list only means "saved"; this says whether it actually works right now.
 */
export async function GET(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const { data } = await adminDb().from('social_accounts').select('id').eq('user_id', userId).in('provider', ['facebook', 'instagram']);
  const results = await Promise.all((data ?? []).map(async (a) => {
    try { return { id: a.id as string, ...(await checkMetaAccount(await metaAccount(userId, a.id))) }; }
    catch (e: any) { return { id: a.id as string, ok: false, reason: String(e?.message ?? e).slice(0, 200), reconnect: true }; }
  }));
  return NextResponse.json({ results });
}
