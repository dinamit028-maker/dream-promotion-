import { createHmac } from 'node:crypto';

/**
 * A preview link of a store (2.55, server only): `<store id>.<expiry, unix seconds>.<HMAC-SHA256, base64url>` signed with
 * STOREFRONT_PREVIEW_SECRET — the storefront has its own copy of this format (storefront/src/lib/preview.ts) and checks it;
 * both are tested against the same vector. One hour; it opens that one store's draft, nothing else.
 */
export const PREVIEW_SECONDS = 60 * 60;

export function makePreviewToken(storeId: string, secret: string, expires: number): string {
  const body = `${storeId}.${Math.floor(expires)}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/** where the preview opens: the store's own domain once it works, else the storefront's address (STOREFRONT_URL) */
export function previewUrl(base: string, token: string): string {
  const u = new URL(base.endsWith('/') ? base : `${base}/`);
  u.searchParams.set('preview', token);
  return u.toString();
}

/**
 * 2.74: "drop what the storefront keeps of this store" — the same secret, another purpose (the signature covers
 * "revalidate.<store>.<expiry>": never a preview). The storefront's copy: storefront/src/lib/preview.ts (one shared vector).
 */
export const REVALIDATE_SECONDS = 60;
export function makeRevalidateToken(storeId: string, secret: string, expires: number): string {
  const body = `${storeId}.${Math.floor(expires)}`;
  return `${body}.${createHmac('sha256', secret).update(`revalidate.${body}`).digest('base64url')}`;
}
