'use client';
import { supabase } from '@/lib/supabase/client';
import { mediaApi } from './data';
import { toMedia, type CatalogMedia } from './catalog';
import { BUCKET, MAX_SOURCE_BYTES, plannedSizes, type ImageType } from './images';

/**
 * One product picture from the device to the store (2.54): decoded in the browser (the phone's orientation applied),
 * made in 3 sizes at most (400 / 800 / 1600 — never enlarged), WebP where the browser can write it (else JPEG), each size
 * uploaded with its own signed link, then registered by the server — which checks the files really landed.
 */
type Result<T> = { ok: true; data: T } | { ok: false; error: string };

let webp: boolean | null = null;
/** can this browser write WebP? (old Safari writes PNG instead — then JPEG) */
function canWriteWebp(): boolean {
  if (webp !== null) return webp;
  try { const c = document.createElement('canvas'); c.width = c.height = 1; webp = c.toDataURL('image/webp').startsWith('data:image/webp'); }
  catch { webp = false; }
  return webp;
}

async function decode(file: File): Promise<{ source: CanvasImageSource; w: number; h: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const b = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
      return { source: b, w: b.width, h: b.height, close: () => b.close() };
    } catch { /* fall back to an <img> (older browsers, some HEIC photos) */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error('decode')); img.src = url; });
    return { source: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) { URL.revokeObjectURL(url); throw e; }
}

const toBlob = (c: HTMLCanvasElement, type: ImageType) =>
  new Promise<Blob | null>((ok) => c.toBlob(ok, type, type === 'image/webp' ? 0.82 : 0.85));

/** the sizes, biggest first, each drawn from the one before (a smoother result than one big jump) */
async function makeSizes(source: CanvasImageSource, w: number, h: number, type: ImageType): Promise<{ size: number; blob: Blob; w: number; h: number }[]> {
  const plan = plannedSizes(w, h).reverse();
  const out: { size: number; blob: Blob; w: number; h: number }[] = [];
  let from: CanvasImageSource = source;
  for (const p of plan) {
    const c = document.createElement('canvas');
    c.width = p.w; c.height = p.h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, p.w, p.h); } // a transparent PNG gets a white background, not black
    ctx.drawImage(from, 0, 0, p.w, p.h);
    const blob = await toBlob(c, type);
    if (!blob || blob.type !== type) throw new Error('encode');
    out.push({ size: p.size, blob, w: p.w, h: p.h });
    from = c;
  }
  return out.reverse();
}

/** the sizes of a picture, uploaded with the server's signed links: `sign` names the action, `register` turns the upload id
 *  into the result */
async function sendSizes<T>(file: File, sign: Record<string, unknown>, register: (upload: string, sizes: { size: number; w: number; h: number }[], type: ImageType) => Promise<Result<T>>): Promise<Result<T>> {
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name)) return { ok: false, error: `"${file.name}" אינו תמונה.` };
  if (file.size > MAX_SOURCE_BYTES) return { ok: false, error: `"${file.name}" גדול מדי (עד 25MB).` };
  let pic: Awaited<ReturnType<typeof decode>>;
  try { pic = await decode(file); }
  catch { return { ok: false, error: `לא הצלחנו לפתוח את "${file.name}". נסו תמונה אחרת (JPG / PNG / WEBP).` }; }
  try {
    let type: ImageType = canWriteWebp() ? 'image/webp' : 'image/jpeg';
    let sizes: Awaited<ReturnType<typeof makeSizes>>;
    try { sizes = await makeSizes(pic.source, pic.w, pic.h, type); }
    catch { type = 'image/jpeg'; sizes = await makeSizes(pic.source, pic.w, pic.h, type); }
    const signed = await mediaApi<{ uploadId: string; uploads: { size: number; path: string; token: string }[] }>({ ...sign, sizes: sizes.map((s) => s.size), type });
    if (!signed.ok) return signed;
    const store = supabase().storage.from(BUCKET);
    for (const u of signed.data.uploads) {
      const s = sizes.find((x) => x.size === u.size);
      if (!s) return { ok: false, error: 'ההעלאה לא הושלמה — נסו שוב.' };
      const { error } = await store.uploadToSignedUrl(u.path, u.token, s.blob, { contentType: type, cacheControl: '31536000' });
      if (error) return { ok: false, error: 'ההעלאה נקטעה — בדקו את החיבור ונסו שוב.' };
    }
    return await register(signed.data.uploadId, sizes, type);
  } catch {
    return { ok: false, error: `לא הצלחנו להכין את "${file.name}" להעלאה. נסו תמונה אחרת.` };
  } finally { pic.close(); }
}

/** a picture of the store itself — its logo, a picture of the home page (2.55): its address, to save in that setting */
export function uploadStorePicture(file: File): Promise<Result<{ url: string; sizes: Record<string, string> }>> {
  return sendSizes(file, { action: 'store-sign' }, (uploadId, sizes, type) =>
    mediaApi<{ url: string; sizes: Record<string, string> }>({ action: 'store-register', uploadId, sizes: sizes.map((s) => s.size), type }));
}

export async function uploadPicture(file: File, itemId: string, opts: { alt?: string; variantId?: string | null } = {}): Promise<Result<CatalogMedia>> {
  return sendSizes(file, { action: 'sign', itemId }, async (uploadId, sizes, type) => {
    const big = sizes[sizes.length - 1];
    const reg = await mediaApi<{ media: any }>({ action: 'register', itemId, uploadId, sizes: sizes.map((s) => s.size), type,
      width: big.w, height: big.h, alt: opts.alt ?? '', variantId: opts.variantId ?? null });
    return reg.ok ? { ok: true, data: toMedia(reg.data.media) } : reg;
  });
}
