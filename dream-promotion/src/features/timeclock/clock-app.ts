import type { Metadata, MetadataRoute } from 'next';

/**
 * The employee's clock as an app on the phone (tests/clock-app.test.ts): its own home-screen manifest, the clock pages'
 * metadata, and reading the business's QR inside the page. Nothing here opens or mentions Dream — an employee never
 * has a Dream account, and Dream's manifest (start_url /dashboard) leads to its sign-in screen.
 */

/** a personal link's token: random, url-safe (newToken in hours.ts) — the same check as the clock API */
export const isClockToken = (token: string) => /^[A-Za-z0-9_-]{20,80}$/.test(token);

export const CLOCK_NAME = 'שעון נוכחות';
/** a wrong, replaced or cancelled personal link (the clock API and the page) */
export const LINK_NOT_VALID = 'הקישור לא תקין, בקש קישור חדש מהמנהל';

/** /clock/* and /c/*: never Dream's manifest, the clock's name on the home screen and in a WhatsApp preview */
export const clockMetadata: Metadata = {
  title: CLOCK_NAME,
  description: 'כניסה ויציאה ממשמרת',
  manifest: null,
  appleWebApp: { capable: true, title: CLOCK_NAME, statusBarStyle: 'black-translucent' },
};

/** where a clock page links its personal manifest (the page renders the link — React puts it in <head>) */
export const clockManifestPath = (token: string) => `/api/clock/${token}/manifest`;

/**
 * One employee's clock as a home-screen app. The icon opens start_url — the personal link itself — so it never
 * depends on what Safari remembered: on iPhone a home-screen app starts with its own, empty storage. scope keeps
 * the app on the clock only.
 */
export function clockManifest(token: string): MetadataRoute.Manifest {
  const home = `/clock/${token}`;
  return {
    id: home, name: CLOCK_NAME, short_name: CLOCK_NAME, start_url: home, scope: '/clock/', display: 'standalone',
    dir: 'rtl', lang: 'he', background_color: '#0b0a16', theme_color: '#6b3bf5',
    icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
  };
}

/**
 * What the camera read → the business's code, or null. The printed QR is <origin>/c/<code> (QrTab in
 * AttendanceScreen). Any origin is accepted (a code printed from the live site still works on a Preview): the
 * scanned address is never opened — only the code is sent to the clock API, which compares it with the business's.
 */
export function siteFromScan(text: string): string | null {
  let path: string;
  try { path = new URL(text.trim(), 'https://clock.invalid').pathname; } catch { return null; }
  const m = /^\/c\/([A-Za-z0-9_-]{16,64})\/?$/.exec(path);
  return m ? m[1] : null;
}

export type CameraProblem = 'denied' | 'no_camera' | 'busy' | 'unsupported' | 'failed';

/** getUserMedia's error → what the employee is told (the names differ a little between browsers) */
export function cameraProblem(e: unknown): CameraProblem {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'no_camera';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  return 'failed';
}

/** which steps to show for allowing the camera (an iPad says "Macintosh" — it is the one with a touch screen) */
export function phoneKind(userAgent: string, touchPoints = 0): 'iphone' | 'android' | 'other' {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && touchPoints > 1)) return 'iphone';
  if (/Android/i.test(userAgent)) return 'android';
  return 'other';
}
