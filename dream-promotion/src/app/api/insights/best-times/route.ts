import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { businessOf } from '@/lib/server/business';
import { metaAccount } from '@/lib/server/meta';
import { RESEARCH, personalBestTimes, type PersonalResult } from '@/lib/server/best-times';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Recommended posting times: research defaults for every format, plus — per connected Instagram
 * account — the hours its own posts and reels got the most likes and comments.
 */
export async function GET(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const biz = await businessOf(userId);
  const { data } = await adminDb().from('social_accounts').select('id, display_name').eq('business_id', biz ?? '00000000-0000-0000-0000-000000000000').eq('provider', 'instagram').eq('status', 'active');
  const personal: Record<string, (PersonalResult & { name: string }) | { name: string; error: string }> = {};
  await Promise.all((data ?? []).map(async (a) => {
    try { personal[a.id] = { name: a.display_name ?? '', ...(await personalBestTimes(await metaAccount(userId, a.id))) }; }
    catch (e: any) { personal[a.id] = { name: a.display_name ?? '', error: String(e?.message ?? e).slice(0, 200) }; }
  }));
  return NextResponse.json({ research: RESEARCH, personal });
}
