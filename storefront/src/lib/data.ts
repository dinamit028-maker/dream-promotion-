import type { CollectionCard, HostInfo, Page, Product, ProductList, ProductQuery, Sitemap, StoreAny } from './types';

/**
 * The storefront's only door to the database: the sf_* functions (migration 20261005003400), from the server only.
 * - On Vercel: Supabase's REST API with a server key (SUPABASE_URL + SUPABASE_SECRET_KEY) — a role that may run sf_* and
 *   nothing of the dashboard's code. No table is ever read from here: tests/unit/no-tables.test.ts checks the source.
 * - In the local tests (SF_DATA=pg, never on Vercel): the same functions through a Postgres connection as service_role,
 *   so the browser tests exercise the real SQL end to end.
 */
type Args = Record<string, unknown>;
type Rpc = (fn: SfFunction, args: Args) => Promise<unknown>;
type SfFunction = 'sf_resolve_host' | 'sf_domain_seen' | 'sf_store' | 'sf_products' | 'sf_product' | 'sf_collections' | 'sf_page' | 'sf_redirect' | 'sf_sitemap';

export class DataError extends Error {}

function restRpc(url: string, key: string): Rpc {
  const base = url.replace(/\/+$/, '');
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;   // a legacy JWT key; the new secret keys go in apikey only
  return async (fn, args) => {
    const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers, body: JSON.stringify(args), cache: 'no-store', signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new DataError(`${fn}: ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
}

/** argument types the functions declare, for the pg path (named notation, explicit casts) */
const CASTS: Record<string, string> = { p_store: 'uuid', p_opts: 'jsonb', p_preview: 'boolean', p_host: 'text', p_slug: 'text', p_kind: 'text', p_path: 'text' };

function pgRpc(connectionString: string): Rpc {
  let pool: Promise<{ query: (sql: string, values: unknown[]) => Promise<{ rows: { r: unknown }[] }> }> | null = null;
  const getPool = () => (pool ??= (async () => {
    const pg = await import('pg');
    const Pool = (pg.default ?? pg).Pool;
    return new Pool({ connectionString, max: 4, options: '-c role=service_role' });
  })());
  return async (fn, args) => {
    const names = Object.keys(args);
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}::${CASTS[n] ?? 'text'}`).join(', ')})::text as r`;
    const values = names.map((n) => (CASTS[n] === 'jsonb' ? JSON.stringify(args[n] ?? {}) : args[n]));
    const { rows } = await (await getPool()).query(sql, values);
    const r = rows[0]?.r;
    if (r == null) return null;
    return fn === 'sf_redirect' ? r : JSON.parse(String(r));
  };
}

let rpc: Rpc | null = null;
function client(): Rpc {
  if (rpc) return rpc;
  if (process.env.SF_DATA === 'pg') {
    if (process.env.VERCEL) throw new DataError('SF_DATA=pg is for the local tests only');
    rpc = pgRpc(process.env.SF_DATABASE_URL ?? '');
  } else {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new DataError('SUPABASE_URL / SUPABASE_SECRET_KEY are not set');
    rpc = restRpc(url, key);
  }
  return rpc;
}

const call = <T>(fn: SfFunction, args: Args) => client()(fn, args) as Promise<T | null>;

export const data = {
  resolveHost: (host: string) => call<HostInfo>('sf_resolve_host', { p_host: host }),
  domainSeen: (host: string) => call<null>('sf_domain_seen', { p_host: host }),
  store: (store: string, preview: boolean) => call<StoreAny>('sf_store', { p_store: store, p_preview: preview }),
  products: (store: string, q: ProductQuery, preview: boolean) => call<ProductList>('sf_products', { p_store: store, p_opts: toOpts(q), p_preview: preview }),
  product: (store: string, slug: string, preview: boolean) => call<Product>('sf_product', { p_store: store, p_slug: slug, p_preview: preview }),
  collections: (store: string, preview: boolean) => call<CollectionCard[]>('sf_collections', { p_store: store, p_preview: preview }),
  page: (store: string, kind: 'page' | 'policy', slug: string, preview: boolean) => call<Page>('sf_page', { p_store: store, p_kind: kind, p_slug: slug, p_preview: preview }),
  redirect: (store: string, path: string) => call<string>('sf_redirect', { p_store: store, p_path: path }),
  sitemap: (store: string) => call<Sitemap>('sf_sitemap', { p_store: store }),
};

/** the query of a list, as sf_products reads it (strings for numbers: the function parses them itself) */
export function toOpts(q: ProductQuery): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (q.collection) o.collection = q.collection;
  if (q.q) o.q = q.q;
  if (q.sort) o.sort = q.sort;
  if (q.in_stock) o.in_stock = '1';
  if (q.min_price != null) o.min_price = String(q.min_price);
  if (q.max_price != null) o.max_price = String(q.max_price);
  if (q.options && Object.keys(q.options).length) o.options = q.options;
  if (q.limit != null) o.limit = String(q.limit);
  if (q.offset != null) o.offset = String(q.offset);
  return o;
}
