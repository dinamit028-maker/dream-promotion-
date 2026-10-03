/** Clocking only by scanning the business's QR (and optionally only near the business). */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';

const TOKEN = 'tok_QRQRQRQRQRQRQRQRQRQRQRQRQR1234';
const SITE = 'SITEcodeABCDEFGHJKMN1234';
const tables: Record<string, any[]> = {
  employees: [{ id: 'q1', user_id: 'biz', name: 'נועה', active: true, token: TOKEN }],
  brands: [{ user_id: 'biz', name: 'SaGabot' }],
  timeclock_settings: [{ user_id: 'biz', site_code: SITE, require_qr: true, geo_lat: null, geo_lng: null, geo_radius_m: 150 }],
  time_entries: [],
};
before(() => { (globalThis as any).__DP_TEST_ADMIN_DB__ = fakeDb(tables); });
const ctx = { params: { token: TOKEN } };
const post = (body: any) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) });

test('QR clock: the business code is required, old codes are refused', async () => {
  const r = await import('../src/app/api/clock/[token]/route');
  const g = await (await r.GET(new Request('http://x'), ctx)).json();
  assert.equal(g.requireScan, true); assert.equal(g.siteOk, false);
  assert.equal((await (await r.GET(new Request(`http://x?site=${SITE}`), ctx)).json()).siteOk, true);

  const noScan = await r.POST(post({ action: 'in' }), ctx);
  assert.equal(noScan.status, 403); assert.equal((await noScan.json()).code, 'scan_required');
  assert.equal((await r.POST(post({ action: 'in', site: 'OLDcodeOLDcodeOLDcode99' }), ctx)).status, 403, 'a replaced (old) code no longer works');
  assert.equal(tables.time_entries.length, 0);

  const ok = await r.POST(post({ action: 'in', site: SITE }), ctx);
  assert.equal(ok.status, 200);
  assert.equal(tables.time_entries[0].source, 'qr', 'stamped as a QR clock-in');
});

test('QR clock: optional location lock', async () => {
  const r = await import('../src/app/api/clock/[token]/route');
  tables.time_entries.length = 0;
  Object.assign(tables.timeclock_settings[0], { geo_lat: 32.1133, geo_lng: 34.8044, geo_radius_m: 150 });
  assert.equal((await (await r.GET(new Request('http://x'), ctx)).json()).needsLocation, true);
  const noLoc = await r.POST(post({ action: 'in', site: SITE }), ctx);
  assert.equal(noLoc.status, 403); assert.equal((await noLoc.json()).code, 'location_required');
  const far = await r.POST(post({ action: 'in', site: SITE, lat: 32.0853, lng: 34.7818 }), ctx);
  assert.equal(far.status, 403); assert.match((await far.json()).message, /מרחק/);
  const near = await r.POST(post({ action: 'in', site: SITE, lat: 32.1140, lng: 34.8046 }), ctx);
  assert.equal(near.status, 200, 'inside the radius (with GPS slack)');
});
