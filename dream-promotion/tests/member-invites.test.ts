/**
 * An invitation by link (2.114, migration 6500): the super admin's "invite" makes the sign-in (no password), the member and a
 * link — only the token's hash is kept, a new link revokes the open one; /api/join/<token> shows the business, and the tap signs
 * in once (a second tap, an expired link, a person removed from the business — nothing).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fakeDb } from './fakedb';
import { homeOf, inviteText, inviteWhatsapp, isInviteToken } from '../src/features/admin/invite';
import { inviteState } from '../src/lib/server/invites';

const tables: Record<string, any[]> = {
  businesses: [
    { id: 'sg', name: 'SaGabot', slug: 'sagabot', status: 'active', paid_until: null, grace_days: 0, lock_reason: '', created_at: '1' },
  ],
  business_members: [{ business_id: 'sg', user_id: 'sagit', role: 'owner', access: 'full' }],
  profiles: [{ id: 'aviv', email: 'aviv@x.com', is_super_admin: true }, { id: 'sagit', email: 'sagit@x.com', is_super_admin: false }],
  member_invites: [],
};
const signIns: Record<string, { email: string; confirmed: boolean }> = {
  aviv: { email: 'aviv@x.com', confirmed: true }, sagit: { email: 'sagit@x.com', confirmed: true },
};
const made: any[] = [];
const links: string[] = [];
before(() => {
  (globalThis as any).__DP_TEST_ADMIN_DB__ = {
    ...fakeDb(tables),
    auth: {
      getUser: async (t: string) => ({ data: { user: signIns[t] ? { id: t, email: signIns[t].email } : null } }),
      admin: {
        getUserById: async (id: string) => ({ data: { user: signIns[id] ? { id, email: signIns[id].email, email_confirmed_at: signIns[id].confirmed ? '2026-11-01' : null } : null } }),
        createUser: async (u: any) => {
          made.push(u);
          const id = `u-${u.email.split('@')[0]}`;
          signIns[id] = { email: u.email, confirmed: true };
          return { data: { user: { id, email: u.email } }, error: null };
        },
        updateUserById: async () => ({ data: {}, error: null }),
        generateLink: async (o: { type: string; email: string }) => { links.push(`${o.type}:${o.email}`); return { data: { properties: { hashed_token: `h-${o.email}` } }, error: null }; },
      },
    },
  };
});
const admin = (who: string, body: object) =>
  new Request('http://x/api/admin/businesses', { method: 'PATCH', headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const join = (token: string, method = 'GET') => new Request(`http://x/api/join/${token}`, { method, headers: { 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 200)}` } });
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const tokenOf = (link: string) => link.split('/join/')[1];

test('the message: the business, what it opens, the link, 48 hours — on WhatsApp only with a phone', () => {
  const t = inviteText('SaGabot', 'agenda', 'https://d.test/join/abc');
  assert.match(t, /ליומן התורים של SaGabot/);
  assert.match(t, /https:\/\/d\.test\/join\/abc/);
  assert.match(t, /48 שעות/);
  assert.match(inviteWhatsapp('052-1234567', 'SaGabot', 'agenda', 'L'), /^https:\/\/wa\.me\/972521234567\?text=/);
  assert.equal(inviteWhatsapp('', 'SaGabot', 'agenda', 'L'), '');
  assert.deepEqual(['agenda', 'calendar', 'register', 'full'].map(homeOf), ['/appointments', '/appointments', '/register', '/dashboard']);
  assert.ok(isInviteToken('a'.repeat(64)) && !isInviteToken('A'.repeat(64)) && !isInviteToken('abc'));
  const now = Date.parse('2026-11-05T10:00:00Z');
  assert.equal(inviteState(null, now), 'not_found');
  assert.equal(inviteState({ expires_at: '2026-11-07T10:00:00Z', used_at: null, revoked_at: null }, now), 'ok');
  assert.equal(inviteState({ expires_at: '2026-11-05T10:00:00Z', used_at: null, revoked_at: null }, now), 'expired');
  assert.equal(inviteState({ expires_at: '2026-11-07T10:00:00Z', used_at: 'x', revoked_at: null }, now), 'used');
  assert.equal(inviteState({ expires_at: '2026-11-07T10:00:00Z', used_at: null, revoked_at: 'x' }, now), 'revoked');
});

test('invite → join: one sign-in with no password, the hash only, once; a new link revokes the old', async () => {
  const api = await import('../src/app/api/admin/businesses/route');
  const route = await import('../src/app/api/join/[token]/route');
  const body = { id: 'sg', action: 'invite', email: ' Karin@X.com ', phone: '052-1234567', access: 'agenda' };
  assert.equal((await api.PATCH(admin('sagit', body))).status, 403, 'only the super admin');
  assert.match((await (await api.PATCH(admin('aviv', { ...body, phone: '12' }))).json()).message, /טלפון/);
  assert.equal(made.length, 0, 'nothing before the checks pass');

  const r = await api.PATCH(admin('aviv', body));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(made, [{ email: 'karin@x.com', email_confirm: true }], 'a sign-in with no password, confirmed');
  assert.match(j.link, /^http:\/\/x\/join\/[0-9a-f]{64}$/);
  assert.match(j.whatsapp, /^https:\/\/wa\.me\/972521234567\?text=/);
  const token = tokenOf(j.link);
  const row = tables.member_invites[0];
  assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'), 'only the hash');
  assert.ok(!JSON.stringify(tables.member_invites).includes(token), 'never the token');
  assert.deepEqual([row.access, row.phone, row.user_id], ['agenda', '972521234567', 'u-karin']);
  assert.deepEqual((({ access, role }) => [access, role])(tables.business_members.find((m) => m.user_id === 'u-karin')), ['agenda', 'editor']);

  // a second link: the first stops working
  const j2 = await (await api.PATCH(admin('aviv', body))).json();
  assert.equal(made.length, 1, 'the same sign-in');
  assert.equal((await route.GET(join(token), ctx(token))).status, 410, 'the old one is revoked');
  const t2 = tokenOf(j2.link);

  // the page: the business and the email; reading uses nothing
  const g = await route.GET(join(t2), ctx(t2));
  assert.deepEqual((({ business, email }) => ({ business, email }))(await g.json()), { business: 'SaGabot', email: 'karin@x.com' });
  assert.equal(links.length, 0, 'no sign-in before the tap');
  // the tap: a one-time sign-in, the link used, she works in SaGabot
  const p = await route.POST(join(t2, 'POST'), ctx(t2));
  assert.equal(p.status, 200);
  assert.deepEqual(await p.json(), { tokenHash: 'h-karin@x.com', email: 'karin@x.com', home: '/appointments' });
  assert.deepEqual(links, ['magiclink:karin@x.com']);
  assert.equal(tables.profiles.find((x) => x.id === 'u-karin').current_business_id, 'sg');
  assert.equal((await (await route.POST(join(t2, 'POST'), ctx(t2))).json()).code, 'used', 'a second tap — nothing');
  assert.equal(links.length, 1);

  // removed from the business after the link was sent — not let in
  const j3 = await (await api.PATCH(admin('aviv', body))).json();
  const t3 = tokenOf(j3.link);
  tables.business_members = tables.business_members.filter((m) => m.user_id !== 'u-karin');
  assert.equal((await route.POST(join(t3, 'POST'), ctx(t3))).status, 410);
  // expired
  tables.business_members.push({ business_id: 'sg', user_id: 'u-karin', role: 'editor', access: 'agenda' });
  tables.member_invites.find((x) => x.used_at == null && x.revoked_at == null).expires_at = '2020-01-01T00:00:00Z';
  assert.equal((await (await route.POST(join(t3, 'POST'), ctx(t3))).json()).code, 'expired');
  assert.equal((await route.GET(join('nope'), ctx('nope'))).status, 404);

  // never a super admin's account
  assert.match((await (await api.PATCH(admin('aviv', { ...body, email: 'aviv@x.com' }))).json()).message, /מנהל-על/);
});
