import { Plus, ShoppingBag, Storefront } from '@/components/ui/Icon';
import type { ModuleConfig } from '@/components/shell/module-nav';
import { storeHref } from './routes';

/** "חנות" as an app of its own (2.54, ModuleShell) — stage 1: the products, the same ones as the register and finance */
export const STORE_MODULE: ModuleConfig = {
  id: 'store',
  name: 'חנות',
  theme: 'module-store',
  home: storeHref('products'),
  Icon: Storefront,
  groups: [{ id: 'products', label: 'מוצרים', Icon: ShoppingBag, links: [{ href: storeHref('products'), label: 'מוצרים', Icon: ShoppingBag }] }],
  tabs: [{ href: storeHref('products'), label: 'מוצרים', Icon: ShoppingBag }],
  actions: [{ id: 'product', label: 'מוצר חדש', Icon: Plus, href: storeHref('products', { new: '1' }) }],
};
