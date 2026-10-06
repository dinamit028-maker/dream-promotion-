/**
 * Selling on the site (Dream Commerce stage 3, 2.56) in the dashboard:
 *   - the pure rules: checkout settings, the terminal's keys, coupons, what an order's statuses and timeline read as;
 *   - the register: a unit held for an order on the site is not sold (the owner's decision), the same rule as the database;
 *   - the sealed keys: what the dashboard seals, the storefront's own code opens (the two apps never import each other);
 *   - /api/store/payments with an in-memory database: who may connect a terminal, and that the keys never come back.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkCheckout, checkCoupon, checkoutError, checkTerminal, couponLabel, couponState, eventText, keyHint, ORDER_FILTERS, orderLabel,
  sellingMissing, toCheckout, toCoupon, type CheckoutForm, type Coupon,
} from '../src/features/store/checkout';
import { heldConflict, heldMap } from '../src/features/register/stock';
import { sealPaymentKeys } from '../src/lib/server/payment-seal';
import { fakeDb } from './fakedb';
import { resetRateLimits } from '../src/lib/server/rate-limit';

const STOREFRONT = fileURLToPath(new URL('../../storefront/', import.meta.url));

// ---- checkout settings -----------------------------------------------------------------------------------------------------------
const form = (o: Partial<CheckoutForm> = {}): CheckoutForm => ({
  reserveMinutes: '15', pickupEnabled: true, pickupNote: ' הרצל 1 ', deliveryEnabled: true, deliveryPrice: '30', freeDeliveryOver: '300', deliveryNote: '', ...o,
});

test('checkout settings: minutes, delivery price, free above — checked before the database checks them again', () => {
  assert.deepEqual(checkCheckout(form()), { ok: true, patch: {
    reserve_minutes: 15, pickup_enabled: true, pickup_note: 'הרצל 1', delivery_enabled: true, delivery_price: 30, free_delivery_over: 300, delivery_note: '' } });
  assert.equal((checkCheckout(form({ deliveryPrice: '29.90', freeDeliveryOver: '' })) as any).patch.delivery_price, 29.9);
  assert.equal((checkCheckout(form({ freeDeliveryOver: '' })) as any).patch.free_delivery_over, null, 'empty: never free');
  assert.equal((checkCheckout(form({ deliveryEnabled: false, deliveryPrice: 'abc' })) as any).patch.delivery_price, 0, 'no delivery: no price to check');
  for (const bad of [form({ reserveMinutes: '4' }), form({ reserveMinutes: '61' }), form({ reserveMinutes: '7.5' }), form({ deliveryPrice: '-1' }),
    form({ deliveryPrice: '30.999' }), form({ freeDeliveryOver: '0' }), form({ pickupNote: 'x'.repeat(201) })]) {
    assert.equal(checkCheckout(bad).ok, false);
  }
  assert.deepEqual(toCheckout({ checkout_enabled: true, reserve_minutes: 20, delivery_price: '30.00', free_delivery_over: null }),
    { checkoutEnabled: true, reserveMinutes: 20, pickupEnabled: false, pickupNote: '', deliveryEnabled: false, deliveryPrice: 30, freeDeliveryOver: null, deliveryNote: '' });
});

test('"מכירה באתר" waits for a terminal and a way to get the goods; the database\'s refusals in Hebrew', () => {
  assert.deepEqual(sellingMissing({ pickupEnabled: false, deliveryEnabled: false }, false), ['payment', 'shipping']);
  assert.deepEqual(sellingMissing({ pickupEnabled: true, deliveryEnabled: false }, true), []);
  assert.match(checkoutError('checkout_not_ready: payment') ?? '', /מסוף סליקה/);
  assert.match(checkoutError('checkout_not_ready: shipping') ?? '', /איסוף עצמי או משלוח/);
  assert.equal(checkoutError('something else'), null);
});

test('the terminal: three keys, sane, different — and only 4 characters ever shown', () => {
  const ok = checkTerminal({ apiKey: ' abcd-1234-efgh ', secretKey: 'zzzz-9999-yyyy', pageUid: '1b2c3d4e-0000-4000-8000-1234567890ab' });
  assert.deepEqual(ok, { ok: true, keys: { api_key: 'abcd-1234-efgh', secret_key: 'zzzz-9999-yyyy' }, pageUid: '1b2c3d4e-0000-4000-8000-1234567890ab' });
  assert.equal(checkTerminal({ apiKey: 'short', secretKey: 'zzzz-9999-yyyy', pageUid: '1b2c3d4e-0000' }).ok, false);
  assert.equal(checkTerminal({ apiKey: 'abcd-1234-efgh', secretKey: 'abcd-1234-efgh', pageUid: '1b2c3d4e-0000' }).ok, false, 'the same value twice');
  assert.equal(checkTerminal({ apiKey: 'abcd 1234 efgh', secretKey: 'zzzz-9999-yyyy', pageUid: '1b2c3d4e-0000' }).ok, false);
  assert.equal(checkTerminal({ apiKey: 'abcd-1234-efgh', secretKey: 'zzzz-9999-yyyy', pageUid: '<script>' }).ok, false);
  assert.equal(keyHint('abcd-1234-efgh'), 'efgh');
});

// ---- coupons -------------------------------------------------------------------------------------------------------------------
test('a coupon: a code, a percent or an amount, until a date (Israel time), a number of uses', () => {
  const now = new Date('2026-10-06T09:00:00Z');
  assert.deepEqual(checkCoupon({ code: ' welcome10 ', kind: 'percent', value: '10', minSubtotal: '', endsOn: '2026-10-31', maxUses: '100' }, now), { ok: true, row: {
    code: 'WELCOME10', kind: 'percent', value: 10, min_subtotal: 0, ends_at: '2026-10-31T20:59:59.000Z', max_uses: 100 } });
  assert.equal((checkCoupon({ code: 'TWENTY', kind: 'amount', value: '20', minSubtotal: '100', endsOn: '', maxUses: '' }, now) as any).row.max_uses, null);
  for (const [f, why] of [
    [{ code: 'ab', kind: 'percent', value: '10' }, 'too short'], [{ code: 'שלום', kind: 'percent', value: '10' }, 'Hebrew'],
    [{ code: 'BIG', kind: 'percent', value: '101' }, 'over 100%'], [{ code: 'ZERO', kind: 'amount', value: '0' }, 'nothing off'],
    [{ code: 'PAST', kind: 'amount', value: '5', endsOn: '2026-10-01' }, 'ended already'], [{ code: 'USES', kind: 'amount', value: '5', maxUses: '1.5' }, 'half a use'],
  ] as const) {
    const r = checkCoupon({ minSubtotal: '', endsOn: '', maxUses: '', ...f } as any, now);
    assert.equal(r.ok, false, why);
  }
  const c: Coupon = toCoupon({ id: 'c', code: 'X', kind: 'percent', value: '10', min_subtotal: '0', used_count: 3, max_uses: 3, active: true });
  assert.equal(couponState(c, now), 'used_up');
  assert.equal(couponState({ ...c, maxUses: null }, now), 'active');
  assert.equal(couponState({ ...c, active: false }, now), 'off');
  assert.equal(couponState({ ...c, maxUses: null, endsAt: '2026-10-05T00:00:00Z' }, now), 'ended');
  assert.equal(couponLabel({ kind: 'percent', value: 10 }), '10% הנחה');
  assert.equal(couponLabel({ kind: 'amount', value: 20 }), '₪20 הנחה');
});

// ---- orders ---------------------------------------------------------------------------------------------------------------------
test('an order reads as one status in Hebrew; a test order says so; the timeline in words', () => {
  assert.deepEqual(orderLabel({ paymentStatus: 'test_paid', isTest: true }), { text: 'שולם (בדיקה)', tone: 'ok' });
  assert.equal(orderLabel({ paymentStatus: 'pending', isTest: true }).text, 'ממתין לתשלום');
  assert.equal(orderLabel({ paymentStatus: 'expired', isTest: true }).text, 'לא שולם (פג תוקף)');
  assert.deepEqual(ORDER_FILTERS.find((f) => f.id === 'paid')!.match('test_paid'), true);
  assert.deepEqual(ORDER_FILTERS.find((f) => f.id === 'failed')!.match('expired'), true);
  assert.match(eventText({ kind: 'test_paid', data: { late: true }, at: '' }), /סביבת בדיקה.*אחרי שזמן השמירה עבר.*לא נוצרה מכירה/);
  assert.match(eventText({ kind: 'amount_mismatch', data: { amount: 110, currency: 'ILS' }, at: '' }), /110 ILS.*לא סומנה כשולמה/);
  assert.match(eventText({ kind: 'double_payment', data: {}, at: '' }), /חיוב כפול/);
  for (const k of ['created', 'payment_page', 'failed', 'expired', 'payment_rejected']) assert.notEqual(eventText({ kind: k, data: {}, at: '' }), k, `${k} has words`);
});

// ---- the register and the held units ----------------------------------------------------------------------------------------------
test('the register does not sell a unit held for an order on the site — and sells everything else as before', () => {
  const items = [{ id: 'tote', trackStock: true, stockQty: 2 }, { id: 'shirt', trackStock: true, stockQty: 4 }, { id: 'gift', trackStock: false, stockQty: 0 }];
  const variants = [{ id: 'S', itemId: 'shirt', stockQty: 1 }, { id: 'M', itemId: 'shirt', stockQty: 3 }];
  const h = heldMap([{ item_id: 'tote', variant_id: null, qty: 2 }, { item_id: 'shirt', variant_id: 'S', qty: 1 }]);
  const line = (itemId: string, qty: number, variantId?: string) => ({ itemId, variantId, qty, name: `${itemId}${variantId ? ` ${variantId}` : ''}` });
  assert.equal(heldConflict([line('tote', 1)], items, variants, h), 'tote', 'both totes are held');
  assert.equal(heldConflict([line('shirt', 1, 'S')], items, variants, h), 'shirt S', 'the one S is held');
  assert.equal(heldConflict([line('shirt', 3, 'M')], items, variants, h), null, 'M is not held: sold as before');
  assert.equal(heldConflict([line('shirt', 3)], items, variants, h), null, 'a shirt without a size: 3 of the 4 − 1 held');
  assert.equal(heldConflict([line('shirt', 4)], items, variants, h), 'shirt', 'all 4 would take the held S');
  assert.equal(heldConflict([line('gift', 9)], items, variants, h), null, 'not counted: never held');
  assert.equal(heldConflict([line('shirt', 2, 'M'), line('shirt', 2, 'M')], items, variants, h), null, 'two lines of M: 4 > 3, but M holds nothing — as before');
  assert.equal(heldConflict([line('tote', 1)], items, variants, heldMap([])), null, 'nothing held: as before (even below zero)');
  assert.equal(heldConflict([{ itemId: undefined, qty: 1, name: 'סכום חופשי' } as any], items, variants, h), null);
});

// ---- the sealed keys: the dashboard seals, the storefront opens ------------------------------------------------------------------
test('payment keys sealed here are opened by the storefront\'s own code (and by no other key)', () => {
  const KEY = 'shared-payment-seal-key-0123456789abcdef';
  const sealed = sealPaymentKeys({ api_key: 'api-1234', secret_key: 'secret-5678' }, KEY);
  assert.ok(!sealed.includes('secret-5678'));
  assert.throws(() => sealPaymentKeys({ api_key: 'a', secret_key: 'b' }, 'short'), /PAYMENT_SEAL_KEY/);
  const tsx = `${STOREFRONT}node_modules/.bin/tsx`;
  assert.ok(existsSync(tsx), 'storefront/node_modules is missing — run `npm ci` in storefront/ first');
  const code = `import { openKeys } from './src/lib/seal'; const i = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    console.log(JSON.stringify([openKeys(i.sealed, i.key), openKeys(i.sealed, i.key + 'x')]));`;
  const r = spawnSync(tsx, ['-e', code], { cwd: STOREFRONT, input: JSON.stringify({ sealed, key: KEY }), encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [{ api_key: 'api-1234', secret_key: 'secret-5678' }, null]);
});

// ---- /api/store/payments --------------------------------------------------------------------------------------------------------
const OWN = 'user-own', CASH = 'user-cash', VIEW = 'user-view', OTHER = 'user-other';
const B1 = '00000000-0000-4000-8000-00000000b001', B2 = '00000000-0000-4000-8000-00000000b002';
const tables: Record<string, any[]> = {};
const current: Record<string, string> = { [OWN]: B1, [CASH]: B1, [VIEW]: B1, [OTHER]: B2 };
const SEAL = 'route-payment-seal-key-0123456789abcdef';
function reset() {
  for (const k of Object.keys(tables)) delete tables[k];
  resetRateLimits();
  process.env.PAYMENT_SEAL_KEY = SEAL;
  Object.assign(tables, {
    profiles: [OWN, CASH, VIEW, OTHER].map((id) => ({ id, is_super_admin: false })),
    businesses: [B1, B2].map((id) => ({ id, status: 'active', paid_until: null, grace_days: 0 })),
    business_members: [
      { business_id: B1, user_id: OWN, role: 'owner', access: 'full' }, { business_id: B1, user_id: CASH, role: 'editor', access: 'register' },
      { business_id: B1, user_id: VIEW, role: 'viewer', access: 'full' }, { business_id: B2, user_id: OTHER, role: 'owner', access: 'full' }],
    stores: [{ id: 's1', business_id: B1, checkout_enabled: true }, { id: 's2', business_id: B2, checkout_enabled: true }],
    payment_accounts: [{ business_id: B2, provider: 'payplus', mode: 'test', sealed: 'v1.other', page_uid: 'p2', hint: 'zz99', connected_at: '2026-10-01T00:00:00Z' }],
    finance_access_grants: [],
  });
}
before(() => {
  (globalThis as any).__DP_TEST_ADMIN_DB__ = {
    from: (t: string) => fakeDb(tables).from(t),
    auth: { getUser: async (t: string) => ({ data: { user: [OWN, CASH, VIEW, OTHER].includes(t) ? { id: t } : null } }) },
    rpc: async (fn: string, a: { uid: string }) => ({ data: fn === 'business_for_user' ? current[a.uid] ?? null : null, error: null }),
  };
});
beforeEach(reset);
const call = async (user: string | null, body?: unknown) => {
  const { GET, POST } = await import('../src/app/api/store/payments/route');
  const req = new Request('http://x/api/store/payments', { method: body ? 'POST' : 'GET', headers: user ? { authorization: `Bearer ${user}` } : {}, body: body ? JSON.stringify(body) : undefined });
  const r = await (body ? POST(req) : GET(req));
  return { status: r.status, body: await r.json() };
};
const connect = { action: 'connect', apiKey: 'abcd-1234-efgh', secretKey: 'zzzz-9999-yyyy', pageUid: '1b2c3d4e-0000-4000-8000-1234567890ab' };

test('payments: the owner connects a test terminal — sealed, of their own business, never sent back', async () => {
  const r = await call(OWN, connect);
  assert.equal(r.status, 200);
  assert.deepEqual({ ...r.body, connectedAt: undefined }, { connected: true, provider: 'payplus', mode: 'test', hint: 'efgh', connectedAt: undefined, ready: true });
  assert.ok(!JSON.stringify(r.body).includes('zzzz-9999-yyyy') && !JSON.stringify(r.body).includes('abcd-1234-efgh'), 'no key in the answer');
  const row = tables.payment_accounts.find((x) => x.business_id === B1);
  assert.equal(row.mode, 'test', 'stage 3: test only');
  assert.match(row.sealed, /^v1\./);
  assert.ok(!row.sealed.includes('zzzz-9999-yyyy'));
  assert.equal(tables.payment_accounts.find((x) => x.business_id === B2).sealed, 'v1.other', 'another business\'s terminal untouched');
  assert.equal((await call(OWN)).body.connected, true);
});

test('payments: not a cashier, not a viewer; nothing without a session or a seal key; bad keys refused', async () => {
  assert.equal((await call(CASH, connect)).status, 403);
  assert.equal((await call(CASH)).status, 403, 'a cashier does not even see whether there is a terminal');
  assert.equal((await call(VIEW, connect)).status, 403);
  assert.equal((await call(VIEW)).status, 200, 'a viewer reads');
  assert.equal((await call(null, connect)).status, 401);
  assert.equal((await call(OWN, { ...connect, secretKey: 'abcd-1234-efgh' })).status, 400);
  delete process.env.PAYMENT_SEAL_KEY;
  const r = await call(OWN, connect);
  assert.equal(r.status, 503);
  assert.match(r.body.message, /PAYMENT_SEAL_KEY/);
  assert.equal(tables.payment_accounts.filter((x) => x.business_id === B1).length, 0);
});

test('payments: disconnecting switches selling off first, only for the business worked in now', async () => {
  await call(OWN, connect);
  const r = await call(OWN, { action: 'disconnect' });
  assert.equal(r.status, 200);
  assert.equal(r.body.connected, false);
  assert.equal(tables.stores.find((s) => s.id === 's1').checkout_enabled, false);
  assert.equal(tables.stores.find((s) => s.id === 's2').checkout_enabled, true, 'another business keeps selling');
  assert.equal(tables.payment_accounts.filter((x) => x.business_id === B2).length, 1);
});
