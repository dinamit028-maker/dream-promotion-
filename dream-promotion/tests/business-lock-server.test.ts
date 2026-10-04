/**
 * Multi-business stage 5: a locked business spends and publishes nothing on the server.
 * The timer cancels its due posts ("העסק נעול") instead of publishing them; AI calls answer
 * 403 business_locked; the super admin is never locked out; extending opens everything at once.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';

const OPEN = 'biz-open', SHUT = 'biz-shut';
const past = new Date(Date.now() - 60_000).toISOString();
const tables: Record<string, any[]> = {
  businesses: [
    { id: OPEN, status: 'active', paid_until: null, grace_days: 0 },
    { id: SHUT, status: 'active', paid_until: '2020-01-01', grace_days: 0 },
  ],
  profiles: [{ id: 'owner-open', is_super_admin: false }, { id: 'owner-shut', is_super_admin: false }, { id: 'admin', is_super_admin: true }],
  scheduled_posts: [
    { id: 'p-shut', user_id: 'owner-shut', business_id: SHUT, media_id: 'm1', caption: '', run_at: past, status: 'scheduled', results: {}, attempts: 0,
      destinations: [{ accountId: 'fb-1', provider: 'facebook' }, { accountId: 'ig-1', provider: 'instagram', target: 'feed' }] },
    { id: 'p-open', user_id: 'owner-open', business_id: OPEN, media_id: 'gone', caption: '', run_at: past, status: 'scheduled', results: {}, attempts: 0,
      destinations: [{ accountId: 'fb-2', provider: 'facebook' }] },
  ],
  media: [], content: [],
};
const memberOf: Record<string, string | null> = { 'owner-open': OPEN, 'owner-shut': SHUT, admin: OPEN, nobody: null };
before(() => {
  (globalThis as any).__DP_TEST_ADMIN_DB__ = { ...fakeDb(tables), rpc: async (_: string, a: any) => ({ data: memberOf[a.uid] ?? null, error: null }) };
});

test('timer: a locked business\'s due post is cancelled with the reason, never published', async () => {
  const { publishDue } = await import('../src/lib/server/scheduler');
  const sum = await publishDue({ deadline: Date.now() + 30_000 });
  assert.equal(sum.cancelled, 1);
  const shut = tables.scheduled_posts.find((p) => p.id === 'p-shut');
  assert.equal(shut.status, 'cancelled');
  assert.equal(shut.cancel_reason, 'העסק נעול');
  assert.deepEqual(Object.values(shut.results).map((r: any) => [r.state, r.error]), [['failed', 'העסק נעול'], ['failed', 'העסק נעול']]);
  const open = tables.scheduled_posts.find((p) => p.id === 'p-open');
  assert.notEqual(open.status, 'cancelled', 'an open business is served as usual');
});

test('lock check: owner of a locked business is locked, super admin never, no business = locked', async () => {
  const { userLocked } = await import('../src/lib/server/business');
  assert.equal(await userLocked('owner-open'), false);
  assert.equal(await userLocked('owner-shut'), true);
  assert.equal(await userLocked('admin'), false);
  assert.equal(await userLocked('nobody'), true);
  tables.businesses[1].paid_until = null; // "extend" → open at once
  assert.equal(await userLocked('owner-shut'), false);
  tables.businesses[1].paid_until = '2020-01-01';
});

test('AI gate: a signed-in user of a locked business gets 403 business_locked', async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://sb.test'; process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  delete process.env.APP_ACCESS_CODE;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => {
    const id = String(init?.headers?.Authorization ?? '').replace('Bearer ', '');
    return new Response(JSON.stringify({ id }), { status: 200 });
  }) as any;
  try {
    const { accessDenied } = await import('../src/lib/server/access');
    const req = (id: string) => new Request('http://x', { headers: { authorization: `Bearer ${id}` } });
    const shut = await accessDenied(req('owner-shut'));
    assert.equal(shut?.status, 403);
    assert.deepEqual(await shut!.json(), { code: 'business_locked', message: 'העסק נעול. כדי לחדש את השירות פנו למנהל המערכת.' });
    assert.equal(await accessDenied(req('owner-open')), null);
    assert.equal(await accessDenied(req('admin')), null, 'the super admin works in a locked business too');
  } finally { globalThis.fetch = realFetch; }
});
