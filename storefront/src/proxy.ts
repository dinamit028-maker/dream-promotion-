import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp } from '@/lib/csp';
import { normalizeHost } from '@/lib/host';
import { dashboardOrigin, EDIT_HEADER, EDIT_PARAM, PREVIEW_COOKIE, verifyPreviewToken } from '@/lib/preview';
import { KIT_COOKIE, KIT_COOKIE_SECONDS, KIT_MODE_PARAM, KIT_PARAM, kitCookieValue } from '@/lib/kit-choice';

/**
 * Every request of every store: the Host chooses the store (the pages ask the database which), so the request is rewritten
 * to /site/<host>/<path>. A request that names /site/… itself lands under its own host and finds nothing. Headers that
 * pretend to choose a store are dropped. A preview link (?preview=<token>) becomes a cookie of this host, and the address
 * loses the token. Every page gets this request's CSP nonce. No database here: the proxy stays fast and independent.
 */
const OURS = ['x-sf-host', 'x-sf-path', 'x-nonce', EDIT_HEADER];

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
      res.cookies.delete(KIT_COOKIE);
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

  // a kit's preview (2.64): the choice becomes a cookie of this address and the address loses it — it counts only with the
  // preview token (getSite checks), so a link with ?kit= alone shows a shopper nothing different
  const kit = url.searchParams.get(KIT_PARAM);
  if (kit !== null) {
    const clean = new URL(url.pathname, origin);
    url.searchParams.forEach((v, k) => { if (k !== KIT_PARAM && k !== KIT_MODE_PARAM) clean.searchParams.append(k, v); });
    const res = NextResponse.redirect(clean, 302);
    res.headers.set('Cache-Control', 'no-store');
    const value = kit === 'off' ? null : kitCookieValue(kit, url.searchParams.get(KIT_MODE_PARAM) ?? 'design');
    if (value) res.cookies.set(KIT_COOKIE, value, { httpOnly: true, secure: https, sameSite: 'lax', path: '/', maxAge: KIT_COOKIE_SECONDS });
    else res.cookies.delete(KIT_COOKIE);
    return res;
  }

  // "לחץ לעריכה" (2.61): a valid edit token, and a dashboard to frame it — the token travels in a header, never a cookie
  const edit = url.searchParams.get(EDIT_PARAM);
  const frameAncestor = edit ? dashboardOrigin(process.env.DASHBOARD_URL) : null;
  const editing = Boolean(frameAncestor && verifyPreviewToken(edit, process.env.STOREFRONT_PREVIEW_SECRET));

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === 'development', https, frameAncestor: editing ? frameAncestor : null });
  const headers = new Headers(request.headers);
  for (const h of OURS) headers.delete(h);
  headers.set('x-nonce', nonce);
  if (editing) headers.set(EDIT_HEADER, edit!);
  headers.set('content-security-policy', csp);
  headers.set('x-sf-host', host);
  headers.set('x-sf-path', url.pathname + url.search);

  const target = url.clone();
  target.pathname = `/site/${encodeURIComponent(host || '_')}${url.pathname === '/' ? '' : url.pathname}`;
  const res = NextResponse.rewrite(target, { request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  if (editing) res.headers.set('Cache-Control', 'no-store');
  return res;
}

export const config = {
  // kit-images/: the starter kits' default pictures (2.62), files of this app — the same for every store
  matcher: ['/((?!_next/static|_next/image|favicon.ico|kit-images/).*)'],
};
