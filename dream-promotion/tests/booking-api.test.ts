/**
 * The public booking API, end to end with an in-memory database (the real route code runs):
 * business card → free times → book → the time disappears → double booking refused → CRM updated.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';
import { israelParts } from '../src/lib/il-time';

const OWNER = 'owner-1';
const tables: Record<string, any[]> = {
  booking_settings: [{ user_id: OWNER, slug: 'sagaboot', enabled: true, title: 'SaGabot', address: 'רמת אביב', phone: '050-0000000', message: '',
    slot_minutes: 30, min_notice_minutes: 0, max_days_ahead: 30, closed_dates: [],
    hours: { 0: [['09:00', '19:00']], 1: [['09:00', '19:00']], 2: [['09:00', '19:00']], 3: [['09:00', '19:00']], 4: [['09:00', '19:00']], 5: [['09:00', '19:00']], 6: [['09:00', '19:00']] } }],
  booking_services: [{ id: 'svc-1', user_id: OWNER, name: 'לייזר פנים', minutes: 45, price: 250, active: true, sort: 0 }],
  appointments: [], leads: [{ id: 'lead-1', user_id: OWNER, name: 'דנה', phone: '052-1112233', status: 'מעוניין' }], lead_activities: [],
};
// the same rule as the database's exclusion constraint
const overlap = (t: string, r: any, all: any[]) => t === 'appointments' && ['booked', 'confirmed'].includes(r.status)
  && all.some((x) => x.user_id === r.user_id && ['booked', 'confirmed'].includes(x.status) && r.start_at < x.end_at && r.end_at > x.start_at)
  ? { code: '23P01', message: 'conflicting key value violates exclusion constraint "appointments_no_overlap"' } : null;
before(() => { (globalThis as any).__DP_TEST_ADMIN_DB__ = fakeDb(tables, { onInsert: overlap }); });

const day = israelParts(Date.now() + 2 * 864e5).date;
const ctx = { params: Promise.resolve({ slug: 'sagaboot' }) };
const post = (body: any) => new Request('http://x/api/book/sagaboot', { method: 'POST', body: JSON.stringify(body) });

test('booking API: card, free times, book, conflict, CRM', async () => {
  const card = await import('../src/app/api/book/[slug]/route');
  const slotsR = await import('../src/app/api/book/[slug]/slots/route');

  const g = await (await card.GET(new Request('http://x'), ctx)).json();
  assert.equal(g.title, 'SaGabot'); assert.equal(g.services[0].name, 'לייזר פנים'); assert.ok(g.days.includes(day));
  assert.ok(!('user_id' in g), 'no private fields on the public card');

  const s1 = await (await slotsR.GET(new Request(`http://x/s?service=svc-1&date=${day}`), ctx)).json();
  const first = s1.slots.find((s: any) => s.time === '10:00');
  assert.ok(first, '10:00 is free');

  const ok = await card.POST(post({ serviceId: 'svc-1', start: first.start, name: 'דנה כהן', phone: '+972 52 111 2233' }), ctx);
  const okJ = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(okJ)); assert.ok(okJ.whenHe);
  assert.equal(tables.appointments.length, 1);
  assert.equal(tables.appointments[0].lead_id, 'lead-1', 'matched the existing contact by phone (any format)');
  assert.equal(tables.leads[0].status, 'נקבע תור', 'CRM stage moved to "appointment set"');
  assert.match(tables.lead_activities[0].body, /נקבע תור אונליין: לייזר פנים/);

  const s2 = await (await slotsR.GET(new Request(`http://x/s?service=svc-1&date=${day}`), ctx)).json();
  assert.ok(!s2.slots.some((s: any) => ['09:30', '10:00', '10:30'].includes(s.time)), 'overlapping 45-min times are gone');

  const again = await card.POST(post({ serviceId: 'svc-1', start: first.start, name: 'מישהו', phone: '0549998877' }), ctx);
  assert.equal(again.status, 409, 'the same time cannot be booked twice');

  const fresh = await card.POST(post({ serviceId: 'svc-1', start: s2.slots.find((s: any) => s.time === '12:00').start, name: 'יוסי', phone: '054-999-8877' }), ctx);
  assert.equal(fresh.status, 200);
  assert.equal(tables.leads.length, 2, 'a new phone creates a new contact');
  assert.equal(tables.leads[1].source, 'הזמנת תור אונליין');
});

test('booking API: refuses bad input, bots, off-grid times and too many bookings', async () => {
  const card = await import('../src/app/api/book/[slug]/route');
  const slotsR = await import('../src/app/api/book/[slug]/slots/route');
  assert.equal((await card.POST(post({ serviceId: 'svc-1', start: new Date().toISOString(), name: '', phone: '1' }), ctx)).status, 400);
  const bot = await card.POST(post({ website: 'spam', serviceId: 'svc-1', start: 'x', name: 'x', phone: '0500000000' }), ctx);
  assert.equal(bot.status, 200); // silently ignored
  const off = new Date(new Date((await (await slotsR.GET(new Request(`http://x/s?service=svc-1&date=${day}`), ctx)).json()).slots[0].start).getTime() + 7 * 60_000).toISOString();
  assert.equal((await card.POST(post({ serviceId: 'svc-1', start: off, name: 'x', phone: '0501234567' }), ctx)).status, 409, 'off-grid time');
  assert.equal((await card.GET(new Request('http://x'), { params: Promise.resolve({ slug: 'nope' }) })).status, 404);
  const free = (await (await slotsR.GET(new Request(`http://x/s?service=svc-1&date=${day}`), ctx)).json()).slots;
  for (const k of [0, 1]) await card.POST(post({ serviceId: 'svc-1', start: free[k * 4].start, name: 'דנה', phone: '0521112233' }), ctx);
  const fourth = await card.POST(post({ serviceId: 'svc-1', start: free[12].start, name: 'דנה', phone: '0521112233' }), ctx);
  assert.equal(fourth.status, 429, 'a 4th upcoming booking for the same phone is refused');
});
