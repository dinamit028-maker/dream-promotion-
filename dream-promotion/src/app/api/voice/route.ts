import { NextResponse } from 'next/server';
import { getVoiceProvider } from '@/lib/services/voice';
import { accessDenied } from '@/lib/server/access';
import { userFromRequest } from '@/lib/server/admin';
import { commitUsage, releaseUsage, requestUser, reserveUsage, type Reservation } from '@/lib/server/quota';
import { PRICES } from '@/lib/server/ai/config';
import { contentIdFrom, logGeneration } from '@/lib/server/ai/ledger';

export const runtime = 'nodejs';

/** the voices and the plan's usage — for a signed-in user only (before 2.52.1 anyone could read the account's usage) */
export async function GET(req: Request) {
  if (!(await userFromRequest(req))) return NextResponse.json({ code: 'no_session', available: false, voices: [] }, { status: 401 });
  const provider = getVoiceProvider();
  if (!provider.available()) {
    return NextResponse.json({ available: false, provider: provider.id, voices: [] });
  }
  const url = new URL(req.url);
  const language = url.searchParams.get('language') || 'he';
  try {
    const [voices, usage] = await Promise.all([provider.listVoices(language), provider.usage?.() ?? Promise.resolve(null)]);
    return NextResponse.json({ available: true, provider: provider.id, label: provider.label, voices, usage });
  } catch (e: any) {
    return NextResponse.json({ available: true, provider: provider.id, voices: [], error: e?.message ?? 'voices_failed' });
  }
}

export async function POST(req: Request) {
  const provider = getVoiceProvider();
  if (!provider.available()) {
    return NextResponse.json({ code: 'no_voice_key', message: 'Voice provider is not configured' }, { status: 503 });
  }
  const denied = await accessDenied(req);
  if (denied) return denied;

  let slot: Reservation | null = null;
  try {
    const body = await req.json();
    const text = String(body.text ?? '').trim().slice(0, 4000);
    if (!text) return NextResponse.json({ code: 'bad_request', message: 'text required' }, { status: 400 });
    const userId = await requestUser(req);
    const r = await reserveUsage(userId, 'voice', text.length, { voiceId: String(body.voiceId ?? '') });
    if (r.denied) return r.denied;
    slot = r.reservation;

    const started = Date.now();
    const out = await provider.speak({
      text,
      voiceId: String(body.voiceId ?? ''),
      style: body.style ?? 'natural',
      language: body.language === 'en' ? 'en' : 'he',
      speed: typeof body.speed === 'number' ? body.speed : undefined,
    });
    // ElevenLabs bills by character; the price per character depends on the plan (VOICE_USD_PER_1K_CHARS)
    const cost = PRICES.voicePer1k == null ? null : (text.length / 1000) * PRICES.voicePer1k;
    await commitUsage(slot, { status: 'done', costUsd: cost ?? 0, meta: { provider: provider.id } });
    void logGeneration({
      userId, contentId: await contentIdFrom(req, userId), type: 'voice', provider: provider.id,
      model: body.language === 'en' ? (process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2') : (process.env.ELEVENLABS_MODEL_HE || 'eleven_v3'),
      status: 'succeeded', inputUnits: text.length, durationSeconds: (out as any).durationSec ?? null,
      estimatedCostUsd: cost, latencyMs: Date.now() - started, meta: { voiceId: String(body.voiceId ?? ''), style: body.style ?? 'natural' },
    });
    return NextResponse.json(out);
  } catch (e: any) {
    const msg = e?.message ?? 'voice_error';
    if (slot) await releaseUsage(slot, msg);
    // ElevenLabs answers 401 also when the account is out of characters ("quota_exceeded"),
    // so credit is checked first — it used to show up as "the key was rejected"
    const code = /quota_exceeded|quota|credit|insufficient|402/i.test(msg) ? 'no_voice_credit'
      : /429/.test(msg) ? 'rate_limited'
      : /401|403/.test(msg) ? 'bad_voice_key'
      : 'voice_error';
    console.error('[voice]', msg.slice(0, 300));
    return NextResponse.json({ code, message: msg }, { status: 200 });
  }
}
