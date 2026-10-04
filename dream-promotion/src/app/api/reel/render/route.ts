import { createClient } from '@supabase/supabase-js';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { urlLooksAllowed } from '@/lib/server/safe-fetch';
import { PRICES } from '@/lib/server/ai/config';
import { logGeneration } from '@/lib/server/ai/ledger';
import { commitUsage, releaseUsage, reserveUsage } from '@/lib/server/quota';
import { MOTIONS, renderReel, type RenderJob } from '@/lib/server/reel-render';
import { LOCKED, userLocked } from '@/lib/server/business';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// a 45-second reel renders in well under a minute on a normal CPU; leave generous room
export const maxDuration = 300;

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// only this project's storage and the AI providers' CDNs — never an arbitrary address (see safe-fetch)
const isHttps = (u: unknown): u is string => urlLooksAllowed(u);

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
  if (await userLocked(user.id)) return Response.json({ ...LOCKED, error: LOCKED.message }, { status: 403 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'bad json', code: 'bad_request' }, { status: 400 }); }

  // captions travel as images; when there are many, the browser parks them in storage first
  // (a request body is capped at 4.5 MB on Vercel) and sends only the path
  let packPath: string | null = null;
  if (typeof body.scenesPath === 'string' && body.scenesPath.startsWith(`${user.id}/`) && body.scenesPath.endsWith('.json')) {
    const pack: string = body.scenesPath;
    packPath = pack;
    const dl = await admin.storage.from('assets').download(pack);
    if (dl.error || !dl.data) return Response.json({ error: `caption pack missing: ${dl.error?.message ?? ''}`, code: 'bad_request' }, { status: 400 });
    try { body.scenes = JSON.parse(await dl.data.text()); } catch { return Response.json({ error: 'caption pack unreadable', code: 'bad_request' }, { status: 400 }); }
  }
  const scenes = Array.isArray(body.scenes) ? body.scenes.slice(0, 12) : [];
  if (!scenes.length || !scenes.every((s: any) => isHttps(s.url) && (!s.narrationUrl || isHttps(s.narrationUrl)))) {
    return Response.json({ error: 'every scene needs a finished clip or image (https)', code: 'bad_request' }, { status: 400 });
  }
  const job: RenderJob = {
    scenes: scenes.map((s: any) => ({
      url: s.url, kind: s.kind === 'image' ? 'image' : 'video', seconds: Number(s.seconds) || undefined,
      narrationUrl: s.narrationUrl || undefined,
      text: typeof s.text === 'string' ? s.text.slice(0, 2000) : undefined,
      keepAudio: body.originalAudio !== false && s.keepAudio !== false,
      motion: s.kind === 'image' && MOTIONS.includes(s.motion) ? s.motion : undefined,
      cues: Array.isArray(s.cues) ? s.cues.slice(0, 800).map((c: any) => ({
        start: +c.start || 0, end: +c.end || 0, text: String(c.text ?? '').slice(0, 200),
        png: typeof c.png === 'string' && c.png.startsWith('data:image/png') && c.png.length < 1_500_000 ? c.png : undefined,
      })) : [],
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
  const replaceMediaId = typeof body.replaceMediaId === 'string' ? body.replaceMediaId : null;

  const enc = new TextEncoder();
  // a render costs server time: one at a time per user, a few per minute, a monthly ceiling
  const r = await reserveUsage(user.id, 'render', 1, { scenes: job.scenes.length });
  if (r.denied) {
    const j = await r.denied.json().catch(() => ({}));
    return Response.json({ error: j.message || 'render limit reached', code: j.code || 'quota_exceeded' }, { status: 429 });
  }
  const slot = r.reservation;

  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: object) => ctrl.enqueue(enc.encode(JSON.stringify(o) + '\n'));
      const dir = path.join(os.tmpdir(), `reel-${user.id.slice(0, 8)}-${Date.now()}`);
      const started = Date.now();
      // the render's own cost (function time) goes into the reel's cost, like every AI call
      const ownContent = contentId
        ? (await admin.from('content').select('id').eq('id', contentId).eq('user_id', user.id).maybeSingle()).data?.id ?? null
        : null;
      const logRender = (status: 'succeeded' | 'failed', extra: { durationSec?: number; error?: string } = {}) => {
        const minutes = (Date.now() - started) / 60_000;
        return logGeneration({
          userId: user.id, contentId: ownContent, type: 'render', provider: 'vercel', model: 'ffmpeg', status,
          durationSeconds: Math.round((Date.now() - started) / 1000), outputUnits: extra.durationSec ?? null,
          estimatedCostUsd: PRICES.renderPerMin == null ? null : minutes * PRICES.renderPerMin,
          latencyMs: Date.now() - started, error: extra.error ?? null, meta: { scenes: job.scenes.length },
        });
      };
      try {
        const { file, durationSec, captionLines } = await renderReel(job, dir, (p) => send(p));
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
        if (contentId) {
          await admin.from('content').update({ media_id: row.data.id }).eq('id', contentId).eq('user_id', user.id);
          // the finished reel is written into the project on the server too: a refresh, a closed phone or
          // a lost connection during the render never loses it
          try {
            const cur = await admin.from('content').select('reel').eq('id', contentId).eq('user_id', user.id).maybeSingle();
            const reel = (cur.data as any)?.reel;
            if (reel && typeof reel === 'object') {
              await admin.from('content').update({
                reel: { ...reel, final: { mediaId: row.data.id, url: signed.data.signedUrl, durationSec, renderedAt: Date.now() } },
              }).eq('id', contentId).eq('user_id', user.id);
            }
          } catch { /* the browser saves it too */ }
        }
        // a re-render replaces the previous final of this reel instead of piling up copies
        if (replaceMediaId && replaceMediaId !== row.data.id) {
          const old = await admin.from('media').select('id, storage_path, name').eq('id', replaceMediaId).eq('user_id', user.id).maybeSingle();
          if (old.data && String(old.data.name || '').includes('ריל סופי')) {
            if (old.data.storage_path) await admin.storage.from('assets').remove([old.data.storage_path]).catch(() => {});
            await admin.from('media').delete().eq('id', old.data.id).eq('user_id', user.id);
          }
        }
        await logRender('succeeded', { durationSec });
        await commitUsage(slot, { status: 'done', costUsd: PRICES.renderPerMin == null ? 0 : ((Date.now() - started) / 60_000) * PRICES.renderPerMin });
        send({ done: true, mediaId: row.data.id, url: signed.data.signedUrl, durationSec, captionLines, sizeMb: +(buf.length / 1e6).toFixed(1) });
      } catch (e: any) {
        await logRender('failed', { error: String(e?.message ?? e) });
        await releaseUsage(slot, String(e?.message ?? e));
        send({ error: String(e?.message ?? e).slice(0, 600) });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        if (packPath) await admin.storage.from('assets').remove([packPath]).catch(() => {});
        ctrl.close();
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
}
