import { NextResponse } from 'next/server';
import { fal } from '@fal-ai/client';
import { accessDenied } from '@/lib/server/access';
import { urlLooksAllowed } from '@/lib/server/safe-fetch';
import { commitUsage, releaseUsage, requestUser, reserveUsage, type Reservation } from '@/lib/server/quota';
import { AI_CONFIG, PRICES } from '@/lib/server/ai/config';
import { contentIdFrom, logGeneration } from '@/lib/server/ai/ledger';

export const runtime = 'nodejs';
export const maxDuration = 180;

const KEY = process.env.FAL_KEY;
if (KEY) fal.config({ credentials: KEY });

/**
 * Speech → text with Whisper on fal.
 *  { url }   — a video or audio file already in storage (a clip, a story): word-by-word timing for captions
 *  { audio } — a short recording from the microphone (data URL): plain text for a text field
 * Returns { text, words: [{ text, start, end }] } (words only when timing was asked for).
 */
export async function POST(req: Request) {
  if (!KEY) return NextResponse.json({ code: 'no_fal_key', message: 'FAL_KEY is not configured' }, { status: 503 });
  const denied = await accessDenied(req);
  if (denied) return denied;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ code: 'bad_request', message: 'Invalid JSON' }, { status: 400 }); }

  // a transcription costs money: reserved first like every paid call (monthly quota, parallel and per-minute limits)
  const userId = await requestUser(req);
  const r = await reserveUsage(userId, 'transcribe', 1, { source: body.url ? 'file' : 'mic' });
  if (r.denied) return r.denied;
  const slot: Reservation = r.reservation;

  try {
    let audioUrl: string;
    if (urlLooksAllowed(body.url)) {
      audioUrl = body.url;
    } else if (typeof body.audio === 'string' && body.audio.startsWith('data:audio/')) {
      const comma = body.audio.indexOf(',');
      const mime = body.audio.slice(5, body.audio.indexOf(';'));
      const buf = Buffer.from(body.audio.slice(comma + 1), 'base64');
      if (buf.length < 800) { await releaseUsage(slot, 'empty_audio'); return NextResponse.json({ code: 'empty_audio', message: 'the recording is empty' }, { status: 400 }); }
      if (buf.length > 4 * 1024 * 1024) { await releaseUsage(slot, 'too_large'); return NextResponse.json({ code: 'too_large', message: 'recording too long' }, { status: 413 }); }
      audioUrl = await fal.storage.upload(new Blob([buf], { type: mime || 'audio/webm' }));
    } else {
      await releaseUsage(slot, 'bad_request');
      return NextResponse.json({ code: 'bad_request', message: 'send url or audio' }, { status: 400 });
    }

    const words = body.words !== false && Boolean(body.url);
    const language = typeof body.language === 'string' && /^[a-z]{2}$/.test(body.language) ? body.language : 'he';
    const started = Date.now();
    const r: any = await fal.subscribe(AI_CONFIG.models.falWhisper, {
      input: {
        audio_url: audioUrl, task: 'transcribe', language,
        chunk_level: words ? 'word' : 'segment',
        ...(typeof body.prompt === 'string' && body.prompt.trim() ? { prompt: body.prompt.slice(0, 400) } : {}),
      } as any,
    });
    const data = r?.data ?? r;
    const text = String(data?.text ?? '').trim();
    const out = words
      ? (data?.chunks ?? [])
          .map((c: any) => ({ text: String(c.text ?? '').trim(), start: Number(c.timestamp?.[0]), end: Number(c.timestamp?.[1]) }))
          .filter((w: any) => w.text && Number.isFinite(w.start))
          .map((w: any) => ({ ...w, end: Number.isFinite(w.end) && w.end > w.start ? w.end : w.start + 0.35 }))
      : [];
    // ledger: audio length = end of the last word (Whisper reports no billable minutes per call)
    const audioSec = out.length ? out[out.length - 1].end : null;
    const estimate = PRICES.falWhisperPerMin != null && audioSec ? (audioSec / 60) * PRICES.falWhisperPerMin : null;
    await commitUsage(slot, { status: 'done', costUsd: estimate ?? 0, meta: { provider: 'fal', audioSec } });
    void logGeneration({
      userId, contentId: await contentIdFrom(req, userId), type: 'transcribe', provider: 'fal', model: AI_CONFIG.models.falWhisper,
      status: 'succeeded', durationSeconds: audioSec, outputUnits: out.length || text.split(/\s+/).length,
      estimatedCostUsd: estimate,
      latencyMs: Date.now() - started, meta: { source: body.url ? 'file' : 'mic' },
    });
    return NextResponse.json({ text, words: out });
  } catch (e: any) {
    const message = String(e?.body?.detail ? JSON.stringify(e.body.detail) : e?.message ?? e).slice(0, 400);
    console.error('[transcribe]', message);
    await releaseUsage(slot, message);
    return NextResponse.json({ code: 'transcribe_failed', message }, { status: 502 });
  }
}
