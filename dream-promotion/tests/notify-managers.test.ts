/**
 * Phone notifications on a sale go to the business's managers — also when a cashier sold — never to the
 * cashier's own phone; a product that ran low sends a second, stock notification.
 * web-push is replaced by a recorder (no network); the VAPID keys are generated for the test.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { fakeDb } from './fakedb';

const BIZ = 'biz-1';
const tables: Record<string, any[]> = {
  business_members: [
    { business_id: BIZ, user_id: 'owner', role: 'owner', access: 'full' },
    { business_id: BIZ, user_id: 'manager', role: 'editor', access: 'full' },
    { business_id: BIZ, user_id: 'cashier', role: 'editor', access: 'register' },
    { business_id: 'other', user_id: 'stranger', role: 'owner', access: 'full' },
  ],
  push_subscriptions: [
    { id: 'p1', user_id: 'owner', endpoint: 'https://push.test/owner', keys: { p256dh: 'x', auth: 'y' } },
    { id: 'p2', user_id: 'manager', endpoint: 'https://push.test/manager', keys: { p256dh: 'x', auth: 'y' } },
    { id: 'p3', user_id: 'cashier', endpoint: 'https://push.test/cashier', keys: { p256dh: 'x', auth: 'y' } },
    { id: 'p4', user_id: 'stranger', endpoint: 'https://push.test/stranger', keys: { p256dh: 'x', auth: 'y' } },
  ],
  sales: [{ id: 'S1', business_id: BIZ, total: 240, method: 'cash', status: 'paid', customer_name: 'דנה', employee_name: 'נועה',
    items: [{ name: 'קרם לחות', price: 120, qty: 2, itemId: 'cream', kind: 'product' }] }],
  catalog_items: [{ id: 'cream', business_id: BIZ, name: 'קרם לחות', track_stock: true, stock_qty: 1, low_stock: 2 }],
};
const sent: { endpoint: string; title: string; body: string }[] = [];
before(() => {
  const keys = webpush.generateVAPIDKeys();
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = keys.publicKey; process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  (webpush as any).sendNotification = async (sub: { endpoint: string }, payload: string) => { const p = JSON.parse(payload); sent.push({ endpoint: sub.endpoint, title: p.title, body: p.body }); return {}; };
  (globalThis as any).__DP_TEST_ADMIN_DB__ = {
    ...fakeDb(tables),
    auth: { getUser: async (t: string) => ({ data: { user: ['owner', 'cashier'].includes(t) ? { id: t } : null } }) },
    rpc: async (fn: string, a: { uid: string }) => ({ data: fn === 'business_for_user' ? (tables.business_members.find((m) => m.user_id === a.uid)?.business_id ?? null) : null }),
  };
});

test('a cashier\'s sale reaches the managers\' phones (not the cashier\'s), with a low-stock alert', async () => {
  const route = await import('../src/app/api/notify/sale/route');
  const r = await route.POST(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer cashier' }, body: JSON.stringify({ saleId: 'S1' }) }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.sent, 2);
  assert.deepEqual(j.lowStock, ['קרם לחות: נשארה יחידה אחת']);
  const sale = sent.filter((s) => s.title.startsWith('💰'));
  assert.deepEqual(sale.map((s) => s.endpoint).sort(), ['https://push.test/manager', 'https://push.test/owner']);
  assert.match(sale[0].title, /עסקה חדשה ₪240/);
  assert.match(sale[0].body, /דנה · מזומן · קרם לחות · מוכר\/ת: נועה/);
  const stock = sent.filter((s) => s.title === '⚠️ מלאי נמוך');
  assert.deepEqual(stock.map((s) => s.endpoint).sort(), ['https://push.test/manager', 'https://push.test/owner']);
  assert.ok(!sent.some((s) => s.endpoint.endsWith('/cashier') || s.endpoint.endsWith('/stranger')), 'nobody else is notified');
});

test('a sale of another business is not found (no notification leaks across businesses)', async () => {
  sent.length = 0;
  tables.sales.push({ id: 'S2', business_id: 'other', total: 1, method: 'cash', status: 'paid', items: [] });
  const route = await import('../src/app/api/notify/sale/route');
  const r = await route.POST(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer owner' }, body: JSON.stringify({ saleId: 'S2' }) }));
  assert.equal(r.status, 404);
  assert.equal(sent.length, 0);
});
