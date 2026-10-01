'use client';
import type { BrandProfile } from '@/types';
import { FRAME_H, FRAME_W, loadCaptionFont } from './captionImages';

/**
 * A "graphic" scene: a branded card (the brand's two colours, the scene's on-screen line,
 * the brand name and its call to action) drawn in the browser — no AI, no cost.
 * Usually the last scene of a reel. Returns a PNG file ready for the media library.
 */
const HEB = /[\u0590-\u05FF]/;

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(next).width > maxW) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Black or white, whichever reads better on this colour. */
function inkOn(hex: string) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return '#ffffff';
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#111111' : '#ffffff';
}

export async function drawGraphicCard(brand: BrandProfile, headline: string, logoUrl?: string): Promise<File> {
  await loadCaptionFont('Heebo');
  await document.fonts.ready;
  const [c1, c2] = brand.colors?.length === 2 ? brand.colors : ['#6B3BF5', '#D6336C'];
  const ink = inkOn(c1);
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_W; canvas.height = FRAME_H;
  const ctx = canvas.getContext('2d')!;

  const g = ctx.createLinearGradient(0, 0, FRAME_W, FRAME_H);
  g.addColorStop(0, c1); g.addColorStop(1, c2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);
  // soft light shapes, so the card does not look flat
  ctx.globalAlpha = 0.12; ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(FRAME_W * 0.85, FRAME_H * 0.15, 260, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(FRAME_W * 0.1, FRAME_H * 0.9, 320, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ink;
  const dir = (t: string) => { ctx.direction = HEB.test(t) ? 'rtl' : 'ltr'; };

  // logo (when the brand has one) above the headline
  let top = FRAME_H * 0.3;
  if (logoUrl) {
    try {
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = logoUrl;
      });
      const size = 150, ratio = img.width / img.height || 1;
      const w = ratio >= 1 ? size : size * ratio, h = ratio >= 1 ? size / ratio : size;
      ctx.drawImage(img, (FRAME_W - w) / 2, top - h - 40, w, h);
    } catch { /* no logo */ }
  }

  ctx.font = '900 76px "Heebo", Rubik, Arial, sans-serif';
  const head = wrap(ctx, headline || brand.cta || brand.name, FRAME_W - 120).slice(0, 4);
  head.forEach((l, k) => { dir(l); ctx.fillText(l, FRAME_W / 2, top + k * 92); });

  const cta = brand.cta?.trim();
  if (cta && cta !== headline) {
    ctx.font = '800 44px "Heebo", Rubik, Arial, sans-serif';
    const w = Math.min(FRAME_W - 120, ctx.measureText(cta).width + 90);
    const y = top + head.length * 92 + 90;
    ctx.fillStyle = ink;
    ctx.beginPath();
    (ctx as any).roundRect ? (ctx as any).roundRect((FRAME_W - w) / 2, y - 44, w, 88, 44) : ctx.rect((FRAME_W - w) / 2, y - 44, w, 88);
    ctx.fill();
    ctx.fillStyle = ink === '#ffffff' ? c1 : '#ffffff';
    dir(cta); ctx.fillText(cta, FRAME_W / 2, y + 2);
  }

  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.85;
  ctx.font = '700 40px "Heebo", Rubik, Arial, sans-serif';
  const foot = [brand.name, brand.city].filter(Boolean).join(' · ');
  if (foot) { dir(foot); ctx.fillText(foot, FRAME_W / 2, FRAME_H - 260); }
  ctx.globalAlpha = 1;

  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
  return new File([blob], `${brand.name || 'brand'} · כרטיס.png`, { type: 'image/png' });
}
