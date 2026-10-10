/**
 * A small rate limit for the public links (quote, booking, a document and its PDF): per client address and route, a fixed
 * window, in memory. Each server instance keeps its own count (Vercel may run several), so this slows down floods and
 * bots — it is not a quota and not a security boundary (the 64-hex tokens are). No dependency, nothing stored.
 */
type Bucket = { n: number; until: number };
const buckets = new Map<string, Bucket>();
const MAX_KEYS = 10_000;

/** the client's address as the platform reports it (Vercel sets x-forwarded-for / x-real-ip); 'unknown' locally */
export function clientAddress(req: Request): string {
  const first = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return (first || req.headers.get('x-real-ip')?.trim() || 'unknown').slice(0, 64);
}

/** null = go ahead; otherwise the 429 answer to return (in Hebrew, with Retry-After) */
export function rateLimited(req: Request, name: string, limit: number, windowMs: number, now = Date.now()): Response | null {
  const key = `${name}|${clientAddress(req)}`;
  let b = buckets.get(key);
  if (!b || b.until <= now) {
    if (buckets.size >= MAX_KEYS) for (const [k, v] of buckets) if (v.until <= now || buckets.size >= MAX_KEYS) buckets.delete(k);
    b = { n: 0, until: now + windowMs };
    buckets.set(key, b);
  }
  b.n += 1;
  if (b.n <= limit) return null;
  const seconds = Math.max(1, Math.ceil((b.until - now) / 1000));
  return Response.json({ code: 'rate_limited', message: 'נשלחו יותר מדי בקשות בזמן קצר. נסו שוב בעוד דקה.' },
    { status: 429, headers: { 'Retry-After': String(seconds), 'Cache-Control': 'no-store' } });
}

/** for tests: forget every count */
export function resetRateLimits() { buckets.clear(); }

/** the limits of the public links, per address per minute */
export const PUBLIC_LIMITS = {
  quoteRead: 60, quoteAnswer: 10, docRead: 60, docPdf: 20, bookRead: 120, bookPost: 10, declarationRead: 60, declarationSign: 10,
  payRead: 60, payStart: 10, payCheck: 30,
} as const;
export const MINUTE = 60_000;
