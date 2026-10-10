import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentKeys } from '../seal';
import { ProviderError, type Notice, type PageRequest, type Provider, type Verified } from './types';

/**
 * PayPlus (the owner's choice, 6.10.2026). From PayPlus's public documentation (docs.payplus.co.il), NOT yet tried against
 * a real terminal — NEEDS_PROVIDER_VERIFICATION on the staging terminal before the first real sale:
 *   - PaymentPages/generateLink: payment_page_uid, amount, currency_code, refURL_success / _failure / _callback, more_info
 *     (our order id) → data.payment_page_link + data.page_request_uid. initial_invoice: false — the provider issues no
 *     invoice or receipt (our documents are the only ones, stage 4).
 *   - PaymentPages/ipn with payment_request_uid: the transaction of the page — status_code "000" is an approved charge.
 *   - A notice (refURL_callback) carries `user-agent: PayPlus` and `hash` = base64(HMAC-SHA256(body, secret key)).
 * Staging: restapidev.payplus.co.il; production: restapi.payplus.co.il. The keys go in the headers api-key / secret-key.
 */
const BASE = { test: 'https://restapidev.payplus.co.il/api/v1.0', live: 'https://restapi.payplus.co.il/api/v1.0' };
type Fetch = typeof fetch;

const headers = (k: PaymentKeys) => ({
  'Content-Type': 'application/json', Accept: 'application/json', 'api-key': k.api_key, 'secret-key': k.secret_key,
  Authorization: JSON.stringify({ api_key: k.api_key, secret_key: k.secret_key }),
});
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v: unknown) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };

export function payplus(fetchImpl: Fetch = fetch): Provider {
  async function post(test: boolean, path: string, k: PaymentKeys, body: unknown): Promise<any> {
    const res = await fetchImpl(`${test ? BASE.test : BASE.live}${path}`, {
      method: 'POST', headers: headers(k), body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok || !json) throw new ProviderError(`payplus ${path}: ${res.status}`);
    return json;
  }

  return {
    id: 'payplus',
    async createPage(k, pageUid, test, r: PageRequest) {
      if (!pageUid) throw new ProviderError('payplus: no payment page uid');
      const j = await post(test, '/PaymentPages/generateLink', k, {
        payment_page_uid: pageUid, charge_method: 1, amount: r.amount, currency_code: r.currency,
        refURL_success: r.successUrl, refURL_failure: r.failureUrl, refURL_cancel: r.failureUrl, refURL_callback: r.callbackUrl,
        more_info: r.orderId, initial_invoice: false, sendEmailApproval: false, sendEmailFailure: false,
        customer: { customer_name: r.customer.name, email: r.customer.email, phone: r.customer.phone },
        items: [{ name: (r.itemName || `הזמנה ${r.number} — ${r.storeName}`).slice(0, 100), quantity: 1, price: r.amount }],
      });
      const url = str(j?.data?.payment_page_link), page = str(j?.data?.page_request_uid);
      if (str(j?.results?.status) !== 'success' || !/^https:\/\//.test(url) || !page) throw new ProviderError('payplus: no payment page');
      return { url, page };
    },
    async verify(k, test, page): Promise<Verified> {
      const j = await post(test, '/PaymentPages/ipn', k, { payment_request_uid: page });
      const d = j?.data ?? {};
      const code = str(d.status_code), txn = str(d.transaction_uid);
      const status: Verified['status'] = code === '000' && txn ? 'approved' : code && code !== '000' ? 'declined' : 'pending';
      return { status, txn, amount: num(d.amount), currency: str(d.currency_code).toUpperCase(), orderId: str(d.more_info), detail: `${code} ${str(d.status)}`.trim() };
    },
    readNotice(k, body, h): Notice {
      let j: any = {};
      try { j = JSON.parse(body); } catch { /* not JSON: no page, nothing to ask about */ }
      const t = j?.transaction ?? j?.data ?? j ?? {};
      const page = str(t.payment_page_request_uid ?? j?.payment_page_request_uid ?? j?.page_request_uid);
      const orderId = str(t.more_info ?? j?.more_info);
      const hash = h.get('hash');
      if (!hash) return { signature: null, page, orderId };
      const want = Buffer.from(createHmac('sha256', k.secret_key).update(body, 'utf8').digest('base64'));
      const got = Buffer.from(hash);
      const ok = /payplus/i.test(h.get('user-agent') ?? '') && want.length === got.length && timingSafeEqual(want, got);
      return { signature: ok, page, orderId };
    },
  };
}
