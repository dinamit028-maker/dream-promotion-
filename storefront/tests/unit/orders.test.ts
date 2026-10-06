/**
 * Dream Commerce stage 4 on the storefront: the signed order link of an email (the same example as the dashboard's test —
 * the two servers must agree), and the call that tells the dashboard an order was paid (never fatal, never without a secret).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderRef, orderRefOk } from '../../src/lib/order-link';
import { documentPdf, notifyPaid } from '../../src/lib/dashboard';

const ID = '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b', SECRET = 'test-secret-0123456789';

test('the order link: the same HMAC as the dashboard (dream-promotion/tests/commerce-finance.test.ts)', () => {
  assert.equal(orderRef(ID, SECRET), `${ID}.i0PORRpTW-5HQ4PuVM_J47zzXhuXRnnL`);
  assert.equal(orderRefOk(`${ID}.i0PORRpTW-5HQ4PuVM_J47zzXhuXRnnL`, SECRET), ID);
  assert.equal(orderRefOk(`${ID}.i0PORRpTW-5HQ4PuVM_J47zzXhuXRnnL`, `${SECRET}x`), null, 'another secret');
  assert.equal(orderRefOk(`${ID.replace('3f', '4f')}.i0PORRpTW-5HQ4PuVM_J47zzXhuXRnnL`, SECRET), null, 'another order');
  assert.equal(orderRefOk('x', SECRET), null);
  assert.equal(orderRef(ID, ''), null, 'no secret, no link');
});

test('"paid" reaches the dashboard with the shared secret; without its settings nothing is sent', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status: 200 }); }) as any;
  try {
    delete process.env.DASHBOARD_URL; delete process.env.COMMERCE_SECRET;
    assert.equal(await notifyPaid(ID), false);
    process.env.DASHBOARD_URL = 'https://dash.example/'; process.env.COMMERCE_SECRET = 'short';
    assert.equal(await notifyPaid(ID), false, 'a short secret is not a secret');
    process.env.COMMERCE_SECRET = 'commerce-secret-0123456789';
    assert.equal(await notifyPaid(ID), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://dash.example/api/commerce/finalize');
    assert.equal((calls[0].init.headers as Record<string, string>)['x-commerce-secret'], 'commerce-secret-0123456789');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { orderId: ID });
    assert.equal(await documentPdf('../../etc'), null, 'only a share token goes to the dashboard');
    globalThis.fetch = (async () => { throw new Error('down'); }) as any;
    assert.equal(await notifyPaid(ID), false, 'the dashboard is down: the cron will finish it');
  } finally {
    globalThis.fetch = real;
    delete process.env.DASHBOARD_URL; delete process.env.COMMERCE_SECRET;
  }
});

test('a failed cron run says why, and never with a key in it (2.57.4)', async () => {
  const { failureReason } = await import('../../src/lib/failure');
  const cause = new TypeError('Cannot convert argument to a ByteString because the character at index 18 has a value of 8226');
  assert.equal(failureReason(new TypeError('fetch failed', { cause })),
    'TypeError: fetch failed ← TypeError: Cannot convert argument to a ByteString because the character at index 18 has a value of 8226');
  assert.equal(failureReason(new Error('sf_orders_unconfirmed: 401')), 'Error: sf_orders_unconfirmed: 401');
  const leaky = failureReason(new Error('bad key sb_secret_AbCdEf0123456789xyz and eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.sig and ' + 'x'.repeat(40)));
  assert.ok(!leaky.includes('AbCdEf') && !leaky.includes('eyJhbGci') && !leaky.includes('x'.repeat(40)), leaky);
  assert.equal(failureReason(undefined), 'unknown');
  assert.equal(failureReason('plain'), 'plain');
});
