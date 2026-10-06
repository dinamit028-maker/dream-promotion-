import { adminDb } from '@/lib/server/admin';
import { financeCaller } from '@/lib/server/finance';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { recordOrderRefund, sendQueuedEmails } from '@/lib/server/commerce';
import { planOrderRefund, saleFromRow } from '@/features/store/commerce';
import { financeError } from '@/features/finance/rows';
import { toRefund, type RefundRequest } from '@/features/register/refunds';

export const runtime = 'nodejs';

/**
 * "החזר" on an order of the site (Dream Commerce stage 4). The money goes back in the payment company's own screen; here
 * the owner confirms it was done, and the refund is recorded the register's way (planRefund → sale_refunds: the ceiling
 * under a lock, the ledger, the stock) with its credit invoice. Body: {orderId, mode: 'full' | 'items' | 'amount',
 * qty?: number[], amount?: number, restock?: boolean, reason?: string, confirmed: true}.
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const bad = (message: string, code = 'bad_request', status = 400) => json(status, { code, message });

export async function POST(req: Request) {
  const limited = rateLimited(req, 'store-refund', 10, MINUTE);
  if (limited) return limited;
  const c = await financeCaller(req, { write: true });
  if (!c.ok) return json(c.status, c.body);
  const body = await req.json().catch(() => null);
  if (!body || typeof body.orderId !== 'string') return bad('בקשה לא תקינה.');
  const db = adminDb();
  const { data: o } = await db.from('orders').select('id, sale_id, is_test').eq('id', body.orderId).eq('business_id', c.businessId).maybeSingle();
  if (!o) return bad('ההזמנה לא נמצאה.', 'not_found', 404);
  if (o.is_test) return bad('הזמנת בדיקה — אין עליה מכירה ואין מה להחזיר.');
  if (!o.sale_id) return bad('המכירה של ההזמנה עוד לא נרשמה. נסו שוב בעוד דקה.');
  const [{ data: s }, { data: prior }, { data: me }] = await Promise.all([
    db.from('sales').select('*').eq('id', o.sale_id).eq('business_id', c.businessId).maybeSingle(),
    db.from('sale_refunds').select('*').eq('sale_id', o.sale_id).eq('business_id', c.businessId),
    db.from('profiles').select('full_name').eq('id', c.userId).maybeSingle(),
  ]);
  if (!s) return bad('המכירה לא נמצאה.', 'not_found', 404);
  const mode = body.mode === 'items' ? 'items' : body.mode === 'amount' ? 'amount' : 'full';
  const req2: RefundRequest = mode === 'items' ? { mode, qty: (Array.isArray(body.qty) ? body.qty : []).map((n: unknown) => Number(n) || 0) }
    : mode === 'amount' ? { mode, amount: Number(body.amount) || 0 } : { mode };
  const plan = planOrderRefund(saleFromRow(s), (prior ?? []).map(toRefund), req2, {
    confirmed: body.confirmed === true, restock: body.restock === true, reason: String(body.reason ?? ''), employeeName: String((me as any)?.full_name ?? '').slice(0, 80),
  });
  if (!plan.ok) return bad(plan.error);
  const r = await recordOrderRefund(c.businessId, c.userId, o.sale_id, plan.refund);
  if (!r.ok) return bad(financeError(r.error), 'refund_failed', 409);
  await sendQueuedEmails().catch(() => null);
  return json(200, { ok: true, refundId: r.refundId, amount: plan.refund.amount, credit: r.credit });
}
