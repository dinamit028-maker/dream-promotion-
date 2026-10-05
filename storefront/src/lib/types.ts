/** What the database's sf_* functions return (migration 20261005003400) — the storefront's whole view of a store. */

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
