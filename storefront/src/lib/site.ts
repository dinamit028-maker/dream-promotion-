import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { data } from './data';
import { ACCESS_COOKIE, hasAccess } from './access';
import { isPlatformHost, subdomainOf } from './host';
import { dashboardOrigin, EDIT_HEADER, PREVIEW_COOKIE, verifyPreviewToken } from './preview';
import { PLATFORM_STORE_COOKIE } from './host';
import { resolveTheme, type Theme } from './theme';
import { isFullStore, type Store, type StoreAny } from './types';

/**
 * The store of this request. Its id comes only from the Host (a domain of store_domains) — or, on the storefront's own
 * addresses, from a preview token the dashboard signed. Never from the address, a header or a form of the browser.
 */
export interface Site {
  host: string;
  storeId: string;
  preview: boolean;          // the store's draft may be shown: a signed preview token, or the password of a store not yet published
  via: 'public' | 'token' | 'password';   // how this visitor sees it: on the air, the owner's preview link, the password
  platform: boolean;         // the storefront's own address (*.vercel.app, the root domain): only a preview lives there
  subdomain: string | null;  // <slug>.<STORE_ROOT_DOMAIN> (2.57.1)
  platformSlug: string | null; // the storefront's own address, opened at /s/<slug> (2.57.2): a store with no domain at all
  isPrimary: boolean;        // www ↔ the bare name, the subdomain ↔ the store's own domain: the other one redirects here
  primaryDomain: string | null;
  origin: string;            // canonical addresses: https://<the primary address>
  store: StoreAny;
  theme: Theme | null;
  live: boolean;             // may be shown: on the air, previewed, or opened with the password
  locked: boolean;           // not open to everyone (before publishing, or locked): never indexed
  passwordPage: boolean;     // "בקרוב" offers the password
  /** the dashboard's visual editor (2.61): its origin, when this page was opened with a valid edit token — else null */
  edit: { origin: string; token: string } | null;
}

const seen = new Map<string, number>();

export const getSite = cache(async (host: string): Promise<Site | null> => {
  if (!host || host === '_') return null;
  const jar = await cookies();
  const h = await headers();
  // the visual editor's token (set by the proxy only, after it checked it) comes before a preview cookie
  const editToken = h.get(EDIT_HEADER);
  const editPv = editToken ? verifyPreviewToken(editToken, process.env.STOREFRONT_PREVIEW_SECRET) : null;
  const editOrigin = editPv ? dashboardOrigin(process.env.DASHBOARD_URL) : null;
  const pv = editPv && editOrigin ? editPv : verifyPreviewToken(jar.get(PREVIEW_COOKIE)?.value, process.env.STOREFRONT_PREVIEW_SECRET);
  const slug = subdomainOf(host);
  const resolved = slug ? await data.resolveSlug(slug) : await data.resolveHost(host);
  let storeId: string, token = false, platform = false, isPrimary = true;
  let platformSlug: string | null = null, platformResolved: Awaited<ReturnType<typeof data.resolveSlug>> = null;
  if (resolved) {
    storeId = resolved.store; isPrimary = resolved.primary; token = pv?.store === resolved.store;
  } else if (pv && isPlatformHost(host)) {
    storeId = pv.store; token = true; platform = true;
  } else if (isPlatformHost(host) && (platformSlug = jar.get(PLATFORM_STORE_COOKIE)?.value ?? null)) {
    // the storefront's own address with no domain at all: /s/<slug> chose the store (a cookie of this address)
    platformResolved = await data.resolveSlug(platformSlug);
    if (!platformResolved) return null;
    storeId = platformResolved.store; platform = true; isPrimary = platformResolved.primary;
  } else {
    return null;
  }
  let store = await data.store(storeId, token);
  if (!store) return null;
  // before migration 3700 there is no access: on the air = public, as before
  const access = store.access ?? { mode: store.status === 'published' ? 'public' : 'closed', key: null };
  const unlocked = !token && access.mode === 'password' && hasAccess(jar.get(ACCESS_COOKIE)?.value, storeId, access.key);
  if (unlocked && store.status !== 'published') store = (await data.store(storeId, true)) ?? store;   // the draft, behind the password
  // the subdomain: its canonical address is the store's own domain only once that works (the database says which)
  const primaryDomain = slug ? resolved?.primary_domain ?? null : platformResolved ? platformResolved.primary_domain ?? null
    : store.primary_domain ?? resolved?.primary_domain ?? null;
  const proto = h.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const origin = primaryDomain && !platform ? `https://${primaryDomain}` : `${proto}://${h.get('host') ?? host}`;
  return {
    host, storeId, preview: token || (unlocked && store.status !== 'published'), via: token ? 'token' : unlocked ? 'password' : 'public',
    platform, subdomain: slug, platformSlug: platformResolved ? platformSlug : null, isPrimary, primaryDomain, origin, store,
    theme: isFullStore(store) ? resolveTheme(store.template, store.theme.settings) : null,
    live: access.mode === 'public' || token || unlocked,
    locked: access.mode !== 'public',
    passwordPage: access.mode === 'password' && (!platform || Boolean(platformResolved)),
    edit: token && editPv && editOrigin && editPv === pv ? { origin: editOrigin, token: editToken! } : null,
  };
});

/** a domain the storefront served is "active" in the dashboard (once in 10 minutes per instance is plenty) */
export async function markSeen(host: string, slug: string | null = null) {
  const last = seen.get(host) ?? 0;
  if (Date.now() - last < 10 * 60_000) return;
  seen.set(host, Date.now());
  try { await (slug ? data.slugSeen(slug) : data.domainSeen(host)); } catch { seen.delete(host); }
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
