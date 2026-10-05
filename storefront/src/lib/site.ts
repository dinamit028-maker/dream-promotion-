import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { data } from './data';
import { isPlatformHost } from './host';
import { PREVIEW_COOKIE, verifyPreviewToken } from './preview';
import { resolveTheme, type Theme } from './theme';
import { isFullStore, type Store, type StoreAny } from './types';

/**
 * The store of this request. Its id comes only from the Host (a domain of store_domains) — or, on the storefront's own
 * addresses, from a preview token the dashboard signed. Never from the address, a header or a form of the browser.
 */
export interface Site {
  host: string;
  storeId: string;
  preview: boolean;          // a signed token opened the draft (theme, a store that is not on the air)
  platform: boolean;         // the storefront's own address (*.vercel.app): only a preview lives there
  isPrimary: boolean;        // www ↔ the bare name: the other one redirects here
  primaryDomain: string | null;
  origin: string;            // canonical addresses: https://<the primary domain>
  store: StoreAny;
  theme: Theme | null;
  live: boolean;             // may be shown: on the air, or previewed
}

const seen = new Map<string, number>();

export const getSite = cache(async (host: string): Promise<Site | null> => {
  if (!host || host === '_') return null;
  const pv = verifyPreviewToken((await cookies()).get(PREVIEW_COOKIE)?.value, process.env.STOREFRONT_PREVIEW_SECRET);
  const resolved = await data.resolveHost(host);
  let storeId: string, preview = false, platform = false, isPrimary = true;
  if (resolved) {
    storeId = resolved.store; isPrimary = resolved.primary; preview = pv?.store === resolved.store;
  } else if (pv && isPlatformHost(host)) {
    storeId = pv.store; preview = true; platform = true;
  } else {
    return null;
  }
  const store = await data.store(storeId, preview);
  if (!store) return null;
  const primaryDomain = store.primary_domain ?? resolved?.primary_domain ?? null;
  const h = await headers();
  const proto = h.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const origin = primaryDomain && !platform ? `https://${primaryDomain}` : `${proto}://${h.get('host') ?? host}`;
  return {
    host, storeId, preview, platform, isPrimary, primaryDomain, origin, store,
    theme: isFullStore(store) ? resolveTheme(store.template, store.theme.settings) : null,
    live: store.status === 'published' || preview,
  };
});

/** a domain the storefront served is "active" in the dashboard (once in 10 minutes per instance is plenty) */
export async function markSeen(host: string) {
  const last = seen.get(host) ?? 0;
  if (Date.now() - last < 10 * 60_000) return;
  seen.set(host, Date.now());
  try { await data.domainSeen(host); } catch { seen.delete(host); }
}

/** the host of a page's address segment (the proxy wrote it) */
export function hostOf(param: string): string {
  try { return decodeURIComponent(param); } catch { return ''; }
}
export const decodeSlug = (s: string) => { try { return s.includes('%') ? decodeURIComponent(s) : s; } catch { return s; } };

/** a page of a store that may be shown — else the layout already shows "בקרוב" / 404 */
export async function liveSite(param: string): Promise<Site & { store: Store; theme: Theme }> {
  const site = await getSite(hostOf(param));
  if (!site || !site.live || !isFullStore(site.store) || !site.theme) notFound();
  return site as Site & { store: Store; theme: Theme };
}

/** an address that is gone: its 301 (permanent) if it moved, else 404 */
export async function movedOr404(site: Site, path: string): Promise<never> {
  const to = await data.redirect(site.storeId, path);
  if (to && to !== path) permanentRedirect(to);
  notFound();
}
