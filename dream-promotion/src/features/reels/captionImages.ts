'use client';

/**
 * Captions are drawn here, in the browser, onto transparent images — the browser shapes
 * Hebrew and mixed Hebrew/English text perfectly with the app's own font. The server
 * then only lays these images over the video at the right moments.
 */
const W = 720;

function displayFont(): string {
  const v = getComputedStyle(document.body).getPropertyValue('--font-display').trim();
  return v ? `${v}, Arial, sans-serif` : 'Arial, sans-serif';
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(next).width > maxWidth) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

/** One caption as a PNG data URL, 720px wide, height fitted to its lines. */
export function captionPng(text: string, size: 'md' | 'lg'): string {
  const px = size === 'lg' ? 60 : 48;
  const lineH = Math.round(px * 1.3);
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `700 ${px}px ${displayFont()}`;
  const lines = wrap(measure, text, W - 110);
  const pad = 24;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = lines.length * lineH + pad * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `700 ${px}px ${displayFont()}`;
  ctx.direction = /[\u0590-\u05FF]/.test(text) ? 'rtl' : 'ltr';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  lines.forEach((line, i) => {
    const y = pad + lineH * i + lineH / 2;
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
    ctx.lineWidth = Math.round(px / 5); ctx.strokeStyle = '#141028';
    ctx.strokeText(line, W / 2, y);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line, W / 2, y);
  });
  return canvas.toDataURL('image/png');
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

type Cue = { start: number; end: number; text: string };

/**
 * Timed captions for one scene: word timing from the voice when there is one;
 * otherwise the original text spread evenly over the narration.
 */
export function sceneCues(cues: Cue[] | undefined, text: string | undefined, durationSec: number | undefined): Cue[] {
  if (cues?.length) return cues;
  if (!text?.trim() || !durationSec) return [];
  const words = text.trim().split(/\s+/);
  const groups: string[] = [];
  for (let k = 0; k < words.length; k += 5) groups.push(words.slice(k, k + 5).join(' '));
  const per = durationSec / groups.length;
  return groups.map((t, k) => ({ start: k * per, end: (k + 1) * per, text: t }));
}
