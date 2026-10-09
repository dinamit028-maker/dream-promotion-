/** The public links (quote, booking, document, PDF) slow down floods: per address and route, per minute, in Hebrew. */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';
import { MINUTE, PUBLIC_LIMITS, clientAddress, rateLimited, resetRateLimits } from '../src/lib/server/rate-limit';

const from = (ip?: string) => new Request('http://x', { headers: ip ? { 'x-forwarded-for': `${ip}, 10.0.0.1` } : {} });
beforeEach(() => resetRateLimits());
before(() => { (globalThis as any).__DP_TEST_ADMIN_DB__ = { ...fakeDb({ quotes: [] }), auth: { getUser: async () => ({ data: { user: null } }) } }; });

test('the client address: the first forwarded address, then x-real-ip, else one shared bucket', () => {
  assert.equal(clientAddress(from('1.2.3.4')), '1.2.3.4');
  assert.equal(clientAddress(new Request('http://x', { headers: { 'x-real-ip': '5.6.7.8' } })), '5.6.7.8');
  assert.equal(clientAddress(from()), 'unknown');
});

test('a fixed window per address and route: the limit passes, the next one waits, others are not affected', async () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(rateLimited(from('1.1.1.1'), 'r', 3, MINUTE, t0 + i), null);
  const no = rateLimited(from('1.1.1.1'), 'r', 3, MINUTE, t0 + 10);
  assert.ok(no); assert.equal(no!.status, 429);
  assert.equal(no!.headers.get('Retry-After'), '60');
  const j = await no!.json();
  assert.equal(j.code, 'rate_limited'); assert.match(j.message, /יותר מדי בקשות/);
  assert.equal(rateLimited(from('2.2.2.2'), 'r', 3, MINUTE, t0 + 10), null, 'another address');
  assert.equal(rateLimited(from('1.1.1.1'), 'other', 3, MINUTE, t0 + 10), null, 'another route');
  assert.equal(rateLimited(from('1.1.1.1'), 'r', 3, MINUTE, t0 + MINUTE + 1), null, 'a new minute');
});

test('the quote link answers 429 after its limit, before touching the database', async () => {
  const route = await import('../src/app/api/quote/[token]/route');
  const T = 'c'.repeat(64);
  const post = () => route.POST(new Request('http://x', { method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: '{}' }), { params: Promise.resolve({ token: T }) });
  for (let i = 0; i < PUBLIC_LIMITS.quoteAnswer; i++) assert.equal((await post()).status, 404, 'not found (no such quote) — but counted');
  assert.equal((await post()).status, 429);
  const get = await route.GET(new Request('http://x', { headers: { 'x-forwarded-for': '9.9.9.9' } }), { params: Promise.resolve({ token: T }) });
  assert.equal(get.status, 404, 'reading has its own, larger limit');
});
