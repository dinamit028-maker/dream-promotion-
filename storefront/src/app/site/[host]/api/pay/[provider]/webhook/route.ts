import { createHash } from 'node:crypto';
import { confirmOrder } from '@/lib/checkout';
import { data } from '@/lib/data';
import { providerOf } from '@/lib/pay';
import { openKeys } from '@/lib/seal';
import { getSite, hostOf } from '@/lib/site';

/**
 * The provider's notice about a payment (refURL_callback). It never marks anything paid by itself:
 *   1. the store is the host's; the order must be of this store and of this provider;
 *   2. the signature is checked (PayPlus signs: HMAC of the body with the terminal's secret) — a wrong one is logged and refused;
 *   3. the notice is logged once (payment_events: a repeated or replayed notice changes nothing);
 *   4. the provider is asked directly about the order's page (confirmOrder), and only its answer counts.
 * The answer is 200 for anything the provider should not send again.
 */
type Ctx = { params: Promise<{ host: string; provider: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ok = (status = 200) => new Response(status === 200 ? 'ok' : 'no', { status, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });

export async function POST(req: Request, { params }: Ctx) {
  const { host, provider: pid } = await params;
  const site = await getSite(hostOf(host));
  if (!site) return ok(404);
  const body = await req.text().catch(() => '');
  if (!body || body.length > 64_000) return ok(400);
  if (!(await data.rateHit(`webhook:${site.storeId}`, 60, 300).catch(() => true))) return ok(429);
  const account = await data.paymentAccount(site.storeId);
  if (!account || account.provider !== pid) return ok(404);
  const keys = openKeys(account.sealed);
  let provider;
  try { provider = providerOf(account.provider); } catch { return ok(404); }
  if (!keys) return ok(503);
  const notice = provider.readNotice(keys, body, req.headers);
  const orderId = UUID.test(notice.orderId) ? notice.orderId : null;
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 40);
  const fresh = await data.paymentEvent(site.storeId, orderId, account.provider, `${account.provider}:callback:${digest}`, 'callback',
    notice.signature, { page: notice.page.slice(0, 80), order: orderId, signature: notice.signature });
  if (notice.signature === false) return ok(401);                       // forged or broken: logged, nothing asked
  if (!fresh || !orderId) return ok();                                   // a repeat, or not about an order of ours
  const order = await data.orderById(site.storeId, orderId);
  if (!order || order.page !== notice.page) return ok();                 // not this store's order, or another page
  await confirmOrder(site.storeId, order, 'callback');
  return ok();
}
