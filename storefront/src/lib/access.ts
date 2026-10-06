import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * "מוגן בסיסמה" (2.57.1): a store before publishing, or one its owner locked, opens to whoever has the link and the password.
 * The storefront never sees the password: the database gives a key (sha-256 of the store and the password) when it is right,
 * and the cookie of this host carries an HMAC of that key with STOREFRONT_PREVIEW_SECRET. A new password = a new key: every
 * cookie of the old one stops opening the store.
 */
export const ACCESS_COOKIE = 'sf_access';
export const ACCESS_DAYS = 30;

export function accessCookie(storeId: string, key: string, secret = process.env.STOREFRONT_PREVIEW_SECRET ?? ''): string | null {
  if (secret.length < 16 || !/^[0-9a-f]{64}$/.test(key)) return null;
  return createHmac('sha256', secret).update(`store-access:${storeId}:${key}`).digest('base64url');
}
export function hasAccess(cookie: string | null | undefined, storeId: string, key: string | null | undefined,
                          secret = process.env.STOREFRONT_PREVIEW_SECRET ?? ''): boolean {
  if (!cookie || !key) return false;
  const want = accessCookie(storeId, key, secret);
  if (!want || want.length !== cookie.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(cookie));
}
