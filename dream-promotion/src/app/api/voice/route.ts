import { NextResponse } from 'next/server';
import { getVoiceProvider } from '@/lib/services/voice';
import { accessDenied } from '@/lib/server/access';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const provider = getVoiceProvider();
  if (!provider.available()) {
    return NextResponse.json({ available: false, provider: provider.id, voices: [] });
  }
  const url = new URL(req.url);
  const language = url.searchParams.get('language') || 'he';
  try {
    const voices = await provider.listVoices(language);
    return NextResponse.json({ available: true, provider: provider.id, label: provider.label, voices });
  } catch (e: any) {
    return NextResponse.json({ available: true, provider: provider.id, voices: [], error: e?.message ?? 'voices_failed' });
  }
}

export async function POST(req: Request) {
  const provider = getVoiceProvider();
  if (!provider.available()) {
    return NextResponse.json({ code: 'no_voice_key', message: 'Voice provider is not configured' }, { status: 503 });
  }
  const denied = accessDenied(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const text = String(body.text ?? '').trim().slice(0, 4000);
    if (!text) return NextResponse.json({ code: 'bad_request', message: 'text required' }, { status: 400 });

    const out = await provider.speak({
      text,
      voiceId: String(body.voiceId ?? ''),
      style: body.style ?? 'natural',
      language: body.language === 'en' ? 'en' : 'he',
      speed: typeof body.speed === 'number' ? body.speed : undefined,
    });
    return NextResponse.json(out);
  } catch (e: any) {
    const msg = e?.message ?? 'voice_error';
    const code = /401|403/.test(msg) ? 'bad_voice_key'
      : /429/.test(msg) ? 'rate_limited'
      : /quota|credit|402/.test(msg) ? 'no_voice_credit'
      : 'voice_error';
    return NextResponse.json({ code, message: msg }, { status: 200 });
  }
}
