/**
 * The employee's clock as an app on the phone: its own home-screen manifest (the icon opens the personal link, never
 * Dream's /dashboard and its sign-in), the clock pages' metadata, and what the in-page scanner accepts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOCK_NAME, LINK_NOT_VALID, cameraProblem, clockManifest, clockManifestPath, clockMetadata, isClockToken, phoneKind, siteFromScan } from '../src/features/timeclock/clock-app';

const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
const SITE = 'SITEcodeABCDEFGHJKMN1234';

test('clock app: the manifest opens the personal link and stays on the clock', () => {
  const m = clockManifest(TOKEN);
  assert.equal(m.start_url, `/clock/${TOKEN}`, 'the icon opens this employee\'s own clock — the token is in the address, not in storage');
  assert.equal(m.id, `/clock/${TOKEN}`, 'one app per employee on a shared phone');
  assert.equal(m.scope, '/clock/');
  assert.ok(m.start_url!.startsWith(m.scope!), 'start_url inside scope — otherwise a browser ignores it');
  assert.equal(m.display, 'standalone'); assert.equal(m.dir, 'rtl'); assert.equal(m.lang, 'he');
  assert.equal(m.name, CLOCK_NAME); assert.equal(m.short_name, CLOCK_NAME);
  assert.ok(!JSON.stringify(m).includes('dashboard'), 'nothing of Dream');
  assert.equal(clockManifestPath(TOKEN), `/api/clock/${TOKEN}/manifest`);
});

test('clock app: the manifest route', async () => {
  const r = await import('../src/app/api/clock/[token]/manifest/route');
  const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
  const ok = await r.GET(new Request('http://x'), ctx(TOKEN));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') ?? '', /^application\/manifest\+json/);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await ok.json(), JSON.parse(JSON.stringify(clockManifest(TOKEN))));
  for (const bad of ['short', '../../dashboard', `${TOKEN}/x`, 'a b c d e f g h i j k l m n o p']) {
    assert.equal((await r.GET(new Request('http://x'), ctx(bad))).status, 404, `not a token: ${bad}`);
  }
});

test('clock app: the clock pages never carry Dream\'s manifest', async () => {
  assert.equal(clockMetadata.manifest, null, 'null removes the root /manifest.webmanifest (start_url /dashboard)');
  assert.deepEqual(clockMetadata.appleWebApp, { capable: true, title: CLOCK_NAME, statusBarStyle: 'black-translucent' });
  assert.equal(clockMetadata.title, CLOCK_NAME);
  const clock = await import('../src/app/clock/layout');
  const scan = await import('../src/app/c/layout');
  assert.equal(clock.metadata, clockMetadata, '/clock/<token>');
  assert.equal(scan.metadata, clockMetadata, '/c/<site> (the business QR)');
  assert.ok(isClockToken(TOKEN)); assert.ok(!isClockToken('short')); assert.ok(!isClockToken(`${TOKEN}/`));
  assert.equal(LINK_NOT_VALID, 'הקישור לא תקין, בקש קישור חדש מהמנהל');
});

test('clock app: the scanner takes only the business QR (/c/<code>)', () => {
  assert.equal(siteFromScan(`https://dream.example/c/${SITE}`), SITE);
  assert.equal(siteFromScan(`https://other-preview.vercel.app/c/${SITE}/`), SITE, 'a code printed from another address of the app still works');
  assert.equal(siteFromScan(`  https://dream.example/c/${SITE}?utm=x#y \n`), SITE);
  assert.equal(siteFromScan(`/c/${SITE}`), SITE);
  for (const other of [SITE, `https://dream.example/clock/${TOKEN}`, `https://dream.example/x/c/${SITE}`, 'https://dream.example/c/short',
    `https://dream.example/c/${SITE}/extra`, 'WIFI:S:office;T:WPA;P:secret;;', 'javascript:alert(1)', '', 'https://dream.example/c/abc$defghijklmnopqrstu']) {
    assert.equal(siteFromScan(other), null, `not the business QR: ${other}`);
  }
});

test('clock app: camera errors and which help to show', () => {
  const err = (name: string) => Object.assign(new Error(name), { name });
  assert.equal(cameraProblem(err('NotAllowedError')), 'denied');
  assert.equal(cameraProblem(err('SecurityError')), 'denied');
  assert.equal(cameraProblem(err('NotFoundError')), 'no_camera');
  assert.equal(cameraProblem(err('OverconstrainedError')), 'no_camera');
  assert.equal(cameraProblem(err('NotReadableError')), 'busy');
  assert.equal(cameraProblem(err('TypeError')), 'failed');
  assert.equal(cameraProblem(null), 'failed');
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
  assert.equal(phoneKind(iphone), 'iphone');
  assert.equal(phoneKind(ipad, 5), 'iphone', 'an iPad says Macintosh, with a touch screen');
  assert.equal(phoneKind(ipad, 0), 'other', 'a real Mac');
  assert.equal(phoneKind(android), 'android');
});
