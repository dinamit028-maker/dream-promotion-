/** The employee clock API end to end (real route code, in-memory DB with the one-open-shift rule). */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';

const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
const tables: Record<string, any[]> = {
  employees: [
    { id: 'e1', user_id: 'owner', name: 'מיכל לוי', active: true, token: TOKEN },
    { id: 'e2', user_id: 'owner', name: 'רון', active: false, token: 'tok_INACTIVEINACTIVEINACTIVE123' },
  ],
  brands: [{ user_id: 'owner', name: 'SaGabot' }],
  time_entries: [],
};
const oneOpen = (t: string, r: any, all: any[]) => t === 'time_entries' && !r.clock_out && all.some((x) => x.employee_id === r.employee_id && !x.clock_out)
  ? { code: '23505', message: 'duplicate key value violates unique constraint "time_entries_one_open"' } : null;
before(() => { (globalThis as any).__DP_TEST_ADMIN_DB__ = fakeDb(tables, { onInsert: oneOpen }); });
const ctx = (t = TOKEN) => ({ params: { token: t } });
const post = (body: any) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) });

test('clock API: in → double tap → out too soon → out → stamps from the server', async () => {
  const r = await import('../src/app/api/clock/[token]/route');
  const g = await (await r.GET(new Request('http://x'), ctx())).json();
  assert.equal(g.name, 'מיכל לוי'); assert.equal(g.business, 'SaGabot'); assert.equal(g.openSince, null);
  assert.ok(!('token' in g) && !('user_id' in g), 'nothing private in the answer');

  const before = Date.now();
  const inR = await r.POST(post({ action: 'in', lat: 32.1, lng: 34.8, clock_in: '2020-01-01T00:00:00Z' }), ctx());
  const inJ = await inR.json();
  assert.equal(inR.status, 200); assert.ok(inJ.openSince);
  assert.ok(+new Date(tables.time_entries[0].clock_in) >= before - 1000, 'the server time is used, not anything the phone sends');
  assert.equal(tables.time_entries[0].in_lat, 32.1);

  assert.equal((await r.POST(post({ action: 'in' }), ctx())).status, 409, 'double tap on "in" does not open a second shift');
  assert.equal(tables.time_entries.length, 1);
  assert.equal((await r.POST(post({ action: 'out' }), ctx())).status, 409, '"out" seconds after "in" is treated as a double tap');

  tables.time_entries[0].clock_in = new Date(Date.now() - 4 * 3600_000).toISOString(); // pretend 4 hours passed
  const outR = await r.POST(post({ action: 'out' }), ctx());
  const outJ = await outR.json();
  assert.equal(outR.status, 200); assert.equal(outJ.openSince, null);
  assert.ok(tables.time_entries[0].clock_out);
  assert.ok(outJ.todayMinutes >= 239 || outJ.recent.length === 1, 'today total / recent shift reported');
  assert.equal((await r.POST(post({ action: 'out' }), ctx())).status, 409, 'no open shift to close');
});

test('clock API: bad, revoked and inactive links', async () => {
  const r = await import('../src/app/api/clock/[token]/route');
  assert.equal((await r.GET(new Request('http://x'), ctx('short'))).status, 404);
  assert.equal((await r.GET(new Request('http://x'), ctx('tok_DOESNOTEXISTDOESNOTEXIST12'))).status, 404, 'a regenerated (old) link stops working');
  assert.equal((await r.POST(post({ action: 'in' }), ctx('tok_INACTIVEINACTIVEINACTIVE123'))).status, 403, 'inactive employee cannot clock in');
  assert.equal((await r.POST(post({ action: 'dance' }), ctx())).status, 400);
});
