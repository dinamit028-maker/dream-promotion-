import type { ProductQuery, Sort } from './types';

/** the shopper's filters, as the address carries them: ?q=&sort=&stock=1&min=&max=&o.מידה=S&o.מידה=M&page=2 */
export const PAGE_SIZE = 24;
const SORTS: readonly Sort[] = ['manual', 'newest', 'price_asc', 'price_desc', 'name'];
export const SORT_LABELS: Record<Sort, string> = {
  manual: 'מומלץ', newest: 'חדש באתר', price_asc: 'מחיר: מהנמוך', price_desc: 'מחיר: מהגבוה', name: 'לפי שם',
};

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const all = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const price = (v: string) => (/^\d{1,7}(\.\d{1,2})?$/.test(v) ? Number(v) : undefined);

export function parseQuery(sp: Params): ProductQuery & { page: number } {
  const options: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (!k.startsWith('o.') || k.length > 42) continue;
    const name = k.slice(2);
    const vals = all(v).map((x) => x.trim()).filter((x) => x && x.length <= 40).slice(0, 20);
    if (name && vals.length) options[name] = Array.from(new Set(vals));
    if (Object.keys(options).length >= 3) break;
  }
  const sort = first(sp.sort) as Sort;
  const page = Math.min(Math.max(parseInt(first(sp.page), 10) || 1, 1), 200);
  return {
    q: first(sp.q).trim().slice(0, 80) || undefined,
    sort: SORTS.includes(sort) ? sort : undefined,
    in_stock: first(sp.stock) === '1' || undefined,
    min_price: price(first(sp.min)),
    max_price: price(first(sp.max)),
    options: Object.keys(options).length ? options : undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    page,
  };
}

/** the same list on another page (the filters kept) */
export function pageHref(path: string, sp: Params, page: number): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (k !== 'page') for (const x of all(v)) u.append(k, x);
  if (page > 1) u.set('page', String(page));
  const s = u.toString();
  return s ? `${path}?${s}` : path;
}
