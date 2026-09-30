import { authHeaders } from './http';
import type { CaptionWord } from '@/types';

async function call(body: Record<string, unknown>): Promise<{ text: string; words: CaptionWord[] }> {
  const res = await fetch('/api/transcribe', { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.message || j.code || `http_${res.status}`), { code: j.code });
  return { text: String(j.text ?? ''), words: Array.isArray(j.words) ? j.words : [] };
}

const toDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error('read_failed'));
  r.readAsDataURL(blob);
});

/** Speech → text (Whisper on fal). Hebrew by default. */
export const TranscribeService = {
  /** A video or audio file in storage → words with timing, for captions. prompt: names and terms to spell right. */
  file: (url: string, prompt?: string) => call({ url, words: true, prompt }),
  /** A microphone recording → plain text. */
  async recording(blob: Blob): Promise<string> {
    const audio = await toDataUrl(blob);
    return (await call({ audio })).text;
  },
};
