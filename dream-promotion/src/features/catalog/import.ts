import { LIMITS, QUOTE_CURRENCIES, draftError, emptyDraft, isSlug, slugify, uniqueSlug, type ItemDraft, type ItemKind } from './catalog';

/**
 * "ייבוא מוצרים מקובץ" (2.102): a table of products (products.csv — Excel's "CSV UTF-8"), alone or in a ZIP with their pictures.
 * Only adds: a row whose SKU is already a product's or a variant's is left as it is — never updated, never deleted. Every row
 * passes the editor's own rules (draftError) and becomes its columns the editor's way (itemColumns), so an imported product is
 * the same as one typed in ProductEditor. Pure (no database, no browser) — tests/catalog-import.test.ts.
 */

/** the columns a file may have — the English key or its Hebrew name */
export const IMPORT_COLUMNS = {
  sku: ['sku', 'מק"ט', 'מק״ט', 'מקט'],
  name: ['name', 'שם'],
  kind: ['kind', 'סוג'],
  price: ['price', 'מחיר', 'מחיר בקופה'],
  description: ['description', 'תיאור'],
  tags: ['tags', 'תגיות'],
  publish: ['publish', 'באתר', 'פרסום באתר'],
  slug: ['slug', 'כתובת'],
  quote: ['quote', 'הצעת מחיר'],
  quote_from: ['quote_from', 'החל מ-', 'החל מ'],
  quote_currency: ['quote_currency', 'מטבע'],
  quote_min_qty: ['quote_min_qty', 'כמות מינימום'],
  image: ['image', 'תמונה'],
} as const;
export type ImportColumn = keyof typeof IMPORT_COLUMNS;
export const IMPORT_MAX_ROWS = 500;

/** one row to add: the editor's draft, the picture's file (in the ZIP), and its line in the file (for the messages) */
export interface ImportRow { line: number; draft: ItemDraft; image: string }
export interface ImportPlan {
  add: ImportRow[];
  /** already in the catalog (the same SKU) — left as they are */
  skip: { line: number; sku: string; name: string }[];
  errors: { line: number; message: string }[];
  /** pictures named in the file that are not in the ZIP (the product is added without one) */
  missingImages: string[];
}

/** RFC 4180: commas, "quoted, fields", "" for a quote, line breaks inside quotes; a BOM and \r\n are fine */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const norm = (h: string) => h.replace(/\s+/g, ' ').trim().toLowerCase();
/** which column is which: the header's names → their keys (an unknown column is left out) */
export function headerMap(header: string[]): Partial<Record<ImportColumn, number>> {
  const out: Partial<Record<ImportColumn, number>> = {};
  header.forEach((h, i) => {
    const n = norm(h);
    for (const [key, names] of Object.entries(IMPORT_COLUMNS) as [ImportColumn, readonly string[]][]) {
      if (out[key] === undefined && names.some((x) => norm(x) === n)) out[key] = i;
    }
  });
  return out;
}

const YES = new Set(['1', 'yes', 'y', 'true', 'כן', 'v', '✓', 'x']);
const KIND_OF: Record<string, ItemKind> = { product: 'product', 'מוצר': 'product', service: 'service', 'שירות': 'service', 'טיפול': 'service', other: 'other', 'אחר': 'other' };
/** "path/to/bag-001.webp" → "bag-001.webp" (a picture is matched by its file name, in any folder of the ZIP) */
export const fileName = (p: string) => p.replace(/\\/g, '/').split('/').pop()!.trim().toLowerCase();

/**
 * The file's rows → what will be added, what is already there, and what is wrong (by line). takenSkus: every SKU of the
 * catalog (items and variants, any case); takenSlugs: every product's address; images: the pictures' file names in the ZIP.
 */
export function planImport(table: string[][], ctx: { takenSkus: Iterable<string>; takenSlugs: Iterable<string>; images?: Iterable<string> }): ImportPlan {
  const plan: ImportPlan = { add: [], skip: [], errors: [], missingImages: [] };
  if (!table.length) { plan.errors.push({ line: 1, message: 'הקובץ ריק.' }); return plan; }
  const map = headerMap(table[0]);
  if (map.name === undefined) { plan.errors.push({ line: 1, message: 'חסרה עמודת "name" (שם המוצר) בשורה הראשונה.' }); return plan; }
  if (table.length - 1 > IMPORT_MAX_ROWS) { plan.errors.push({ line: 1, message: `עד ${IMPORT_MAX_ROWS} מוצרים בקובץ אחד.` }); return plan; }
  const skus = new Set([...ctx.takenSkus].map((x) => x.trim().toLowerCase()).filter(Boolean));
  const slugs = new Set(ctx.takenSlugs);
  const images = ctx.images ? new Set([...ctx.images].map(fileName)) : null;
  const seen = new Set<string>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (k: ImportColumn) => (map[k] === undefined ? '' : String(cells[map[k]!] ?? '').trim());
    const name = get('name').replace(/\s+/g, ' ');
    const sku = get('sku');
    if (!name && !sku) return;
    if (sku && skus.has(sku.toLowerCase())) { plan.skip.push({ line, sku, name }); return; }
    if (sku && seen.has(sku.toLowerCase())) { plan.errors.push({ line, message: `המק״ט "${sku}" מופיע בקובץ יותר מפעם אחת.` }); return; }
    const kindRaw = get('kind').toLowerCase();
    const kind = kindRaw ? KIND_OF[kindRaw] : 'product';
    if (!kind) { plan.errors.push({ line, message: `סוג לא מוכר: "${get('kind')}" (מוצר / שירות / אחר).` }); return; }
    const currency = get('quote_currency').toUpperCase().replace(/^₪$|^ILS$/, '').replace(/^\$$/, 'USD').replace(/^€$/, 'EUR');
    let slug = get('slug').toLowerCase();
    if (slug && !isSlug(slug)) { plan.errors.push({ line, message: `הכתובת "${slug}" לא תקינה (אותיות, ספרות ומקפים).` }); return; }
    slug = uniqueSlug(slug || slugify(name) || slugify(sku), slugs);
    const draft = emptyDraft({
      name, kind, sku, slug, price: get('price') || '0', description: get('description').replace(/\\n/g, '\n'), tags: get('tags').replace(/[|;]/g, ','),
      publishOnline: YES.has(get('publish').toLowerCase()), quoteMode: YES.has(get('quote').toLowerCase()),
      quoteFrom: get('quote_from').replace(/[$€₪\s]/g, ''), quoteCurrency: QUOTE_CURRENCIES.some((c) => c.id === currency) ? currency : `?${currency}`,
      quoteMinQty: get('quote_min_qty'),
    });
    const e = draftError(draft);
    if (e) { plan.errors.push({ line, message: e }); return; }
    if (draft.tags && draft.tags.split(',').some((t) => t.trim().length > LIMITS.tag)) { plan.errors.push({ line, message: `תגית ארוכה מ-${LIMITS.tag} תווים.` }); return; }
    const image = get('image') ? fileName(get('image')) : '';
    if (image && images && !images.has(image)) plan.missingImages.push(image);
    if (sku) seen.add(sku.toLowerCase());
    slugs.add(slug);
    plan.add.push({ line, draft, image: image && (!images || images.has(image)) ? image : '' });
  });
  return plan;
}

/** the second try of a picture comes after this pause (a server that said "too many" — 120 a minute — is free again) */
export const PICTURE_RETRY_MS = 15_000;

/**
 * The picture of a product the import has just added, with one more try — and never a second copy (2.102.2). The answer of
 * a try can be lost while the picture itself landed (a phone that locked, a connection that dropped on the way back), so
 * before trying again the product's pictures are counted: a new product has none of its own, so a picture there is this one.
 * When they cannot be counted (no connection) there is no second try — the message says to look at the product.
 * `count` → the product's pictures, or null when the database could not be asked.
 */
export async function pictureOnce(
  upload: () => Promise<{ ok: true } | { ok: false; error: string }>,
  count: () => Promise<number | null>,
  wait: (ms: number) => Promise<void>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const first = await upload();
  if (first.ok) return { ok: true };
  await wait(PICTURE_RETRY_MS);
  const before = await count();
  if (before === null) return { ok: false, message: `נוסף, ולא ברור אם התמונה נשמרה (${first.error}) — בדקו במוצר.` };
  if (before > 0) return { ok: true };
  const second = await upload();
  if (second.ok) return { ok: true };
  // the second answer can be lost as well: what is there says
  const after = await count();
  if (after === null) return { ok: false, message: `נוסף, ולא ברור אם התמונה נשמרה (${second.error}) — בדקו במוצר.` };
  return after > 0 ? { ok: true } : { ok: false, message: `נוסף בלי תמונה: ${second.error}` };
}
