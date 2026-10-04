/** Multi-business stage 3: one Meta connection, upsert-never-delete, 'missing' pages, business activity. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetsFromPages, missingBanner, planMetaSync, type StoredAsset } from '../src/lib/server/meta-sync';
import { businessIsActive } from '../src/lib/server/business';

const AVIV = 'user-aviv', SAGIT = 'user-sagit', CONN = 'conn-1', FM = 'biz-followme', SG = 'biz-sagabot';
const pages = [
  { id: 'P-FM', name: 'FollowMe', access_token: 'tok-fm', picture: { data: { url: 'fm.jpg' } }, instagram_business_account: { id: 'IG-FM', username: 'followmecollection' } },
  { id: 'P-SG', name: 'SaGabot', access_token: 'tok-sg', instagram_business_account: { id: 'IG-SG', username: 'sagit_sagabot', profile_picture_url: 'sg.jpg' } },
  { id: 'P-NEW', name: 'New Page', access_token: 'tok-new' },
];
const S = (p: Partial<StoredAsset>): StoredAsset => ({ id: 'x', provider: 'facebook', externalId: 'X', userId: AVIV, businessId: FM, connectionId: null, status: 'active', name: null, ...p });

test('pages → assets: the page and its linked Instagram, same token', () => {
  const a = assetsFromPages(pages);
  assert.deepEqual(a.map((x) => `${x.provider}:${x.externalId}:${x.name}`), [
    'facebook:P-FM:FollowMe', 'instagram:IG-FM:@followmecollection', 'facebook:P-SG:SaGabot', 'instagram:IG-SG:@sagit_sagabot', 'facebook:P-NEW:New Page']);
  assert.equal(a[1].token, 'tok-fm'); assert.equal(a[3].avatar, 'sg.jpg');
});

test('first connection: existing assets keep business + creator, a new page is unassigned, tokens sealed', () => {
  const stored = [
    S({ id: 'a1', externalId: 'P-FM' }), S({ id: 'a2', provider: 'instagram', externalId: 'IG-FM' }),
    S({ id: 'a3', externalId: 'P-SG', userId: SAGIT, businessId: SG }), S({ id: 'a4', provider: 'instagram', externalId: 'IG-SG', userId: SAGIT, businessId: SG }),
  ];
  const plan = planMetaSync(stored, assetsFromPages(pages), CONN, AVIV, (t) => `sealed(${t})`);
  assert.deepEqual(plan.update.map((u) => u.id).sort(), ['a1', 'a2', 'a3', 'a4']);
  assert.ok(plan.update.every((u) => u.connection_id === CONN && u.status === 'active' && u.access_token.startsWith('sealed(')));
  assert.ok(plan.update.every((u) => !('business_id' in u) && !('user_id' in u)), 'an update never moves an asset to another business or creator');
  assert.equal(plan.insert.length, 1);
  assert.deepEqual({ ...plan.insert[0], access_token: '' }, { provider: 'facebook', external_id: 'P-NEW', display_name: 'New Page', avatar_url: null, access_token: '',
    user_id: AVIV, business_id: null, connection_id: CONN, status: 'active', scope: 'full' });
  assert.deepEqual(plan.missing, []);
});

test('reconnect with fewer pages: nothing deleted, the dropped ones are marked missing', () => {
  const stored = [
    S({ id: 'a1', externalId: 'P-FM', connectionId: CONN, name: 'FollowMe' }), S({ id: 'a2', provider: 'instagram', externalId: 'IG-FM', connectionId: CONN, name: '@followmecollection' }),
    S({ id: 'a3', externalId: 'P-SG', userId: SAGIT, businessId: SG, connectionId: CONN, name: 'SaGabot' }),
    S({ id: 'a4', provider: 'instagram', externalId: 'IG-SG', userId: SAGIT, businessId: SG, connectionId: CONN, name: '@sagit_sagabot' }),
    S({ id: 't1', provider: 'tiktok', externalId: 'TT', connectionId: null, name: 'tiktok' }),                 // not Meta: untouched
    S({ id: 'o1', externalId: 'P-OTHER', connectionId: 'conn-2', userId: SAGIT, name: 'Other user page' }), // another Facebook user's page: untouched
  ];
  const onlySagabot = assetsFromPages([pages[1]]);
  const plan = planMetaSync(stored, onlySagabot, CONN, AVIV);
  assert.deepEqual(plan.update.map((u) => u.id).sort(), ['a3', 'a4']);
  assert.deepEqual(plan.missing.map((m) => m.id).sort(), ['a1', 'a2']);
  assert.equal(plan.insert.length, 0);
  assert.ok(!('delete' in plan), 'there is no delete in the plan at all');
});

test('a missing page comes back to active on the next full approval; already-missing ones are not re-marked', () => {
  const stored = [S({ id: 'a1', externalId: 'P-FM', connectionId: CONN, status: 'missing' }), S({ id: 'a9', externalId: 'P-GONE', connectionId: CONN, status: 'missing' })];
  const plan = planMetaSync(stored, assetsFromPages([pages[0]]), CONN, AVIV);
  assert.equal(plan.update.find((u) => u.id === 'a1')?.status, 'active');
  assert.equal(plan.update.find((u) => u.id === 'a1')?.missing_since, null);
  assert.deepEqual(plan.missing, [], 'P-GONE is already missing');
});

test('legacy rows (before connections existed) are matched by their creator only', () => {
  const stored = [S({ id: 'mine', externalId: 'P-OLD', userId: AVIV, connectionId: null }), S({ id: 'hers', externalId: 'P-HERS', userId: SAGIT, connectionId: null })];
  const plan = planMetaSync(stored, [], CONN, AVIV);
  assert.deepEqual(plan.missing.map((m) => m.id), ['mine'], "Sagit's old page is not marked by Aviv's connection");
});

test('a page returned twice (two Facebook pages listing the same Instagram) is stored once', () => {
  const twice = assetsFromPages([pages[0], { ...pages[0], id: 'P-FM2', name: 'FM2' }]);
  const plan = planMetaSync([], twice, CONN, AVIV);
  assert.equal(plan.insert.filter((i) => i.external_id === 'IG-FM').length, 1);
});

test('the disconnected-page banner', () => {
  assert.equal(missingBanner('FollowMe'), "העמוד FollowMe נותק. בחיבור מחדש בחרו 'כל הדפים הנוכחיים והעתידיים'");
});

test('business is active: manual lock, paid_until + grace days, Israel calendar day', () => {
  const at = (iso: string) => new Date(iso);
  assert.equal(businessIsActive({ status: 'active', paid_until: null, grace_days: 0 }), true, 'no limit');
  assert.equal(businessIsActive({ status: 'locked', paid_until: null, grace_days: 0 }), false, 'manual lock');
  const b = { status: 'active', paid_until: '2026-10-10', grace_days: 0 };
  assert.equal(businessIsActive(b, at('2026-10-10T20:59:00Z')), true, '23:59 Israel on the last paid day');
  assert.equal(businessIsActive(b, at('2026-10-10T21:01:00Z')), false, '00:01 Israel the day after');
  assert.equal(businessIsActive({ ...b, grace_days: 3 }, at('2026-10-13T12:00:00Z')), true, 'within grace');
  assert.equal(businessIsActive({ ...b, grace_days: 3 }, at('2026-10-14T12:00:00Z')), false, 'after grace');
  assert.equal(businessIsActive({ status: 'active', paid_until: '2026-10-03', grace_days: 0 }, at('2026-10-04T08:00:00Z')), false, 'paid until yesterday → locked');
});
