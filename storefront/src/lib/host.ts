/**
 * The request's host, as the storefront trusts it: lower case, without a port or a trailing dot, an IDN in punycode.
 * Anything that is not a plain host name becomes '' (no store).
 */
export function normalizeHost(raw: string | null | undefined): string {
  let h = String(raw ?? '').trim().toLowerCase();
  if (!h || h.length > 300) return '';
  if (h.startsWith('[')) return '';                       // an IPv6 literal is never a store
  h = h.replace(/:\d+$/, '').replace(/\.$/, '');
  if (/[^\x00-\x7f]/.test(h)) {
    try { h = new URL(`http://${h}`).hostname; } catch { return ''; }   // Hebrew name → punycode (xn--…)
  }
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(h) ? h : '';
}

/**
 * The storefront's own hosts (its Vercel addresses, localhost): no store lives there, only a preview that a signed token
 * opened. STOREFRONT_PLATFORM_HOSTS adds more, comma-separated.
 */
export function isPlatformHost(host: string, extra: string = process.env.STOREFRONT_PLATFORM_HOSTS ?? ''): boolean {
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.vercel.app')) return true;
  if (isRootHost(host)) return true;
  return extra.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).includes(host);
}

/**
 * The store's own address (2.57.1): <slug>.<STORE_ROOT_DOMAIN>. The slug of a host under the root, or null. The root itself
 * and www.<root> are the platform's (no store lives there); a deeper name (a.b.<root>) is nobody's.
 */
export function rootDomain(env: string = process.env.STORE_ROOT_DOMAIN ?? ''): string {
  return normalizeHost(env);
}
export function subdomainOf(host: string, root: string = rootDomain()): string | null {
  if (!host || !root || !host.endsWith(`.${root}`)) return null;
  const label = host.slice(0, -root.length - 1);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(label) || label.length < 3 || label.length > 40 || label === 'www') return null;
  return label;
}
/** the root and www.<root>: the platform's own, like its Vercel address */
export const isRootHost = (host: string, root: string = rootDomain()) => Boolean(root) && (host === root || host === `www.${root}`);
