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
