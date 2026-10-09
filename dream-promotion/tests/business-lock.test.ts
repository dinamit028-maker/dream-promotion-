/**
 * Multi-business stage 4: a locked business closes its public pages (booking, a shared document,
 * the employee clock) with "השירות אינו זמין"; extending the payment opens them again at once.
 * Also checks that the RLS migration covers every business table with the lock gate.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDb } from './fakedb';

const BIZ = 'biz-1';
const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
const DOC = 'a'.repeat(64);
const yesterday = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
const tables: Record<string, any[]> = {
  businesses: [{ id: BIZ, status: 'active', paid_until: null, grace_days: 0 }],
  booking_settings: [{ user_id: 'owner', business_id: BIZ, slug: 'sagabot', enabled: true, title: 'SaGabot', address: '', phone: '', message: '',
    slot_minutes: 30, min_notice_minutes: 0, max_days_ahead: 30, closed_dates: [], hours: { 0: [['09:00', '19:00']] } }],
  booking_services: [{ id: 'svc-1', user_id: 'owner', name: 'לייזר', minutes: 45, price: 250, active: true, sort: 0 }],
  appointments: [],
  employees: [{ id: 'e1', user_id: 'owner', business_id: BIZ, name: 'מיכל', active: true, token: TOKEN }],
  brands: [{ user_id: 'owner', name: 'SaGabot' }],
  time_entries: [],
  documents: [{ id: 'd1', user_id: 'owner', business_id: BIZ, share_token: DOC, doc_type: 320, doc_number: 1 }],
  register_settings: [],
};
before(() => { (globalThis as any).__DP_TEST_ADMIN_DB__ = fakeDb(tables); });
const biz = () => tables.businesses[0];

async function statuses() {
  const book = await import('../src/app/api/book/[slug]/route');
  const clock = await import('../src/app/api/clock/[token]/route');
  const doc = await import('../src/app/api/doc/[token]/route');
  const b = await book.GET(new Request('http://x'), { params: Promise.resolve({ slug: 'sagabot' }) });
  const c = await clock.GET(new Request('http://x'), { params: Promise.resolve({ token: TOKEN }) });
  const d = await doc.GET(new Request('http://x'), { params: Promise.resolve({ token: DOC }) });
  return { book: b.status, clock: c.status, doc: d.status, bodies: [await b.json(), await c.json(), await d.json()] };
}

test('public pages: open business works, locked business says "the service is unavailable"', async () => {
  const open = await statuses();
  assert.deepEqual([open.book, open.clock, open.doc], [200, 200, 200]);
  assert.ok(!('business_id' in open.bodies[2].doc), 'no internal ids on the shared document');

  biz().paid_until = yesterday; // paid until the day before yesterday, no grace → locked automatically
  const locked = await statuses();
  assert.deepEqual([locked.book, locked.clock, locked.doc], [403, 403, 403]);
  for (const j of locked.bodies) assert.deepEqual(j, { code: 'unavailable', message: 'השירות אינו זמין' });

  const post = await (await import('../src/app/api/book/[slug]/route')).POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify({ serviceId: 'svc-1', start: new Date().toISOString(), name: 'דנה', phone: '0521112233' }) }),
    { params: Promise.resolve({ slug: 'sagabot' }) });
  assert.equal(post.status, 403, 'no booking into a locked business');
  assert.equal(tables.appointments.length, 0);

  biz().grace_days = 5; // grace days keep it open
  assert.equal((await statuses()).book, 200);
  biz().grace_days = 0;
  biz().status = 'locked'; biz().paid_until = null; // manual lock
  assert.equal((await statuses()).book, 403);
  biz().status = 'active'; // "extend" / unlock opens everything at once
  assert.deepEqual(Object.values(await statuses()).slice(0, 3), [200, 200, 200]);
});

test('RLS migration: every business table has the lock gate', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261004002300_business_rls.sql', import.meta.url), 'utf8');
  const list = /tables constant text\[\] := array\[([^\]]+)\]/.exec(sql)?.[1] ?? '';
  const named = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.equal(named.length, 23);
  for (const t of ['leads', 'documents', 'sales', 'social_accounts', 'scheduled_posts', 'appointments', 'brands']) assert.ok(named.includes(t), t);
  assert.match(sql, /as restrictive for all to authenticated/);
  assert.ok(!/\bdrop\b/i.test(sql.replace(/--.*$/gm, '')), 'additive only — nothing dropped');
});
