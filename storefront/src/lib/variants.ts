/**
 * Variants (Dream Builder phase 1, 2.63): the shapes a kit — or the business — picks for each part of the site. Every value
 * is from a fixed list; the first one of each list is the look of 2.61, so a site that never picked anything looks exactly
 * as it did. A value not on the list falls back (never an error, never an arbitrary class).
 * The dashboard has the same lists with Hebrew labels (src/features/store/variants.ts); tests/store-variants.test.ts fails
 * if the two differ. Only the variants the renderer draws are listed — a kit that names another one gets the default.
 */
export const DESIGN = {
  spacing: ['normal', 'compact', 'airy'],
  headingScale: ['normal', 'large', 'display'],
  buttonStyle: ['solid', 'outline', 'soft', 'underline'],
  container: ['normal', 'narrow', 'wide'],
  cardStyle: ['border', 'flat', 'soft', 'shadow'],
} as const;
export const CHROME = {
  header: ['classic', 'centered-logo', 'transparent-overlay', 'minimal', 'commerce-wide', 'search-heavy', 'compact'],
  footer: ['classic', 'minimal', 'centered', 'multi-column', 'dark'],
} as const;
export const COMMERCE = {
  productCard: ['classic', 'editorial', 'minimal', 'horizontal', 'compact'],
  collectionCard: ['grid', 'editorial', 'circles', 'carousel'],
  productPage: ['classic', 'gallery-left', 'gallery-right', 'wide', 'compact'],
} as const;
/** a section's layout, by its type; '' for a type with one look */
export const SECTION_VARIANTS = {
  hero: ['split', 'full-image', 'editorial', 'centered', 'slider'],
  collections: ['grid', 'editorial', 'circles', 'carousel'],
  products: ['grid', 'carousel'],
  imageText: ['split', 'full-bleed', 'overlap'],
  steps: ['cards', 'horizontal'],
  faq: ['accordion'],
  contact: ['dark', 'centered'],
  text: ['plain'],
  gallery: ['grid', 'masonry', 'editorial'],
  newsletter: ['minimal'],
} as const;

export type Design = { [K in keyof typeof DESIGN]: (typeof DESIGN)[K][number] };
export type Chrome = { [K in keyof typeof CHROME]: (typeof CHROME)[K][number] };
export type Commerce = { [K in keyof typeof COMMERCE]: (typeof COMMERCE)[K][number] };

/** a value from the list, else undefined */
export function pick<T extends readonly string[]>(list: T, v: unknown): T[number] | undefined {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T[number]) : undefined;
}
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Each value: the business's own (saved), else the kit's, else the default (the look of 2.61). The business's choice
 * always wins; "חזרה לברירת המחדל" removes it from the saved settings, and the kit's shows again.
 */
export function layered<L extends Record<string, readonly string[]>>(lists: L, saved: unknown, kit: unknown): { [K in keyof L]: L[K][number] } {
  const s = obj(saved), k = obj(kit);
  return Object.fromEntries(Object.entries(lists).map(([key, list]) => [key, pick(list, s[key]) ?? pick(list, k[key]) ?? list[0]])) as { [K in keyof L]: L[K][number] };
}
export function sectionVariant(type: string, saved: unknown, kit: unknown): string {
  const list = (SECTION_VARIANTS as Record<string, readonly string[]>)[type];
  if (!list) return '';
  return pick(list, saved) ?? pick(list, kit) ?? list[0];
}

/** the classes the <body> carries: one per choice (every value from the lists above, so safe as a class name) */
export function bodyClasses(d: Design, c: Chrome, m: Commerce): string {
  return [
    `v-sp-${d.spacing}`, `v-hs-${d.headingScale}`, `v-btn-${d.buttonStyle}`, `v-ct-${d.container}`, `v-card-${d.cardStyle}`,
    `v-h-${c.header}`, `v-f-${c.footer}`, `v-pc-${m.productCard}`, `v-cc-${m.collectionCard}`, `v-pp-${m.productPage}`,
  ].join(' ');
}
