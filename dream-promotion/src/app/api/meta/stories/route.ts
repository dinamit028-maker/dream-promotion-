import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { importStories, metaAccount, recentStoryMedia } from '@/lib/server/meta';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Copies live Instagram stories into the media library — one account, or all of the user's. */
export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  let ids: string[] = body.accountId ? [String(body.accountId)] : [];
  if (!ids.length) {
    const { data } = await adminDb().from('social_accounts').select('id').eq('user_id', userId).eq('provider', 'instagram');
    ids = (data ?? []).map((a) => a.id);
  }
  if (!ids.length) return NextResponse.json({ code: 'no_instagram', message: 'no Instagram account connected' }, { status: 404 });
  const total = { added: [] as unknown[], already: 0, noFile: 0, failed: 0, live: 0, errors: [] as string[] };
  for (const id of ids) {
    try {
      const r = await importStories(userId, await metaAccount(userId, id));
      total.added.push(...r.added); total.already += r.already; total.noFile += r.noFile; total.failed += r.failed; total.live += r.live;
    } catch (e: any) { total.errors.push(String(e?.message ?? e).slice(0, 160)); }
  }
  // stories the timer saved in the background, so this screen shows them too
  const recent = await recentStoryMedia(userId).catch(() => []);
  return NextResponse.json({ ...total, recent });
}
