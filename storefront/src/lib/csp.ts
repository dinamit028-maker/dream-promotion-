/**
 * The Content-Security-Policy of every page: scripts only with this request's nonce (Next.js puts it on its own scripts),
 * styles from the storefront or with the nonce (no inline style attributes), pictures over https, nothing framed, forms
 * only to the store. Google Analytics is allowed to talk only after the shopper agreed (the script loads only then).
 */
export function buildCsp(nonce: string, { dev = false, https = true, frameAncestor = null }: { dev?: boolean; https?: boolean; frameAncestor?: string | null } = {}): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' https: data:",
    "font-src 'self'",
    "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // the dashboard's visual editor (2.61) may frame a page opened with a valid edit token; nobody else, ever
    `frame-ancestors ${frameAncestor && /^https?:\/\/[a-z0-9.:-]+$/i.test(frameAncestor) ? frameAncestor : "'none'"}`,
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

/** JSON inside <script type="application/ld+json">: nothing in it can close the tag */
export const jsonForScript = (v: unknown) =>
  JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
