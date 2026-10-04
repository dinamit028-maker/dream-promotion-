/**
 * Multi-business stage 6: the super admin's dashboard of businesses.
 * Pure rules (state, 7-day warning, "extend a month") and the admin API end to end: only the
 * super admin may read or change businesses; extend opens an expired business at once.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';
import { addMonth, bizView, extendMonth, todayIL } from '../src/features/admin/business-state';

const at = (d: string) => new Date(`${d}T09:00:00Z`); // noon in Israel

test('state: active / locked / expired, grace days, the 7-day warning', () => {
  assert.equal(bizView({ status: 'active', paid_until: null, grace_days: 0 }, at('2026-10-04')).state, 'active');
  assert.equal(bizView({ status: 'locked', paid_until: '2027-01-01', grace_days: 0 }, at('2026-10-04')).state, 'locked');
  const last = bizView({ status: 'active', paid_until: '2026-10-04', grace_days: 0 }, at('2026-10-04'));
  assert.deepEqual([last.state, last.daysLeft, last.endingSoon], ['active', 0, true], 'the paid day itself is still open');
  assert.equal(bizView({ status: 'active', paid_until: '2026-10-03', grace_days: 0 }, at('2026-10-04')).state, 'expired', 'yesterday → closed');
  assert.equal(bizView({ status: 'active', paid_until: '2026-10-03', grace_days: 2 }, at('2026-10-04')).state, 'active', 'grace days keep it open');
  assert.equal(bizView({ status: 'active', paid_until: '2026-10-11', grace_days: 0 }, at('2026-10-04')).endingSoon, true);
  assert.equal(bizView({ status: 'active', paid_until: '2026-10-12', grace_days: 0 }, at('2026-10-04')).endingSoon, false);
});

test('extend a month: from the later of today and the paid date; month ends clamp', () => {
  assert.equal(addMonth('2026-01-31'), '2026-02-28');
  assert.equal(addMonth('2028-01-31'), '2028-02-29');
  assert.equal(addMonth('2026-12-15'), '2027-01-15');
  assert.equal(extendMonth('2026-10-20', at('2026-10-04')), '2026-11-20', 'paid days are kept');
  assert.equal(extendMonth('2026-09-01', at('2026-10-04')), '2026-11-04', 'expired → a month from today');
  assert.equal(extendMonth(null, at('2026-10-04')), null, 'no limit stays no limit');
});

// ---- the API, with an in-memory database ----
const tables: Record<string, any[]> = {
  businesses: [
    { id: 'fm', name: 'FollowMe', slug: 'followme', status: 'active', paid_until: null, grace_days: 0, lock_reason: '', created_at: '1' },
    { id: 'sg', name: 'SaGabot', slug: 'sagabot', status: 'active', paid_until: '2020-01-01', grace_days: 0, lock_reason: '', created_at: '2' },
  ],
  business_members: [{ business_id: 'fm', user_id: 'aviv', role: 'owner' }, { business_id: 'sg', user_id: 'sagit', role: 'owner' }],
  profiles: [{ id: 'aviv', email: 'aviv@x.com', is_super_admin: true, current_business_id: null }, { id: 'sagit', email: 'sagit@x.com', is_super_admin: false }],
  social_accounts: [
    { business_id: 'fm', provider: 'facebook', display_name: 'FollowMe', status: 'active' },
    { business_id: 'sg', provider: 'instagram', display_name: 'sagabot', status: 'missing' },
    { business_id: null, provider: 'facebook', display_name: 'new page', status: 'active' },
  ],
  scheduled_posts: [{ business_id: 'fm', status: 'done', last_run_at: new Date().toISOString() }],
  leads: [{ business_id: 'sg', created_at: new Date().toISOString() }],
  ai_generations: [{ business_id: 'fm', actual_cost_usd: 1.25, estimated_cost_usd: null, status: 'succeeded', created_at: new Date().toISOString() }],
};
before(() => {
  const emails: Record<string, string> = { aviv: 'aviv@x.com', sagit: 'sagit@x.com' };
  (globalThis as any).__DP_TEST_ADMIN_DB__ = { ...fakeDb(tables), auth: { getUser: async (t: string) => ({ data: { user: emails[t] ? { id: t, email: emails[t] } : null } }) } };
});
const req = (who: string, method = 'GET', body?: object) =>
  new Request('http://x/api/admin/businesses', { method, headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('admin API: cards for the super admin, refused for an owner', async () => {
  const api = await import('../src/app/api/admin/businesses/route');
  assert.equal((await api.GET(req('sagit'))).status, 403, 'an owner sees no dashboard');
  assert.equal((await api.PATCH(req('sagit', 'PATCH', { id: 'sg', action: 'extend' }))).status, 403, 'an owner can not extend herself');
  assert.equal(tables.businesses[1].paid_until, '2020-01-01');

  const j = await (await api.GET(req('aviv'))).json();
  assert.equal(j.unassignedAssets, 1);
  const fm = j.businesses.find((b: any) => b.id === 'fm'), sg = j.businesses.find((b: any) => b.id === 'sg');
  assert.deepEqual([fm.state, sg.state], ['active', 'expired']);
  assert.deepEqual(fm.month, { posts: 1, leads: 0, costUsd: 1.25 });
  assert.equal(sg.month.leads, 1);
  assert.deepEqual(sg.missing, ['instagram · sagabot']);
  assert.equal(fm.members[0].email, 'aviv@x.com');
});

test('admin API: extend opens at once; lock, unlock, manual date, enter, add', async () => {
  const api = await import('../src/app/api/admin/businesses/route');
  const sg = () => tables.businesses[1];
  assert.equal((await api.PATCH(req('aviv', 'PATCH', { id: 'sg', action: 'extend' }))).status, 200);
  assert.equal(sg().paid_until, extendMonth(todayIL(), new Date()), 'a month from today');
  assert.equal(bizView(sg()).state, 'active');

  await api.PATCH(req('aviv', 'PATCH', { id: 'sg', action: 'lock', reason: 'לא שולם' }));
  assert.deepEqual([sg().status, sg().lock_reason, bizView(sg()).state], ['locked', 'לא שולם', 'locked']);
  await api.PATCH(req('aviv', 'PATCH', { id: 'sg', action: 'unlock' }));
  assert.deepEqual([sg().status, sg().lock_reason], ['active', '']);

  await api.PATCH(req('aviv', 'PATCH', { id: 'sg', action: 'paid_until', paidUntil: '' }));
  assert.equal(sg().paid_until, null, 'empty date = no limit');
  assert.equal((await api.PATCH(req('aviv', 'PATCH', { id: 'sg', action: 'paid_until', paidUntil: '4.10.26' }))).status, 400);

  await api.PATCH(req('aviv', 'PATCH', { id: 'sg', action: 'enter' }));
  assert.equal(tables.profiles[0].current_business_id, 'sg');

  const bad = await api.POST(req('aviv', 'POST', { name: 'רוני', slug: 'Roni Hair' }));
  assert.equal(bad.status, 400);
  const noUser = await api.POST(req('aviv', 'POST', { name: 'רוני', slug: 'roni-hair', ownerEmail: 'nobody@x.com' }));
  assert.match((await noUser.json()).message, /עוד לא נרשם/);
  const ok = await api.POST(req('aviv', 'POST', { name: 'רוני', slug: 'roni-hair', ownerEmail: 'SAGIT@x.com', paidUntil: '2026-12-31' }));
  assert.equal(ok.status, 200);
  const roni = tables.businesses.find((b) => b.slug === 'roni-hair');
  assert.equal(roni.paid_until, '2026-12-31');
  assert.ok(tables.business_members.some((m) => m.business_id === roni.id && m.user_id === 'sagit' && m.role === 'owner'));
});
