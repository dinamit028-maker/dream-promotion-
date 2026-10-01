import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Removes, in one go, everything the user pulled from Instagram of one kind
 * (source 'instagram_post' = posts & reels, 'instagram_story' = stories): the library rows and
 * the stored files. Only the signed-in user's own rows. Nothing on Instagram is touched.
 */
export async function DELETE(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const source = body.source === 'instagram_story' ? 'instagram_story' : body.source === 'instagram_post' ? 'instagram_post' : null;
  if (!source) return NextResponse.json({ code: 'bad_request', message: 'source required' }, { status: 400 });

  const db = adminDb();
  let removed = 0;
  for (let round = 0; round < 40; round++) {
    const { data, error } = await db.from('media').select('id, storage_path').eq('user_id', userId).eq('source', source).limit(200);
    if (error) return NextResponse.json({ code: 'db_error', message: error.message }, { status: 500 });
    if (!data?.length) break;
    const paths = data.map((r) => r.storage_path).filter((p): p is string => typeof p === 'string' && p.startsWith(`${userId}/`));
    if (paths.length) await db.storage.from('assets').remove(paths).catch(() => {});
    const del = await db.from('media').delete().eq('user_id', userId).in('id', data.map((r) => r.id));
    if (del.error) return NextResponse.json({ code: 'db_error', message: del.error.message, removed }, { status: 500 });
    removed += data.length;
  }
  return NextResponse.json({ removed });
}
