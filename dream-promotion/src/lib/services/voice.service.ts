import { authHeaders } from './http';
import { pronounceWithMap, type Pronunciation } from '@/lib/pronunciation';
import { cuesFromOriginal, toSrt, toVtt, type Cue } from '@/lib/subtitles';
import type { VoiceOption, VoiceStyle } from './voice/types';

export type { VoiceOption, VoiceStyle };

export interface Narration {
  audioUrl: string;      // object URL for playback / download
  audioBlob: Blob;       // the file itself, so it can be stored permanently
  originalText: string;  // what the captions show
  mimeType: string;
  durationSec?: number;
  cues: Cue[];
  srt: string;
  vtt: string;
  spokenText: string;    // after pronunciation overrides — useful for debugging
}

export class VoiceError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const b64ToBlob = (b64: string, type: string) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
};

export const VOICE_STYLES: { id: VoiceStyle; label: string }[] = [
  { id: 'natural', label: 'טבעי' },
  { id: 'energetic', label: 'אנרגטי' },
  { id: 'premium', label: 'יוקרתי' },
  { id: 'commercial', label: 'פרסומי' },
];

export const PREVIEW_LINE = 'שלום, זו דוגמה לקריינות בעברית עבור הסרטון שלכם.';

export const VoiceService = {
  async status(language = 'he'): Promise<{ available: boolean; provider: string; voices: VoiceOption[] }> {
    try {
      const r = await fetch(`/api/voice?language=${language}`);
      const j = await r.json();
      return { available: !!j.available, provider: j.provider ?? 'none', voices: j.voices ?? [] };
    } catch {
      return { available: false, provider: 'none', voices: [] };
    }
  },

  /** Speaks `text`, applying pronunciation overrides, and returns audio plus synced captions. */
  async narrate(opts: {
    text: string; voiceId: string; style: VoiceStyle; language?: 'he' | 'en';
    pronunciations?: Pronunciation[]; speed?: number;
  }): Promise<Narration> {
    const { spoken: spokenText, segments } = pronounceWithMap(opts.text, opts.pronunciations);
    const res = await fetch('/api/voice', {
      method: 'POST', headers: await authHeaders(),
      body: JSON.stringify({
        text: spokenText, voiceId: opts.voiceId, style: opts.style,
        language: opts.language ?? 'he', speed: opts.speed,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.code) throw new VoiceError(j.code || 'voice_error', j.message || 'voice failed');

    const blob = b64ToBlob(j.audioBase64, j.mimeType || 'audio/mpeg');
    // captions carry the ORIGINAL text; the timing comes from what was actually spoken
    const cues = j.alignment ? cuesFromOriginal(segments, j.alignment, spokenText.length) : [];
    return {
      audioUrl: URL.createObjectURL(blob), audioBlob: blob, originalText: opts.text,
      mimeType: j.mimeType || 'audio/mpeg',
      durationSec: j.durationSec,
      cues, srt: toSrt(cues), vtt: toVtt(cues),
      spokenText,
    };
  },
};
