import type { MenuEntry } from './menu-search';

/**
 * Favorites in the menu (2.96, docs/FINANCE_ADDITIONS_HE.md T11): a star next to a screen of the menu puts it in "מועדפים" — at the top
 * of the menu and on the home screen. Kept with the person (their account's own data, user_metadata.dp_favorites — on every device
 * they sign in with; not a business's data, so nothing of a business is in it). Only addresses of screens the person sees now are
 * shown: a favorite of a screen this business does not have (or no longer has) stays hidden, never a link to nowhere.
 */
export const FAV_KEY = 'dp_favorites';
export const MAX_FAVORITES = 12;
const PATH = /^\/[a-z0-9/_-]{0,80}(\?[a-z0-9=&_-]{0,80})?$/;

/** what was saved → a clean list: addresses of the app only, once each, at most 12 */
export function parseFavorites(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) if (typeof x === 'string' && PATH.test(x) && !x.includes('//') && !out.includes(x)) out.push(x);
  return out.slice(0, MAX_FAVORITES);
}
export type ToggleResult = { list: string[]; full: boolean };
/** a star: on → at the end of the list; off → out of it. A full list stays as it was (and says so) */
export function toggleFavorite(list: string[], href: string): ToggleResult {
  if (list.includes(href)) return { list: list.filter((x) => x !== href), full: false };
  if (list.length >= MAX_FAVORITES || !PATH.test(href)) return { list, full: list.length >= MAX_FAVORITES };
  return { list: [...list, href], full: false };
}
/** the favorites to show: in the order they were starred, only screens the person sees now */
export function favoriteEntries(list: string[], entries: MenuEntry[]): MenuEntry[] {
  const by = new Map(entries.map((e) => [e.href, e]));
  return list.map((h) => by.get(h)).filter((e): e is MenuEntry => Boolean(e));
}
