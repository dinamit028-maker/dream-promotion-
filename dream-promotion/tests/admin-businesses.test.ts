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
// the sign-in records (auth.users): the address each person signed up with, confirmed
const signIns: Record<string, string> = { aviv: 'aviv@x.com', sagit: 'sagit@x.com', noa: 'noa@x.com', mallory: 'mallory@x.com' };
const authFake = (emails: Record<string, string>) => ({
  getUser: async (t: string) => ({ data: { user: emails[t] ? { id: t, email: emails[t] } : null } }),
  admin: { getUserById: async (id: string) => ({ data: { user: signIns[id] ? { id, email: signIns[id], email_confirmed_at: '2026-10-01T00:00:00Z' } : null } }) },
});
before(() => {
  const emails: Record<string, string> = { aviv: 'aviv@x.com', sagit: 'sagit@x.com' };
  (globalThis as any).__DP_TEST_ADMIN_DB__ = { ...fakeDb(tables), auth: authFake(emails) };
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
  // pilot milestones: dates only — the first customer of SaGabot, nothing yet at FollowMe
  assert.equal(sg.milestones.created, '2'); assert.ok(sg.milestones.firstLead, 'SaGabot has its first customer');
  assert.equal(fm.milestones.firstLead, null); assert.equal(fm.milestones.firstDocument, null);
  const { MILESTONES } = await import('../src/features/admin/milestones');
  for (const b of [fm, sg]) for (const [k, v] of Object.entries(b.milestones)) {
    assert.ok(MILESTONES.some((m) => m.key === k), `${k} is a milestone`); assert.ok(v === null || typeof v === 'string', 'a date or nothing');
  }
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

test('admin API: a cashier ("קופה בלבד") joins a business, works in it, and leaves it', async () => {
  const api = await import('../src/app/api/admin/businesses/route');
  const me = await import('../src/app/api/business/me/route');
  const { businessManagers, registerOnly, blockedFor } = await import('../src/lib/server/business');
  tables.profiles.push({ id: 'noa', email: 'noa@x.com', is_super_admin: false, current_business_id: null });
  assert.equal((await api.PATCH(req('sagit', 'PATCH', { id: 'fm', action: 'add_member', email: 'noa@x.com', access: 'register' }))).status, 403, 'only the super admin adds people');
  const nobody = await api.PATCH(req('aviv', 'PATCH', { id: 'fm', action: 'add_member', email: 'ghost@x.com', access: 'register' }));
  assert.match((await nobody.json()).message, /עוד לא נרשם/);
  assert.equal((await api.PATCH(req('aviv', 'PATCH', { id: 'fm', action: 'add_member', email: 'NOA@x.com', access: 'register' }))).status, 200);
  const row = tables.business_members.find((m) => m.business_id === 'fm' && m.user_id === 'noa');
  assert.deepEqual([row.access, row.role], ['register', 'editor']);
  assert.equal(tables.profiles.find((p) => p.id === 'noa').current_business_id, 'fm', 'she works in the business she was added to');

  (globalThis as any).__DP_TEST_ADMIN_DB__.rpc = async (_fn: string, a: { uid: string }) => ({ data: tables.profiles.find((p) => p.id === a.uid)?.current_business_id ?? null });
  const emails: Record<string, string> = { aviv: 'aviv@x.com', sagit: 'sagit@x.com', noa: 'noa@x.com' };
  (globalThis as any).__DP_TEST_ADMIN_DB__.auth = authFake(emails);
  const j = await (await me.GET(new Request('http://x/api/business/me', { headers: { authorization: 'Bearer noa' } }))).json();
  assert.equal(j.access, 'register', 'the app opens the register only');
  assert.equal(await registerOnly('noa'), true);
  assert.equal((await blockedFor('noa'))?.code, 'register_only', 'AI, publishing and Meta refuse a cashier');
  assert.deepEqual(await businessManagers('fm'), ['aviv'], 'sale notifications go to the managers, not to the cashier');

  const card = (await (await api.GET(req('aviv'))).json()).businesses.find((b: any) => b.id === 'fm');
  assert.ok(card.members.some((m: any) => m.email === 'noa@x.com' && m.access === 'register'));
  assert.equal((await api.PATCH(req('aviv', 'PATCH', { id: 'fm', action: 'remove_member', email: 'noa@x.com' }))).status, 200);
  assert.ok(!tables.business_members.some((m) => m.user_id === 'noa'));
  assert.equal(tables.profiles.find((p) => p.id === 'noa').current_business_id, null);
});

test('admin API: a profile\'s email is not proof — the sign-in record decides who is added', async () => {
  const api = await import('../src/app/api/admin/businesses/route');
  // mallory wrote the owner-to-be's address into her own profile row (a user may edit her profile)
  tables.profiles.push({ id: 'mallory', email: 'roni.owner@x.com', is_super_admin: false, current_business_id: null });
  const r = await api.POST(req('aviv', 'POST', { name: 'מספרה', slug: 'roni-salon', ownerEmail: 'roni.owner@x.com' }));
  assert.equal(r.status, 400); assert.match((await r.json()).message, /עוד לא נרשם/);
  assert.ok(!tables.business_members.some((m) => m.user_id === 'mallory'), 'mallory did not become an owner');
  const add = await api.PATCH(req('aviv', 'PATCH', { id: 'fm', action: 'add_member', email: 'roni.owner@x.com', access: 'full' }));
  assert.equal(add.status, 400);
  assert.ok(!tables.business_members.some((m) => m.user_id === 'mallory'), 'nor a member');
  const { likeExact } = await import('../src/lib/server/admin-users');
  assert.equal(likeExact('dana_cohen%@x.com'), 'dana\\_cohen\\%@x.com', '"_" and "%" match themselves only');
});
