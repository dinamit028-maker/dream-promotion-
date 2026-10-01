import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * The only way the server downloads a file from a URL it was handed (render inputs, archive,
 * TikTok upload). A plain fetch(url) would let anyone make the server call its own network,
 * localhost or the cloud metadata service (SSRF). Here:
 *  - https only (data: URLs are handled by callers, never fetched)
 *  - the host must be on the allowlist: this project's Supabase storage, fal.ai's CDN,
 *    plus anything in ASSET_HOSTS (comma separated, "*.example.com" for subdomains)
 *  - every address the host resolves to must be public (no loopback, private, link-local,
 *    carrier-grade NAT, multicast or metadata ranges — IPv4 and IPv6)
 *  - redirects are followed by hand, and every hop is checked again
 *  - the body is capped (maxBytes)
 */

// fal's CDN, and Alibaba Model Studio's result storage (video_url of a finished Wan task)
// + the free-music sources Openverse indexes (Jamendo, Freesound, Wikimedia)
const BUILT_IN = ['*.fal.media', 'fal.media', '*.fal.ai', '*.oss-accelerate.aliyuncs.com', '*.aliyuncs.com',
  '*.jamendo.com', 'cdn.freesound.org', 'freesound.org', 'upload.wikimedia.org'];

function allowedHosts(): string[] {
  const list = [...BUILT_IN];
  try {
    const sb = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (sb) list.push(new URL(sb).hostname);
  } catch { /* no supabase url */ }
  for (const h of (process.env.ASSET_HOSTS || '').split(',')) if (h.trim()) list.push(h.trim().toLowerCase());
  return list;
}

export function hostAllowed(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowedHosts().some((rule) => (rule.startsWith('*.') ? h.endsWith(rule.slice(1)) && h.length > rule.length - 1 : h === rule));
}

function privateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 // this-network, private, loopback, multicast/reserved
    || (a === 100 && b >= 64 && b <= 127)             // carrier-grade NAT
    || (a === 169 && b === 254)                       // link-local + cloud metadata (169.254.169.254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)                         // 192.0.0.0/24, 192.0.2.0/24
    || (a === 198 && (b === 18 || b === 19));         // benchmarking
}
function privateV6(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === '::' || x === '::1') return true;
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return /^(fc|fd)/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff') || x.startsWith('64:ff9b:');
}
export function ipIsPrivate(ip: string): boolean {
  const v = isIP(ip);
  return v === 4 ? privateV4(ip) : v === 6 ? privateV6(ip) : true;
}

export class BlockedUrlError extends Error {
  code = 'blocked_url';
}

async function assertSafe(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new BlockedUrlError('invalid url'); }
  if (u.protocol !== 'https:') throw new BlockedUrlError('only https is allowed');
  if (u.username || u.password) throw new BlockedUrlError('credentials in url');
  if (u.port && u.port !== '443') throw new BlockedUrlError('non-standard port');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) throw new BlockedUrlError('ip addresses are not allowed');
  if (!hostAllowed(host)) throw new BlockedUrlError(`host not allowed: ${host}`);
  const addrs = await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new BlockedUrlError(`cannot resolve ${host}`);
  if (addrs.some((a) => ipIsPrivate(a.address))) throw new BlockedUrlError(`${host} resolves to a private address`);
  return u;
}

/** Is this URL one the server may fetch? (quick check for request validation, no network) */
export function urlLooksAllowed(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !isIP(u.hostname.replace(/^\[|\]$/g, '')) && hostAllowed(u.hostname);
  } catch { return false; }
}

/**
 * fetch() for untrusted URLs. Returns the final response (after at most 3 checked redirects),
 * with its body wrapped so reading more than maxBytes fails.
 */
export async function safeFetch(raw: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<Response> {
  const maxBytes = opts.maxBytes ?? 300 * 1024 * 1024;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  try {
    let url = raw;
    for (let hop = 0; hop < 4; hop++) {
      const u = await assertSafe(url);
      const res = await fetch(u, { redirect: 'manual', signal: ctrl.signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new BlockedUrlError('redirect without location');
        url = new URL(loc, u).toString();
        continue;
      }
      const len = Number(res.headers.get('content-length') || 0);
      if (len > maxBytes) throw new BlockedUrlError(`file too large (${Math.round(len / 1e6)} MB)`);
      if (!res.body) return res;
      let seen = 0;
      const capped = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, c) {
          seen += chunk.byteLength;
          if (seen > maxBytes) { c.error(new BlockedUrlError('file too large')); return; }
          c.enqueue(chunk);
        },
      }));
      clearTimeout(timer);
      return new Response(capped, { status: res.status, headers: res.headers });
    }
    throw new BlockedUrlError('too many redirects');
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}
