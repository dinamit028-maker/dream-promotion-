import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { accessTokenFor, uploadToInbox } from '@/lib/server/tiktok';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** Sends one of the user's library videos to their TikTok inbox as a draft. */
export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session', message: 'sign in required' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const db = adminDb();
  const { data: media } = await db.from('media').select('id, url, kind').eq('id', body.mediaId).eq('user_id', userId).maybeSingle();
  if (!media || media.kind !== 'video') return NextResponse.json({ code: 'bad_media', message: 'choose a video from your library' }, { status: 400 });

  const { data: log } = await db.from('social_posts').insert({
    user_id: userId, account_id: body.accountId, provider: 'tiktok', content_id: body.contentId ?? null,
    media_id: media.id, mode: 'draft', status: 'sending',
  }).select('id').single();
  const mark = (patch: Record<string, unknown>) =>
    log ? db.from('social_posts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', log.id) : Promise.resolve();

  try {
    const token = await accessTokenFor(userId, body.accountId);
    const file = await fetch(media.url);
    if (!file.ok) throw new Error(`video_download_${file.status}`);
    const buf = Buffer.from(await file.arrayBuffer());
    const publishId = await uploadToInbox(token, buf);
    await mark({ external_id: publishId, status: 'uploaded' });
    return NextResponse.json({ publishId, postId: log?.id ?? null });
  } catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 300);
    await mark({ status: 'failed', error: message });
    const status = /reconnect_required|access_token_invalid/.test(message) ? 401 : /spam_risk|rate_limit/.test(message) ? 429 : 502;
    return NextResponse.json({ code: message.split(':')[0], message }, { status });
  }
}
