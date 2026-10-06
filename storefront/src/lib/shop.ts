import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { data } from './data';
import { clientIp } from './request';
import { getSite, hostOf, type Site } from './site';
import { CART_COOKIE, CART_COUNT_COOKIE, CART_DAYS, isToken, shopperKey } from './tokens';
import { isFullStore, type Cart, type Store } from './types';

/**
 * The store of a cart / checkout request: shown (on the air, or previewed by its owner) and selling on the site. Its id
 * comes from the host the proxy wrote — never from the request's body.
 */
export type ShopSite = Site & { store: Store };
export async function shopSite(param: string): Promise<ShopSite | null> {
  const site = await getSite(hostOf(param));
  if (!site?.live || !isFullStore(site.store) || !site.store.can_buy) return null;
  return site as ShopSite;
}

/** this browser's cart token (an httpOnly cookie of this host), or null */
export async function cartToken(): Promise<string | null> {
  const t = (await cookies()).get(CART_COOKIE)?.value;
  return isToken(t) ? t : null;
}

/** one more request of this shopper on this store: false when over the limit (the database counts) */
export async function allowed(req: Request, site: Site, action: string, perWindow: number, windowSeconds: number): Promise<boolean> {
  try {
    return (await data.rateHit(`${action}:${shopperKey(clientIp(req), site.storeId)}`, windowSeconds, perWindow)) !== false;
  } catch {
    return true;   // the counter is a guard, not a gate: a database hiccup does not close the store
  }
}

const secure = (req: Request) => req.headers.get('x-forwarded-proto') === 'https' || new URL(req.url).protocol === 'https:';

/** a JSON answer that also keeps the cart's cookie (when one was made) and the header's count */
export function cartJson(req: Request, body: unknown, o: { status?: number; token?: string | null; cart?: Cart | null } = {}) {
  const res = NextResponse.json(body, { status: o.status ?? 200, headers: { 'Cache-Control': 'no-store' } });
  if (o.token) {
    res.cookies.set(CART_COOKIE, o.token, { httpOnly: true, secure: secure(req), sameSite: 'lax', path: '/', maxAge: CART_DAYS * 86400 });
  }
  if (o.cart) {
    res.cookies.set(CART_COUNT_COOKIE, String(o.cart.count), { httpOnly: false, secure: secure(req), sameSite: 'lax', path: '/', maxAge: CART_DAYS * 86400 });
  }
  return res;
}
