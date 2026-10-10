/**
 * The public booking page of a business with several locations (T12א, migration 4600): it books at the main location — the
 * database's own choice (location_pick) — so its free hours are that location's: an appointment at a branch does not take a
 * time away, one at the main location does (a row with no location is the main one's). Before the migration (no
 * location_pick) it is the whole business, as before.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';
import { israelParts, israelToIso } from '../src/lib/il-time';

const OWNER = 'owner-1', BIZ = 'biz-1', BRANCH = 'loc-2';
const day = israelParts(Date.now() + 2 * 864e5).date;
const at = (hm: string, minutes: number) => ({ start_at: israelToIso(day, hm), end_at: new Date(Date.parse(israelToIso(day, hm)) + minutes * 60_000).toISOString() });
const tables: Record<string, any[]> = {
  businesses: [{ id: BIZ, status: 'active', paid_until: null, grace_days: null }],
  booking_settings: [{ user_id: OWNER, business_id: BIZ, slug: 'two-places', enabled: true, title: 'שני מקומות', address: '', phone: '', message: '',
    slot_minutes: 30, min_notice_minutes: 0, max_days_ahead: 30, closed_dates: [],
    hours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['09:00', '19:00']]])) }],
  booking_services: [{ id: 'svc-1', user_id: OWNER, business_id: BIZ, name: 'טיפול', minutes: 30, price: 200, active: true, sort: 0 }],
  appointments: [
    { id: 'a-branch', user_id: OWNER, business_id: BIZ, location_id: BRANCH, status: 'booked', ...at('10:00', 30) },
    { id: 'a-main-old', user_id: OWNER, business_id: BIZ, location_id: null, status: 'confirmed', ...at('11:00', 30) },
    { id: 'a-main', user_id: OWNER, business_id: BIZ, location_id: BIZ, status: 'booked', ...at('12:00', 30) },
  ],
  leads: [], lead_activities: [],
};
let pick: string | null = BIZ;   // location_pick's answer (null: the migration is not in the database)
before(() => {
  (globalThis as any).__DP_TEST_ADMIN_DB__ = fakeDb(tables, { rpc: { location_pick: ({ p_business }: any) => (p_business === BIZ ? pick : null) } });
});
const ctx = { params: Promise.resolve({ slug: 'two-places' }) };
const times = async () => {
  const slotsR = await import('../src/app/api/book/[slug]/slots/route');
  const j = await (await slotsR.GET(new Request(`http://x/s?service=svc-1&date=${day}`), ctx)).json();
  return j.slots.map((s: any) => s.time) as string[];
};

test('several locations: the page books at the main location — a branch\'s appointment does not take its time', async () => {
  const t = await times();
  assert.ok(t.includes('10:00'), 'the branch\'s 10:00 is free at the main location');
  assert.ok(!t.includes('11:00'), 'an appointment with no location is the main location\'s');
  assert.ok(!t.includes('12:00'), 'the main location\'s own appointment');
  const card = await import('../src/app/api/book/[slug]/route');
  const start = israelToIso(day, '10:00');
  const r = await card.POST(new Request('http://x/api/book/two-places', { method: 'POST', body: JSON.stringify({ serviceId: 'svc-1', start, name: 'דנה', phone: '0521112233' }) }), ctx);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const made = tables.appointments.find((a) => a.source === 'public');
  assert.equal(made.location_id, BIZ, 'the appointment goes to the main location');
});

test('before migration 4600 (no location_pick): the whole business, as before', async () => {
  pick = null;
  const t = await times();
  assert.ok(!t.includes('10:00') && !t.includes('11:00') && !t.includes('12:00'), 'every appointment of the business takes its time');
  pick = BIZ;
});

test('the main location closed: the page books at the location the database picks', async () => {
  pick = BRANCH;
  const t = await times();
  assert.ok(!t.includes('10:00'), 'the branch\'s appointment now takes its time');
  assert.ok(t.includes('11:00') && t.includes('12:00'), 'the main location\'s do not');
  pick = BIZ;
});
