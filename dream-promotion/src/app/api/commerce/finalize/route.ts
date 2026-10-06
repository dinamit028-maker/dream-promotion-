import { timingSafeEqual } from 'node:crypto';
import { adminDb } from '@/lib/server/admin';
import { financeCaller } from '@/lib/server/finance';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { finalizeOrder, pushStoreAlerts, sendQueuedEmails } from '@/lib/server/commerce';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Finish a paid order of the site now (Dream Commerce stage 4): record the sale, issue the document, tell the owner, send
 * the customer's emails. The cron (/api/cron/commerce) does the same for whatever was missed, so a failure here loses nothing.
 *   the storefront's server   header x-commerce-secret = COMMERCE_SECRET (both Vercel projects), body {orderId}
 *   the owner                 signed in, money open, may write; body {orderId, retry?} — only an order of their own business.
 *                             retry: a document that was blocked is tried again (after the business fixed what blocked it)
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fromStorefront(req: Request) {
  const want = process.env.COMMERCE_SECRET ?? '';
  const got = req.headers.get('x-commerce-secret') ?? '';
  return want.length >= 16 && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const orderId = String(body?.orderId ?? '');
  if (!UUID.test(orderId)) return json(400, { code: 'bad_request' });
  if (!fromStorefront(req)) {
    const limited = rateLimited(req, 'commerce-finalize', 20, MINUTE);
    if (limited) return limited;
    const c = await financeCaller(req, { write: true });
    if (!c.ok) return json(c.status, c.body);
    const { data: o } = await adminDb().from('orders').select('id').eq('id', orderId).eq('business_id', c.businessId).maybeSingle();
    if (!o) return json(404, { code: 'not_found', message: 'ההזמנה לא נמצאה.' });
    if (body?.retry === true) await adminDb().rpc('order_document_retry', { p_order: orderId });
  }
  try {
    const result = await finalizeOrder(orderId);
    await pushStoreAlerts().catch((e) => console.error('[commerce] alerts', e?.message ?? e));
    const emails = await sendQueuedEmails().catch((e) => { console.error('[commerce] emails', e?.message ?? e); return null; });
    return json(200, { ...result, emails });
  } catch (e: any) {
    console.error('[commerce/finalize]', e?.message ?? e);
    return json(500, { code: 'error' });
  }
}
