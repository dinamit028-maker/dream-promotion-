/**
 * The choice of a kit's preview (2.64) as the proxy keeps it: ?kit=<id>&kitmode=<design|full> → a cookie of this address,
 * "<kit>:<mode>", for an hour; ?kit=off (or ?preview=off) removes it. Nothing here grants anything: getSite takes the
 * cookie only for a visitor with a valid preview token, and only for a kit that exists (lib/kit-preview.ts).
 */
export const KIT_COOKIE = 'sf_kit';
export const KIT_PARAM = 'kit';
export const KIT_MODE_PARAM = 'kitmode';
export const KIT_COOKIE_SECONDS = 60 * 60;
export const kitCookieValue = (kit: string, mode: string): string | null =>
  /^[a-z][a-z0-9-]{1,30}$/.test(kit) && (mode === 'design' || mode === 'full') ? `${kit}:${mode}` : null;
