import { timingSafeEqual } from 'node:crypto';
import { finalizePaylink, isUuid } from '@/lib/server/paylinks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * A payment link was paid (migration 4300): the storefront's server, right after the provider confirmed it — header
 * x-commerce-secret = COMMERCE_SECRET (both Vercel projects), body {requestId}. The owner's alert, and a real payment's
 * receipt now (or kept for the owner's approval). Safe to call twice: the receipt has the link's own key. The cron
 * (/api/cron/commerce) issues whatever this missed.
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
function fromStorefront(req: Request) {
  const want = process.env.COMMERCE_SECRET ?? '';
  const got = req.headers.get('x-commerce-secret') ?? '';
  return want.length >= 16 && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export async function POST(req: Request) {
  if (!fromStorefront(req)) return json(401, { code: 'forbidden' });
  const body = await req.json().catch(() => ({}));
  const id = String(body?.requestId ?? '');
  if (!isUuid(id)) return json(400, { code: 'bad_request' });
  try {
    return json(200, await finalizePaylink(id.toLowerCase()));
  } catch (e: any) {
    console.error('[finance/paylinks/finalize]', e?.message ?? e);
    return json(500, { code: 'error' });
  }
}
