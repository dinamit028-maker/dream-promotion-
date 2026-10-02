import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { importPosts, isRateLimited, metaAccount } from '@/lib/server/meta';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Pulls every published post and reel of the user's Instagram accounts into the media library.
 * One call works ~45 seconds, then answers { done:false, state } — the browser calls again with
 * that state until done. Already-saved items are skipped, so it is safe to run any time.
 * Body: { state?: { account: number, after: string | null }, days?: number }
 */
export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { data } = await adminDb().from('social_accounts').select('id').eq('user_id', userId).eq('provider', 'instagram').order('created_at');
  const ids = (data ?? []).map((a) => a.id as string);
  if (!ids.length) return NextResponse.json({ code: 'no_instagram', message: 'no Instagram account connected' }, { status: 404 });

  let account = Math.max(0, Math.min(ids.length - 1, Number(body.state?.account) || 0));
  let after: string | null = typeof body.state?.after === 'string' ? body.state.after : null;
  const deadline = Date.now() + 45_000;
  // only posts from the last N days (0 / missing = the whole profile)
  const days = Math.max(0, Math.min(3650, Number(body.days) || 0));
  const since = days ? Date.now() - days * 864e5 : null;
  const total = { added: [] as unknown[], already: 0, noFile: 0, failed: 0, scanned: 0, errors: [] as string[] };

  while (account < ids.length) {
    try {
      const r = await importPosts(userId, await metaAccount(userId, ids[account]), { after, deadline, since });
      total.added.push(...r.added); total.already += r.already; total.noFile += r.noFile; total.failed += r.failed; total.scanned += r.scanned;
      if (!r.done) return NextResponse.json({ ...total, done: false, state: { account, after: r.after } });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (isRateLimited(msg)) {
        // Meta is limiting us: stop here, keep everything saved, and continue later from this account
        return NextResponse.json({ ...total, done: false, rateLimited: true, state: { account, after } });
      }
      total.errors.push(msg.slice(0, 160));
    }
    account++; after = null;
    if (Date.now() > deadline) break;
  }
  const done = account >= ids.length;
  return NextResponse.json({ ...total, done, state: done ? null : { account, after: null } });
}
