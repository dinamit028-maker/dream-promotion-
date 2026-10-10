import type { Cart, CartResult, CheckoutStart, CollectionCard, HostInfo, OrderRequestResult, OrderView, Page, PaylinkAccount, PaylinkStatus, PaylinkView, PaymentAccount, Product, ProductList, ProductQuery, Sitemap, StoreAny } from './types';

/**
 * The storefront's only door to the database: the sf_* functions (migrations 20261005003400 and 20261006003500), from the
 * server only.
 * - On Vercel: Supabase's REST API with a server key (SUPABASE_URL + SUPABASE_SECRET_KEY) — a role that may run sf_* and
 *   nothing of the dashboard's code. No table is ever read from here: tests/unit/no-tables.test.ts checks the source.
 * - In the local tests (SF_DATA=pg, never on Vercel): the same functions through a Postgres connection as service_role,
 *   so the browser tests exercise the real SQL end to end.
 */
type Args = Record<string, unknown>;
type Rpc = (fn: SfFunction, args: Args) => Promise<unknown>;
type SfFunction = 'sf_resolve_host' | 'sf_domain_seen' | 'sf_store' | 'sf_products' | 'sf_product' | 'sf_collections' | 'sf_page' | 'sf_redirect' | 'sf_sitemap'
  | 'sf_cart' | 'sf_cart_set' | 'sf_cart_coupon' | 'sf_checkout_start' | 'sf_order_page' | 'sf_payment_account' | 'sf_payment_event'
  | 'sf_order_paid' | 'sf_order_failed' | 'sf_order' | 'sf_order_by_id' | 'sf_orders_unconfirmed' | 'sf_rate_hit'
  | 'sf_order_request' | 'sf_order_request_by_id' | 'sf_order_request_by_number'
  | 'sf_resolve_slug' | 'sf_slug_seen' | 'sf_store_unlock'
  | 'sf_paylink' | 'sf_paylink_page' | 'sf_paylink_event' | 'sf_paylink_paid' | 'sf_paylink_failed' | 'sf_paylinks_unconfirmed'
  | 'sf_paylink_account' | 'sf_paylink_verified';

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
const CASTS: Record<string, string> = {
  p_store: 'uuid', p_opts: 'jsonb', p_preview: 'boolean', p_host: 'text', p_slug: 'text', p_kind: 'text', p_path: 'text',
  p_cart: 'text', p_item: 'uuid', p_variant: 'uuid', p_qty: 'int', p_mode: 'text', p_code: 'text', p_order_token: 'text',
  p_customer: 'jsonb', p_ip_hash: 'text', p_order: 'uuid', p_page: 'text', p_provider: 'text', p_key: 'text',
  p_signature_ok: 'boolean', p_payload: 'jsonb', p_txn: 'text', p_amount: 'numeric', p_currency: 'text', p_reason: 'text',
  p_limit: 'int', p_window: 'int', p_max: 'int', p_number: 'int', p_email: 'text', p_note: 'text',
  p_request: 'uuid', p_url: 'text', p_business: 'uuid', p_sealed: 'text',
};
/** the functions that return text (the rest return JSON) */
const TEXT_RESULT = new Set<SfFunction>(['sf_redirect', 'sf_store_unlock', 'sf_paylink_page']);

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
    if (r == null || r === '') return null;          // a function that returns nothing (void)
    return TEXT_RESULT.has(fn) ? r : JSON.parse(String(r));
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
  /** 2.57.1: <slug>.<STORE_ROOT_DOMAIN> — the store, and whether its own domain (once working) is the primary address */
  resolveSlug: (slug: string) => call<HostInfo>('sf_resolve_slug', { p_slug: slug }),
  slugSeen: (slug: string) => call<null>('sf_slug_seen', { p_slug: slug }),
  /** a password typed on "בקרוב": the key to sign the cookie with when it is right, else null */
  storeUnlock: (store: string, password: string) => call<string>('sf_store_unlock', { p_store: store, p_password: password }),
  store: (store: string, preview: boolean) => call<StoreAny>('sf_store', { p_store: store, p_preview: preview }),
  products: (store: string, q: ProductQuery, preview: boolean) => call<ProductList>('sf_products', { p_store: store, p_opts: toOpts(q), p_preview: preview }),
  product: (store: string, slug: string, preview: boolean) => call<Product>('sf_product', { p_store: store, p_slug: slug, p_preview: preview }),
  collections: (store: string, preview: boolean) => call<CollectionCard[]>('sf_collections', { p_store: store, p_preview: preview }),
  page: (store: string, kind: 'page' | 'policy', slug: string, preview: boolean) => call<Page>('sf_page', { p_store: store, p_kind: kind, p_slug: slug, p_preview: preview }),
  redirect: (store: string, path: string) => call<string>('sf_redirect', { p_store: store, p_path: path }),
  sitemap: (store: string) => call<Sitemap>('sf_sitemap', { p_store: store }),
  // stage 3: the cart, the checkout and the payment (the amount is always the database's)
  cart: (store: string, cart: string, preview: boolean) => call<Cart>('sf_cart', { p_store: store, p_cart: cart, p_preview: preview }),
  cartSet: (store: string, cart: string, item: string, variant: string | null, qty: number, mode: 'set' | 'add', preview: boolean) =>
    call<CartResult>('sf_cart_set', { p_store: store, p_cart: cart, p_item: item, p_variant: variant, p_qty: qty, p_mode: mode, p_preview: preview }),
  cartCoupon: (store: string, cart: string, code: string, preview: boolean) =>
    call<CartResult>('sf_cart_coupon', { p_store: store, p_cart: cart, p_code: code, p_preview: preview }),
  checkoutStart: (store: string, cart: string, orderToken: string, customer: Record<string, string>, ipHash: string, preview: boolean) =>
    call<CheckoutStart>('sf_checkout_start', { p_store: store, p_cart: cart, p_order_token: orderToken, p_customer: customer, p_ip_hash: ipHash, p_preview: preview }),
  orderPage: (store: string, order: string, page: string) => call<null>('sf_order_page', { p_store: store, p_order: order, p_page: page }),
  paymentAccount: (store: string) => call<PaymentAccount>('sf_payment_account', { p_store: store }),
  paymentEvent: (store: string, order: string | null, provider: string, key: string, kind: 'callback' | 'return' | 'verify' | 'poll',
                 signatureOk: boolean | null, payload: Record<string, unknown>) =>
    call<boolean>('sf_payment_event', { p_store: store, p_order: order, p_provider: provider, p_key: key, p_kind: kind, p_signature_ok: signatureOk, p_payload: payload }),
  orderPaid: (store: string, order: string, provider: string, txn: string, amount: number, currency: string) =>
    call<{ result: string; status?: string }>('sf_order_paid', { p_store: store, p_order: order, p_provider: provider, p_txn: txn, p_amount: amount, p_currency: currency }),
  orderFailed: (store: string, order: string, reason: string) =>
    call<{ result: string; status?: string }>('sf_order_failed', { p_store: store, p_order: order, p_reason: reason }),
  order: (store: string, orderToken: string) => call<OrderView>('sf_order', { p_store: store, p_order_token: orderToken }),
  orderById: (store: string, order: string) => call<OrderView>('sf_order_by_id', { p_store: store, p_order: order }),
  ordersUnconfirmed: (limit = 50) => call<{ store: string; id: string }[]>('sf_orders_unconfirmed', { p_limit: limit }),
  /** stage 4: the customer asks to cancel or return (recorded on the order; no money moves by itself) */
  orderRequest: (store: string, orderToken: string, kind: 'cancel' | 'return', note: string) =>
    call<OrderRequestResult>('sf_order_request', { p_store: store, p_order_token: orderToken, p_kind: kind, p_note: note }),
  orderRequestById: (store: string, order: string, kind: 'cancel' | 'return', note: string) =>
    call<OrderRequestResult>('sf_order_request_by_id', { p_store: store, p_order: order, p_kind: kind, p_note: note }),
  orderRequestByNumber: (store: string, num: number, email: string, kind: 'cancel' | 'return', note: string) =>
    call<OrderRequestResult>('sf_order_request_by_number', { p_store: store, p_number: num, p_email: email, p_kind: kind, p_note: note }),
  rateHit: (key: string, windowSeconds: number, max: number) => call<boolean>('sf_rate_hit', { p_key: key, p_window: windowSeconds, p_max: max }),
  // payment links (migration 4300): the dashboard's server asks for a page, the provider's answer settles it
  paylink: (request: string) => call<PaylinkView>('sf_paylink', { p_request: request }),
  /** 'ok' | 'closed' | 'too_many' | 'bad' | 'not_found' */
  paylinkPage: (request: string, page: string, url: string) => call<string>('sf_paylink_page', { p_request: request, p_page: page, p_url: url }),
  paylinkEvent: (request: string, provider: string, key: string, kind: 'callback' | 'verify' | 'poll', signatureOk: boolean | null,
                 payload: Record<string, unknown>) =>
    call<boolean>('sf_paylink_event', { p_request: request, p_provider: provider, p_key: key, p_kind: kind, p_signature_ok: signatureOk, p_payload: payload }),
  paylinkPaid: (request: string, page: string, provider: string, txn: string, amount: number, currency: string) =>
    call<{ result: 'ok' | 'already' | 'double' | 'mismatch' | 'rejected' | 'not_found'; status?: PaylinkStatus; test?: boolean; late?: boolean }>(
      'sf_paylink_paid', { p_request: request, p_page: page, p_provider: provider, p_txn: txn, p_amount: amount, p_currency: currency }),
  paylinkFailed: (request: string, page: string, reason: string) =>
    call<{ result: 'ok' | 'ignored' | 'not_found'; status?: PaylinkStatus }>('sf_paylink_failed', { p_request: request, p_page: page, p_reason: reason }),
  paylinksUnconfirmed: (limit = 50) => call<string[]>('sf_paylinks_unconfirmed', { p_limit: limit }),
  paylinkAccount: (business: string) => call<PaylinkAccount>('sf_paylink_account', { p_business: business }),
  paylinkVerified: (business: string, sealed: string) => call<boolean>('sf_paylink_verified', { p_business: business, p_sealed: sealed }),
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
