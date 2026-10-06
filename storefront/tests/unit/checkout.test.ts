/**
 * Stage 3 on the storefront's server: the sealed payment keys, the PayPlus adapter (what it sends, what counts as paid, the
 * notice's signature), the pretend provider's lock, the customer's form, and same-origin requests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { customerOf } from '../../src/lib/checkout';
import { providerOf } from '../../src/lib/pay';
import { mockAllowed } from '../../src/lib/pay/mock';
import { payplus } from '../../src/lib/pay/payplus';
import { ProviderError } from '../../src/lib/pay/types';
import { readJson, sameOrigin } from '../../src/lib/request';
import { openKeys, sealKeys } from '../../src/lib/seal';
import { hashToken, isToken, newToken, shopperKey } from '../../src/lib/tokens';

const KEY = 'test-payment-seal-key-0123456789abcdef';
const keys = { api_key: 'api-1234', secret_key: 'secret-5678' };

test('payment keys: sealed and opened with the shared key only', () => {
  const s = sealKeys(keys, KEY);
  assert.match(s, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!s.includes('secret-5678') && !s.includes('api-1234'), 'nothing readable in the sealed value');
  assert.deepEqual(openKeys(s, KEY), keys);
  assert.equal(openKeys(s, `${KEY}-other`), null, 'another key opens nothing');
  const parts = s.split('.'); parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('A') ? 'BB' : 'AA');
  assert.equal(openKeys(parts.join('.'), KEY), null, 'a changed value is refused');
  assert.equal(openKeys('v2.x.y.z', KEY), null);
  assert.throws(() => sealKeys(keys, 'short'), /PAYMENT_SEAL_KEY/);
});

test('tokens: random, 43 characters, only their hash goes to the database', () => {
  const a = newToken(), b = newToken();
  assert.ok(isToken(a) && isToken(b) && a !== b);
  assert.ok(!isToken('x') && !isToken(`${a}!`) && !isToken(null));
  assert.match(hashToken(a), /^[0-9a-f]{64}$/);
  assert.equal(shopperKey('1.2.3.4', 's1'), shopperKey('1.2.3.4', 's1'));
  assert.notEqual(shopperKey('1.2.3.4', 's1'), shopperKey('1.2.3.4', 's2'), 'per store');
  assert.ok(!shopperKey('1.2.3.4', 's1').includes('1.2.3.4'));
});

function fakeFetch(answer: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const pageReq = {
  orderId: '11111111-2222-4333-8444-555555555555', number: 1001, amount: 111, currency: 'ILS',
  customer: { name: 'דנה', email: 'd@example.com', phone: '0501234567' },
  successUrl: 'https://shop.test/checkout/return?o=tok', failureUrl: 'https://shop.test/checkout/return?o=tok&r=failed',
  callbackUrl: 'https://shop.test/api/pay/payplus/webhook', storeName: 'חנות',
};

test('PayPlus: the payment page — staging in test, our amount and order, no invoice from the provider', async () => {
  const { f, calls } = fakeFetch({ results: { status: 'success' }, data: { payment_page_link: 'https://payments.payplus.co.il/x', page_request_uid: 'pr-1' } });
  const r = await payplus(f).createPage(keys, 'page-uid', true, pageReq);
  assert.deepEqual(r, { url: 'https://payments.payplus.co.il/x', page: 'pr-1' });
  assert.equal(calls[0].url, 'https://restapidev.payplus.co.il/api/v1.0/PaymentPages/generateLink');
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h['api-key'], 'api-1234'); assert.equal(h['secret-key'], 'secret-5678');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.payment_page_uid, 'page-uid');
  assert.equal(body.amount, 111); assert.equal(body.currency_code, 'ILS');
  assert.equal(body.more_info, pageReq.orderId);
  assert.equal(body.initial_invoice, false, 'the provider issues no invoice — our documents are the only ones');
  assert.equal(body.refURL_callback, pageReq.callbackUrl);
  assert.equal(body.items.reduce((s: number, i: { price: number; quantity: number }) => s + i.price * i.quantity, 0), 111, 'the items add up to the amount');
  // production when not in test
  const live = fakeFetch({ results: { status: 'success' }, data: { payment_page_link: 'https://p.test/y', page_request_uid: 'pr-2' } });
  await payplus(live.f).createPage(keys, 'page-uid', false, pageReq);
  assert.equal(live.calls[0].url, 'https://restapi.payplus.co.il/api/v1.0/PaymentPages/generateLink');
});

test('PayPlus: no page without a success and an https link', async () => {
  await assert.rejects(payplus(fakeFetch({ results: { status: 'error' } }).f).createPage(keys, 'u', true, pageReq), ProviderError);
  await assert.rejects(payplus(fakeFetch({ results: { status: 'success' }, data: { payment_page_link: 'javascript:alert(1)', page_request_uid: 'p' } }).f)
    .createPage(keys, 'u', true, pageReq), ProviderError);
  await assert.rejects(payplus(fakeFetch({}, 500).f).createPage(keys, 'u', true, pageReq), ProviderError);
  await assert.rejects(payplus(fakeFetch({}).f).createPage(keys, '', true, pageReq), ProviderError, 'no page uid configured');
});

test('PayPlus: only status 000 with a transaction is "approved"', async () => {
  const ok = fakeFetch({ results: { status: 'success' }, data: { status_code: '000', transaction_uid: 't-1', amount: '111.00', currency_code: 'ils', more_info: pageReq.orderId } });
  const v = await payplus(ok.f).verify(keys, true, 'pr-1');
  assert.deepEqual({ ...v, detail: '' }, { status: 'approved', txn: 't-1', amount: 111, currency: 'ILS', orderId: pageReq.orderId, detail: '' });
  assert.equal(ok.calls[0].url, 'https://restapidev.payplus.co.il/api/v1.0/PaymentPages/ipn');
  assert.deepEqual(JSON.parse(String(ok.calls[0].init.body)), { payment_request_uid: 'pr-1' });
  assert.equal((await payplus(fakeFetch({ data: { status_code: '000' } }).f).verify(keys, true, 'p')).status, 'pending', '000 without a transaction');
  assert.equal((await payplus(fakeFetch({ data: { status_code: '003', transaction_uid: 't' } }).f).verify(keys, true, 'p')).status, 'declined');
  assert.equal((await payplus(fakeFetch({ data: {} }).f).verify(keys, true, 'p')).status, 'pending', 'nothing yet');
  assert.equal((await payplus(fakeFetch({ data: { status_code: '000', transaction_uid: 't', amount: 'abc' } }).f).verify(keys, true, 'p')).amount, null);
});

test("PayPlus: a notice is signed with the terminal's secret (or it is refused)", () => {
  const body = JSON.stringify({ transaction: { payment_page_request_uid: 'pr-1', more_info: pageReq.orderId, status_code: '000' } });
  const sig = createHmac('sha256', keys.secret_key).update(body).digest('base64');
  const p = payplus(fakeFetch({}).f);
  assert.deepEqual(p.readNotice(keys, body, new Headers({ hash: sig, 'user-agent': 'PayPlus' })), { signature: true, page: 'pr-1', orderId: pageReq.orderId });
  assert.equal(p.readNotice(keys, body, new Headers({ hash: sig, 'user-agent': 'curl' })).signature, false, 'not from PayPlus');
  assert.equal(p.readNotice(keys, `${body} `, new Headers({ hash: sig, 'user-agent': 'PayPlus' })).signature, false, 'a changed body');
  assert.equal(p.readNotice({ ...keys, secret_key: 'other' }, body, new Headers({ hash: sig, 'user-agent': 'PayPlus' })).signature, false, 'another terminal');
  assert.equal(p.readNotice(keys, body, new Headers()).signature, null, 'no signature: the direct question decides');
  assert.deepEqual(p.readNotice(keys, 'not json', new Headers()), { signature: null, page: '', orderId: '' });
});

test('the pretend provider exists only in local tests', () => {
  assert.equal(mockAllowed({ PAYMENT_MOCK: '1' }), true);
  assert.equal(mockAllowed({ PAYMENT_MOCK: '1', VERCEL: '1' }), false, 'never on Vercel');
  assert.equal(mockAllowed({}), false, 'never without PAYMENT_MOCK=1');
  const before = { m: process.env.PAYMENT_MOCK, v: process.env.VERCEL };
  process.env.PAYMENT_MOCK = '1'; process.env.VERCEL = '1';
  assert.throws(() => providerOf('mock'), ProviderError);
  delete process.env.VERCEL; delete process.env.PAYMENT_MOCK;
  assert.throws(() => providerOf('mock'), ProviderError);
  assert.equal(providerOf('payplus').id, 'payplus');
  assert.throws(() => providerOf('cardcom'), ProviderError);
  if (before.m !== undefined) process.env.PAYMENT_MOCK = before.m;
  if (before.v !== undefined) process.env.VERCEL = before.v;
});

test("the customer's form: known fields only — a price or a total from the browser is dropped", () => {
  const c = customerOf({ name: 'דנה', phone: '050', email: 'd@x.co', method: 'pickup', terms: true, price: 1, total: 1, store: 'x', notes: 'n'.repeat(900) });
  assert.deepEqual(Object.keys(c).sort(), ['apartment', 'city', 'email', 'house', 'method', 'name', 'notes', 'phone', 'street', 'terms']);
  assert.equal(c.terms, 'true');
  assert.equal(c.notes.length, 600);
  assert.equal(customerOf({ terms: 'yes' }).terms, 'false');
  assert.equal(customerOf({ name: 5 }).name, '');
});

test('a cart or a checkout is changed only from a page of the same host', async () => {
  const req = (h: Record<string, string>) => new Request('http://shop.test/api/cart', { method: 'POST', headers: h, body: '{"a":1}' });
  assert.equal(sameOrigin(req({ host: 'shop.test', origin: 'https://shop.test' })), true);
  assert.equal(sameOrigin(req({ host: 'shop.test:3231', origin: 'http://shop.test:3231' })), true);
  assert.equal(sameOrigin(req({ host: 'shop.test', origin: 'https://evil.test' })), false);
  assert.equal(sameOrigin(req({ host: 'shop.test' })), false, 'no Origin header');
  assert.equal(sameOrigin(req({ host: 'shop.test', origin: 'null' })), false);
  assert.deepEqual(await readJson(req({ host: 'shop.test' })), { a: 1 });
  assert.equal(await readJson(new Request('http://x.test', { method: 'POST', body: '[1]' })), null);
  assert.equal(await readJson(new Request('http://x.test', { method: 'POST', body: 'x'.repeat(9000) })), null);
});
