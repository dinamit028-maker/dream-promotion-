import { NextResponse } from 'next/server';
import { data } from '@/lib/data';
import { cleanSlug, isPlatformHost, PLATFORM_STORE_COOKIE } from '@/lib/host';
import { PREVIEW_COOKIE } from '@/lib/preview';
import { hostOf } from '@/lib/site';

/**
 * /s/<slug> on the storefront's own address (2.57.2): the store with that address opens here — no domain needed. The
 * store is remembered in a cookie of this address and the browser goes to "/" (every link of the store keeps working).
 * Only on the storefront's own addresses: a store's domain is that store's, and its /s/… is nobody's.
 */
type Ctx = { params: Promise<{ host: string; slug: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { host, slug: raw } = await params;
  const slug = cleanSlug(decodeURIComponent(raw));
  const none = () => new Response('לא נמצא', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' } });
  if (!isPlatformHost(hostOf(host)) || !slug) return none();
  const found = await data.resolveSlug(slug).catch(() => null);
  if (!found) return none();
  const url = new URL(req.url);
  const https = req.headers.get('x-forwarded-proto') === 'https' || url.protocol === 'https:';
  const origin = `${https ? 'https' : 'http'}://${req.headers.get('host') ?? url.host}`;
  const res = NextResponse.redirect(new URL('/', origin), 302);
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('X-Robots-Tag', 'noindex');
  res.cookies.set(PLATFORM_STORE_COOKIE, slug, { httpOnly: true, secure: https, sameSite: 'lax', path: '/', maxAge: 30 * 86400 });
  res.cookies.delete(PREVIEW_COOKIE);   // the link chose this store: an owner's preview of another one ends
  return res;
}
