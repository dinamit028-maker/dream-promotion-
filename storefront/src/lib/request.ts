import { normalizeHost } from './host';

/**
 * What a route handler may trust about its request. The proxy wrote the store's host into the address (/site/<host>/…);
 * the shopper's address comes from the platform's forwarding header; a form is sent only from a page of the same host.
 */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  return (fwd.split(',')[0] || req.headers.get('x-real-ip') || '').trim().slice(0, 64) || 'unknown';
}

/** the origin the shopper sees (https on the platform; http only on a local test machine) */
export function requestOrigin(req: Request): string {
  const host = req.headers.get('host') ?? '';
  const proto = req.headers.get('x-forwarded-proto') === 'https' || new URL(req.url).protocol === 'https:' ? 'https' : 'http';
  return `${proto}://${host}`;
}

/** a POST from a page of this very host (a form of another site cannot fill a cart or start a checkout) */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    return normalizeHost(new URL(origin).host) === normalizeHost(req.headers.get('host')) && normalizeHost(req.headers.get('host')) !== '';
  } catch {
    return false;
  }
}

/** a JSON body of at most `max` bytes, or null */
export async function readJson(req: Request, max = 8_000): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => '');
  if (!text || text.length > max) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
