import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp } from '@/lib/csp';
import { normalizeHost } from '@/lib/host';
import { PREVIEW_COOKIE, verifyPreviewToken } from '@/lib/preview';

/**
 * Every request of every store: the Host chooses the store (the pages ask the database which), so the request is rewritten
 * to /site/<host>/<path>. A request that names /site/… itself lands under its own host and finds nothing. Headers that
 * pretend to choose a store are dropped. A preview link (?preview=<token>) becomes a cookie of this host, and the address
 * loses the token. Every page gets this request's CSP nonce. No database here: the proxy stays fast and independent.
 */
const OURS = ['x-sf-host', 'x-sf-path', 'x-nonce'];

export function proxy(request: NextRequest) {
  const rawHost = request.headers.get('host') ?? '';
  const host = normalizeHost(rawHost);
  const url = request.nextUrl;
  const https = request.headers.get('x-forwarded-proto') === 'https' || url.protocol === 'https:';
  const origin = `${https ? 'https' : 'http'}://${rawHost || 'localhost'}`;

  const token = url.searchParams.get('preview');
  if (token !== null) {
    const clean = new URL(url.pathname, origin);
    url.searchParams.forEach((v, k) => { if (k !== 'preview') clean.searchParams.append(k, v); });
    const res = NextResponse.redirect(clean, 302);
    res.headers.set('Cache-Control', 'no-store');
    if (token === 'off') {
      res.cookies.delete(PREVIEW_COOKIE);
    } else {
      const ok = verifyPreviewToken(token, process.env.STOREFRONT_PREVIEW_SECRET);
      if (ok) {
        res.cookies.set(PREVIEW_COOKIE, token, {
          httpOnly: true, secure: https, sameSite: 'lax', path: '/', maxAge: Math.max(60, Math.floor(ok.expires - Date.now() / 1000)),
        });
      }
    }
    return res;
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === 'development', https });
  const headers = new Headers(request.headers);
  for (const h of OURS) headers.delete(h);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  headers.set('x-sf-host', host);
  headers.set('x-sf-path', url.pathname + url.search);

  const target = url.clone();
  target.pathname = `/site/${encodeURIComponent(host || '_')}${url.pathname === '/' ? '' : url.pathname}`;
  const res = NextResponse.rewrite(target, { request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
