'use client';
import type { CaptionCue, CaptionStyle, CaptionWord } from '@/types';

/**
 * Captions are drawn here, in the browser — it shapes Hebrew and mixed Hebrew/English text
 * perfectly in any web font. Every caption state becomes one full-frame transparent image
 * (720×1280) with the text already in place; the server only lays those images over the video.
 * The same drawing code runs the live preview in the caption editor, so what you see is what burns.
 */
export const FRAME_W = 720;
export const FRAME_H = 1280;

// ------------------------------------------------------------------ fonts --

export const FONTS: { id: string; label: string; weight: number; google: string }[] = [
  { id: 'Rubik', label: 'Rubik', weight: 800, google: 'Rubik:wght@400;700;800;900' },
  { id: 'Heebo', label: 'Heebo', weight: 900, google: 'Heebo:wght@400;700;800;900' },
  { id: 'Assistant', label: 'Assistant', weight: 800, google: 'Assistant:wght@400;600;700;800' },
  { id: 'Secular One', label: 'Secular One', weight: 400, google: 'Secular+One' },
  { id: 'Karantina', label: 'Karantina', weight: 700, google: 'Karantina:wght@400;700' },
  { id: 'Suez One', label: 'Suez One', weight: 400, google: 'Suez+One' },
  { id: 'Varela Round', label: 'Varela Round', weight: 400, google: 'Varela+Round' },
  { id: 'Frank Ruhl Libre', label: 'Frank Ruhl', weight: 900, google: 'Frank+Ruhl+Libre:wght@400;700;900' },
  { id: 'Amatic SC', label: 'Amatic', weight: 700, google: 'Amatic+SC:wght@400;700' },
  { id: 'Bellefair', label: 'Bellefair', weight: 400, google: 'Bellefair' },
];
const fontOf = (id: string) => FONTS.find((f) => f.id === id) ?? FONTS[0];

let fontsLink: Promise<void> | null = null;
/** Loads the caption fonts once (Google Fonts, Hebrew subsets) and waits for the one in use. */
export async function loadCaptionFont(id: string): Promise<void> {
  if (typeof document === 'undefined') return;
  if (!fontsLink) {
    fontsLink = new Promise<void>((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?${FONTS.map((f) => `family=${f.google}`).join('&')}&display=swap`;
      link.onload = () => resolve();
      link.onerror = () => resolve(); // offline: the canvas falls back to the app's own font
      document.head.appendChild(link);
    });
  }
  await fontsLink;
  const f = fontOf(id);
  try { await document.fonts.load(`${f.weight} 48px "${f.id}"`, 'אבגד abc 123'); } catch { /* fallback font */ }
}

// ------------------------------------------------------------------ styles --

export const PRESETS: { id: CaptionStyle['preset']; label: string; style: Omit<CaptionStyle, 'y'> }[] = [
  { id: 'classic', label: 'קלאסי', style: { preset: 'classic', font: 'Rubik', size: 58, color: '#ffffff', highlightColor: '#FFD400', strokeColor: '#141028', strokeWidth: 6, shadow: true, background: 'none', backgroundColor: 'rgba(0,0,0,0.7)', highlight: 'none', maxWords: 5 } },
  { id: 'pop', label: 'Bold Pop', style: { preset: 'pop', font: 'Heebo', size: 66, color: '#ffffff', highlightColor: '#FFE14D', strokeColor: '#000000', strokeWidth: 8, shadow: true, background: 'none', backgroundColor: 'rgba(0,0,0,0.7)', highlight: 'word', maxWords: 3 } },
  { id: 'karaoke', label: 'קריוקי', style: { preset: 'karaoke', font: 'Assistant', size: 60, color: '#ffffff', highlightColor: '#22D3EE', strokeColor: '#000000', strokeWidth: 6, shadow: true, background: 'none', backgroundColor: 'rgba(0,0,0,0.7)', highlight: 'karaoke', maxWords: 5 } },
  { id: 'box', label: 'קופסה', style: { preset: 'box', font: 'Heebo', size: 52, color: '#ffffff', highlightColor: '#FFD400', strokeColor: '#000000', strokeWidth: 0, shadow: false, background: 'box', backgroundColor: 'rgba(0,0,0,0.72)', highlight: 'none', maxWords: 5 } },
  { id: 'neon', label: 'ניאון', style: { preset: 'neon', font: 'Secular One', size: 62, color: '#ffffff', highlightColor: '#FF3EA5', strokeColor: '#000000', strokeWidth: 0, shadow: false, background: 'none', backgroundColor: 'rgba(0,0,0,0.7)', highlight: 'word', maxWords: 4 } },
  { id: 'minimal', label: 'מינימלי', style: { preset: 'minimal', font: 'Assistant', size: 46, color: '#ffffff', highlightColor: '#ffffff', strokeColor: '#000000', strokeWidth: 0, shadow: true, background: 'none', backgroundColor: 'rgba(0,0,0,0.7)', highlight: 'none', maxWords: 6 } },
];

/** The style of a reel: the saved one, or one made from the older bottom/middle + size settings. */
export function styleOf(c: { position: 'bottom' | 'middle'; size: 'md' | 'lg'; style?: CaptionStyle }): CaptionStyle {
  if (c.style) return c.style;
  return { ...PRESETS[0].style, size: c.size === 'md' ? 48 : 60, y: c.position === 'middle' ? 0.5 : 0.78 };
}
export function presetStyle(id: CaptionStyle['preset'], y = 0.78): CaptionStyle {
  const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0];
  return { ...p.style, y };
}

// ------------------------------------------------------------------ timing --

/** Words of a line with timing: the ones stored, or the line's time shared by word length. */
export function wordsOf(cue: CaptionCue): CaptionWord[] {
  const tokens = cue.text.trim().split(/\s+/).filter(Boolean);
  if (cue.words?.length === tokens.length) return cue.words.map((w, i) => ({ ...w, text: tokens[i] }));
  const hl = new Set((cue.words ?? []).filter((w) => w.hl).map((w) => w.text));
  const weight = tokens.map((t) => t.length + 2);
  const sum = weight.reduce((a, b) => a + b, 0) || 1;
  const span = Math.max(0.1, cue.end - cue.start);
  let t = cue.start;
  return tokens.map((text, i) => {
    const d = (span * weight[i]) / sum;
    const w: CaptionWord = { text, start: t, end: t + d };
    if (hl.has(text)) w.hl = true;
    t += d;
    return w;
  });
}

/** Transcribed words → caption lines: a few words each, broken at pauses and punctuation. */
export function linesFromWords(words: CaptionWord[], maxWords = 5, maxSec = 3): CaptionCue[] {
  const out: CaptionCue[] = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' '), words: cur });
    cur = [];
  };
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (cur.length && prev && w.start - prev.end > 0.6) flush(); // a real pause starts a new line
    cur.push(w);
    const long = w.end - cur[0].start >= maxSec;
    if (/[.,!?;:]$/.test(w.text) || cur.length >= maxWords || long) flush();
  });
  flush();
  return out;
}

/** Same words, new line length (when "words per line" changes). */
export function regroup(cues: CaptionCue[], maxWords: number): CaptionCue[] {
  return linesFromWords(cues.flatMap((c) => wordsOf(c)), maxWords);
}

/** The older caption source: narration cues, or the text shared evenly over the narration. */
export function sceneCues(cues: { start: number; end: number; text: string }[] | undefined, text: string | undefined, durationSec: number | undefined): CaptionCue[] {
  if (cues?.length) return cues.map((c) => ({ start: c.start, end: c.end, text: c.text }));
  if (!text?.trim() || !durationSec) return [];
  const words = text.trim().split(/\s+/);
  const groups: string[] = [];
  for (let k = 0; k < words.length; k += 5) groups.push(words.slice(k, k + 5).join(' '));
  const per = durationSec / groups.length;
  return groups.map((t, k) => ({ start: k * per, end: (k + 1) * per, text: t }));
}

// ------------------------------------------------------------------ drawing --

const HEB = /[\u0590-\u05FF]/;
const LATIN = /[A-Za-z0-9]/;
const fontCss = (s: CaptionStyle, scale = 1) => {
  const f = fontOf(s.font);
  return `${f.weight} ${Math.round(s.size * scale)}px "${f.id}", Rubik, Arial, sans-serif`;
};

type Token = { text: string; i: number; hl: boolean; emoji?: boolean };
type Placed = Token & { x: number; w: number; line: number };

/** Lays the words out right-to-left (English runs stay left-to-right), wrapped to the frame width. */
function layout(ctx: CanvasRenderingContext2D, tokens: Token[], s: CaptionStyle) {
  ctx.font = fontCss(s);
  const space = ctx.measureText(' ').width * 1.15;
  const maxW = FRAME_W - 90;
  const rtl = tokens.some((t) => HEB.test(t.text));
  const lines: Token[][] = [[]];
  let lw = 0;
  for (const t of tokens) {
    const w = ctx.measureText(t.text).width;
    if (lines[lines.length - 1].length && lw + space + w > maxW) { lines.push([]); lw = 0; }
    lw += (lines[lines.length - 1].length ? space : 0) + w;
    lines[lines.length - 1].push(t);
  }
  const placed: Placed[] = [];
  const widths: number[] = [];
  lines.forEach((line, li) => {
    // visual order: a run of English words keeps its own left-to-right order inside a Hebrew line
    const runs: { ltr: boolean; items: Token[] }[] = [];
    for (const t of line) {
      const ltr = rtl && !HEB.test(t.text) && LATIN.test(t.text);
      const last = runs[runs.length - 1];
      if (ltr && last?.ltr) last.items.push(t);
      else runs.push({ ltr, items: [t] });
    }
    const visual = rtl ? runs.reverse().flatMap((r) => r.items) : runs.flatMap((r) => r.items);
    const total = visual.reduce((a, t, k) => a + ctx.measureText(t.text).width + (k ? space : 0), 0);
    widths.push(total);
    let x = (FRAME_W - total) / 2;
    visual.forEach((t) => {
      const w = ctx.measureText(t.text).width;
      placed.push({ ...t, x, w, line: li });
      x += w + space;
    });
  });
  return { placed, lineCount: lines.length, widths };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draws one caption state onto a 720×1280 canvas (cleared first).
 * active: index of the word being spoken (-1: none yet) — used by the word and karaoke styles.
 */
export function drawCaption(canvas: HTMLCanvasElement, cue: CaptionCue | null, active: number, s: CaptionStyle) {
  if (canvas.width !== FRAME_W) canvas.width = FRAME_W;
  if (canvas.height !== FRAME_H) canvas.height = FRAME_H;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, FRAME_W, FRAME_H);
  if (!cue || !cue.text.trim()) return;

  const words = wordsOf(cue);
  const tokens: Token[] = words.map((w, i) => ({ text: w.text, i, hl: Boolean(w.hl) }));
  if (cue.emoji) tokens.push({ text: cue.emoji, i: -2, hl: false, emoji: true });
  const { placed, lineCount, widths } = layout(ctx, tokens, s);
  const lineH = Math.round(s.size * 1.3);
  const blockH = lineCount * lineH;
  const top = Math.min(FRAME_H - blockH - 60, Math.max(60, Math.round(FRAME_H * s.y - blockH / 2)));

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';

  if (s.background === 'box') {
    ctx.fillStyle = s.backgroundColor;
    widths.forEach((w, li) => {
      const padX = s.size * 0.35, padY = s.size * 0.1;
      roundRect(ctx, (FRAME_W - w) / 2 - padX, top + li * lineH + padY, w + padX * 2, lineH - padY * 2, s.size * 0.22);
      ctx.fill();
    });
  }

  for (const t of placed) {
    const cy = top + t.line * lineH + lineH / 2;
    const isActive = t.i === active;
    const spoken = s.highlight === 'karaoke' && t.i >= 0 && t.i <= active;
    const lit = (s.highlight === 'word' && isActive) || spoken || (s.highlight !== 'karaoke' && t.hl);
    const pop = s.preset === 'pop' && isActive;
    const scale = pop ? 1.12 : 1;
    ctx.save();
    ctx.font = fontCss(s, scale);
    ctx.direction = HEB.test(t.text) ? 'rtl' : 'ltr';
    const w = ctx.measureText(t.text).width;
    const x = t.x + (t.w - w) / 2;

    // "Bold Pop": a coloured pill behind the spoken word, CapCut style
    if (pop) {
      ctx.fillStyle = s.highlightColor;
      roundRect(ctx, x - s.size * 0.16, cy - s.size * 0.64, w + s.size * 0.32, s.size * 1.28, s.size * 0.22);
      ctx.fill();
    }
    if (s.shadow && !pop) { ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3; }
    if (s.strokeWidth > 0 && !t.emoji && !pop) {
      ctx.lineWidth = s.strokeWidth * 2;
      ctx.strokeStyle = s.strokeColor;
      ctx.strokeText(t.text, x, cy);
      ctx.shadowColor = 'transparent';
    }
    if (s.preset === 'neon' && !t.emoji) {
      ctx.shadowColor = lit ? s.highlightColor : s.color;
      ctx.shadowBlur = 22; ctx.shadowOffsetY = 0;
    }
    ctx.fillStyle = pop ? '#111111' : lit ? s.highlightColor : s.color;
    ctx.fillText(t.text, x, cy);
    if (s.preset === 'neon' && !t.emoji) ctx.fillText(t.text, x, cy); // a second pass makes the glow read
    ctx.restore();
  }
}

/** Which word is spoken at time t (scene-local), -1 before the first. */
export function activeWord(cue: CaptionCue, t: number): number {
  const w = wordsOf(cue);
  let k = -1;
  for (let i = 0; i < w.length; i++) if (t >= w[i].start - 0.02) k = i;
  return k;
}

/**
 * Every image one line needs, timed on its scene:
 * a single image for a still line, one per word for the word and karaoke styles.
 */
export function cueFrames(cue: CaptionCue, s: CaptionStyle, canvas: HTMLCanvasElement) {
  const out: { start: number; end: number; text: string; png: string }[] = [];
  const shot = (start: number, end: number, active: number) => {
    if (end - start < 0.03) return;
    drawCaption(canvas, cue, active, s);
    out.push({ start, end, text: cue.text, png: canvas.toDataURL('image/png') });
  };
  if (s.highlight === 'none') { shot(cue.start, cue.end, -1); return out; }
  const w = wordsOf(cue);
  if (w[0] && w[0].start > cue.start + 0.03) shot(cue.start, w[0].start, -1);
  w.forEach((word, i) => shot(Math.max(cue.start, word.start), i + 1 < w.length ? w[i + 1].start : cue.end, i));
  return out;
}

/** Length of an audio file, read by the browser (0 if it cannot be read in time). */
export function audioDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const a = new Audio();
    const t = setTimeout(() => resolve(0), 8000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => { clearTimeout(t); resolve(Number.isFinite(a.duration) ? a.duration : 0); };
    a.onerror = () => { clearTimeout(t); resolve(0); };
    a.src = url;
  });
}
