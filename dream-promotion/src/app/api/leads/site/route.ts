import { timingSafeEqual } from 'node:crypto';
import { routeSiteRequest } from '@/lib/server/site-leads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * A request of the site was recorded (2.102): route it now — its department, the person responsible, the WhatsApp message to
 * them, the owners' push (lib/server/site-leads.ts). The cron (/api/cron/commerce) does the same for whatever was missed.
 *   the storefront's server   header x-commerce-secret = COMMERCE_SECRET (both Vercel projects), body {requestId}
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fromStorefront(req: Request) {
  const want = process.env.COMMERCE_SECRET ?? '';
  const got = req.headers.get('x-commerce-secret') ?? '';
  return want.length >= 16 && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export async function POST(req: Request) {
  if (!fromStorefront(req)) return json(403, { code: 'forbidden' });
  const body = await req.json().catch(() => ({}));
  const requestId = String(body?.requestId ?? '');
  if (!UUID.test(requestId)) return json(400, { code: 'bad_request' });
  try {
    return json(200, await routeSiteRequest(requestId));
  } catch (e: any) {
    console.error('[leads/site]', e?.message ?? e);
    return json(500, { code: 'error' });
  }
}
