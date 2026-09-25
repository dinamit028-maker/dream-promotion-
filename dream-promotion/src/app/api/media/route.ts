import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * User uploads, in two steps so large files never pass through this function:
 *  action "sign"     → a one-time upload link into the user's own folder
 *  action "register" → after the browser uploaded the file: a long-lived read link + a row in `media`
 * Works without any storage policies, because the server hands out the link.
 */
export async function POST(req: Request) {
  if (!URL_ || !SERVICE) return NextResponse.json({ code: 'no_cloud', message: 'Supabase is not configured' }, { status: 503 });
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return NextResponse.json({ code: 'no_session', message: 'sign in required' }, { status: 401 });

  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
  const { data: u } = await admin.auth.getUser(token);
  const user = u?.user;
  if (!user) return NextResponse.json({ code: 'bad_session', message: 'sign in required' }, { status: 401 });

  try {
    const body = await req.json();
    if (body.action === 'sign') {
      const ext = String(body.ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
      const path = `${user.id}/upload/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { data, error } = await admin.storage.from('assets').createSignedUploadUrl(path);
      if (error || !data) return NextResponse.json({ code: 'sign_failed', message: error?.message ?? 'no link' }, { status: 500 });
      return NextResponse.json({ path, token: data.token });
    }

    if (body.action === 'register') {
      const path = String(body.path || '');
      if (!path.startsWith(`${user.id}/`)) return NextResponse.json({ code: 'forbidden', message: 'not your file' }, { status: 403 });
      const kind = body.kind === 'video' ? 'video' : body.kind === 'audio' ? 'audio' : 'image';
      const signed = await admin.storage.from('assets').createSignedUrl(path, 60 * 60 * 24 * 365);
      if (!signed.data?.signedUrl) return NextResponse.json({ code: 'read_link_failed', message: signed.error?.message ?? '' }, { status: 500 });
      const row = await admin.from('media').insert({
        user_id: user.id, url: signed.data.signedUrl, storage_path: path,
        name: String(body.name || '').slice(0, 200), kind, source: 'upload',
      }).select('id').single();
      if (row.error) return NextResponse.json({ code: 'row_failed', message: row.error.message }, { status: 500 });
      return NextResponse.json({ id: row.data.id, url: signed.data.signedUrl });
    }

    return NextResponse.json({ code: 'bad_request', message: 'unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ code: 'media_error', message: e?.message ?? 'unknown' }, { status: 500 });
  }
}
