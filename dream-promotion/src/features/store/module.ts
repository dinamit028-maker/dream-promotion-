import { FileText, GearSix, List, MagicWand, Plus, ShoppingBag, SquaresFour, Storefront } from '@/components/ui/Icon';
import type { ModuleConfig } from '@/components/shell/module-nav';
import { storeHref } from './routes';

/**
 * "חנות" as an app of its own (ModuleShell): the products — the same ones as the register and finance (2.54) — and the
 * site itself (2.55): collections, design, pages, menus, settings and the domain.
 */
export const STORE_MODULE: ModuleConfig = {
  id: 'store',
  name: 'חנות',
  theme: 'module-store',
  home: storeHref('products'),
  Icon: Storefront,
  groups: [
    { id: 'catalog', label: 'מוצרים', Icon: ShoppingBag, links: [
      { href: storeHref('products'), label: 'מוצרים', Icon: ShoppingBag },
      { href: storeHref('collections'), label: 'קולקציות', Icon: SquaresFour },
    ] },
    { id: 'site', label: 'האתר', Icon: MagicWand, links: [
      { href: storeHref('design'), label: 'עיצוב', Icon: MagicWand },
      { href: storeHref('pages'), label: 'עמודים', Icon: FileText },
      { href: storeHref('navigation'), label: 'תפריטים', Icon: List },
    ] },
    { id: 'settings', label: 'הגדרות ודומיין', Icon: GearSix, links: [{ href: storeHref('settings'), label: 'הגדרות ודומיין', Icon: GearSix }] },
  ],
  tabs: [
    { href: storeHref('products'), label: 'מוצרים', Icon: ShoppingBag },
    { href: storeHref('collections'), label: 'קולקציות', Icon: SquaresFour },
    { href: storeHref('design'), label: 'עיצוב', Icon: MagicWand },
    { href: storeHref('settings'), label: 'הגדרות', Icon: GearSix },
  ],
  actions: [
    { id: 'product', label: 'מוצר חדש', Icon: Plus, href: storeHref('products', { new: '1' }) },
    { id: 'collection', label: 'קולקציה חדשה', Icon: SquaresFour, href: storeHref('collections', { new: '1' }) },
    { id: 'page', label: 'עמוד חדש', Icon: FileText, href: storeHref('pages', { new: '1' }) },
  ],
};
