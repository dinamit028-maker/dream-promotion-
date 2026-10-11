import { QUICK_COUNT_OWNER } from '@/features/stock/stock-locations';
import { serialError } from './serials';
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
  /** a package's terms (kind 'package', migration 20261010004200): treatments, a treatment type (null = any), months valid */
  packageSessions: number | null; packageTypeId: string | null; packageValidMonths: number | null;
  /** 2.93 (migration 20261011004800): every unit has its own serial number (features/catalog/serials.ts) */
  trackSerials: boolean;
  /** 2.94 (migration 20261011004900): a service's treatment type — sales by treatment type (a package keeps packageTypeId) */
  treatmentTypeId: string | null;
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
export const MIGRATION_4200 = 'צריך להריץ את מיגרציה 20261010004200 (חבילות) ב-Supabase לפני שהחבילות עובדות.';
/** a package: up to this many treatments, valid up to this many months (the database checks the same) */
export const PACKAGE_LIMITS = { sessions: 500, months: 120 } as const;

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
    packageSessions: numOrNull(r.package_sessions), packageTypeId: r.package_type_id ? str(r.package_type_id) : null, packageValidMonths: numOrNull(r.package_valid_months),
    trackSerials: Boolean(r.track_serials),
    treatmentTypeId: r.treatment_type_id ? str(r.treatment_type_id) : null,
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

/** the register's price: the variant's own, else the item's — the base price list ("מחירון בסיס"); see priceFor for the others */
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
  /** a package's terms ('' = not set; the type '' = any treatment) */
  packageSessions: string; packageTypeId: string; packageValidMonths: string;
  /** a service's treatment type ('' = none) — written only for a service, and only when the database has it (4900) */
  treatmentTypeId: string;
}
export const emptyDraft = (p: Partial<ItemDraft> = {}): ItemDraft => ({
  name: '', kind: 'product', price: '', active: true, description: '', seoTitle: '', seoDescription: '', slug: '', publishOnline: false,
  onlinePrice: '', compareAtPrice: '', sku: '', barcode: '', tags: '', customFields: {}, manufacturer: '', countryOfOrigin: '',
  packageSessions: '', packageTypeId: '', packageValidMonths: '', treatmentTypeId: '', ...p,
});
export const draftOf = (i: CatalogItem): ItemDraft => ({
  name: i.name, kind: i.kind, price: String(i.price), active: i.active, description: i.description, seoTitle: i.seoTitle, seoDescription: i.seoDescription,
  slug: i.slug ?? '', publishOnline: i.publishOnline, onlinePrice: i.onlinePrice == null ? '' : String(i.onlinePrice),
  compareAtPrice: i.compareAtPrice == null ? '' : String(i.compareAtPrice), sku: i.sku, barcode: i.barcode, tags: i.tags.join(', '),
  customFields: { ...i.customFields }, manufacturer: i.manufacturer, countryOfOrigin: i.countryOfOrigin,
  packageSessions: i.packageSessions == null ? '' : String(i.packageSessions), packageTypeId: i.packageTypeId ?? '',
  packageValidMonths: i.packageValidMonths == null ? '' : String(i.packageValidMonths),
  treatmentTypeId: i.treatmentTypeId ?? '',
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
  // a package's terms: optional (a package of the register without them is not sold as a customer's package), checked when set
  if (d.kind === 'package') {
    const s = Number(d.packageSessions);
    if (d.packageSessions.trim() && !(Number.isInteger(s) && s >= 1 && s <= PACKAGE_LIMITS.sessions)) return `מספר הטיפולים בחבילה: מספר שלם בין 1 ל-${PACKAGE_LIMITS.sessions}.`;
    const m = Number(d.packageValidMonths);
    if (d.packageValidMonths.trim() && !(Number.isInteger(m) && m >= 1 && m <= PACKAGE_LIMITS.months)) return `תוקף החבילה: מספר חודשים שלם בין 1 ל-${PACKAGE_LIMITS.months} — או ריק (בלי הגבלה).`;
    if (!d.packageSessions.trim() && (d.packageTypeId || d.packageValidMonths.trim())) return 'כמה טיפולים בחבילה? בלי מספר טיפולים היא לא נמכרת כחבילה ללקוח.';
  }
  return null;
}

/** the package columns of a draft (migration 20261010004200) — written only for a package, and only when the database has them */
const packageColumns = (d: ItemDraft) => ({
  package_sessions: d.packageSessions.trim() ? Number(d.packageSessions) : null,
  package_type_id: d.packageTypeId || null,
  package_valid_months: d.packageValidMonths.trim() ? Number(d.packageValidMonths) : null,
});
/**
 * the columns of catalog_items a draft writes (only after draftError(d) === null); opts.packages: the database has 4200;
 * opts.types: it has 4900 — a service's treatment type (any other kind has none: the database refuses it)
 */
export function itemColumns(d: ItemDraft, defs: Pick<FieldDef, 'key'>[], opts: { packages?: boolean; types?: boolean } = {}) {
  return {
    ...(opts.packages && d.kind === 'package' ? packageColumns(d) : {}),
    ...(opts.types ? { treatment_type_id: d.kind === 'service' ? d.treatmentTypeId || null : null } : {}),
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
export function itemColumnsOf(i: CatalogItem, opts: { packages?: boolean; types?: boolean } = {}) {
  return {
    ...(opts.packages ? { package_sessions: i.packageSessions, package_type_id: i.packageTypeId, package_valid_months: i.packageValidMonths } : {}),
    ...(opts.types ? { treatment_type_id: i.treatmentTypeId } : {}),
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
  if (/does not exist|schema cache|PGRST20[2-5]|42703/i.test(m) && /package_(sessions|type_id|valid_months)/.test(m)) return MIGRATION_4200;
  if (/catalog_items_package_check/.test(m)) return `מספר טיפולים 1–${PACKAGE_LIMITS.sessions}, תוקף 1–${PACKAGE_LIMITS.months} חודשים.`;
  if (/catalog_items_package_type_fk/.test(m)) return 'סוג הטיפול לא נמצא בעסק.';
  const serial = serialError(e);
  if (serial) return serial;
  const list = priceListError(e);
  if (list) return list;
  if (/the owner counts/.test(m)) return QUICK_COUNT_OWNER;
  if (/variant_required/.test(m)) return 'למוצר עם וריאנטים סופרים מלאי לכל וריאנט בנפרד.';
  if (/not of this item/.test(m)) return 'התמונה והווריאנט חייבים להיות של אותו מוצר.';
  if (/stock changes only/.test(m)) return 'מלאי משתנה רק דרך קבלת סחורה או ספירה.';
  if (/row-level security|permission denied|42501|not allowed/i.test(m)) return 'אין הרשאה לפעולה הזו.';
  return null;
}

// ---- price lists (2.93, migration 20261011004800 — T12ג) ----------------------------------------------------------------------
/**
 * The base price list is the catalog's own price (posPrice). A business may add lists: a location's (its sales and documents)
 * and a customer group's — the customers with a tag of the CRM ("סיטונאי", "חברי מועדון"). A list prices the products it names
 * (a product, or one of its variants; a product's price is its variants' too, unless a variant has its own in that list).
 * THE rule, everywhere a price is picked (the register, a document, a quote): the customer's group, else the location's, else
 * the base. Changing the price on a line stays with whoever may write it, as before.
 */
export interface PriceList { id: string; name: string; kind: 'location' | 'group'; locationId: string | null; tag: string | null; active: boolean; sort: number }
export interface ListPrice { listId: string; itemId: string; variantId: string | null; price: number }
export const toPriceList = (r: any): PriceList => ({
  id: str(r.id), name: str(r.name), kind: r.kind === 'location' ? 'location' : 'group', locationId: r.location_id ? str(r.location_id) : null,
  tag: r.tag ? str(r.tag) : null, active: r.active !== false, sort: num(r.sort),
});
export const toListPrice = (r: any): ListPrice => ({ listId: str(r.list_id), itemId: str(r.item_id), variantId: r.variant_id ? str(r.variant_id) : null, price: num(r.price) });
export const PRICE_LIST_LIMITS = { name: 40, tag: 40, lines: 500 } as const;
const sameTag = (a: string, b: string) => a.trim().toLocaleLowerCase('he') === b.trim().toLocaleLowerCase('he');

/** the lists that price a sale or a document, in the order they are asked: the customer's group(s), then the location's */
export function listsFor(lists: PriceList[], ctx: { locationId?: string | null; tags?: readonly string[] | null }): PriceList[] {
  const tags = (ctx.tags ?? []).filter((t) => t.trim());
  const group = lists.filter((l) => l.active && l.kind === 'group' && l.tag && tags.some((t) => sameTag(t, l.tag!)))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'he'));
  const here = ctx.locationId ? lists.filter((l) => l.active && l.kind === 'location' && l.locationId === ctx.locationId) : [];
  return [...group, ...here];
}
/** a product's (or a variant's) price by those lists: the first that names it — else the base; and which list it was */
export function priceFor(item: Pick<CatalogItem, 'id' | 'price'>, v: Pick<CatalogVariant, 'id' | 'price'> | null | undefined,
  lists: PriceList[], prices: ListPrice[]): { price: number; list: PriceList | null } {
  for (const l of lists) {
    const own = v ? prices.find((p) => p.listId === l.id && p.itemId === item.id && p.variantId === v.id) : undefined;
    const whole = own ?? prices.find((p) => p.listId === l.id && p.itemId === item.id && p.variantId === null);
    if (whole) return { price: whole.price, list: l };
  }
  return { price: posPrice(item, v), list: null };
}
/** a list's price as typed: '' takes it off (the base again); else shekels and agorot, 0 or more (as the database: price_list_set) */
export function listPriceInput(raw: string): { ok: true; price: number | null } | { ok: false; error: string } {
  const t = raw.replace(/[₪,\s]/g, '');
  if (t === '') return { ok: true, price: null };
  if (!/^[0-9]{1,7}(\.[0-9]{1,2})?$/.test(t)) return { ok: false, error: 'מחיר: מספר, 0 או יותר (עד 2 ספרות אחרי הנקודה) — או ריק (אז המחיר הרגיל).' };
  return { ok: true, price: Number(t) };
}
/** a list's name and kind, the first problem in Hebrew */
export function priceListDraftError(d: { name: string; kind: 'location' | 'group'; locationId: string | null; tag: string }): string | null {
  if (!d.name.trim()) return 'שם למחירון — למשל "סיטונאי".';
  if (d.name.trim().length > PRICE_LIST_LIMITS.name) return `שם המחירון — עד ${PRICE_LIST_LIMITS.name} תווים.`;
  if (d.kind === 'location' && !d.locationId) return 'לאיזה סניף המחירון?';
  if (d.kind === 'group' && !d.tag.trim()) return 'לאיזו קבוצת לקוחות? (תגית בכרטיס הלקוח, למשל "סיטונאי")';
  if (d.kind === 'group' && d.tag.trim().length > PRICE_LIST_LIMITS.tag) return `תגית — עד ${PRICE_LIST_LIMITS.tag} תווים.`;
  return null;
}
/** a refusal of the database about price lists and SKU series, in Hebrew (null: not one of these) */
export function priceListError(e: { message?: string; code?: string } | null | undefined): string | null {
  const m = `${e?.message ?? ''} ${e?.code ?? ''}`;
  if (/price_lists_tag_uq/.test(m)) return 'כבר יש מחירון פעיל לקבוצה הזו.';
  if (/price_lists_location_uq/.test(m)) return 'כבר יש מחירון פעיל לסניף הזה.';
  if (/price_lists_name_uq/.test(m)) return 'כבר יש מחירון בשם הזה.';
  if (/price_list_name/.test(m)) return `שם המחירון: 1–${PRICE_LIST_LIMITS.name} תווים.`;
  if (/price_list_tag/.test(m)) return 'מחירון של קבוצה צריך תגית של לקוחות.';
  if (/price_list_kind/.test(m)) return 'מחירון של סניף או של קבוצת לקוחות.';
  if (/price_list_price/.test(m)) return 'מחיר: מספר, 0 או יותר (עד 2 ספרות אחרי הנקודה).';
  if (/price_list_lines/.test(m)) return `עד ${PRICE_LIST_LIMITS.lines} מחירים בשמירה אחת.`;
  if (/price_list_item/.test(m)) return 'המוצר לא נמצא בעסק.';
  if (/sku_series_prefix_uq/.test(m)) return 'כבר יש סדרה עם הקידומת הזו.';
  if (/sku_series_name_uq/.test(m)) return 'כבר יש סדרה בשם הזה.';
  if (/sku_series_prefix/.test(m)) return 'קידומת: 1–6 אותיות באנגלית או ספרות (למשל JW).';
  if (/sku_series_digits/.test(m)) return 'מספר הספרות: 3 עד 6.';
  if (/sku_series_next/.test(m)) return 'המספר הבא: מ-1 עד 999999.';
  if (/sku_series_name/.test(m)) return 'שם לסדרה — למשל "תכשיטים".';
  if (/sku_series_full/.test(m)) return 'נגמרו המספרים בסדרה — מגדילים את מספר הספרות.';
  if (/sku_series_closed/.test(m)) return 'הסדרה סגורה — פותחים אותה בעריכת הסדרה.';
  return null;
}

// ---- SKU series ("מק״ט מונה", 2.93 — T12ג) ---------------------------------------------------------------------------------
/**
 * A series is a category of SKUs with its own prefix and counter: "תכשיטים" → JW-0001, JW-0002… The database hands out the next
 * free code (sku_next — under the catalog's code lock, never one a product or a variant has); the editor puts it in the SKU field.
 */
export interface SkuSeries { id: string; name: string; prefix: string; digits: number; nextNo: number; active: boolean }
export const toSkuSeries = (r: any): SkuSeries => ({
  id: str(r.id), name: str(r.name), prefix: str(r.prefix), digits: num(r.digits, 4), nextNo: num(r.next_no, 1), active: r.active !== false,
});
export const SKU_LIMITS = { name: 40, prefix: 6, digitsMin: 3, digitsMax: 6, next: 999999 } as const;
/** "JW-0001" — the shape of a code of a series (the database's: prefix || '-' || lpad(n, digits)) */
export const skuCode = (prefix: string, n: number, digits: number) => `${prefix}-${String(n).padStart(digits, '0')}`;
/** a prefix as typed: capitals, no spaces */
export const skuPrefix = (raw: string) => raw.replace(/\s+/g, '').toUpperCase();
/** what the next code of a series looks like (the database may skip one a product already has) */
export const nextSkuPreview = (s: Pick<SkuSeries, 'prefix' | 'nextNo' | 'digits'>) => skuCode(s.prefix, s.nextNo, s.digits);
/** a series' fields, the first problem in Hebrew (the same rules as sku_series_save) */
export function skuSeriesError(d: { name: string; prefix: string; digits: number; next: number }): string | null {
  if (!d.name.trim()) return 'שם לסדרה — למשל "תכשיטים".';
  if (d.name.trim().length > SKU_LIMITS.name) return `שם הסדרה — עד ${SKU_LIMITS.name} תווים.`;
  if (!/^[A-Z0-9]{1,6}$/.test(skuPrefix(d.prefix))) return 'קידומת: 1–6 אותיות באנגלית או ספרות (למשל JW).';
  if (!(Number.isInteger(d.digits) && d.digits >= SKU_LIMITS.digitsMin && d.digits <= SKU_LIMITS.digitsMax)) return 'מספר הספרות: 3 עד 6.';
  if (!(Number.isInteger(d.next) && d.next >= 1 && d.next <= SKU_LIMITS.next)) return 'המספר הבא: מ-1 עד 999999.';
  if (d.next > 10 ** d.digits - 1) return `עם ${d.digits} ספרות המספר הגבוה הוא ${10 ** d.digits - 1}.`;
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
