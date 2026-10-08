/**
 * Variants (Dream Builder phase 1, 2.63) — the editor's side of storefront/src/lib/variants.ts: the same lists, in the same
 * order (the first of each is the look of 2.61), with Hebrew labels. tests/store-variants.test.ts fails if they differ.
 *
 * How a value is chosen: the business's own (saved in the draft), else the kit's (kits/<kit>.json), else the first. The
 * business's choice always wins; "חזרה לברירת המחדל של הערכה" deletes it from the draft, and the kit's shows again.
 */
type Opt = { id: string; label: string };
export const DESIGN_OPTIONS: Record<'spacing' | 'headingScale' | 'buttonStyle' | 'container' | 'cardStyle', { label: string; options: Opt[] }> = {
  spacing: { label: 'ריווח', options: [{ id: 'normal', label: 'רגיל' }, { id: 'compact', label: 'צפוף' }, { id: 'airy', label: 'מרווח' }] },
  headingScale: { label: 'גודל הכותרות', options: [{ id: 'normal', label: 'רגיל' }, { id: 'large', label: 'גדול' }, { id: 'display', label: 'גדול מאוד' }] },
  buttonStyle: { label: 'צורת הכפתור', options: [{ id: 'solid', label: 'מלאים' }, { id: 'outline', label: 'מסגרת' }, { id: 'soft', label: 'רכים' }, { id: 'underline', label: 'קו תחתון' }] },
  container: { label: 'רוחב העמוד', options: [{ id: 'normal', label: 'רגיל' }, { id: 'narrow', label: 'צר' }, { id: 'wide', label: 'רחב' }] },
  cardStyle: { label: 'מסגרת לכרטיסים', options: [{ id: 'border', label: 'קו דק' }, { id: 'flat', label: 'בלי מסגרת' }, { id: 'soft', label: 'רקע רך' }, { id: 'shadow', label: 'צל' }] },
};
export const CHROME_OPTIONS: Record<'header' | 'footer', { label: string; options: Opt[] }> = {
  header: { label: 'ראש האתר', options: [{ id: 'classic', label: 'קלאסי' }, { id: 'centered-logo', label: 'לוגו באמצע' }, { id: 'transparent-overlay', label: 'שקוף מעל התמונה' }] },
  footer: { label: 'תחתית האתר', options: [{ id: 'classic', label: 'עמודות' }, { id: 'minimal', label: 'שורה אחת' }, { id: 'centered', label: 'באמצע' }] },
};
export const COMMERCE_OPTIONS: Record<'productCard' | 'collectionCard' | 'productPage', { label: string; options: Opt[] }> = {
  productCard: { label: 'כרטיס מוצר', options: [{ id: 'classic', label: 'קלאסי' }, { id: 'editorial', label: 'מגזיני' }, { id: 'minimal', label: 'מינימלי' }] },
  collectionCard: { label: 'קטגוריות', options: [{ id: 'grid', label: 'ריבועים' }, { id: 'editorial', label: 'תמונות גדולות' }, { id: 'circles', label: 'עיגולים' }] },
  productPage: { label: 'עמוד מוצר', options: [{ id: 'classic', label: 'קלאסי' }, { id: 'gallery-left', label: 'תמונות משמאל' }, { id: 'gallery-right', label: 'תמונות מימין' }] },
};
export const SECTION_VARIANT_OPTIONS: Record<string, Opt[]> = {
  hero: [{ id: 'split', label: 'טקסט ותמונה זה לצד זה' }, { id: 'full-image', label: 'תמונה על כל הרוחב' }, { id: 'editorial', label: 'כותרת גדולה, תמונה רחבה מתחת' }],
  collections: [{ id: 'grid', label: 'ריבועים' }, { id: 'editorial', label: 'תמונות גדולות' }, { id: 'circles', label: 'עיגולים' }],
  products: [{ id: 'grid', label: 'רשת' }],
  imageText: [{ id: 'split', label: 'חצי-חצי' }, { id: 'full-bleed', label: 'תמונה עד הקצה' }, { id: 'overlap', label: 'טקסט בכרטיס על התמונה' }],
  steps: [{ id: 'cards', label: 'כרטיסים' }],
  faq: [{ id: 'accordion', label: 'נפתח בלחיצה' }],
  contact: [{ id: 'dark', label: 'רקע כהה' }, { id: 'centered', label: 'רקע בהיר' }],
  text: [{ id: 'plain', label: 'רגיל' }],
  gallery: [{ id: 'grid', label: 'רשת' }, { id: 'masonry', label: 'גבהים שונים' }, { id: 'editorial', label: 'תמונה גדולה ראשונה' }],
  newsletter: [{ id: 'minimal', label: 'רגיל' }],
};

export type DesignKey = keyof typeof DESIGN_OPTIONS;
export type ChromeKey = keyof typeof CHROME_OPTIONS;
export type CommerceKey = keyof typeof COMMERCE_OPTIONS;
/** the business's own choices — only what it picked; anything missing comes from the kit */
export interface Overrides {
  design: Partial<Record<DesignKey, string>>;
  chrome: Partial<Record<ChromeKey, string>>;
  commerce: Partial<Record<CommerceKey, string>>;
}
/** a kit's defaults (kits/<kit>.json: theme.design, theme.chrome, theme.commerceDesign and each section's "variant") */
export interface KitVariants extends Overrides { sections: Record<string, string> }
export const NO_VARIANTS: KitVariants = { design: {}, chrome: {}, commerce: {}, sections: {} };

const has = (opts: Opt[], v: unknown): v is string => typeof v === 'string' && opts.some((o) => o.id === v);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** only known keys with known values (anything else is dropped, like the storefront does) */
export function cleanGroup<K extends string>(lists: Record<K, { options: Opt[] }>, raw: unknown): Partial<Record<K, string>> {
  const r = obj(raw);
  const out: Partial<Record<K, string>> = {};
  for (const k of Object.keys(lists) as K[]) if (has(lists[k].options, r[k])) out[k] = r[k] as string;
  return out;
}
export const sectionVariantOk = (type: string, v: unknown): v is string => has(SECTION_VARIANT_OPTIONS[type] ?? [], v);

/** what the site shows for one choice: the business's, else the kit's, else the first (the look of 2.61) */
export function effective(opts: Opt[], own: string | undefined, kit: string | undefined): string {
  return has(opts, own) ? own : has(opts, kit) ? kit : opts[0].id;
}
