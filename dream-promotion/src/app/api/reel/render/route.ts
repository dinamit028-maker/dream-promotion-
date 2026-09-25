import { createClient } from '@supabase/supabase-js';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderReel, type RenderJob } from '@/lib/server/reel-render';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// a 45-second reel renders in well under a minute on a normal CPU; leave generous room
export const maxDuration = 300;

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const isHttps = (u: unknown): u is string => typeof u === 'string' && u.startsWith('https://');

/**
 * Renders the final reel and stores it. The response is a stream of JSON lines
 * ({stage, pct} … then {done, mediaId, url, durationSec} or {error}), so the
 * screen can show real progress while ffmpeg works.
 */
export async function POST(req: Request) {
  if (!URL_ || !SERVICE) return Response.json({ error: 'Supabase is not configured', code: 'no_cloud' }, { status: 503 });
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
  const { data: u } = token ? await admin.auth.getUser(token) : { data: null as any };
  const user = u?.user;
  if (!user) return Response.json({ error: 'sign in required', code: 'no_session' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'bad json', code: 'bad_request' }, { status: 400 }); }

  const scenes = Array.isArray(body.scenes) ? body.scenes.slice(0, 12) : [];
  if (!scenes.length || !scenes.every((s: any) => isHttps(s.url) && (!s.narrationUrl || isHttps(s.narrationUrl)))) {
    return Response.json({ error: 'every scene needs a finished clip or image (https)', code: 'bad_request' }, { status: 400 });
  }
  const job: RenderJob = {
    scenes: scenes.map((s: any) => ({
      url: s.url, kind: s.kind === 'image' ? 'image' : 'video', seconds: Number(s.seconds) || undefined,
      narrationUrl: s.narrationUrl || undefined,
      cues: Array.isArray(s.cues) ? s.cues.slice(0, 200).map((c: any) => ({ start: +c.start || 0, end: +c.end || 0, text: String(c.text ?? '').slice(0, 200) })) : [],
    })),
    music: body.music && isHttps(body.music.url) ? { url: body.music.url, volume: Number(body.music.volume ?? 0.25) } : null,
    captions: {
      enabled: body.captions?.enabled !== false,
      position: body.captions?.position === 'middle' ? 'middle' : 'bottom',
      size: body.captions?.size === 'md' ? 'md' : 'lg',
    },
  };
  const title = String(body.title || 'ריל').slice(0, 120);
  const contentId = typeof body.contentId === 'string' ? body.contentId : null;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: object) => ctrl.enqueue(enc.encode(JSON.stringify(o) + '\n'));
      const dir = path.join(os.tmpdir(), `reel-${user.id.slice(0, 8)}-${Date.now()}`);
      try {
        const { file, durationSec } = await renderReel(job, dir, (p) => send(p));
        send({ stage: 'upload', pct: 0 });
        const buf = await readFile(file);
        const storagePath = `${user.id}/reel/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
        const up = await admin.storage.from('assets').upload(storagePath, buf, { contentType: 'video/mp4', upsert: false });
        if (up.error) throw new Error(`upload_failed: ${up.error.message}`);
        const signed = await admin.storage.from('assets').createSignedUrl(storagePath, 60 * 60 * 24 * 365);
        if (!signed.data?.signedUrl) throw new Error('signed_url_failed');
        const row = await admin.from('media').insert({
          user_id: user.id, url: signed.data.signedUrl, storage_path: storagePath,
          name: `${title} · ריל סופי`, kind: 'video', source: 'generated',
        }).select('id').single();
        if (row.error) throw new Error(`media_row_failed: ${row.error.message}`);
        // link the finished file to its reel so it opens with the project
        if (contentId) await admin.from('content').update({ media_id: row.data.id }).eq('id', contentId).eq('user_id', user.id);
        send({ done: true, mediaId: row.data.id, url: signed.data.signedUrl, durationSec, sizeMb: +(buf.length / 1e6).toFixed(1) });
      } catch (e: any) {
        send({ error: String(e?.message ?? e).slice(0, 600) });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        ctrl.close();
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
}
