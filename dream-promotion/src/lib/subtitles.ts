import type { Alignment } from '@/lib/services/voice/types';

export interface Cue { start: number; end: number; text: string }

const pad = (n: number, l = 2) => String(Math.floor(n)).padStart(l, '0');
const stamp = (s: number, sep: ',') => {
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}${sep}${String(ms).padStart(3, '0')}`;
};

/**
 * Groups character timings into short caption lines — a few words each, broken at
 * punctuation. Works for Hebrew because we never reorder characters, only slice them.
 */
export function cuesFromAlignment(a: Alignment, maxWords = 5, maxSec = 3.2): Cue[] {
  const cues: Cue[] = [];
  let text = '';
  let start: number | null = null;
  let words = 0;

  const push = (end: number) => {
    const t = text.trim();
    if (t && start !== null) cues.push({ start, end, text: t });
    text = ''; start = null; words = 0;
  };

  for (let i = 0; i < a.characters.length; i++) {
    const ch = a.characters[i];
    if (start === null && ch.trim()) start = a.startsSec[i];
    text += ch;
    if (/\s/.test(ch) && text.trim()) words++;
    const long = start !== null && a.endsSec[i] - start >= maxSec;
    if (/[.,!?;:]/.test(ch) || words >= maxWords || long) push(a.endsSec[i]);
  }
  push(a.endsSec[a.endsSec.length - 1] ?? 0);
  return cues;
}

export const toSrt = (cues: Cue[]) =>
  cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n`).join('\n');

export const toVtt = (cues: Cue[]) =>
  `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, ',').replace(',', '.')} --> ${stamp(c.end, ',').replace(',', '.')}\n${c.text}\n`).join('\n')}`;
