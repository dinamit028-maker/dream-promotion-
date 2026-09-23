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
