import { createHmac, randomUUID } from 'node:crypto';
import { ProviderError, type Notice, type PageRequest, type Provider, type Verified } from './types';

/**
 * A pretend provider for the local tests and development only (DREAM_COMMERCE_ARCHITECTURE §12, like the tax authority's
 * test mode): its "payment page" is a page of this storefront (/pay-mock/<page>), its memory is this server's. Never on
 * Vercel and never without PAYMENT_MOCK=1 — mockAllowed() is checked before it is used, and a unit test pins that.
 */
export function mockAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.PAYMENT_MOCK === '1' && !env.VERCEL;
}

interface MockPage { req: PageRequest; status: Verified['status']; txn: string; secret: string }
const g = globalThis as unknown as { __mockPay?: Map<string, MockPage> };
export const mockPages: Map<string, MockPage> = (g.__mockPay ??= new Map());

/** the shopper pressed "pay" or "decline" on the pretend page: the page changes, and the provider's notice is sent */
export async function mockDecide(page: string, approve: boolean, fetchImpl: typeof fetch = fetch): Promise<MockPage | null> {
  const p = mockPages.get(page);
  if (!p) return null;
  if (p.status === 'pending') { p.status = approve ? 'approved' : 'declined'; p.txn = approve ? `mock-${randomUUID()}` : ''; }
  const body = JSON.stringify({ transaction: { payment_page_request_uid: page, more_info: p.req.orderId, status_code: approve ? '000' : '001' } });
  await fetchImpl(p.req.callbackUrl, {
    method: 'POST', body, signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', 'user-agent': 'PayPlus', hash: createHmac('sha256', p.secret).update(body).digest('base64') },
  }).catch(() => undefined);   // a notice that does not arrive: the return page and the cron ask anyway
  return p;
}

export const mock: Provider = {
  id: 'mock',
  async createPage(k, _uid, _test, r) {
    if (!mockAllowed()) throw new ProviderError('mock payments are for local tests only');
    const page = `mp_${randomUUID()}`;
    mockPages.set(page, { req: r, status: 'pending', txn: '', secret: k.secret_key });
    return { url: `${new URL(r.callbackUrl).origin}/pay-mock/${page}`, page };
  },
  async verify(_k, _test, page) {
    if (!mockAllowed()) throw new ProviderError('mock payments are for local tests only');
    const p = mockPages.get(page);
    if (!p) return { status: 'pending', txn: '', amount: null, currency: '', orderId: '', detail: 'unknown page' };
    return { status: p.status, txn: p.txn, amount: p.req.amount, currency: p.req.currency, orderId: p.req.orderId, detail: p.status };
  },
  readNotice(k, body, h): Notice {
    let j: any = {};
    try { j = JSON.parse(body); } catch { /* nothing */ }
    const hash = h.get('hash');
    return {
      signature: hash ? hash === createHmac('sha256', k.secret_key).update(body).digest('base64') : null,
      page: String(j?.transaction?.payment_page_request_uid ?? ''), orderId: String(j?.transaction?.more_info ?? ''),
    };
  },
};
