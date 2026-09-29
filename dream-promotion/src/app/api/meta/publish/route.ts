import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { createIgContainer, metaAccount, publishToPage, type IgTarget } from '@/lib/server/meta';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Publishes a library file. Facebook Page: done in one call.
 * Instagram: returns a container id; the browser then polls /api/meta/publish/status until it is live.
 */
export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session', message: 'sign in required' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { data: media } = await adminDb().from('media').select('id, url, kind').eq('id', body.mediaId).eq('user_id', userId).maybeSingle();
  if (!media || media.kind === 'audio') return NextResponse.json({ code: 'bad_media', message: 'choose an image or a video' }, { status: 400 });
  try {
    const acc = await metaAccount(userId, String(body.accountId));
    if (acc.mode === 'read') return NextResponse.json({ code: 'read_only', message: 'this account is connected for reading only' }, { status: 403 });
    const caption = String(body.caption ?? '').slice(0, 2200);
    if (acc.provider === 'facebook') {
      const id = await publishToPage(acc, media, caption);
      return NextResponse.json({ state: 'published', id });
    }
    const target: IgTarget = body.target === 'story' ? 'story' : media.kind === 'video' ? 'reel' : 'feed';
    const containerId = await createIgContainer(acc, media, caption, target);
    return NextResponse.json({ state: 'processing', containerId });
  } catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 300);
    const status = /reconnect_required/.test(message) ? 401 : /permission_denied/.test(message) ? 403 : 502;
    return NextResponse.json({ code: message.split(':')[0], message }, { status });
  }
}
