import type { ComponentType } from 'react';
import {
  House, PencilSimpleLine, FilmSlate, SquaresFour, CalendarBlank, Images, Compass, Megaphone,
  UsersThree, ChartLineUp, PlugsConnected, GearSix, ShieldCheck, CalendarCheck, IdentificationBadge, CashRegister, Wallet, Storefront, ClipboardText,
  Package,
} from '@/components/ui/Icon';

/**
 * The app's own menu (AppShell): every screen of Dream outside the modules that open as apps of their own. Pure — the search in
 * the menu and the favorites read the same list (menu-search.ts), so a screen added here is found and can be starred.
 */
export type NavItem = { href: string; label: string; Icon: ComponentType<any> };

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'בית', Icon: House },
  { href: '/create', label: 'יצירה', Icon: PencilSimpleLine },
  { href: '/reels', label: 'אולפן רילס', Icon: FilmSlate },
  { href: '/content', label: 'תוכן', Icon: SquaresFour },
  { href: '/calendar', label: 'יומן', Icon: CalendarBlank },
  { href: '/media', label: 'מדיה', Icon: Images },
  { href: '/strategy', label: 'אסטרטגיה', Icon: Compass },
  { href: '/ads', label: 'קמפיינים', Icon: Megaphone },
  { href: '/leads', label: 'לקוחות', Icon: UsersThree },
  { href: '/appointments', label: 'תורים', Icon: CalendarCheck },
  { href: '/declarations', label: 'הצהרות בריאות', Icon: ClipboardText },
  { href: '/register', label: 'קופה', Icon: CashRegister },
  { href: '/finance', label: 'כספים', Icon: Wallet },
  { href: '/store/products', label: 'חנות', Icon: Storefront },
  { href: '/attendance', label: 'נוכחות', Icon: IdentificationBadge },
  { href: '/analytics', label: 'ביצועים', Icon: ChartLineUp },
];
export const NAV_BOTTOM_ALL: NavItem[] = [
  { href: '/integrations', label: 'חיבורים', Icon: PlugsConnected },
  { href: '/settings', label: 'הגדרות', Icon: GearSix },
];
/** internal screen, only for ADMIN_EMAILS (the server checks again) */
export const NAV_ADMIN: NavItem = { href: '/admin', label: 'ניהול', Icon: ShieldCheck };
/** stock by location (T12ב) — in the menu only with more than one active location; with one, the register opens its counts */
export const NAV_STOCK: NavItem = { href: '/stock', label: 'מלאי', Icon: Package };
/** the menu: "מלאי" right after "קופה" when the business works in more than one location */
export const withStock = (multi: boolean) => (multi ? NAV.flatMap((n) => (n.href === '/register' ? [n, NAV_STOCK] : [n])) : NAV);
