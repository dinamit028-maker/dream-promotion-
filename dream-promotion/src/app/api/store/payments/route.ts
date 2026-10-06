import { adminDb } from '@/lib/server/admin';
import { financeCaller } from '@/lib/server/finance';
import { paymentSealReady, sealPaymentKeys } from '@/lib/server/payment-seal';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { checkTerminal, keyHint, type TerminalInfo } from '@/features/store/checkout';

export const runtime = 'nodejs';

/**
 * The store's payment terminal (Dream Commerce stage 3): PayPlus, its TEST environment only in this stage.
 *   GET                       → connected or not, the provider, test / live, the last 4 characters of the API key
 *   POST {action: 'connect'}  → the keys are checked, sealed (PAYMENT_SEAL_KEY) and kept for the business worked in now;
 *                               they are never sent back to any browser
 *   POST {action: 'disconnect'} → selling on the site is switched off first, then the terminal is removed
 * Money: financeCaller — a member who may write (not a cashier, not a viewer, not a locked business); the business is the
 * server's, never the browser's.
 */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const bad = (message: string, code = 'bad_request', status = 400) => json(status, { code, message });

async function info(businessId: string): Promise<TerminalInfo> {
  const { data } = await adminDb().from('payment_accounts').select('provider, mode, hint, connected_at').eq('business_id', businessId).maybeSingle();
  const r = data as { provider: 'payplus' | 'mock'; mode: 'test' | 'live'; hint: string; connected_at: string } | null;
  return { connected: Boolean(r), provider: r?.provider ?? null, mode: r?.mode ?? null, hint: r?.hint ?? '', connectedAt: r?.connected_at ?? null, ready: paymentSealReady() };
}

export async function GET(req: Request) {
  const c = await financeCaller(req);
  if (!c.ok) return json(c.status, c.body);
  return json(200, await info(c.businessId));
}

export async function POST(req: Request) {
  const limited = rateLimited(req, 'store-payments', 10, MINUTE);
  if (limited) return limited;
  const c = await financeCaller(req, { write: true });
  if (!c.ok) return json(c.status, c.body);
  let body: any;
  try { body = await req.json(); } catch { return bad('בקשה לא תקינה.'); }
  const db = adminDb();

  if (body?.action === 'connect') {
    if (!paymentSealReady()) return bad('השרת עוד לא מוכן לשמור מפתחות סליקה (חסר PAYMENT_SEAL_KEY ב-Vercel).', 'not_configured', 503);
    const t = checkTerminal({ apiKey: String(body.apiKey ?? ''), secretKey: String(body.secretKey ?? ''), pageUid: String(body.pageUid ?? '') });
    if (!t.ok) return bad(t.error);
    const { error } = await db.from('payment_accounts').upsert({
      business_id: c.businessId, provider: 'payplus', mode: 'test', sealed: sealPaymentKeys(t.keys), page_uid: t.pageUid,
      hint: keyHint(t.keys.api_key), connected_at: new Date().toISOString(), updated_by: c.userId,
    }, { onConflict: 'business_id' });
    if (error) return bad(/does not exist|schema cache/i.test(error.message) ? 'צריך קודם להריץ את מיגרציה 20261006003500_commerce_checkout.sql.' : 'המסוף לא נשמר — נסו שוב.', 'save_failed', 500);
    return json(200, await info(c.businessId));
  }

  if (body?.action === 'disconnect') {
    const off = await db.from('stores').update({ checkout_enabled: false }).eq('business_id', c.businessId);
    if (off.error) return bad('לא הצלחנו לכבות את המכירה באתר — נסו שוב.', 'save_failed', 500);
    const { error } = await db.from('payment_accounts').delete().eq('business_id', c.businessId);
    if (error) return bad('המסוף לא הוסר — נסו שוב.', 'save_failed', 500);
    return json(200, await info(c.businessId));
  }
  return bad('פעולה לא מוכרת.');
}
