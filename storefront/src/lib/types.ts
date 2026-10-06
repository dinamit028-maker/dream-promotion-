/** What the database's sf_* functions return (migrations 20261005003400, 20261006003500) — the storefront's whole view of a store. */

export type StoreStatus = 'draft' | 'published' | 'paused';

export interface HostInfo { store: string; status: StoreStatus; primary: boolean; primary_domain: string | null }

export interface Link { label: string; href: string }

export interface StoreLite {
  id: string; status: StoreStatus; name: string; lang: 'he' | 'en'; logo_url: string; primary_domain: string | null;
}

export interface Store extends StoreLite {
  template: string; currency: string; country: string; description: string;
  contact: { phone: string; whatsapp: string; email: string; address: string };
  ga4_id: string; gsc_code: string; show_stock_count: boolean;
  theme: { version: number | null; settings: unknown };
  legal: { name: string; number: string; number_kind: 'company' | 'dealer'; address: string };
  menus: { main: Link[]; footer: Link[] };
  policies: { policy: PolicyKind; title: string }[];
  collections: { slug: string; title: string; image_url: string }[];
  can_buy: boolean;          // sells on the site (stage 3): a cart in the header, "הוספה לסל" on a product
}

/** the store as sf_store returns it: whole when it may be shown, only its name when it is not on the air */
export type StoreAny = Store | StoreLite;
export const isFullStore = (s: StoreAny): s is Store => 'theme' in s;

export type PolicyKind = 'returns' | 'privacy' | 'accessibility' | 'terms' | 'shipping';
export const POLICY_KINDS: readonly PolicyKind[] = ['returns', 'privacy', 'accessibility', 'terms', 'shipping'];

export interface Picture { url: string; sizes: Record<string, string>; alt: string; width?: number | null; height?: number | null }

export interface Card {
  slug: string; name: string; price: number; price_max: number; compare_at: number | null; in_stock: boolean;
  stock: number | null; image: Picture | null;
}

export interface ProductList {
  total: number; sort: Sort; items: Card[];
  facets: { options: Record<string, string[]>; price: { min: number | null; max: number | null } };
  collection: null | { slug: string; title: string; description: string; image_url: string; seo_title: string; seo_description: string; updated_at: string };
}

export type Sort = 'manual' | 'newest' | 'price_asc' | 'price_desc' | 'name';

export interface ProductQuery {
  collection?: string; q?: string; sort?: Sort; in_stock?: boolean; min_price?: number; max_price?: number;
  options?: Record<string, string[]>; limit?: number; offset?: number;
}

export interface Variant {
  id: string; options: [string, string, string]; price: number; compare_at: number | null; in_stock: boolean;
  stock: number | null; sku: string; barcode: string; image: string | null;
}

export interface Product {
  id: string; slug: string; name: string; kind: string; description: string; seo_title: string; seo_description: string;
  price: number; price_max: number; compare_at: number | null; in_stock: boolean; stock: number | null;
  sku: string; barcode: string; tags: string[]; manufacturer: string; country_of_origin: string; updated_at: string;
  images: (Picture & { id?: string; variant?: string | null })[];
  options: { name: string; position: number; values: string[] }[];
  variants: Variant[];
  fields: { label: string; value: string; kind: string }[];
  collection: { slug: string; title: string } | null;
  related: Card[];
  can_buy: boolean;
}

export interface CollectionCard { slug: string; title: string; description: string; image_url: string; count: number }

export interface Page {
  slug: string; kind: 'page' | 'policy'; policy: PolicyKind | null; title: string; body: string;
  seo_title: string; seo_description: string; updated_at: string;
}

export interface Sitemap {
  store: string;
  products: { slug: string; updated_at: string }[];
  collections: { slug: string; updated_at: string }[];
  pages: { kind: 'page' | 'policy'; slug: string; policy: PolicyKind | null; updated_at: string }[];
}

// ---- stage 3: cart, checkout, orders --------------------------------------------------------------------------------------
export type LineProblem = 'gone' | 'out' | 'short';
export interface CartLine {
  item: string; variant: string | null; qty: number; slug: string; name: string; variant_label: string; price: number;
  line_total: number | null; image: Picture | null; available: number | null; max: number; problem: LineProblem | null;
}
export type CouponError = 'not_found' | 'not_started' | 'ended' | 'used_up' | 'min_subtotal';
export interface Cart {
  lines: CartLine[]; count: number; subtotal: number; discount: number; currency: string; problems: number;
  coupon: null | { code: string; discount?: number; kind?: 'percent' | 'amount'; value?: number; error?: CouponError; min?: number };
  shipping: {
    pickup: null | { price: number; note: string };
    delivery: null | { price: number; base: number; free_over: number | null; note: string };
  };
  can_checkout: boolean;
  test: boolean;             // the terminal is in test mode: nothing is really charged
}
export interface CartResult { ok: boolean; error?: string; available?: number; max?: number; min?: number; cart?: Cart }

export interface PaymentAccount { provider: 'payplus' | 'mock'; mode: 'test' | 'live'; sealed: string; page_uid: string }

export interface CheckoutStart {
  ok: boolean; error?: string; fields?: string[]; reason?: CouponError; min?: number;
  lines?: { item: string; variant: string | null; name: string; available: number }[];
  order?: {
    id: string; number: number; total: number; currency: string; name: string; email: string; phone: string; expires_at: string;
    lines: { name: string; qty: number; price: number }[]; shipping: number; discount: number;
  };
  account?: PaymentAccount;
}

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded' | 'partially_refunded' | 'test_paid';
export interface OrderView {
  id: string; number: number; status: PaymentStatus; test: boolean; currency: string;
  subtotal: number; discount: number; shipping: number; total: number; coupon: string; method: 'pickup' | 'delivery'; name: string;
  provider: 'payplus' | 'mock'; page: string; created_at: string; expires_at: string; paid_at: string | null;
  lines: { name: string; variant: string; qty: number; price: number; total: number; image: string }[];
  /** stage 4 (migration 3600) — absent before it runs */
  fulfillment?: 'unfulfilled' | 'processing' | 'ready' | 'shipped' | 'delivered' | 'returned'; tracking?: string; tracking_url?: string;
  document?: 'not_required' | 'pending' | 'issued' | 'blocked'; doc_token?: string | null; request?: '' | 'cancel' | 'return';
  refunded?: number; state?: string;
}
export type OrderRequestResult = { ok: true; kind: 'cancel' | 'return'; number?: number } | { ok: false; error: 'bad_request' | 'not_found' | 'not_paid' | 'already'; kind?: string };
