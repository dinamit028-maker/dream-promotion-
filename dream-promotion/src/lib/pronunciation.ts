export interface Pronunciation { term: string; say: string }

/**
 * Rewrites only what the engine SPEAKS. Captions keep the original spelling,
 * so "eSIM" still reads as eSIM on screen while the voice says "אי סים".
 * Longest terms first, so "eSIM card" wins over "eSIM".
 */
export function applyPronunciations(text: string, list: Pronunciation[] = []): string {
  if (!list.length) return text;
  const clean = list.filter((p) => p.term.trim() && p.say.trim())
    .sort((a, b) => b.term.length - a.term.length);
  let out = text;
  for (const p of clean) {
    const escaped = p.term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), p.say.trim());
  }
  return out;
}

/** Brand terms worth checking before the first render. */
export const SUGGESTED_TERMS = ['eSIM', 'Tasimli', 'WhatsApp', 'Instagram', 'AI'];

/** One stretch of the script: what is shown (orig) and what is spoken, with its place in the spoken text. */
export interface SpokenSegment { orig: string; spoken: string; start: number; end: number; replaced: boolean }

/**
 * Same rewrite as applyPronunciations, but also returns a map from every piece of the
 * original script to its range in the spoken text — so caption timing can come from the
 * voice while caption TEXT stays exactly as written ("eSIM", not "אי סים").
 */
export function pronounceWithMap(text: string, list: Pronunciation[] = []): { spoken: string; segments: SpokenSegment[] } {
  const clean = list.filter((p) => p.term.trim() && p.say.trim()).sort((a, b) => b.term.length - a.term.length);
  const segments: SpokenSegment[] = [];
  let spoken = '';
  const push = (orig: string, say: string, replaced: boolean) => {
    if (!orig) return;
    segments.push({ orig, spoken: say, start: spoken.length, end: spoken.length + say.length, replaced });
    spoken += say;
  };
  if (!clean.length) { push(text, text, false); return { spoken, segments }; }
  const esc = (s: string) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(clean.map((p) => esc(p.term)).join('|'), 'gi');
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    push(text.slice(last, at), text.slice(last, at), false);
    const hit = clean.find((p) => p.term.trim().toLowerCase() === m[0].toLowerCase());
    push(m[0], hit ? hit.say.trim() : m[0], true);
    last = at + m[0].length;
  }
  push(text.slice(last), text.slice(last), false);
  return { spoken, segments };
}
