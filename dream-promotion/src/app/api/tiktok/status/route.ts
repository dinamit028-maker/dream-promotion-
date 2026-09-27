import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { accessTokenFor, publishStatus } from '@/lib/server/tiktok';

export const runtime = 'nodejs';

/** Where a sent video is: PROCESSING_UPLOAD → SEND_TO_USER_INBOX (waiting in the TikTok app) or FAILED. */
export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    const s = await publishStatus(await accessTokenFor(userId, body.accountId), String(body.publishId));
    if (body.postId) {
      await adminDb().from('social_posts').update({ status: s.status.toLowerCase(), error: s.failReason ?? null, updated_at: new Date().toISOString() })
        .eq('id', body.postId).eq('user_id', userId);
    }
    return NextResponse.json(s);
  } catch (e: any) {
    return NextResponse.json({ code: 'status_failed', message: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
