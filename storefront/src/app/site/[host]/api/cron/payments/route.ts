import { timingSafeEqual } from 'node:crypto';
import { confirmOrder } from '@/lib/checkout';
import { data } from '@/lib/data';
import { failureReason } from '@/lib/failure';

/**
 * Orders whose payment nobody confirmed after 10 minutes (the notice did not arrive, the shopper closed the tab): the
 * provider is asked about each one. Called by pg_cron every few minutes (supabase/cron-commerce.sql) with the shared secret
 * STOREFRONT_CRON_SECRET — on any host of the storefront; no store is chosen by the host here.
 */
function authorized(req: Request): boolean {
  const want = process.env.STOREFRONT_CRON_SECRET ?? '';
  const got = req.headers.get('x-cron-secret') ?? '';
  return want.length >= 16 && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export async function POST(req: Request) {
  if (!authorized(req)) return new Response('no', { status: 401 });
  try {
    return await run();
  } catch (e) {
    console.error(e);
    // 2.57.4: the reason goes back to pg_cron (net._http_response), where it can be read without Vercel's logs
    return Response.json({ error: failureReason(e) }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

async function run(): Promise<Response> {
  const list = (await data.ordersUnconfirmed(30)) ?? [];
  const results: Record<string, number> = {};
  const started = Date.now();
  for (const o of list) {
    if (Date.now() - started > 45_000) break;                            // the rest wait for the next run
    const order = await data.orderById(o.store, o.id);
    if (!order) continue;
    const r = await confirmOrder(o.store, order, 'poll').catch(() => 'unknown' as const);
    results[r] = (results[r] ?? 0) + 1;
  }
  return Response.json({ asked: list.length, results }, { headers: { 'Cache-Control': 'no-store' } });
}
