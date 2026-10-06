/**
 * Dream Commerce stage 1 (2.54): ONE catalog for the register, finance and the online store — the same rows of
 * catalog_items, catalog_variants, catalog_options, catalog_media and catalog_field_defs (migration 20261005003300).
 * Pure functions only (no React, no network): prices, names, codes, slugs, variants and the checks before publishing
 * are the same in every screen, and tested directly (tests/catalog.test.ts).
 *
 * Rules (the database keeps the same ones):
 *  - an item without variants behaves exactly as before 2.54;
 *  - an item with variants keeps the SUM of its variants in its own stock_qty; a line without a variant of such an item
 *    moves only that sum ("לא משויך לווריאנט") — never a variant picked at random;
 *  - a variant's price null = the item's price; a variant's online price null = the item's online price, then the price;
 *  - a SKU / barcode is one product of the business (unique across items and variants).
 */

export type ItemKind = 'service' | 'product' | 'package' | 'other';
export const KIND_HE: Record<ItemKind, string> = { service: 'טיפול/שירות', product: 'מוצר', package: 'חבילה', other: 'אחר' };

export interface CatalogItem {
  id: string; name: string; price: number; kind: ItemKind; active: boolean; favorite: boolean; favOrder: number; sort: number;
  /** the first picture, in the 400 size (kept by the database) — the register's tile */
  imageUrl: string;
  trackStock: boolean; stockQty: number; lowStock: number;
  slug: string | null; description: string; seoTitle: string; seoDescription: string;
  publishOnline: boolean; onlinePrice: number | null; compareAtPrice: number | null;
  sku: string; barcode: string; hasVariants: boolean; tags: string[]; customFields: Record<string, string>;
  manufacturer: string; countryOfOrigin: string; publishedAt: string | null; updatedAt: string | null;
}
export interface CatalogOption { id: string; itemId: string; position: number; name: string; choices: string[] }
export interface CatalogVariant {
  id: string; itemId: string; option1: string; option2: string; option3: string; sku: string; barcode: string;
  price: number | null; onlinePrice: number | null; compareAtPrice: number | null;
  stockQty: number; lowStock: number | null; mediaId: string | null; active: boolean; position: number;
}
export interface CatalogMedia {
  id: string; itemId: string; variantId: string | null; path: string; url: string; sizes: Record<string, string>;
  width: number | null; height: number | null; alt: string; position: number;
}
export interface FieldDef { id: string; key: string; label: string; kind: 'text' | 'multiline'; showOnline: boolean; position: number }

export const MAX_OPTIONS = 3;
export const MAX_CHOICES = 50;
export const MAX_VARIANTS = 100;
export const MAX_PICTURES = 12;
export const LIMITS = { name: 80, description: 5000, seoTitle: 120, seoDescription: 320, slug: 80, sku: 64, tags: 30, tag: 40, manufacturer: 120, country: 60, option: 30, choice: 40, field: 2000, alt: 250 } as const;
/** what search engines show (a longer SEO text is saved, but cut by Google) */
export const SEO_SHOWN = { title: 60, description: 155 } as const;
export const MIGRATION_3300 = 'צריך להריץ את מיגרציה 20261005003300 (קטלוג 2.54: וריאנטים, תמונות, אתר) ב-Supabase.';

// ---- rows of the database → the screen (lenient: a row from before 3300 has none of the new columns) --------------------
const num = (v: unknown, d = 0) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const numOrNull = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const KINDS: ItemKind[] = ['service', 'product', 'package', 'other'];

export function toCatalogItem(r: any): CatalogItem {
  const cf = r?.custom_fields && typeof r.custom_fields === 'object' && !Array.isArray(r.custom_fields) ? r.custom_fields : {};
  return {
    id: str(r.id), name: str(r.name), price: num(r.price), kind: KINDS.includes(r.kind) ? r.kind : 'other', active: r.active !== false,
    favorite: Boolean(r.favorite), favOrder: num(r.fav_order), sort: num(r.sort), imageUrl: str(r.image_url),
    trackStock: Boolean(r.track_stock), stockQty: num(r.stock_qty), lowStock: num(r.low_stock, 2),
    slug: r.slug ? str(r.slug) : null, description: str(r.description), seoTitle: str(r.seo_title), seoDescription: str(r.seo_description),
    publishOnline: Boolean(r.publish_online), onlinePrice: numOrNull(r.online_price), compareAtPrice: numOrNull(r.compare_at_price),
    sku: str(r.sku), barcode: str(r.barcode), hasVariants: Boolean(r.has_variants), tags: Array.isArray(r.tags) ? r.tags.map(str) : [],
    customFields: Object.fromEntries(Object.entries(cf).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
    manufacturer: str(r.manufacturer), countryOfOrigin: str(r.country_of_origin), publishedAt: r.published_at ?? null, updatedAt: r.updated_at ?? null,
  };
}
export const toOption = (r: any): CatalogOption => ({ id: str(r.id), itemId: str(r.item_id), position: num(r.position, 1), name: str(r.name), choices: Array.isArray(r.choices) ? r.choices.map(str) : [] });
export const toVariant = (r: any): CatalogVariant => ({
  id: str(r.id), itemId: str(r.item_id), option1: str(r.option1), option2: str(r.option2), option3: str(r.option3), sku: str(r.sku), barcode: str(r.barcode),
  price: numOrNull(r.price), onlinePrice: numOrNull(r.online_price), compareAtPrice: numOrNull(r.compare_at_price),
  stockQty: num(r.stock_qty), lowStock: numOrNull(r.low_stock), mediaId: r.media_id ?? null, active: r.active !== false, position: num(r.position),
});
export const toMedia = (r: any): CatalogMedia => ({
  id: str(r.id), itemId: str(r.item_id), variantId: r.variant_id ?? null, path: str(r.path), url: str(r.url),
  sizes: r.sizes && typeof r.sizes === 'object' ? Object.fromEntries(Object.entries(r.sizes).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {},
  width: numOrNull(r.width), height: numOrNull(r.height), alt: str(r.alt), position: num(r.position),
});
export const toFieldDef = (r: any): FieldDef => ({ id: str(r.id), key: str(r.field_key), label: str(r.label), kind: r.kind === 'multiline' ? 'multiline' : 'text', showOnline: r.show_online !== false, position: num(r.position) });

// ---- variants -------------------------------------------------------------------------------------------------------------
export const variantOptions = (v: Pick<CatalogVariant, 'option1' | 'option2' | 'option3'>) => [v.option1, v.option2, v.option3].filter((x) => x !== '');
/** "M / שחור" */
export const variantLabel = (v: Pick<CatalogVariant, 'option1' | 'option2' | 'option3'>) => variantOptions(v).join(' / ');
/** the name on a register line, a document line, an expense line: "חולצה · M / שחור" (an item without a variant: its name) */
export function lineName(itemName: string, v?: Pick<CatalogVariant, 'option1' | 'option2' | 'option3'> | null): string {
  const label = v ? variantLabel(v) : '';
  return label ? `${itemName} · ${label}` : itemName;
}
export const variantsOf = <V extends Pick<CatalogVariant, 'itemId' | 'position'>>(variants: V[], itemId: string) =>
  variants.filter((v) => v.itemId === itemId).sort((a, b) => a.position - b.position);

/** the register's price: the variant's own, else the item's */
export const posPrice = (item: Pick<CatalogItem, 'price'>, v?: Pick<CatalogVariant, 'price'> | null) => v?.price ?? item.price;
/** the store's price: the variant's online price → the item's online price → the register's price */
export const onlinePriceOf = (item: Pick<CatalogItem, 'price' | 'onlinePrice'>, v?: Pick<CatalogVariant, 'price' | 'onlinePrice'> | null) =>
  v?.onlinePrice ?? item.onlinePrice ?? v?.price ?? item.price;

/** every combination of the options' values, in order (1 × 2 × 3); options without values are skipped */
export function optionCombos(options: Pick<CatalogOption, 'position' | 'choices'>[]): string[][] {
  const lists = [...options].sort((a, b) => a.position - b.position).map((o) => uniqueClean(o.choices, LIMITS.choice)).filter((c) => c.length);
  if (!lists.length) return [];
  return lists.reduce<string[][]>((acc, list) => acc.flatMap((a) => list.map((c) => [...a, c])), [[]]);
}
const comboKey = (c: readonly string[]) => JSON.stringify([c[0] ?? '', c[1] ?? '', c[2] ?? '']);

/**
 * The variants the options describe, against the ones that exist: which to create, which stay, and which no option
 * describes any more ("orphans" — the screen offers to hide or delete them; never deleted by itself, they may hold stock
 * and history).
 */
export function planVariants<V extends Pick<CatalogVariant, 'option1' | 'option2' | 'option3'>>(options: Pick<CatalogOption, 'position' | 'choices'>[], existing: V[]):
  { ok: true; create: string[][]; keep: V[]; orphan: V[] } | { ok: false; error: string } {
  const combos = optionCombos(options);
  if (combos.length > MAX_VARIANTS) return { ok: false, error: `${combos.length} שילובים — יותר מ-${MAX_VARIANTS} וריאנטים למוצר. כדאי לפצל למוצרים נפרדים.` };
  const want = new Set(combos.map(comboKey));
  const have = new Map(existing.map((v) => [comboKey([v.option1, v.option2, v.option3]), v]));
  return {
    ok: true,
    create: combos.filter((c) => !have.has(comboKey(c))),
    keep: existing.filter((v) => want.has(comboKey([v.option1, v.option2, v.option3]))),
    orphan: existing.filter((v) => !want.has(comboKey([v.option1, v.option2, v.option3]))),
  };
}

/** values of an option: trimmed, without empties and doubles (case-insensitive), each up to max characters */
export function uniqueClean(list: readonly string[], max: number): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const raw of list) {
    const v = raw.replace(/\s+/g, ' ').trim().slice(0, max);
    if (!v || seen.has(v.toLocaleLowerCase('he'))) continue;
    seen.add(v.toLocaleLowerCase('he')); out.push(v);
  }
  return out;
}
/** "S, M, L" / one per line → ['S', 'M', 'L'] */
export const splitList = (text: string, max: number = LIMITS.choice) => uniqueClean(text.split(/[,\n،]/), max);
export const parseTags = (text: string) => splitList(text, LIMITS.tag).slice(0, LIMITS.tags);

// ---- stock ----------------------------------------------------------------------------------------------------------------
export type Level = 'ok' | 'low' | 'out';
export function level(qty: number, low: number): Level { return qty <= 0 ? 'out' : qty <= low ? 'low' : 'ok'; }
/** a variant's stock level (its own alert level, else the item's); null when the item is not tracked */
export const variantLevel = (item: Pick<CatalogItem, 'trackStock' | 'lowStock'>, v: Pick<CatalogVariant, 'stockQty' | 'lowStock'>): Level | null =>
  item.trackStock ? level(v.stockQty, v.lowStock ?? item.lowStock) : null;
/** units on the item that no variant holds (a sale without a variant, units from before the variants): the item's sum − Σ variants */
export function unassignedUnits(item: Pick<CatalogItem, 'id' | 'trackStock' | 'hasVariants' | 'stockQty'>, variants: Pick<CatalogVariant, 'itemId' | 'stockQty'>[]): number {
  if (!item.trackStock || !item.hasVariants) return 0;
  return item.stockQty - variants.filter((v) => v.itemId === item.id).reduce((a, v) => a + v.stockQty, 0);
}
/** "S: 3 · M: אזל" — the variants of an item at a glance */
export function variantStockText(item: Pick<CatalogItem, 'trackStock' | 'lowStock'>, variants: CatalogVariant[]): string {
  if (!item.trackStock) return '';
  return variants.filter((v) => v.active).map((v) => `${variantLabel(v)}: ${v.stockQty <= 0 ? 'אזל' : v.stockQty}`).join(' · ');
}
/** the variants' stock after a sale (sign 1) or a return (sign −1): the screen mirrors what the database did */
export function applyVariantStock<V extends Pick<CatalogVariant, 'id' | 'itemId' | 'stockQty'>>(variants: V[], lines: { itemId?: string; variantId?: string; qty: number }[], sign: 1 | -1 = 1): V[] {
  const d = new Map<string, number>();
  for (const l of lines) if (l.itemId && l.variantId && l.qty > 0) d.set(`${l.itemId}|${l.variantId}`, (d.get(`${l.itemId}|${l.variantId}`) ?? 0) + Math.floor(l.qty));
  return variants.map((v) => (d.has(`${v.itemId}|${v.id}`) ? { ...v, stockQty: v.stockQty - sign * d.get(`${v.itemId}|${v.id}`)! } : v));
}

// ---- the register's cart --------------------------------------------------------------------------------------------------
/** two taps on the same product (and variant) are one line; a free amount is matched by its name and price, as before */
export const cartKey = (l: { name: string; price: number; itemId?: string; variantId?: string }) =>
  l.itemId ? `i:${l.itemId}|${l.variantId ?? ''}|${l.price}` : `n:${l.name}|${l.price}`;

/** a scanned or typed code: a variant's barcode / SKU first, then an item's (active only; a SKU in any case) */
export function findByCode<I extends Pick<CatalogItem, 'id' | 'sku' | 'barcode' | 'active'>, V extends Pick<CatalogVariant, 'itemId' | 'sku' | 'barcode' | 'active'>>(
  code: string, items: I[], variants: V[]): { item: I; variant: V | null } | null {
  const c = code.trim();
  if (!c) return null;
  const lc = c.toLowerCase();
  const byId = new Map(items.filter((i) => i.active).map((i) => [i.id, i]));
  const v = variants.find((x) => x.active && byId.has(x.itemId) && (x.barcode === c || (x.sku !== '' && x.sku.toLowerCase() === lc)));
  if (v) return { item: byId.get(v.itemId)!, variant: v };
  const i = items.find((x) => x.active && (x.barcode === c || (x.sku !== '' && x.sku.toLowerCase() === lc)));
  return i ? { item: i, variant: null } : null;
}

// ---- the online store -----------------------------------------------------------------------------------------------------
/**
 * A product's address in the store: Hebrew and English letters and digits, words joined by "-" (the database's rule:
 * ^[a-z0-9א-ת]+(-[a-z0-9א-ת]+)*$, up to 80). Niqqud and accents are dropped; '' when nothing is left.
 */
export function slugify(text: string): string {
  const s = text.normalize('NFKD')
    .replace(/[\u05be\u05c0\u05c3\u05c6]/g, ' ')                  // Hebrew punctuation (maqaf…) separates words
    .replace(/['`\u2019\u05f3\u05f4"]/g, '')                       // geresh / apostrophes join (ג׳ינס → גינס)
    .replace(/[\u0300-\u036f\u0591-\u05c7]/g, '').toLowerCase()    // accents and niqqud
    .replace(/[^a-z0-9\u05d0-\u05ea]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, LIMITS.slug).replace(/-+$/, '');
}
export const isSlug = (s: string) => s.length >= 1 && s.length <= LIMITS.slug && /^[a-z0-9\u05d0-\u05ea]+(-[a-z0-9\u05d0-\u05ea]+)*$/.test(s);
/** "חולצה" → "חולצה-2" when the address is taken in this business */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const t = new Set(taken);
  const b = base || 'מוצר';
  if (!t.has(b)) return b;
  for (let n = 2; ; n++) {
    const tail = `-${n}`;
    const s = `${b.slice(0, LIMITS.slug - tail.length).replace(/-+$/, '')}${tail}`;
    if (!t.has(s)) return s;
  }
}

/** what is missing before publishing — a suggestion, never a block ("לפרסם בכל זאת") */
export type PublishGap = 'image' | 'description';
export function publishGaps(item: Pick<CatalogItem, 'imageUrl' | 'description'>, pictures?: number): PublishGap[] {
  const gaps: PublishGap[] = [];
  if (!(pictures ?? (item.imageUrl ? 1 : 0))) gaps.push('image');
  if (!item.description.trim()) gaps.push('description');
  return gaps;
}
export const GAP_HE: Record<PublishGap, string> = { image: 'תמונה', description: 'תיאור' };

/** the business's own fields: only the defined ones, trimmed, empty ones dropped */
export function cleanCustomFields(defs: Pick<FieldDef, 'key'>[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of defs) { const v = (values[d.key] ?? '').trim().slice(0, LIMITS.field); if (v) out[d.key] = v; }
  return out;
}
/** an internal key for a new field ("טבלת מידות" → field_1, field_2 …) — the label is what people see */
export function newFieldKey(taken: Iterable<string>): string {
  const t = new Set(taken);
  for (let n = 1; ; n++) if (!t.has(`field_${n}`)) return `field_${n}`;
}

// ---- the editor's draft ---------------------------------------------------------------------------------------------------
export interface ItemDraft {
  name: string; kind: ItemKind; price: string; active: boolean;
  description: string; seoTitle: string; seoDescription: string; slug: string; publishOnline: boolean;
  onlinePrice: string; compareAtPrice: string; sku: string; barcode: string; tags: string;
  customFields: Record<string, string>; manufacturer: string; countryOfOrigin: string;
}
export const emptyDraft = (p: Partial<ItemDraft> = {}): ItemDraft => ({
  name: '', kind: 'product', price: '', active: true, description: '', seoTitle: '', seoDescription: '', slug: '', publishOnline: false,
  onlinePrice: '', compareAtPrice: '', sku: '', barcode: '', tags: '', customFields: {}, manufacturer: '', countryOfOrigin: '', ...p,
});
export const draftOf = (i: CatalogItem): ItemDraft => ({
  name: i.name, kind: i.kind, price: String(i.price), active: i.active, description: i.description, seoTitle: i.seoTitle, seoDescription: i.seoDescription,
  slug: i.slug ?? '', publishOnline: i.publishOnline, onlinePrice: i.onlinePrice == null ? '' : String(i.onlinePrice),
  compareAtPrice: i.compareAtPrice == null ? '' : String(i.compareAtPrice), sku: i.sku, barcode: i.barcode, tags: i.tags.join(', '),
  customFields: { ...i.customFields }, manufacturer: i.manufacturer, countryOfOrigin: i.countryOfOrigin,
});

const money = (s: string) => { const t = s.replace(/[₪,\s]/g, ''); return t === '' ? null : Number(t); };
const okMoney = (n: number | null) => n === null || (Number.isFinite(n) && n >= 0 && Math.round(n * 100) === n * 100 && n < 1e8);
export const isBarcode = (s: string) => s === '' || /^[0-9A-Za-z.-]{3,40}$/.test(s);

/** the first problem of a draft, in Hebrew — or null. The database checks the same (and the codes across products). */
export function draftError(d: ItemDraft): string | null {
  const name = d.name.trim();
  if (!name) return 'חסר שם למוצר.';
  if (name.length > LIMITS.name) return `השם ארוך מדי (עד ${LIMITS.name} תווים — כך הוא נכנס לקופה ולמסמכים).`;
  const price = money(d.price);
  if (price === null || !okMoney(price)) return 'המחיר צריך להיות מספר, 0 או יותר (עד 2 ספרות אחרי הנקודה).';
  if (!okMoney(money(d.onlinePrice))) return 'המחיר באתר צריך להיות מספר, 0 או יותר — או ריק (אז המחיר באתר = מחיר הקופה).';
  if (!okMoney(money(d.compareAtPrice))) return '"מחיר לפני הנחה" צריך להיות מספר, 0 או יותר — או ריק.';
  const cmp = money(d.compareAtPrice), online = money(d.onlinePrice) ?? price;
  if (cmp !== null && cmp <= online) return '"מחיר לפני הנחה" צריך להיות גבוה מהמחיר באתר — אחרת אין הנחה להציג.';
  if (d.slug && !isSlug(d.slug)) return 'הכתובת באתר: אותיות בעברית או באנגלית קטנה, ספרות, ומקף בין מילים.';
  if (d.description.length > LIMITS.description) return `התיאור ארוך מדי (עד ${LIMITS.description} תווים).`;
  if (d.seoTitle.length > LIMITS.seoTitle) return `כותרת לגוגל ארוכה מדי (עד ${LIMITS.seoTitle} תווים).`;
  if (d.seoDescription.length > LIMITS.seoDescription) return `תיאור לגוגל ארוך מדי (עד ${LIMITS.seoDescription} תווים).`;
  if (d.sku.trim().length > LIMITS.sku) return `מק״ט ארוך מדי (עד ${LIMITS.sku} תווים).`;
  if (!isBarcode(d.barcode.trim())) return 'ברקוד: 3–40 ספרות או אותיות באנגלית (בלי רווחים).';
  if (d.manufacturer.length > LIMITS.manufacturer || d.countryOfOrigin.length > LIMITS.country) return 'שם היצרן או ארץ הייצור ארוכים מדי.';
  return null;
}

/** the columns of catalog_items a draft writes (only after draftError(d) === null) */
export function itemColumns(d: ItemDraft, defs: Pick<FieldDef, 'key'>[]) {
  return {
    name: d.name.trim(), kind: d.kind, price: money(d.price) ?? 0, active: d.active,
    description: d.description.trim(), seo_title: d.seoTitle.trim(), seo_description: d.seoDescription.trim(),
    slug: d.slug.trim() || null, publish_online: d.publishOnline, online_price: money(d.onlinePrice), compare_at_price: money(d.compareAtPrice),
    sku: d.sku.trim(), barcode: d.barcode.trim(), tags: parseTags(d.tags), custom_fields: cleanCustomFields(defs, d.customFields),
    manufacturer: d.manufacturer.trim(), country_of_origin: d.countryOfOrigin.trim(),
  };
}
/** only what changed (so a save from an old screen never undoes a change made elsewhere — a price from the register) */
export function changedColumns<T extends Record<string, unknown>>(next: T, before: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(next) as (keyof T)[]) if (stable(next[k]) !== stable(before[k])) out[k] = next[k];
  return out;
}
/** JSON with the keys of every object in order — {a, b} and {b, a} are the same value */
const stable = (v: unknown): string => JSON.stringify(v ?? null, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x);
/** the columns of an item as they are in the database, in the shape itemColumns() returns — to compare */
export function itemColumnsOf(i: CatalogItem) {
  return {
    name: i.name, kind: i.kind, price: i.price, active: i.active, description: i.description, seo_title: i.seoTitle, seo_description: i.seoDescription,
    slug: i.slug, publish_online: i.publishOnline, online_price: i.onlinePrice, compare_at_price: i.compareAtPrice, sku: i.sku, barcode: i.barcode,
    tags: i.tags, custom_fields: i.customFields, manufacturer: i.manufacturer, country_of_origin: i.countryOfOrigin,
  };
}

/** a variant's row from its editor fields ('' = the item's value) */
export function variantColumns(v: { price: string; onlinePrice: string; sku: string; barcode: string; lowStock: string; active: boolean }):
  { ok: true; cols: { price: number | null; online_price: number | null; sku: string; barcode: string; low_stock: number | null; active: boolean } } | { ok: false; error: string } {
  const price = money(v.price), online = money(v.onlinePrice);
  if (!okMoney(price) || !okMoney(online)) return { ok: false, error: 'מחיר של וריאנט: מספר, 0 או יותר — או ריק (אז מחיר המוצר).' };
  if (v.sku.trim().length > LIMITS.sku) return { ok: false, error: `מק״ט ארוך מדי (עד ${LIMITS.sku} תווים).` };
  if (!isBarcode(v.barcode.trim())) return { ok: false, error: 'ברקוד: 3–40 ספרות או אותיות באנגלית (בלי רווחים).' };
  const low = v.lowStock.trim() === '' ? null : Number(v.lowStock);
  if (low !== null && !(Number.isInteger(low) && low >= 0)) return { ok: false, error: 'רמת התראה: מספר שלם, 0 או יותר — או ריק (אז של המוצר).' };
  return { ok: true, cols: { price, online_price: online, sku: v.sku.trim(), barcode: v.barcode.trim(), low_stock: low, active: v.active } };
}

/** a refusal of the database, in words (null: not one of ours — the caller shows its general message) */
export function catalogError(e: { message?: string; code?: string } | null | undefined): string | null {
  const m = `${e?.message ?? ''} ${e?.code ?? ''}`;
  if (/does not exist|schema cache|PGRST20[2-5]/i.test(m)
      && /catalog_(variants|options|media|field_defs)|variant_stock|slug|publish_online|online_price|has_variants|variant/i.test(m)) return MIGRATION_3300;
  if (/code_taken.*barcode/i.test(m)) return 'הברקוד הזה כבר שייך למוצר אחר בעסק.';
  if (/code_taken/i.test(m)) return 'המק״ט הזה כבר שייך למוצר אחר בעסק.';
  if (/catalog_items_slug_uq/.test(m)) return 'הכתובת הזאת באתר כבר שייכת למוצר אחר.';
  if (/catalog_(items|variants)_sku_uq/.test(m)) return 'המק״ט הזה כבר שייך למוצר אחר בעסק.';
  if (/catalog_(items|variants)_barcode_uq/.test(m)) return 'הברקוד הזה כבר שייך למוצר אחר בעסק.';
  if (/catalog_variants_item_id_option1_option2_option3_key/.test(m)) return 'הווריאנט הזה כבר קיים.';
  if (/catalog_options_item_id_position_key/.test(m)) return 'לכל מוצר עד 3 אפשרויות (למשל מידה, צבע, חומר).';
  if (/catalog_field_defs_key_uq/.test(m)) return 'שדה בשם הזה כבר קיים.';
  if (/variant_required/.test(m)) return 'למוצר עם וריאנטים סופרים מלאי לכל וריאנט בנפרד.';
  if (/not of this item/.test(m)) return 'התמונה והווריאנט חייבים להיות של אותו מוצר.';
  if (/stock changes only/.test(m)) return 'מלאי משתנה רק דרך קבלת סחורה או ספירה.';
  if (/row-level security|permission denied|42501|not allowed/i.test(m)) return 'אין הרשאה לפעולה הזו.';
  return null;
}

// ---- ✨ text from the AI (a suggestion: the owner reads and approves it before anything is saved) ------------------------
export interface ProductCopy { description: string; seoTitle: string; seoDescription: string }
const plain = (v: unknown, max: number) => (typeof v === 'string' ? v : '')
  .replace(/<[^>]*>/g, '').replace(/\*\*|__|^#+\s*/gm, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
/** the AI's answer as text fields: no HTML, no Markdown, within the database's limits — or null when there is no text */
export function cleanProductCopy(raw: unknown): ProductCopy | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const description = plain(r.description, 2000);
  if (!description) return null;
  return { description, seoTitle: plain(r.seoTitle, LIMITS.seoTitle).replace(/\n/g, ' '), seoDescription: plain(r.seoDescription, LIMITS.seoDescription).replace(/\n/g, ' ') };
}
/** what the AI may know of a product: its own words only (names, options, fields) — never its price, stock or sales */
export function copyBrief(d: Pick<ItemDraft, 'name' | 'kind' | 'tags' | 'description' | 'manufacturer' | 'countryOfOrigin' | 'customFields'>,
  options: { name: string; choices: string[] }[], defs: Pick<FieldDef, 'key' | 'label'>[]) {
  return {
    name: d.name.trim().slice(0, LIMITS.name), kind: KIND_HE[d.kind] ?? '', tags: parseTags(d.tags),
    options: options.filter((o) => o.name.trim() && o.choices.length).map((o) => ({ name: o.name.trim().slice(0, LIMITS.option), choices: o.choices.slice(0, 20) })),
    fields: defs.map((f) => ({ label: f.label, value: (d.customFields[f.key] ?? '').trim().slice(0, 300) })).filter((f) => f.value),
    manufacturer: d.manufacturer.trim(), country: d.countryOfOrigin.trim(), current: d.description.trim().slice(0, 1500),
  };
}
export type CopyBrief = ReturnType<typeof copyBrief>;

/**
 * What a document line / an expense can pick from the catalog: an item without variants as it is; an item with active
 * variants as one pick per variant ("חולצה · M / שחור", its own price) — so the stock that moves is that variant's.
 */
export interface CatalogPickRow { id: string; name: string; price: number; kind: string; variantId?: string }
export function catalogPicks(items: CatalogItem[], variants: CatalogVariant[]): CatalogPickRow[] {
  return items.filter((i) => i.active).flatMap((i) => {
    const vs = variantsOf(variants, i.id).filter((v) => v.active);
    return i.hasVariants && vs.length
      ? vs.map((v) => ({ id: i.id, variantId: v.id, name: lineName(i.name, v), price: posPrice(i, v), kind: i.kind }))
      : [{ id: i.id, name: i.name, price: i.price, kind: i.kind }];
  });
}

/**
 * "📣 קדם מוצר" (2.60, stage 5): the content studio opens with the product — its main picture as a library item, and a brief
 * from the product's own words (never its price or stock: the AI writes the post, the owner edits and approves it there).
 */
export function promoteBrief(d: { name: string; description: string }): string {
  const about = d.description.replace(/\s+/g, ' ').trim().slice(0, 300);
  return `פוסט שמקדם את המוצר "${d.name.trim().slice(0, LIMITS.name)}"${about ? `: ${about}` : ''}`;
}
export const promoteUrl = (brief: string, mediaId: string | null) =>
  `/create?kind=post&brief=${encodeURIComponent(brief)}${mediaId ? `&media=${encodeURIComponent(mediaId)}` : ''}`;
