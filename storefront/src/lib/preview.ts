import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A preview of a store that is not on the air (or of its draft theme): a token the dashboard signs for one store, for at
 * most an hour — `<store id>.<expiry, unix seconds>.<HMAC-SHA256, base64url>` with STOREFRONT_PREVIEW_SECRET, a secret the
 * dashboard and the storefront share (environment variables only). The dashboard has its own copy of this format
 * (dream-promotion/src/features/store/preview-token.ts); both are tested against the same vector.
 */
export const PREVIEW_COOKIE = 'sf_preview';
export const PREVIEW_MAX_SECONDS = 2 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('base64url');

export function makePreviewToken(storeId: string, secret: string, expires: number): string {
  const body = `${storeId}.${Math.floor(expires)}`;
  return `${body}.${sign(secret, body)}`;
}

/** the store the token opens, and until when — or null (forged, expired, too long, no secret) */
export function verifyPreviewToken(token: string | null | undefined, secret: string | undefined, now: number = Date.now() / 1000):
  { store: string; expires: number } | null {
  if (!token || !secret || secret.length < 16 || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [store, exp, sig] = parts;
  if (!UUID.test(store) || !/^\d{9,11}$/.test(exp)) return null;
  const expires = Number(exp);
  if (expires <= now || expires > now + PREVIEW_MAX_SECONDS) return null;
  const want = Buffer.from(sign(secret, `${store}.${exp}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return { store, expires };
}

/**
 * "לחץ לעריכה" (2.61): the dashboard's visual editor frames the store with ?edit=<the same signed token>. The token stays
 * in the address (a framed page cannot rely on a cookie of another site), the proxy hands it on in EDIT_HEADER, and the
 * page may be framed only by the dashboard (DASHBOARD_URL's origin) — every other site still gets frame-ancestors 'none'.
 */
export const EDIT_PARAM = 'edit';
export const EDIT_HEADER = 'x-sf-edit';
/** the dashboard's origin, from DASHBOARD_URL: https only (http only for localhost, in development and tests) — or null */
export function dashboardOrigin(url: string | undefined): string | null {
  try {
    const u = new URL(url ?? '');
    if (u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return u.origin;
  } catch { /* not a URL */ }
  return null;
}

/**
 * 2.74: "drop what is kept of this store" (shared-cache.ts) — the dashboard asks after a change the shoppers see. The same
 * secret as a preview, another purpose: the signature covers "revalidate.<store>.<expiry>", so a preview token never
 * passes here and this token never opens a preview. At most five minutes.
 */
export const REVALIDATE_MAX_SECONDS = 5 * 60;
export function makeRevalidateToken(storeId: string, secret: string, expires: number): string {
  const body = `${storeId}.${Math.floor(expires)}`;
  return `${body}.${sign(secret, `revalidate.${body}`)}`;
}
export function verifyRevalidateToken(token: string | null | undefined, secret: string | undefined, now: number = Date.now() / 1000): string | null {
  if (!token || !secret || secret.length < 16 || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [store, exp, sig] = parts;
  if (!UUID.test(store) || !/^\d{9,11}$/.test(exp)) return null;
  const expires = Number(exp);
  if (expires <= now || expires > now + REVALIDATE_MAX_SECONDS) return null;
  const want = Buffer.from(sign(secret, `revalidate.${store}.${exp}`));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? store : null;
}
