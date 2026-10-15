/**
 * The employee's clock in a real browser (Chromium via Playwright, an iPhone's size and user agent) — 2.100:
 *   - the page links its own manifest (the personal link as start_url) and never Dream's (start_url /dashboard → the sign-in);
 *     the business QR page links the same one once the phone knows the employee;
 *   - "סריקה" opens the camera inside the page — a fake camera shows the business QR (Chromium's fake video capture,
 *     a .y4m drawn here from the same QR the owner prints) — and the clock-in goes out with the scanned code;
 *     another QR is refused without a request; a camera that is not allowed shows how to allow it;
 *   - a wrong / cancelled link: the clock's message, no way to Dream; no network: a retry button (a home-screen app has
 *     no reload);
 *   - recent shifts: in → out left to right, the day of a clock-out on another day, over 14 hours flagged.
 * The clock API is answered here (page.route) — its own rules are tested in tests/clock-api.test.ts and clock-qr.test.ts.
 *
 * Run: npx -y tsx tests/e2e/clock.e2e.ts   (starts `next dev` on port 3241; E2E_CLOCK_BASE=<url> uses a running server)
 * Screenshots: tests/e2e/shots (clock* — not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_CLOCK_PORT ?? 3241);
const BASE = process.env.E2E_CLOCK_BASE ?? `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
const SITE = 'SITEcodeABCDEFGHJKMN1234';
const LINK_NOT_VALID = 'הקישור לא תקין, בקש קישור חדש מהמנהל';

/** a camera that films one QR: a .y4m (raw YUV 4:2:0) — Chromium loops it as the phone's back camera */
function cameraFile(name: string, text: string) {
  const W = 640, H = 480;
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
  const cell = Math.floor(300 / (qr.size + 8));
  const side = cell * (qr.size + 8), x0 = Math.floor((W - side) / 2), y0 = Math.floor((H - side) / 2);
  const y = Buffer.alloc(W * H, 60);   // a grey wall around a white sheet
  for (let r = 0; r < side; r++) for (let c = 0; c < side; c++) {
    const mr = Math.floor(r / cell) - 4, mc = Math.floor(c / cell) - 4;
    const dark = mr >= 0 && mc >= 0 && mr < qr.size && mc < qr.size && qr.data[mr * qr.size + mc];
    y[(y0 + r) * W + x0 + c] = dark ? 16 : 235;
  }
  const uv = Buffer.alloc((W / 2) * (H / 2), 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, uv, uv]);
  const file = path.join(SHOTS, name);
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...Array(10).fill(frame)]));
  return file;
}

async function waitForServer(dev: ChildProcess) {
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`next dev did not start:\n${out}`)), 120_000);
    const on = (b: Buffer) => { out += b.toString(); if (/Ready|ready on|started server/i.test(out)) { clearTimeout(t); resolve(); } };
    dev.stdout?.on('data', on); dev.stderr?.on('data', on);
    dev.on('exit', (c) => { clearTimeout(t); reject(new Error(`next dev exited ${c}\n${out}`)); });
  });
}

/** the clock API's answers (the shape of GET /api/clock/<token>) — Israel is UTC+3 in October 2026 */
function fakeApi() {
  const s = {
    name: 'מיכל לוי', business: 'FollowMe', active: true, openSince: null as string | null, todayMinutes: 0, requireScan: true, needsLocation: false,
    recent: [
      { in: '2026-10-12T06:00:00Z', out: '2026-10-12T14:00:00Z' },   // 09:00–17:00
      { in: '2026-10-10T19:00:00Z', out: '2026-10-11T03:00:00Z' },   // 22:00–06:00, out the next day
      { in: '2026-10-08T05:00:00Z', out: '2026-10-09T07:00:00Z' },   // 26 hours: forgot to clock out
    ],
  };
  const posts: any[] = [];
  let mode: 'ok' | 'gone' | 'offline' = 'ok';
  return {
    posts, setMode: (m: typeof mode) => { mode = m; },
    async handle(route: any) {
      const req = route.request();
      const url = new URL(req.url());
      if (mode === 'offline') return route.abort('internetdisconnected');
      if (mode === 'gone') return route.fulfill({ status: 404, json: { code: 'not_found', message: LINK_NOT_VALID } });
      if (req.method() === 'GET') return route.fulfill({ json: { ...s, siteOk: url.searchParams.get('site') === SITE } });
      const body = JSON.parse(req.postData() || '{}');
      posts.push(body);
      if (body.site !== SITE) return route.fulfill({ status: 403, json: { code: 'scan_required', message: 'הקוד שנסרק כבר לא בתוקף. סרקו את הקוד שתלוי בעסק.' } });
      const at = new Date().toISOString();
      if (body.action === 'in') s.openSince = at; else s.openSince = null;
      return route.fulfill({ json: { ok: true, at, ...s, siteOk: false } });
    },
  };
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const pw: any = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.js' as string));
  const { chromium, devices } = pw.default ?? pw;
  let dev: ChildProcess | null = null;
  if (!process.env.E2E_CLOCK_BASE) {
    dev = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: 'http://sb.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-test-key', NEXT_TELEMETRY_DISABLED: '1' },
    });
    await waitForServer(dev);
    for (const p of [`/clock/${TOKEN}`, `/c/${SITE}`, '/clock']) for (let i = 0; i < 3; i++) if (await fetch(`${BASE}${p}`).then((r) => r.ok, () => false)) break;
  }
  // the full Chromium: the headless shell has no camera at all (getUserMedia → NotSupportedError)
  const launch = (video: string, ...more: string[]) => chromium.launch({ channel: 'chromium', args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`, ...more] });
  const business = cameraFile('clock-camera-business.y4m', `https://dream.example/c/${SITE}`);
  const ours = await launch(business);
  const other = await launch(cameraFile('clock-camera-other.y4m', 'https://example.com/menu'));
  // "don't allow" on the camera question (otherwise a headless browser leaves it open forever)
  const refuses = await launch(business, '--deny-permission-prompts');
  const results: { name: string; ok: boolean }[] = [];
  const errors: string[] = [];
  const { defaultBrowserType: _webkit, ...iphone13 } = devices['iPhone 13'];   // an iPhone's size and user agent, in Chromium (its fake camera)
  const iphone = { ...iphone13, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' };

  async function phone(browser: any, opts: { camera?: boolean; api?: ReturnType<typeof fakeApi> } = {}) {
    const ctx = await browser.newContext(iphone);
    if (opts.camera) await ctx.grantPermissions(['camera'], { origin: BASE });
    const api = opts.api ?? fakeApi();
    await ctx.route((u: URL) => /^\/api\/clock\/[^/]+$/.test(u.pathname), (r: any) => api.handle(r));
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(e.message));
    return { ctx, page, api };
  }
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false }); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}`); }
  };
  const shot = async (p: any, name: string) => { await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, name), fullPage: true }); };
  /** no link or button on the page leads into Dream */
  const noDream = async (p: any) => {
    const hrefs: string[] = await p.$$eval('a[href]', (as: HTMLAnchorElement[]) => as.map((a) => a.getAttribute('href') ?? ''));
    assert.deepEqual(hrefs.filter((h) => /dashboard|auth|^\/$/.test(h)), [], `links into Dream: ${hrefs.join(', ')}`);
    assert.equal(await p.locator('link[rel="manifest"][href="/manifest.webmanifest"]').count(), 0, "Dream's manifest");
  };

  try {
    await step('the personal link: its own manifest in <head> — start_url = the personal link, scope = the clock', async () => {
      const { page, ctx } = await phone(ours);
      await page.goto(`${BASE}/clock/${TOKEN}`);
      await page.getByRole('heading', { name: 'שלום, מיכל' }).waitFor();
      const links: string[] = await page.$$eval('link[rel="manifest"]', (ls: HTMLLinkElement[]) => ls.map((l) => `${l.parentElement?.tagName}:${l.getAttribute('href')}`));
      assert.deepEqual(links, [`HEAD:/api/clock/${TOKEN}/manifest`]);
      assert.equal(await page.title(), 'שעון נוכחות');
      assert.equal(await page.locator('meta[name="apple-mobile-web-app-title"]').getAttribute('content'), 'שעון נוכחות');
      const m = await (await page.request.get(`${BASE}/api/clock/${TOKEN}/manifest`)).json();
      assert.equal(m.start_url, `/clock/${TOKEN}`); assert.equal(m.scope, '/clock/'); assert.equal(m.display, 'standalone');
      await noDream(page);
      await page.getByText('טיפ: באייפון — שיתוף ← "הוספה למסך הבית"', { exact: false }).waitFor();
      await ctx.close();
    });

    await step('"סריקה": the camera opens in the page, reads the business QR and clocks in — no phone camera, no Safari', async () => {
      const { page, api, ctx } = await phone(ours, { camera: true });
      await page.goto(`${BASE}/clock/${TOKEN}`);
      await page.getByText('לכניסה — סורקים את קוד ה-QR שבעסק').waitFor();
      assert.equal(await page.getByText('פותחים את המצלמה של הטלפון').count(), 0, 'no more "open your phone camera"');
      await shot(page, 'clock-1-locked.png');
      await page.getByRole('button', { name: 'סריקה' }).click();
      await page.getByRole('dialog', { name: 'סריקת קוד ה-QR של העסק' }).waitFor();
      await page.getByText(/נכנסת ב-\d\d:\d\d\. משמרת טובה!/).waitFor({ timeout: 20_000 });
      assert.deepEqual(api.posts.map((b) => [b.action, b.site]), [['in', SITE]], 'the scanned code goes with the clock-in');
      assert.equal(await page.getByRole('dialog').count(), 0, 'the camera closed by itself');
      assert.equal(await page.locator('video').count(), 0);
      await page.getByText('ליציאה — סורקים את קוד ה-QR שבעסק').waitFor();
      await shot(page, 'clock-2-after-scan.png');
      await ctx.close();
    });

    await step('another QR (not the business): said so, nothing sent', async () => {
      const { page, api, ctx } = await phone(other, { camera: true });
      await page.goto(`${BASE}/clock/${TOKEN}`);
      await page.getByRole('button', { name: 'סריקה' }).click();
      await page.getByText('זה לא הקוד של השעון. סרקו את הקוד שתלוי בעסק.').waitFor({ timeout: 20_000 });
      await shot(page, 'clock-3-other-qr.png');
      assert.equal(api.posts.length, 0);
      await page.getByRole('button', { name: 'סגירה' }).click();
      assert.equal(await page.getByRole('dialog').count(), 0);
      await ctx.close();
    });

    await step('the camera is not allowed: how to allow it on an iPhone, "לנסות שוב"', async () => {
      const { page, api, ctx } = await phone(refuses);
      await page.goto(`${BASE}/clock/${TOKEN}`);
      await page.getByRole('button', { name: 'סריקה' }).click();
      await page.getByRole('heading', { name: 'אין הרשאה למצלמה' }).waitFor({ timeout: 20_000 });
      await page.getByText('באייפון:', { exact: false }).waitFor();
      assert.equal(await page.getByText('באנדרואיד', { exact: false }).count(), 0, 'an iPhone sees the iPhone steps');
      await shot(page, 'clock-4-camera-denied.png');
      await ctx.grantPermissions(['camera'], { origin: BASE });
      await page.getByRole('button', { name: 'לנסות שוב' }).click();
      await page.getByText(/נכנסת ב-\d\d:\d\d/).waitFor({ timeout: 20_000 });
      assert.equal(api.posts.length, 1, 'allowed → the next try clocks in');
      await ctx.close();
    });

    await step('recent shifts: in → out left to right, the exit day, over 14 hours flagged', async () => {
      const { page, ctx } = await phone(ours);
      await page.goto(`${BASE}/clock/${TOKEN}`);
      const rows = page.locator('li');
      await rows.first().waitFor();
      assert.equal(await rows.count(), 3);
      // where each time is drawn on the screen: the clock-in must be left of the clock-out
      // (a string: tsx wraps named functions in __name(), which does not exist in the page)
      const order = await page.evaluate(`[...document.querySelectorAll('li bdi')].map((b) => {
        const t = b.firstChild, left = (i) => { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 5); return r.getBoundingClientRect().left; };
        return { text: b.textContent, inLeftOfOut: left(0) < left(6), dir: getComputedStyle(b).direction };
      })`);
      assert.deepEqual(order, [
        { text: '09:00–17:00', inLeftOfOut: true, dir: 'ltr' },
        { text: '22:00–06:00', inLeftOfOut: true, dir: 'ltr' },
        { text: '08:00–10:00', inLeftOfOut: true, dir: 'ltr' },
      ]);
      const text = await rows.allInnerTexts();
      assert.doesNotMatch(text[0], /יציאה:|חריגה/);
      assert.match(text[1], /יציאה: .*11/, 'the night shift ends on the 11th'); assert.doesNotMatch(text[1], /חריגה/);
      assert.match(text[2], /חריגה/); assert.match(text[2], /26:00/); assert.match(text[2], /יציאה: .*9/);
      await page.locator('ul').scrollIntoViewIfNeeded();
      await shot(page, 'clock-5-recent.png');
      await ctx.close();
    });

    await step('a wrong or cancelled link: the clock\'s message, no way into Dream', async () => {
      const api = fakeApi(); api.setMode('gone');
      const { page, ctx } = await phone(ours, { api });
      await page.goto(`${BASE}/clock/${TOKEN}`);
      await page.getByText(LINK_NOT_VALID).waitFor();
      await noDream(page);
      await shot(page, 'clock-6-bad-link.png');
      await page.goto(`${BASE}/clock`);
      await page.getByText(LINK_NOT_VALID).waitFor();
      await noDream(page);
      await ctx.close();
    });

    await step('no network: "לנסות שוב" (a home-screen app has no reload)', async () => {
      const api = fakeApi(); api.setMode('offline');
      const { page, ctx } = await phone(ours, { api });
      await page.goto(`${BASE}/clock/${TOKEN}`);
      await page.getByText('אין חיבור לאינטרנט', { exact: false }).waitFor();
      api.setMode('ok');
      await page.getByRole('button', { name: 'לנסות שוב' }).click();
      await page.getByRole('heading', { name: 'שלום, מיכל' }).waitFor();
      await ctx.close();
    });

    await step('the business QR page (/c/<site>): no Dream manifest; the employee\'s own once the phone knows who it is', async () => {
      const { page, ctx } = await phone(ours);
      await page.goto(`${BASE}/c/${SITE}`);
      await page.getByText('הטלפון הזה עוד לא מחובר לשעון').waitFor();
      assert.equal(await page.locator('link[rel="manifest"]').count(), 0, 'no manifest at all before the employee is known');
      await page.evaluate((t: string) => localStorage.setItem('dp-clock-tokens', JSON.stringify([{ token: t, name: 'מיכל לוי' }])), TOKEN);
      await page.reload();
      await page.getByRole('button', { name: 'כניסה' }).waitFor();
      const links: string[] = await page.$$eval('link[rel="manifest"]', (ls: HTMLLinkElement[]) => ls.map((l) => `${l.parentElement?.tagName}:${l.getAttribute('href')}`));
      assert.deepEqual(links, [`HEAD:/api/clock/${TOKEN}/manifest`]);
      await noDream(page);
      await ctx.close();
    });

    assert.deepEqual(errors, [], `page errors: ${errors.join(' · ')}`);
  } finally {
    for (const b of [ours, other, refuses]) await b.close().catch(() => null);
    if (dev) try { process.kill(-dev.pid!, 'SIGTERM'); } catch { /* gone */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (errors.length) console.log(`page errors: ${errors.join(' · ')}`);
  process.exit(failed.length || errors.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
