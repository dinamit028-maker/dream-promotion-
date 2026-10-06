/**
 * The store module's addresses (Dream Commerce). Pure functions: the shell decides by them whether the store opens as an
 * app of its own (ModuleShell). 2.54: products; 2.55: collections, design, pages, menus, settings (with the domain).
 * 2.56: orders, selling on the site (the terminal, pickup / delivery) and coupons (DREAM_COMMERCE_ARCHITECTURE §5.1).
 */
export type StoreSection = 'products' | 'collections' | 'design' | 'pages' | 'navigation' | 'settings' | 'orders' | 'selling' | 'coupons';
export const STORE_SECTIONS: readonly { id: StoreSection; path: string; label: string }[] = [
  { id: 'products', path: '/store/products', label: 'מוצרים' },
  { id: 'collections', path: '/store/collections', label: 'קולקציות' },
  { id: 'design', path: '/store/design', label: 'עיצוב' },
  { id: 'pages', path: '/store/pages', label: 'עמודים' },
  { id: 'navigation', path: '/store/navigation', label: 'תפריטים' },
  { id: 'settings', path: '/store/settings', label: 'הגדרות ודומיין' },
  { id: 'orders', path: '/store/orders', label: 'הזמנות' },
  { id: 'selling', path: '/store/selling', label: 'מכירה באתר' },
  { id: 'coupons', path: '/store/coupons', label: 'קופונים' },
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
/** one order's page */
export const orderHref = (id: string) => `/store/orders/${encodeURIComponent(id)}`;
