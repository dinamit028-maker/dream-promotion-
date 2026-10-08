import { unstable_cache } from 'next/cache';
import { data } from './data';

/**
 * 2.74 — what shoppers read again and again, kept for a few minutes: a store's details (its theme, menus and contact), its
 * collections, a page or a policy, and its sitemap. Only for shoppers — a preview, a draft behind its password and the
 * visual editor always read the database. Never kept: a product and its stock, prices, the cart, the payment, the domain
 * (DREAM_COMMERCE_ARCHITECTURE.md §6.1 — availability and the amount to pay are read at every request).
 * Every entry carries the tag store:<id>; the dashboard asks for it to be dropped after a change the shoppers see (a signed
 * request: api/revalidate), and CACHE_SECONDS is the longest anything else (a price changed at the register, a business
 * detail) can stay old.
 */
export const CACHE_SECONDS = 300;
export const storeTag = (store: string) => `store:${store}`;

const keep = <A extends string[], R>(name: string, read: (...a: A) => Promise<R>) =>
  (...a: A): Promise<R> => unstable_cache(() => read(...a), [name, ...a], { tags: [storeTag(a[0])], revalidate: CACHE_SECONDS })();

const store = keep('store', (id: string) => data.store(id, false));
const collections = keep('collections', (id: string) => data.collections(id, false));
const page = keep('page', (id: string, kind: string, slug: string) => data.page(id, kind as 'page' | 'policy', slug, false));
const sitemap = keep('sitemap', (id: string) => data.sitemap(id));

/** the same reads as `data`, kept for shoppers; a preview reads the database */
export const shared = {
  store: (id: string, preview: boolean) => (preview ? data.store(id, true) : store(id)),
  collections: (id: string, preview: boolean) => (preview ? data.collections(id, true) : collections(id)),
  page: (id: string, kind: 'page' | 'policy', slug: string, preview: boolean) => (preview ? data.page(id, kind, slug, true) : page(id, kind, slug)),
  sitemap: (id: string) => sitemap(id),
};
