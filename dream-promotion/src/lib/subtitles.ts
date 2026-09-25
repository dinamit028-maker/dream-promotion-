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

/**
 * Captions in the ORIGINAL script wording, timed by the voice.
 * The voice spoke `spoken` (with pronunciation rewrites); each original word or brand
 * term is timed from the characters it became in the spoken text.
 */
export function cuesFromOriginal(
  segments: { orig: string; start: number; end: number; replaced: boolean }[],
  a: Alignment, spokenLength: number, maxWords = 5, maxSec = 3.2,
): Cue[] {
  const n = a.characters.length;
  if (!n) return [];
  // alignment normally covers the spoken text 1:1; if the engine normalised it, scale indices
  const scale = a.characters.join('').length === spokenLength ? 1 : n / Math.max(1, spokenLength);
  const at = (i: number) => Math.min(n - 1, Math.max(0, Math.round(i * scale)));

  // words of the original script, each with its spoken character range
  const units: { text: string; s: number; e: number; o: number; oe: number }[] = [];
  let o = 0; // position in the original script
  const add = (u: { text: string; s: number; e: number; o: number; oe: number }) => {
    const prev = units[units.length - 1];
    // "ה-eSIM": a term glued to its neighbour stays one caption word
    if (prev && prev.oe === u.o) { prev.text += u.text; prev.e = u.e; prev.oe = u.oe; } else units.push(u);
  };
  for (const seg of segments) {
    if (seg.replaced) { add({ text: seg.orig, s: seg.start, e: seg.end - 1, o, oe: o + seg.orig.length }); }
    else {
      for (const m of seg.orig.matchAll(/\S+/g)) {
        const i = m.index ?? 0, s = seg.start + i;
        add({ text: m[0], s, e: s + m[0].length - 1, o: o + i, oe: o + i + m[0].length });
      }
    }
    o += seg.orig.length;
  }
  // a replaced term glued to punctuation/prefix ("ה-eSIM") is joined back to its neighbour
  const cues: Cue[] = [];
  let words: string[] = [];
  let start: number | null = null;
  let end = 0;
  const flush = () => {
    if (words.length && start !== null) cues.push({ start, end, text: words.join(' ') });
    words = []; start = null;
  };
  for (const u of units) {
    const s = a.startsSec[at(u.s)], e = a.endsSec[at(u.e)];
    if (start === null) start = s;
    words.push(u.text); end = Math.max(end, e);
    if (/[.,!?;:]$/.test(u.text) || words.length >= maxWords || end - start >= maxSec) flush();
  }
  flush();
  return cues;
}
