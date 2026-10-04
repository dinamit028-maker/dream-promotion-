/**
 * Multi-business stage 7: working in one business at a time.
 *  - switching business never uploads the cached data of the previous business into the new one
 *  - only a member (or the super admin) may switch into a business
 *  - a public booking lands in the page's business, even when its owner is working in another one
 *  - the migrations: gates narrowed to the current business; one-per-business keys
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDb } from './fakedb';
import { hydratePlan } from '../src/lib/hydrate-plan';
import { israelParts } from '../src/lib/il-time';

test('device cache: first sign-in uploads local work; a business switch never does', () => {
  assert.deepEqual(hydratePlan({ userId: null, businessId: null, hasWork: true }, { userId: 'u', businessId: 'fm' }), { switched: false, mayUploadLocal: true });
  assert.deepEqual(hydratePlan({ userId: 'u', businessId: 'fm', hasWork: true }, { userId: 'u', businessId: 'sg' }), { switched: true, mayUploadLocal: false });
  assert.deepEqual(hydratePlan({ userId: 'a', businessId: null, hasWork: true }, { userId: 'b', businessId: 'sg' }), { switched: true, mayUploadLocal: false }, 'another user');
  assert.equal(hydratePlan({ userId: 'u', businessId: 'fm', hasWork: true }, { userId: 'u', businessId: 'fm' }).switched, false);
});

const tables: Record<string, any[]> = {
  businesses: [{ id: 'fm', name: 'FollowMe', status: 'active', paid_until: null, grace_days: 0 }, { id: 'sg', name: 'SaGabot', status: 'active', paid_until: null, grace_days: 0 }],
  business_members: [{ business_id: 'fm', user_id: 'aviv', role: 'owner' }, { business_id: 'sg', user_id: 'sagit', role: 'owner' }],
  profiles: [{ id: 'aviv', is_super_admin: true, current_business_id: 'sg' }, { id: 'sagit', is_super_admin: false, current_business_id: null }],
  booking_settings: [{ user_id: 'aviv', business_id: 'fm', slug: 'followme', enabled: true, title: 'FollowMe', address: '', phone: '', message: '',
    slot_minutes: 30, min_notice_minutes: 0, max_days_ahead: 30, closed_dates: [],
    hours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['09:00', '19:00']]])) }],
  booking_services: [{ id: 'svc', user_id: 'aviv', business_id: 'fm', name: 'ייעוץ', minutes: 30, price: 0, active: true, sort: 0 }],
  appointments: [], leads: [], lead_activities: [],
};
before(() => {
  (globalThis as any).__DP_TEST_ADMIN_DB__ = {
    ...fakeDb(tables),
    auth: { getUser: async (t: string) => ({ data: { user: ['aviv', 'sagit'].includes(t) ? { id: t, email: `${t}@x.com` } : null } }) },
    rpc: async (_: string, a: any) => ({ data: tables.profiles.find((p) => p.id === a.uid)?.current_business_id
      ?? tables.business_members.find((m) => m.user_id === a.uid)?.business_id ?? null, error: null }),
  };
});
const req = (who: string, body?: object) => new Request('http://x/api/business/me', {
  method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('switcher: the super admin may enter any business, an owner only their own', async () => {
  const api = await import('../src/app/api/business/me/route');
  const list = await (await api.GET(req('aviv'))).json();
  assert.deepEqual(list.businesses.map((b: any) => b.name), ['FollowMe', 'SaGabot']);
  assert.equal(list.business.name, 'SaGabot', 'works in the business chosen last');
  const own = await (await api.GET(req('sagit'))).json();
  assert.deepEqual(own.businesses.map((b: any) => b.name), ['SaGabot'], 'an owner sees only their business');

  assert.equal((await api.POST(req('sagit', { id: 'fm' }))).status, 403, 'no way into another business');
  assert.equal(tables.profiles[1].current_business_id, null);
  assert.equal((await api.POST(req('aviv', { id: 'fm' }))).status, 200);
  assert.equal(tables.profiles[0].current_business_id, 'fm');
  tables.profiles[0].current_business_id = 'sg';
});

test('a public booking lands in the page\'s business, not where its owner is working now', async () => {
  const book = await import('../src/app/api/book/[slug]/route');
  const slots = await import('../src/app/api/book/[slug]/slots/route');
  const day = israelParts(Date.now() + 2 * 864e5).date;
  const ctx = { params: { slug: 'followme' } };
  const s = await (await slots.GET(new Request(`http://x/s?service=svc&date=${day}`), ctx)).json();
  const r = await book.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ serviceId: 'svc', start: s.slots[0].start, name: 'דנה', phone: '0521112233' }) }), ctx);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal(tables.appointments[0].business_id, 'fm', 'the owner (aviv) works in SaGabot right now — the booking still goes to FollowMe');
  assert.equal(tables.leads[0].business_id, 'fm');
  assert.equal(tables.lead_activities[0].business_id, 'fm');
});

test('migrations: gates narrowed to the current business; one-per-business keys', () => {
  const m25 = readFileSync(new URL('../supabase/migrations/20261004002500_current_business.sql', import.meta.url), 'utf8');
  assert.match(m25, /alter policy %I on public\.%I using/);
  assert.match(m25, /business_id = \(select public\.current_business_id\(\)\) and business_id in \(select public\.accessible_business_ids\(\)\)/);
  assert.ok(!/\bdrop\b/i.test(m25.replace(/--.*$/gm, '')), '2500 is additive');
  const m26 = readFileSync(new URL('../supabase/migrations/20261004002600_business_keys.sql', import.meta.url), 'utf8');
  for (const t of ['brands', 'register_settings', 'booking_settings', 'timeclock_settings']) assert.ok(m26.includes(`'${t}'`), t);
  assert.match(m26, /primary key using index document_counters_business_uq/);
  assert.match(m26, /drop constraint if exists documents_user_id_doc_type_doc_number_key/);
});
