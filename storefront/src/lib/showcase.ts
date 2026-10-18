/**
 * A catalog of models to show (the section "showcase", 2.101): models with their brand, material, handle, finish, shape and
 * minimum order — never products: no price, no stock, no cart, nothing in the catalog of the register or of finance. Each
 * one asks for a quote on WhatsApp. Pure functions (tests/unit/showcase.test.ts) with no import, so the page's part
 * (components/Showcase.tsx) carries nothing else to the browser; the rows become models on the server (showcase-items.ts).
 */
export interface ShowcasePicture { src: string; alt: string; className: string }
export interface ShowcaseItem {
  /** its place in the section's list — a key that stays while the filters change */
  n: number;
  name: string; brand: string; color: string; category: string; material: string; handle: string; finish: string; shape: string;
  minQty: number | null; text: string;
  /** the business's own picture, else the kit's (by its file), else none — a drawing in the brand's colour */
  picture: ShowcasePicture | null;
}
export type FacetKey = 'category' | 'handle' | 'material';
export const FACETS: { key: FacetKey; label: string }[] = [{ key: 'category', label: 'קטגוריה' }, { key: 'handle', label: 'ידית' }, { key: 'material', label: 'חומר' }];
export type Filter = Record<FacetKey, string>;
export const NO_FILTER: Filter = { category: '', handle: '', material: '' };

/** the values each filter offers: the models' own, once each, in the order they first appear */
export function facetValues(items: ShowcaseItem[]): Record<FacetKey, string[]> {
  const out: Record<FacetKey, string[]> = { category: [], handle: [], material: [] };
  for (const it of items) for (const { key } of FACETS) if (it[key] && !out[key].includes(it[key])) out[key].push(it[key]);
  return out;
}

/** the models that fit every chosen filter ('' = any) */
export const filterItems = (items: ShowcaseItem[], f: Filter) => items.filter((it) => FACETS.every(({ key }) => !f[key] || it[key] === f[key]));

/** "מינימום 1,000 יח׳" */
export const minQtyLabel = (n: number | null) => (n ? `מינימום ${n.toLocaleString('he-IL')} יח׳` : '');

/** the message a model's "quote" button opens WhatsApp with: which model, and where it was seen */
export function quoteMessage(it: Pick<ShowcaseItem, 'name' | 'brand'>, store: string): string {
  const model = it.brand ? `"${it.name}" (${it.brand})` : `"${it.name}"`;
  return `היי, אשמח לקבל הצעת מחיר על הדגם ${model} מהקטלוג באתר של ${store}.`;
}
