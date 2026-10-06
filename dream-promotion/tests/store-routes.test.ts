/**
 * The store's server routes (Dream Commerce 2.55) with an in-memory database (the real route code runs):
 *   /api/store/preview-token — a signed link to the store worked in now; not for a cashier; only when configured
 *   /api/store/domains       — a writer connects / checks / removes the domain of their own business's store; with
 *                              Vercel's token the domain is added to the storefront's project; "active" is never set here
 */
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fakeDb } from './fakedb';
import { resetRateLimits } from '../src/lib/server/rate-limit';

const OWN = 'user-own', CASH = 'user-cash', VIEW = 'user-view', OTHER = 'user-other', NOSTORE = 'user-nostore';
const B1 = '00000000-0000-4000-8000-00000000b001', B2 = '00000000-0000-4000-8000-00000000b002', B3 = '00000000-0000-4000-8000-00000000b003';
const S1 = '00000000-0000-4000-8000-0000000005a1', S2 = '00000000-0000-4000-8000-0000000005a2';
const SECRET = 's'.repeat(32);
const tables: Record<string, any[]> = {};
const current: Record<string, string> = { [OWN]: B1, [CASH]: B1, [VIEW]: B1, [OTHER]: B2, [NOSTORE]: B3 };
const calls: { method: string; url: string; body: any }[] = [];
const realFetch = globalThis.fetch;
const ENV_KEYS = ['STOREFRONT_PREVIEW_SECRET', 'STOREFRONT_URL', 'VERCEL_API_TOKEN', 'VERCEL_STOREFRONT_PROJECT', 'VERCEL_TEAM_ID'];

function reset() {
  for (const k of Object.keys(tables)) delete tables[k];
  resetRateLimits();
  calls.length = 0;
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(tables, {
    profiles: [OWN, CASH, VIEW, OTHER, NOSTORE].map((id) => ({ id, is_super_admin: false })),
    businesses: [B1, B2, B3].map((id) => ({ id, status: 'active', paid_until: null, grace_days: 0 })),
    business_members: [
      { business_id: B1, user_id: OWN, role: 'owner', access: 'full' }, { business_id: B1, user_id: CASH, role: 'editor', access: 'register' },
      { business_id: B1, user_id: VIEW, role: 'viewer', access: 'full' }, { business_id: B2, user_id: OTHER, role: 'owner', access: 'full' },
      { business_id: B3, user_id: NOSTORE, role: 'owner', access: 'full' }],
    stores: [{ id: S1, business_id: B1, name: 'FollowMe', status: 'draft' }, { id: S2, business_id: B2, name: 'Beauty', status: 'published' }],
    store_domains: [{ id: '00000000-0000-4000-8000-0000000006d9', business_id: B2, store_id: S2, domain: 'beauty.co.il', is_primary: true, status: 'active', vercel: {} }],
  });
}
/** the database's unique index on the domain (store_domains_domain_uq) */
const unique = (table: string, row: any, all: any[]) =>
  table === 'store_domains' && all.some((r) => r.domain === row.domain)
    ? { code: '23505', message: 'duplicate key value violates unique constraint "store_domains_domain_uq"' } : null;

before(() => {
  (globalThis as any).__DP_TEST_ADMIN_DB__ = {
    from: (t: string) => fakeDb(tables, { onInsert: unique }).from(t),
    auth: { getUser: async (t: string) => ({ data: { user: [OWN, CASH, VIEW, OTHER, NOSTORE].includes(t) ? { id: t } : null } }) },
    rpc: async (fn: string, a: { uid: string }) => ({ data: fn === 'business_for_user' ? current[a.uid] ?? null : null, error: null }),
  };
});
beforeEach(reset);
afterEach(() => { globalThis.fetch = realFetch; for (const k of ENV_KEYS) delete process.env[k]; });

const post = async (route: 'preview-token' | 'domains', user: string | null, body: unknown = {}) => {
  const { POST } = route === 'domains' ? await import('../src/app/api/store/domains/route') : await import('../src/app/api/store/preview-token/route');
  const r = await POST(new Request(`http://x/api/store/${route}`, { method: 'POST', headers: user ? { authorization: `Bearer ${user}` } : {}, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
/** the database's ids are uuids (the in-memory one makes "store_domains-2") */
const uuidIds = () => tables.store_domains.forEach((d, i) => { if (!/^[0-9a-f-]{36}$/.test(d.id)) d.id = `00000000-0000-4000-8000-0000000007${String(i).padStart(2, '0')}`; });
/** Vercel's API, answered in memory (the shapes of its documentation) */
function fakeVercel(answer: (method: string, path: string) => { status: number; body: any } = () => ({ status: 200, body: {} })) {
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push({ method, url: u.pathname + u.search, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const a = answer(method, u.pathname);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

test('a preview link: signed for the store worked in now, for one hour; refused when not configured, to a cashier, without a store', async () => {
  assert.equal((await post('preview-token', null)).status, 401);
  const unset = await post('preview-token', OWN);
  assert.equal(unset.status, 503); assert.equal(unset.body.code, 'not_configured');
  process.env.STOREFRONT_PREVIEW_SECRET = SECRET;
  const noUrl = await post('preview-token', OWN);
  assert.equal(noUrl.status, 503, 'no active domain and no STOREFRONT_URL');
  process.env.STOREFRONT_URL = 'https://storefront-abc.vercel.app';
  assert.equal((await post('preview-token', CASH)).status, 403, 'a cashier has no store');
  assert.equal((await post('preview-token', NOSTORE)).status, 404);

  const t0 = Math.floor(Date.now() / 1000);
  const r = await post('preview-token', OWN);
  assert.equal(r.status, 200);
  const u = new URL(r.body.url);
  assert.equal(u.origin, 'https://storefront-abc.vercel.app');
  const [store, exp, sig] = u.searchParams.get('preview')!.split('.');
  assert.equal(store, S1, 'the store of the business worked in now');
  assert.ok(Number(exp) >= t0 + 3600 && Number(exp) <= t0 + 3602 && r.body.expires === Number(exp), 'one hour');
  assert.equal(sig, createHmac('sha256', SECRET).update(`${store}.${exp}`).digest('base64url'));
  assert.equal((await post('preview-token', VIEW)).status, 200, 'a viewer may look (it changes nothing)');

  tables.store_domains.push({ id: 'd1', business_id: B1, store_id: S1, domain: 'followmecollection.com', is_primary: true, status: 'active' });
  assert.equal(new URL((await post('preview-token', OWN)).body.url).origin, 'https://followmecollection.com', 'the store\'s own domain once it works');
  const beauty = new URL((await post('preview-token', OTHER)).body.url);
  assert.equal(beauty.origin, 'https://beauty.co.il');
  assert.equal(beauty.searchParams.get('preview')!.split('.')[0], S2, 'never another business\'s store');
});

test('a domain without Vercel\'s token: recorded for the own store (and www), the steps by hand, never "active"', async () => {
  assert.equal((await post('domains', null, { action: 'connect', domain: 'a.com' })).status, 401);
  const c = await post('domains', CASH, { action: 'connect', domain: 'a.com' });
  assert.equal(c.status, 403); assert.equal(c.body.code, 'register_only');
  const v = await post('domains', VIEW, { action: 'connect', domain: 'a.com' });
  assert.equal(v.status, 403); assert.equal(v.body.code, 'view_only');
  assert.equal((await post('domains', NOSTORE, { action: 'connect', domain: 'a.com' })).status, 404, 'no store yet');
  assert.equal((await post('domains', OWN, { action: 'connect', domain: 'not a domain' })).status, 400);
  // 2.57.1: an address under the stores' root is the system's, never a store's own domain
  process.env.STORE_ROOT_DOMAIN = 'mystores.co.il';
  try {
    const sys = await post('domains', OWN, { action: 'connect', domain: 'someone.mystores.co.il' });
    assert.equal(sys.status, 400);
    assert.equal((await post('domains', OWN, { action: 'connect', domain: 'mystores.co.il' })).status, 400);
  } finally { delete process.env.STORE_ROOT_DOMAIN; }
  assert.equal((await post('domains', OWN, { action: 'fly' })).status, 400);

  const r = await post('domains', OWN, { action: 'connect', domain: 'https://www.FollowMeCollection.com/', storeId: S2, businessId: B2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.vercel, 'not_configured');
  uuidIds();
  const mine = tables.store_domains.filter((d) => d.store_id === S1);
  assert.deepEqual(mine.map((d) => [d.domain, d.is_primary]), [['followmecollection.com', true], ['www.followmecollection.com', false]]);
  for (const d of mine) {
    assert.equal(d.business_id, B1, 'the business from the server, never from the browser');
    assert.equal(d.created_by, OWN);
    assert.notEqual(d.status, 'active');
    assert.equal(d.vercel.manual, true);
  }
  assert.deepEqual(mine[0].vercel.records, [{ type: 'A', name: '@', value: '76.76.21.21', fromVercel: false }]);
  assert.equal(calls.length, 0, 'nothing is sent to Vercel without its token');

  assert.equal((await post('domains', OWN, { action: 'connect', domain: 'other.com' })).status, 409, 'one primary domain');
  const taken = await post('domains', NOSTORE, { action: 'connect', domain: 'beauty.co.il' });
  assert.equal(taken.status, 404, 'no store → refused before anything');
  tables.stores.push({ id: 'S3', business_id: B3, name: 'Third', status: 'draft' });
  const dup = await post('domains', NOSTORE, { action: 'connect', domain: 'beauty.co.il' });
  assert.equal(dup.status, 409); assert.equal(dup.body.code, 'taken', 'a domain of another store');
  assert.equal(tables.store_domains.find((d) => d.domain === 'beauty.co.il').store_id, S2, 'and it stays theirs');

  const check = await post('domains', OWN, { action: 'check' });
  assert.equal(check.status, 200);
  assert.ok(check.body.domains.every((d: any) => d.status !== 'active'), 'checking never makes a domain active');

  const beautyId = tables.store_domains.find((d) => d.store_id === S2).id;
  assert.equal((await post('domains', OWN, { action: 'remove', domainId: beautyId })).status, 404, 'another business\'s domain is not found');
  assert.equal(tables.store_domains.filter((d) => d.store_id === S2).length, 1);
  const rm = await post('domains', OWN, { action: 'remove', domainId: mine[0].id });
  assert.equal(rm.status, 200);
  assert.equal(tables.store_domains.filter((d) => d.store_id === S1).length, 0, 'the primary takes its www with it');
});

test('a domain with Vercel\'s token: added to the storefront\'s project (www sends to the bare name), its records kept; removed there too', async () => {
  process.env.VERCEL_API_TOKEN = 'vt'; process.env.VERCEL_STOREFRONT_PROJECT = 'storefront'; process.env.VERCEL_TEAM_ID = 'team_1';
  fakeVercel((method, path) => {
    if (method === 'POST' && path.endsWith('/domains')) return { status: 200, body: { name: 'x', verified: true } };
    if (method === 'GET' && path.includes('/config')) return { status: 200, body: { misconfigured: true, recommendedIPv4: [{ rank: 1, value: ['216.150.1.1'] }], recommendedCNAME: [{ rank: 1, value: 'abc.vercel-dns-017.com.' }] } };
    if (method === 'POST' && path.endsWith('/verify')) return { status: 400, body: { error: { code: 'not_verified', message: 'DNS not set' } } };
    return { status: 200, body: {} };
  });
  const r = await post('domains', OWN, { action: 'connect', domain: 'followmecollection.com' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.vercel, 'connected');
  uuidIds();
  const adds = calls.filter((c) => c.method === 'POST' && c.url.startsWith('/v10/projects/storefront/domains'));
  assert.deepEqual(adds.map((c) => c.body), [{ name: 'followmecollection.com' }, { name: 'www.followmecollection.com', redirect: 'followmecollection.com', redirectStatusCode: 308 }]);
  assert.ok(adds.every((c) => c.url.includes('teamId=team_1')));
  const mine = tables.store_domains.filter((d) => d.store_id === S1);
  for (const d of mine) { assert.equal(d.status, 'verifying'); assert.equal(d.vercel.added, true); }
  assert.deepEqual(mine[0].vercel.records, [{ type: 'A', name: '@', value: '216.150.1.1', fromVercel: true }]);
  assert.deepEqual(mine[1].vercel.records, [{ type: 'CNAME', name: 'www', value: 'abc.vercel-dns-017.com', fromVercel: true }]);

  const check = await post('domains', OWN, { action: 'check' });
  assert.equal(check.status, 200);
  const primary = tables.store_domains.find((d) => d.domain === 'followmecollection.com');
  assert.equal(primary.status, 'verifying', 'not verified yet = waiting for the DNS, not a problem');
  assert.equal(primary.vercel.message, 'DNS not set');
  assert.equal(primary.vercel.misconfigured, true);

  fakeVercel((method, path) => (method === 'POST' && path.endsWith('/verify')
    ? { status: 404, body: { error: { code: 'not_found', message: 'Domain not found in project' } } } : { status: 200, body: {} }));
  await post('domains', OWN, { action: 'check' });
  assert.equal(primary.status, 'error', 'gone from the project = a problem');
  primary.status = 'active';
  calls.length = 0;
  await post('domains', OWN, { action: 'check' });
  assert.equal(primary.status, 'active', 'an active domain (the storefront saw it) is left alone');
  assert.ok(!calls.some((c) => c.url.includes('/followmecollection.com/verify')));

  calls.length = 0;
  await post('domains', OWN, { action: 'remove', domainId: primary.id });
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('?')[0]).sort(),
    ['/v9/projects/storefront/domains/followmecollection.com', '/v9/projects/storefront/domains/www.followmecollection.com']);
});

test('Vercel refuses the domain (it belongs to another account): recorded as a problem, with Vercel\'s own words', async () => {
  process.env.VERCEL_API_TOKEN = 'vt'; process.env.VERCEL_STOREFRONT_PROJECT = 'storefront';
  fakeVercel((method, path) => (method === 'POST' && path.endsWith('/domains')
    ? { status: 403, body: { error: { code: 'forbidden', message: 'The domain is used by another account' } } } : { status: 200, body: {} }));
  const r = await post('domains', OWN, { action: 'connect', domain: 'shop.example.com' });
  assert.equal(r.status, 200);
  const d = tables.store_domains.find((x) => x.domain === 'shop.example.com');
  assert.equal(d.status, 'error'); assert.equal(d.vercel.added, false);
  assert.equal(d.vercel.message, 'The domain is used by another account');
  assert.equal(tables.store_domains.filter((x) => x.store_id === S1).length, 1, 'a subdomain has no www');
  assert.ok(calls.every((c) => !c.url.includes('teamId')), 'no team → no teamId');
});
