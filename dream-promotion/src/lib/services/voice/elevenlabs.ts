import type { Alignment, SpeakRequest, SpeakResult, VoiceOption, VoiceProvider, VoiceStyle } from './types';

const API = 'https://api.elevenlabs.io/v1';

/**
 * Hebrew notes that cost us real testing time elsewhere:
 * - language_code must be sent, and it is ignored by multilingual_v2 — so Hebrew
 *   defaults to v3, which honours it.
 * - Numbers and Latin brand names inside Hebrew are the usual failure point; the
 *   pronunciation overrides applied upstream handle those.
 */
const MODEL_HE = process.env.ELEVENLABS_MODEL_HE || 'eleven_v3';
const MODEL_DEFAULT = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

const STYLE_SETTINGS: Record<VoiceStyle, { stability: number; similarity_boost: number; style: number; speed: number }> = {
  natural:    { stability: 0.55, similarity_boost: 0.75, style: 0.15, speed: 1.0 },
  energetic:  { stability: 0.35, similarity_boost: 0.75, style: 0.55, speed: 1.08 },
  premium:    { stability: 0.75, similarity_boost: 0.8,  style: 0.2,  speed: 0.95 },
  commercial: { stability: 0.4,  similarity_boost: 0.8,  style: 0.7,  speed: 1.05 },
};

const guessGender = (labels: Record<string, string> | undefined): VoiceOption['gender'] => {
  const g = (labels?.gender || '').toLowerCase();
  if (g.includes('female')) return 'female';
  if (g.includes('male')) return 'male';
  return 'unknown';
};

export class ElevenLabsProvider implements VoiceProvider {
  readonly id = 'elevenlabs';
  readonly label = 'ElevenLabs';
  private key = process.env.ELEVENLABS_API_KEY;

  available() { return Boolean(this.key); }

  private headers() {
    return { 'xi-api-key': this.key as string, 'Content-Type': 'application/json' };
  }

  async listVoices(language: string): Promise<VoiceOption[]> {
    const res = await fetch(`${API}/voices`, { headers: { 'xi-api-key': this.key as string } });
    if (!res.ok) throw new Error(`voices_failed_${res.status}`);
    const json: any = await res.json();
    const voices: VoiceOption[] = (json.voices || []).map((v: any) => ({
      id: v.voice_id,
      name: v.name,
      gender: guessGender(v.labels),
      description: [v.labels?.accent, v.labels?.description, v.labels?.use_case].filter(Boolean).join(' · '),
      languages: (v.verified_languages || []).map((l: any) => l.language),
    }));
    // Hebrew isn't usually tagged per voice; keep the full list but put verified ones first.
    return voices.sort((a, b) => Number(b.languages?.includes(language)) - Number(a.languages?.includes(language)));
  }

  async speak(req: SpeakRequest): Promise<SpeakResult> {
    const model = req.language === 'he' ? MODEL_HE : MODEL_DEFAULT;
    const settings = STYLE_SETTINGS[req.style] ?? STYLE_SETTINGS.natural;
    const body = {
      text: req.text,
      model_id: model,
      language_code: req.language,
      voice_settings: { ...settings, speed: req.speed ?? settings.speed },
    };
    const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(req.voiceId)}/with-timestamps`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${res.status}: ${detail.slice(0, 300)}`);
    }
    const json: any = await res.json();
    const a = json.alignment || json.normalized_alignment;
    const alignment: Alignment | undefined = a ? {
      characters: a.characters,
      startsSec: a.character_start_times_seconds,
      endsSec: a.character_end_times_seconds,
    } : undefined;
    return {
      audioBase64: json.audio_base64,
      mimeType: 'audio/mpeg',
      alignment,
      durationSec: alignment ? alignment.endsSec[alignment.endsSec.length - 1] : undefined,
    };
  }
}
