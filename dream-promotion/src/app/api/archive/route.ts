import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { BlockedUrlError, safeFetch } from '@/lib/server/safe-fetch';

export const runtime = 'nodejs';
export const maxDuration = 60;

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Generated clips and images live on the provider's CDN, and those links do not
 * last forever. This copies the file into the user's own bucket the moment it is
 * made, so nothing they paid for can quietly disappear.
 */
export async function POST(req: Request) {
  if (!URL_ || !SERVICE) {
    return NextResponse.json({ code: 'no_cloud', message: 'Supabase is not configured' }, { status: 503 });
  }
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return NextResponse.json({ code: 'no_session', message: 'sign in required' }, { status: 401 });

  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return NextResponse.json({ code: 'bad_session', message: 'sign in required' }, { status: 401 });

  try {
    const { url, kind = 'video', name = '' } = await req.json();
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      return NextResponse.json({ code: 'bad_request', message: 'url required' }, { status: 400 });
    }

    // only the AI providers' CDNs and this project's storage; checked on every redirect (SSRF)
    let res: Response;
    try { res = await safeFetch(url, { maxBytes: 300 * 1024 * 1024, timeoutMs: 50_000 }); }
    catch (e: any) {
      if (e instanceof BlockedUrlError) return NextResponse.json({ code: 'blocked_url', message: e.message }, { status: 400 });
      throw e;
    }
    if (!res.ok) return NextResponse.json({ code: 'fetch_failed', message: `source returned ${res.status}` }, { status: 200 });
    const buf = Buffer.from(await res.arrayBuffer());
    const type = (res.headers.get('content-type') || (kind === 'video' ? 'video/mp4' : 'image/jpeg')).split(';')[0].trim().toLowerCase();
    if (!/^(image|video|audio)\//.test(type)) return NextResponse.json({ code: 'bad_type', message: `not a media file (${type})` }, { status: 400 });
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('mp4') ? 'mp4' : type.includes('mpeg') ? 'mp3' : type.includes('wav') ? 'wav' : 'jpg';
    const path = `${user.id}/${kind}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const up = await admin.storage.from('assets').upload(path, buf, { contentType: type, upsert: false });
    if (up.error) return NextResponse.json({ code: 'upload_failed', message: up.error.message }, { status: 200 });

    // a long-lived signed link, since the bucket is private
    const signed = await admin.storage.from('assets').createSignedUrl(path, 60 * 60 * 24 * 365);
    const finalUrl = signed.data?.signedUrl ?? url;

    const row = await admin.from('media').insert({
      user_id: user.id, url: finalUrl, storage_path: path, name,
      kind: kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'image',
      source: 'generated',
    }).select('id').single();

    return NextResponse.json({ id: row.data?.id, url: finalUrl, path });
  } catch (e: any) {
    return NextResponse.json({ code: 'archive_error', message: e?.message ?? 'unknown' }, { status: 200 });
  }
}
