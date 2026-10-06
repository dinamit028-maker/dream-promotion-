/**
 * Product pictures (2.54): the browser makes the sizes (no image library on the server — and a phone photo of 8 MB never
 * crosses the server's 4.5 MB request limit), uploads each size straight to the public bucket store-media with a signed
 * link from the server, and the server registers the picture (catalog_media) after checking the files are there.
 * Pure rules here — sizes, folders, the best size for a place on screen — shared by the browser and the server.
 */
export const BUCKET = 'store-media';
/** the sizes made of every picture (the longest side, in pixels): a tile, a phone, a big screen / zoom */
export const IMAGE_SIZES = [400, 800, 1600] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];
export const IMAGE_TYPES = { 'image/webp': 'webp', 'image/jpeg': 'jpg' } as const;
export type ImageType = keyof typeof IMAGE_TYPES;
/** a photo larger than this is refused before it is decoded (a phone's photo is 2–12 MB) */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/** w × h scaled so its longest side is at most max — never enlarged */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  const s = Math.min(1, max / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}
/** the sizes to make of a w × h picture: 400 always; a bigger one only when the picture is really bigger than the last */
export function plannedSizes(w: number, h: number): { size: ImageSize; w: number; h: number }[] {
  const out: { size: ImageSize; w: number; h: number }[] = [];
  let last = 0;
  for (const size of IMAGE_SIZES) {
    const d = fitWithin(w, h, size);
    const longest = Math.max(d.w, d.h);
    if (out.length && longest <= last) break;
    out.push({ size, ...d });
    last = longest;
  }
  return out;
}
/** the url of the smallest size that is at least `want` pixels (else the biggest there is) */
export function pickSize(m: { url: string; sizes: Record<string, string> }, want: number): string {
  const have = Object.keys(m.sizes).map(Number).filter((n) => Number.isFinite(n) && m.sizes[String(n)]).sort((a, b) => a - b);
  if (!have.length) return m.url;
  const fit = have.find((n) => n >= want) ?? have[have.length - 1];
  return m.sizes[String(fit)];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);
/** the folder of one picture: <business>/<item>/<upload> — its sizes are 400.webp, 800.webp … inside */
export const mediaFolder = (business: string, item: string, upload: string) => `${business}/${item}/${upload}`;
/** a picture of the store itself (its logo, a picture of the home page — 2.55): <business>/store/<upload> */
export const storeFolder = (business: string, upload: string) => `${business}/store/${upload}`;
export const sizeFile = (size: number, type: ImageType) => `${size}.${IMAGE_TYPES[type]}`;
/** a folder of this business only (the server checks every path it removes) */
export const inBusiness = (path: string, business: string) => isUuid(business) && path.startsWith(`${business}/`) && !path.includes('..');

/** the sizes a request names: known sizes, 400 among them, each once, in order — or null */
export function cleanSizes(v: unknown): ImageSize[] | null {
  if (!Array.isArray(v) || !v.length || v.length > IMAGE_SIZES.length) return null;
  const list = [...new Set(v.map(Number))].sort((a, b) => a - b);
  if (list.length !== v.length || !list.every((n) => (IMAGE_SIZES as readonly number[]).includes(n)) || list[0] !== 400) return null;
  return list as ImageSize[];
}
export const cleanType = (v: unknown): ImageType | null => (v === 'image/webp' || v === 'image/jpeg' ? v : null);
