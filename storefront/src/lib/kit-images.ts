import bags from './kit-images/bags.json';
import beauty from './kit-images/beauty.json';
import fashion from './kit-images/fashion.json';
import furniture from './kit-images/furniture.json';
import general from './kit-images/general.json';
import retail from './kit-images/retail.json';
import services from './kit-images/services.json';

/**
 * The default pictures of the starter kits (2.62): shown where the business has no picture of its own yet — the hero, the
 * image-and-text section and a collection's tile — and gone the moment it adds one. They are not products and never enter
 * the catalog. A kit's pictures are files of this app (public/kit-images/<kit>/), its manifest is
 * src/lib/kit-images/<kit>.json (scripts/kit-images.mjs makes both from a delivered folder).
 * Gallery pictures stay in the owner's preview only: a gallery says "this is us" (before / after, Instagram), and a stock
 * picture there would claim something about the business.
 */
export interface KitImage {
  file: string; slot: 'hero' | 'imageText' | 'collection' | 'gallery'; width: number; height: number;
  focal: { x: number; y: number }; alt: string; variant?: 'wide' | 'vertical'; textSafe?: 'start' | 'end'; collection?: string; order: number;
}
export interface KitManifest { kit: string; version: number; images: KitImage[] }

export const KIT_MANIFESTS: Record<string, KitManifest> = Object.fromEntries(
  [bags, beauty, fashion, furniture, general, retail, services].map((m) => [m.kit, m as KitManifest]),
);

/** a picture ready for <img>: its address on this site, its size, its alt text and the class that sets its focal point */
export interface KitPicture { src: string; width: number; height: number; alt: string; className: string }
const FILE = /^[a-z0-9-]+\.webp$/;
const picture = (kit: string, i: KitImage | undefined): KitPicture | null =>
  i && FILE.test(i.file) ? { src: `/kit-images/${kit}/${i.file}`, width: i.width, height: i.height, alt: i.alt, className: `kimg-${i.file.slice(0, -5)}` } : null;
const first = (list: KitImage[]) => [...list].sort((a, b) => a.order - b.order)[0];

/** the kit's default picture for a place on the page — null when the kit has none (or the store has no kit) */
export function kitImage(kit: string | null, slot: 'hero' | 'imageText'): KitPicture | null {
  const m = kit ? KIT_MANIFESTS[kit] : undefined;
  if (!m) return null;
  return picture(m.kit, first(m.images.filter((i) => i.slot === slot && (slot !== 'hero' || i.variant === 'wide'))));
}
/**
 * The hero's pictures (2.63): the first wide one, its portrait one for phones, and the side that is free for text
 * ('start' / 'end', logical — the delivered JSON's "right" is start). The second wide one is for a slider or as a choice.
 */
export function kitHero(kit: string | null): { wide: KitPicture; mobile: KitPicture | null; textSafe: 'start' | 'end' | '' } | null {
  const m = kit ? KIT_MANIFESTS[kit] : undefined;
  if (!m) return null;
  const wideImg = first(m.images.filter((i) => i.slot === 'hero' && i.variant === 'wide'));
  const wide = picture(m.kit, wideImg);
  if (!wide) return null;
  return { wide, mobile: picture(m.kit, first(m.images.filter((i) => i.slot === 'hero' && i.variant === 'vertical'))), textSafe: wideImg?.textSafe ?? '' };
}
/** the kit's picture for a collection, by its address (slug) */
export function kitCollectionImage(kit: string | null, slug: string): KitPicture | null {
  const m = kit ? KIT_MANIFESTS[kit] : undefined;
  return m ? picture(m.kit, m.images.find((i) => i.slot === 'collection' && i.collection === slug)) : null;
}
/** the kit's gallery pictures, in order (the owner's preview only — see above) */
export function kitGallery(kit: string | null): KitPicture[] {
  const m = kit ? KIT_MANIFESTS[kit] : undefined;
  if (!m) return [];
  return m.images.filter((i) => i.slot === 'gallery').sort((a, b) => a.order - b.order).flatMap((i) => picture(m.kit, i) ?? []);
}

/** the focal point of every picture of the kit, as CSS (no style attributes — the CSP blocks them); numbers only */
export function kitImageCss(kit: string | null): string {
  const m = kit ? KIT_MANIFESTS[kit] : undefined;
  if (!m) return '';
  const pct = (n: number) => `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`;
  const files = m.images.filter((i) => FILE.test(i.file));
  // a portrait picture shown on a phone (<picture>, 2.63) keeps the <img>'s class: its own focal point under the same media query
  return files.map((i) => `.kimg-${i.file.slice(0, -5)}{object-position:${pct(i.focal.x)} ${pct(i.focal.y)}}`).join('')
    + `@media (max-width:699px){${files.filter((i) => i.variant === 'vertical').map((i) => `.kimg-m-${i.file.slice(0, -5)}{object-position:${pct(i.focal.x)} ${pct(i.focal.y)}}`).join('')}}`;
}
