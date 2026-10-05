/**
 * Dream Finance 2.51 on the server (service role — so the routes check the rules themselves): who may use the money routes,
 * the Tax Authority gateway (a test number is always labelled; nothing is sent without verified fields; mock never on
 * production), allocation requests, the per-business OAuth connection (tokens sealed, never another business's), the
 * customer's quote link. The network is stubbed: a test that would reach the Tax Authority fails.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fakeDb } from './fakedb';
import { SEED_RULES, minimizedRequest } from '../src/features/finance/allocation';

const OWN = 'user-own', CASH = 'user-cash', SA = 'user-sa', OTHER = 'user-other';
const B1 = 'biz-1', B2 = 'biz-2';
const tables: Record<string, any[]> = {};
const current: Record<string, string> = { [OWN]: B1, [CASH]: B1, [SA]: B1, [OTHER]: B2 };
function reset() {
  for (const k of Object.keys(tables)) delete tables[k];
  Object.assign(tables, {
    profiles: [{ id: SA, is_super_admin: true }, { id: OWN, is_super_admin: false }, { id: CASH, is_super_admin: false }, { id: OTHER, is_super_admin: false }],
    businesses: [{ id: B1, status: 'active', paid_until: null, grace_days: 0 }, { id: B2, status: 'active', paid_until: null, grace_days: 0 }],
    business_members: [{ business_id: B1, user_id: OWN, role: 'owner', access: 'full' }, { business_id: B1, user_id: CASH, role: 'editor', access: 'register' },
      { business_id: B2, user_id: OTHER, role: 'owner', access: 'full' }],
    finance_access_grants: [],
    documents: [
      { id: '00000000-0000-4000-8000-00000000d001', business_id: B1, doc_type: 305, doc_number: 4, link_no: 1, issued_at: '2026-10-04T08:00:00Z', doc_date: '2026-10-04', customer_name: 'לקוח פרטי מאוד', customer_phone: '050-1234567',
        customer_dealer: '514000017', lines: [{ name: 'פרויקט סודי', qty: 1, totalExVat: 6000 }], payments: [], before_discount: 6000, discount: 0, after_discount: 6000, vat_amount: 1080, total: 7080,
        vat_rate: 18, issuer: { dealerNumber: '123456782', entityType: 'company', name: 'FollowMe' } },
      { id: '00000000-0000-4000-8000-00000000d002', business_id: B1, doc_type: 305, doc_number: 5, link_no: 2, issued_at: '2026-10-04T08:00:00Z', doc_date: '2026-10-04', customer_name: 'x', customer_dealer: '514000017',
        lines: [], payments: [], before_discount: 100, discount: 0, after_discount: 100, vat_amount: 18, total: 118, vat_rate: 18, issuer: { dealerNumber: '123456782', entityType: 'company' } },
      { id: '00000000-0000-4000-8000-00000000d003', business_id: B2, doc_type: 305, doc_number: 1, link_no: 3, issued_at: '2026-10-04T08:00:00Z', doc_date: '2026-10-04', customer_name: 'y', customer_dealer: '514000017',
        lines: [], payments: [], before_discount: 9000, discount: 0, after_discount: 9000, vat_amount: 1620, total: 10620, vat_rate: 18, issuer: { dealerNumber: '987654324', entityType: 'company' } },
    ],
    tax_allocations: [],
    tax_allocation_rules: SEED_RULES.map((r) => ({ version: r.version, effective_from: r.effectiveFrom, threshold_before_vat: r.thresholdBeforeVat, doc_types: r.docTypes, requires_customer_dealer: true, verified: false })),
    tax_authority_connections: [],
    quotes: [{ id: 'q1', business_id: B1, quote_number: 7, status: 'sent', share_token: 'c'.repeat(64), customer_name: 'דנה', user_id: OWN, lead_id: 'lead-secret', total: 118, before_discount: 100,
      discount: 0, after_discount: 100, vat_rate: 18, vat_amount: 18, valid_until: '2099-01-01', body: { lines: [{ name: 'טיפול', qty: 1, unitPrice: 118 }], pricesIncludeVat: true, discount: { kind: 'sum', value: 0 } },
      issuer: { name: 'FollowMe', dealerNumber: '123456782', entityType: 'company' }, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00.123456+00:00' }],
    push_subscriptions: [],
  });
}
const auth = (u: string) => ({ authorization: `Bearer ${u}` });
const ENV0 = { ...process.env };
let fetched: string[] = [];
before(() => {
  process.env.TOKEN_ENCRYPTION_KEY = 'test-key-for-sealing';
  delete process.env.ANTHROPIC_API_KEY;
  (globalThis as any).__DP_TEST_ADMIN_DB__ = {
    from: (t: string) => fakeDb(tables).from(t),
    auth: { getUser: async (t: string) => ({ data: { user: [OWN, CASH, SA, OTHER].includes(t) ? { id: t } : null } }) },
    rpc: async (fn: string, a: { uid: string }) => ({ data: fn === 'business_for_user' ? current[a.uid] ?? null : null, error: null }),
  };
  // nothing may reach the network unless a test says so
  (globalThis as any).fetch = async (url: string) => { fetched.push(String(url)); throw new Error(`network call in a test: ${url}`); };
});
beforeEach(() => {
  reset(); fetched = [];
  for (const k of Object.keys(process.env)) if (/^(ITA_|TAX_GATEWAY_MODE|VERCEL_ENV|APP_URL)/.test(k)) delete process.env[k];
  Object.assign(process.env, { TOKEN_ENCRYPTION_KEY: 'test-key-for-sealing' });
  void ENV0;
});

test('who may use the money routes: a member with full access; never a cashier; a super admin only with an open grant', async () => {
  const { financeCaller } = await import('../src/lib/server/finance');
  const call = (u?: string) => financeCaller(new Request('http://x', { headers: u ? auth(u) : {} }));
  assert.deepEqual(await call(OWN), { ok: true, userId: OWN, businessId: B1, member: true });
  assert.equal((await call()).ok, false);
  const c = await call(CASH); assert.ok(!c.ok && c.status === 403 && c.body.code === 'register_only', 'a cashier');
  const s = await call(SA); assert.ok(!s.ok && s.body.code === 'finance_closed', 'a super admin without an opening');
  tables.finance_access_grants.push({ id: 'g1', business_id: B1, user_id: SA, revoked_at: null, expires_at: new Date(Date.now() + 36e5).toISOString() });
  assert.deepEqual(await call(SA), { ok: true, userId: SA, businessId: B1, member: false }, 'with an open grant');
  tables.finance_access_grants[0].expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call(SA)).ok, false, 'an expired grant is closed again');
  tables.businesses[0].status = 'locked';
  const l = await call(OWN); assert.ok(!l.ok && l.body.code === 'business_locked', 'a locked business');
});

test('the gateway: unconfigured by default, mock never in a production build, live never sends unverified fields', async () => {
  const g = await import('../src/lib/server/tax/gateway');
  assert.equal(g.gatewayMode({}), 'unconfigured');
  assert.equal(g.gatewayMode({ TAX_GATEWAY_MODE: 'mock' }), 'mock');
  assert.equal(g.gatewayMode({ TAX_GATEWAY_MODE: 'mock', VERCEL_ENV: 'preview' }), 'mock');
  assert.equal(g.gatewayMode({ TAX_GATEWAY_MODE: 'mock', VERCEL_ENV: 'production' }), 'unconfigured', 'no test numbers on production');
  assert.equal(g.gatewayMode({ TAX_GATEWAY_MODE: 'mock', NODE_ENV: 'production' }), 'unconfigured', 'no production build answers test numbers');
  assert.equal(g.gatewayMode({ TAX_GATEWAY_MODE: 'mock', NODE_ENV: 'production', VERCEL_ENV: 'preview' }), 'unconfigured', 'a preview writes to the live database');
  assert.equal(g.gatewayMode({ TAX_GATEWAY_MODE: 'live' }), 'unconfigured', 'live without its settings');
  const live = { TAX_GATEWAY_MODE: 'live', ITA_API_BASE_URL: 'https://ita.example', ITA_ALLOCATION_PATH: '/x', ITA_OAUTH_AUTHORIZE_URL: 'https://ita.example/a', ITA_OAUTH_TOKEN_URL: 'https://ita.example/t',
    ITA_CLIENT_ID: 'id', ITA_CLIENT_SECRET: 'secret', APP_URL: 'https://app.example' };
  assert.equal(g.gatewayMode(live), 'live');
  const req = minimizedRequest({ docType: 305, docNumber: 4, docDate: '2026-10-04', afterDiscount: 6000, vatAmount: 1080, total: 7080, customerDealer: '514000017' }, { dealerNumber: '123456782' });
  const r = await g.taxGateway(live).requestAllocation(req, { businessId: B1 });
  assert.deepEqual([r.status, r.errorCode, r.isTest], ['error', 'spec_not_verified', false]);
  assert.deepEqual(fetched, [], 'nothing was sent');
  assert.throws(() => g.mapRequest(req), g.SpecNotVerified);
  assert.throws(() => g.mapResponse({}), g.SpecNotVerified);
  const m1 = await g.mockGateway.requestAllocation(req, { businessId: B1 }), m2 = await g.mockGateway.requestAllocation(req, { businessId: B1 });
  assert.match(m1.number!, /^TEST-\d{9}$/); assert.equal(m1.isTest, true); assert.equal(m1.number, m2.number, 'stable for the same request');
  assert.equal(g.requestDigest(req), createHash('sha256').update(JSON.stringify(req)).digest('hex'));
});

test('an allocation request: this business\'s own tax invoice, above the rule, never twice; a test number stays a test', async () => {
  const route = await import('../src/app/api/finance/allocations/route');
  const post = (u: string, documentId: string) => route.POST(new Request('http://x', { method: 'POST', headers: { ...auth(u), 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId }) }));
  const off = await post(OWN, '00000000-0000-4000-8000-00000000d001');
  assert.equal(off.status, 400); assert.equal((await off.json()).code, 'not_configured'); assert.equal(tables.tax_allocations.length, 0, 'nothing recorded without a gateway');
  process.env.TAX_GATEWAY_MODE = 'mock';
  assert.equal((await post(OWN, '00000000-0000-4000-8000-00000000d003')).status, 404, 'another business\'s invoice is not found');
  assert.equal((await post(CASH, '00000000-0000-4000-8000-00000000d001')).status, 403, 'not a cashier');
  const small = await post(OWN, '00000000-0000-4000-8000-00000000d002');
  assert.equal(small.status, 400); assert.equal((await small.json()).code, 'not_required');
  const ok = await post(OWN, '00000000-0000-4000-8000-00000000d001');
  const j = await ok.json();
  assert.equal(ok.status, 200); assert.equal(j.test, true); assert.match(j.number, /^TEST-\d{9}$/); assert.match(j.message, /מספר בדיקה .* לא מספר הקצאה של רשות המסים/);
  assert.deepEqual(tables.tax_allocations.map((r) => [r.status, r.is_test, r.gateway]), [['requested', true, 'mock'], ['approved', true, 'mock']]);
  const stored = JSON.stringify(tables.tax_allocations);
  assert.ok(!stored.includes('לקוח פרטי') && !stored.includes('050') && !stored.includes('פרויקט'), 'no customer details are kept with the request');
  assert.match(tables.tax_allocations[0].request_digest, /^[0-9a-f]{64}$/);
  // a real (manual) number exists → no more requests
  tables.tax_allocations.push({ id: 'm', business_id: B1, document_id: '00000000-0000-4000-8000-00000000d001', status: 'manual', is_test: false, allocation_number: '123456789', gateway: 'manual', created_at: new Date().toISOString() });
  assert.equal((await post(OWN, '00000000-0000-4000-8000-00000000d001')).status, 409);
  assert.deepEqual(fetched, []);
});

test('connecting to the Tax Authority: per business, a member only, tokens sealed and never used for another business', async () => {
  const status = await import('../src/app/api/finance/tax/status/route');
  const s = await (await status.GET(new Request('http://x', { headers: auth(OWN) }))).json();
  assert.deepEqual([s.mode, s.configured, s.connection], ['unconfigured', false, null]);
  assert.match(s.message, /הזין מספר הקצאה שהתקבל מרשות המסים ידנית/);
  assert.equal((await status.GET(new Request('http://x', { headers: auth(CASH) }))).status, 403);
  const connect = await import('../src/app/api/finance/tax/connect/route');
  assert.equal((await connect.POST(new Request('http://x', { method: 'POST', headers: auth(OWN) }))).status, 400, 'not configured');
  Object.assign(process.env, { ITA_OAUTH_AUTHORIZE_URL: 'https://ita.example/authorize', ITA_OAUTH_TOKEN_URL: 'https://ita.example/token', ITA_CLIENT_ID: 'cid', ITA_CLIENT_SECRET: 'csecret', APP_URL: 'https://app.example' });
  const started = await connect.POST(new Request('http://x', { method: 'POST', headers: auth(OWN) }));
  const cookie = /^(dp_tax_oauth=[A-Za-z0-9_-]+);/.exec(started.headers.get('set-cookie') ?? '')?.[1];
  assert.ok(cookie, 'the browser that starts the connection gets a one-time cookie');
  assert.match(started.headers.get('set-cookie') ?? '', /HttpOnly; Secure; SameSite=Lax/);
  const c = await started.json();
  const u = new URL(c.url);
  assert.equal(u.origin + u.pathname, 'https://ita.example/authorize');
  assert.deepEqual([u.searchParams.get('response_type'), u.searchParams.get('client_id'), u.searchParams.get('redirect_uri')], ['code', 'cid', 'https://app.example/api/finance/tax/callback']);
  assert.ok(!c.url.includes('csecret'), 'the client secret never goes to the browser');
  tables.finance_access_grants.push({ id: 'g', business_id: B1, user_id: SA, revoked_at: null, expires_at: new Date(Date.now() + 36e5).toISOString() });
  assert.equal((await connect.POST(new Request('http://x', { method: 'POST', headers: auth(SA) }))).status, 403, 'a super admin from outside does not connect a business');
  // the callback: the signed state decides the business; the token is stored sealed on THAT business only
  const cb = await import('../src/app/api/finance/tax/callback/route');
  const bad = await cb.GET(new Request('http://app/api/finance/tax/callback?code=x&state=forged'));
  assert.match(bad.headers.get('location') ?? '', /tax=failed/);
  (globalThis as any).fetch = async (url: string, init: any) => {
    fetched.push(String(url));
    assert.equal(String(url), 'https://ita.example/token');
    assert.match(String(init.body), /grant_type=authorization_code/);
    return new Response(JSON.stringify({ access_token: 'ACCESS-B1', refresh_token: 'REFRESH-B1', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const back = `http://app/api/finance/tax/callback?code=abc&state=${encodeURIComponent(new URL(c.url).searchParams.get('state')!)}`;
    // the same link finished in another browser (someone else's Tax Authority login): nothing is stored
    const elsewhere = await cb.GET(new Request(back));
    assert.match(elsewhere.headers.get('location') ?? '', /tax=denied/);
    const wrong = await cb.GET(new Request(back, { headers: { cookie: 'dp_tax_oauth=someone-elses-value' } }));
    assert.match(wrong.headers.get('location') ?? '', /tax=denied/);
    assert.deepEqual([fetched.length, tables.tax_authority_connections.length], [0, 0], 'no code was exchanged, nothing stored');
    const good = await cb.GET(new Request(back, { headers: { cookie: `theme=dark; ${cookie}` } }));
    assert.match(good.headers.get('location') ?? '', /tax=connected/);
    assert.match(good.headers.get('set-cookie') ?? '', /dp_tax_oauth=; .*Max-Age=0/, 'the one-time cookie is cleared');
  } finally { (globalThis as any).fetch = async (url: string) => { fetched.push(String(url)); throw new Error(`network call in a test: ${url}`); }; }
  const row = tables.tax_authority_connections.find((r) => r.business_id === B1);
  assert.equal(row.status, 'connected');
  assert.ok(!JSON.stringify(row).includes('ACCESS-B1') && !JSON.stringify(row).includes('REFRESH-B1'), 'tokens are stored sealed, never in the clear');
  const oauth = await import('../src/lib/server/tax/oauth');
  const t1 = await oauth.accessTokenFor(B1);
  assert.ok(t1.ok && t1.accessToken === 'ACCESS-B1');
  const t2 = await oauth.accessTokenFor(B2);
  assert.ok(!t2.ok && t2.code === 'not_connected', 'business B never gets business A\'s token');
  const status2 = await (await status.GET(new Request('http://x', { headers: auth(OWN) }))).json();
  assert.equal(status2.connection.status, 'connected');
  assert.ok(!JSON.stringify(status2).includes('ACCESS') && !JSON.stringify(status2).includes('sealed'), 'the status never carries a token');
});

test('the customer\'s quote link: no internal ids, one answer while it is valid, only for the version read', async () => {
  const route = await import('../src/app/api/quote/[token]/route');
  const T = 'c'.repeat(64);
  const g = await route.GET(new Request('http://x'), { params: { token: T } });
  const j = await g.json();
  assert.equal(g.status, 200); assert.equal(j.quote.number, 7); assert.equal(j.quote.lines[0].name, 'טיפול');
  for (const k of ['id', 'user_id', 'business_id', 'lead_id', 'share_token']) assert.ok(!(k in j.quote), `${k} must not be exposed`);
  assert.ok(!JSON.stringify(j).includes('lead-secret'));
  const post = (b: object) => route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify(b) }), { params: { token: T } });
  assert.equal((await post({ decision: 'accept', name: '' })).status, 400, 'a name is required');
  // the answer belongs to the version the customer read: no version, or the business edited the quote since → refresh first
  const stale = await post({ decision: 'accept', name: 'דנה כהן' });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'changed');
  tables.quotes[0].updated_at = '2026-10-02T09:00:00.000001+00:00';
  const edited = await post({ decision: 'accept', name: 'דנה כהן', version: j.quote.version });
  assert.equal(edited.status, 409); assert.equal((await edited.json()).code, 'changed', 'edited after the customer opened it');
  assert.equal(tables.quotes[0].status, 'sent', 'nothing was answered');
  const fresh = (await (await route.GET(new Request('http://x'), { params: { token: T } })).json()).quote;
  const ok = await post({ decision: 'accept', name: 'דנה כהן', note: 'מתאים', version: fresh.version });
  assert.equal(ok.status, 200);
  assert.deepEqual([tables.quotes[0].status, tables.quotes[0].decision_by, tables.quotes[0].decision_note], ['accepted', 'דנה כהן', 'מתאים']);
  const again = await post({ decision: 'reject', name: 'מישהו', version: fresh.version });
  assert.equal(again.status, 409, 'answered once'); assert.equal((await again.json()).code, 'decided');
  tables.quotes[0].status = 'sent'; tables.quotes[0].valid_until = '2020-01-01';
  const late = await post({ decision: 'accept', name: 'דנה', version: tables.quotes[0].updated_at });
  assert.equal(late.status, 409, 'an expired quote is not accepted'); assert.equal((await late.json()).code, 'expired');
  assert.equal((await route.GET(new Request('http://x'), { params: { token: 'x'.repeat(64) } })).status, 404);
  assert.equal((await route.GET(new Request('http://x'), { params: { token: '../../etc' } })).status, 404);
});

test('reading an expense with AI is off without a key, and never saves anything', async () => {
  const route = await import('../src/app/api/finance/expenses/scan/route');
  const fd = new FormData(); fd.append('file', new Blob(['x'], { type: 'image/png' }), 'r.png');
  const r = await route.POST(new Request('http://x', { method: 'POST', headers: auth(OWN), body: fd }));
  assert.equal(r.status, 503);
  assert.match((await r.json()).message, /ממלאים ידנית/);
  assert.equal((tables.expenses ?? []).length, 0);
});
