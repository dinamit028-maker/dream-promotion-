/**
 * The store module's addresses (Dream Commerce, 2.54 — stage 1: products). Pure functions: the shell decides by them
 * whether the store opens as an app of its own (ModuleShell). The next stages add orders, design, settings…
 * (docs/DREAM_COMMERCE_ARCHITECTURE.md §5.1).
 */
export type StoreSection = 'products';
export const STORE_SECTIONS: readonly { id: StoreSection; path: string; label: string }[] = [
  { id: 'products', path: '/store/products', label: 'מוצרים' },
];
const trim = (p: string) => p.replace(/\/+$/, '') || '/';
/** /store and everything under it */
export const isStorePath = (pathname: string) => { const p = trim(pathname); return p === '/store' || p.startsWith('/store/'); };
export function storeHref(section: StoreSection, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params).toString();
  return `${STORE_SECTIONS.find((s) => s.id === section)?.path ?? '/store/products'}${q ? `?${q}` : ''}`;
}
/** one product's page (the editor); "new" = a new product */
export const productHref = (id: string) => `/store/products/${encodeURIComponent(id)}`;
