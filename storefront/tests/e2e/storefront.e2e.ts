/**
 * The storefront in a real browser (Chromium via Playwright) against a REAL Postgres — every migration of the dashboard
 * and the seed of tests/e2e/seed.sql — through the same sf_* functions the live site calls (SF_DATA=pg, never on Vercel).
 * Chromium maps *.test to this machine, so each store is reached by its own domain: followme.test (+ www), shoes.test,
 * draft.test, and platform.test (the storefront's own address, where only a preview lives). FollowMe sells in test mode
 * through the pretend provider (PAYMENT_MOCK=1, never on Vercel): cart, checkout, the payment page, the notices, the cron.
 *
 * Run: npm run test:e2e   (needs the local Postgres 16 and the preinstalled Chromium; builds and starts the storefront)
 * Screenshots go to tests/e2e/shots/ (not committed).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { makePreviewToken } from '../../src/lib/preview';
import { sealKeys } from '../../src/lib/seal';
import { orderRef } from '../../src/lib/order-link';

const ROOT = path.resolve(__dirname, '../..');
const MIGRATIONS = path.resolve(ROOT, '../dream-promotion/supabase/migrations');
const SHIM = path.resolve(ROOT, '../dream-promotion/tests/sql/supabase-shim.sql');
const PORT = Number(process.env.SF_E2E_PORT ?? 3231);
const DB = process.env.SF_E2E_DB ?? 'sf_e2e';
const SECRET = 'e2e-preview-secret-0123456789abcdef';
const SEAL = 'e2e-payment-seal-key-0123456789abcdef';
const CRON = 'e2e-cron-secret-0123456789';
const COMMERCE = 'e2e-commerce-secret-0123456789';   // the storefront → the dashboard ("an order was paid")
const LINK = 'e2e-order-link-secret-0123456789';     // the signed order link of an email
const DASH_PORT = PORT + 1;                           // a stand-in for the dashboard's server
const MOCK_KEYS = { api_key: 'mock-api', secret_key: 'mock-secret' };
const SHOTS = path.join(__dirname, 'shots');
const DRAFT_STORE = 'cccccccc-0000-4000-8000-0000000000c1';
const FOLLOWME_STORE = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const url = (host: string, p = '/') => `http://${host}:${PORT}${p}`;

// ---- the database ------------------------------------------------------------------------------------------------------
function psql(sql: string, db = DB): string {
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-d', db];
  const asPostgres = process.getuid?.() === 0;
  const r = asPostgres
    ? spawnSync('su', ['postgres', '-c', `psql ${args.join(' ')}`], { input: sql, encoding: 'utf8', env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' } })
    : spawnSync('psql', args, { input: sql, encoding: 'utf8', env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' } });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout.trim();
}
function prepareDatabase() {
  psql(`drop database if exists ${DB} with (force);`, 'postgres');
  psql(`create database ${DB};`, 'postgres');
  psql(readFileSync(SHIM, 'utf8'));
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) psql(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  psql(readFileSync(path.join(__dirname, 'seed.sql'), 'utf8'));
  // FollowMe sells (test): a terminal of the pretend provider — its keys sealed as the dashboard seals them — pickup and delivery
  psql(`insert into public.payment_accounts (business_id, provider, mode, sealed, page_uid, hint)
          values ('aaaaaaaa-0000-4000-8000-00000000000a', 'mock', 'test', '${sealKeys(MOCK_KEYS, SEAL)}', 'mock-page', 'mapi');
        update public.stores set checkout_enabled = true, pickup_enabled = true, pickup_note = 'הרצל 10, תל אביב', delivery_enabled = true,
          delivery_price = 30, free_delivery_over = 100 where id = '${FOLLOWME_STORE}';
        insert into public.store_coupons (store_id, code, kind, value) values ('${FOLLOWME_STORE}', 'WELCOME10', 'percent', 10);`);
  // the storefront's login: may become service_role (the sf_* door), nothing more
  psql(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'sf_e2e') then create role sf_e2e login password 'sf_e2e'; end if; end $$;
        grant service_role to sf_e2e;`, 'postgres');
}

// ---- the server --------------------------------------------------------------------------------------------------------
function run(cmd: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  return spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ...env } });
}
async function waitFor(p: ChildProcess, pattern: RegExp, what: string, ms = 180_000) {
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not finish:\n${out.slice(-3000)}`)), ms);
    const on = (b: Buffer) => { out += b.toString(); if (pattern.test(out)) { clearTimeout(t); resolve(); } };
    p.stdout?.on('data', on); p.stderr?.on('data', on);
    p.on('exit', (c) => { if (!pattern.test(out)) { clearTimeout(t); reject(new Error(`${what} exited ${c}\n${out.slice(-3000)}`)); } });
  });
}

/** a request with any Host, without following redirects (Node, not the browser) */
function raw(host: string, p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, headers: { host: `${host}:${PORT}`, ...headers } }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}

/** a POST with any Host (the provider's notice, a form of another site, the cron) */
function rawPost(host: string, p: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: { host: `${host}:${PORT}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    req.on('error', reject); req.end(body);
  });
}

/** a w × h PNG of one colour (the product pictures of the seed live on cdn.test: the browser gets this instead) */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, d: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  prepareDatabase();
  if (process.env.SF_E2E_SKIP_BUILD !== '1') {
    const b = run('npx', ['next', 'build']);
    await waitFor(b, /Proxy|Route \(app\)[\s\S]*ƒ/, 'next build', 400_000);
    await new Promise((r) => b.on('exit', r));
  }
  // the dashboard's server, as far as the storefront sees it: "finalize" records the sale the way the dashboard does
  // (commerce_record_sale, VAT 18% of the total), and a document's PDF by its share token
  const finalized: string[] = [];
  const dashboard = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/commerce/finalize' && req.headers['x-commerce-secret'] === COMMERCE) {
        const id = String(JSON.parse(body || '{}').orderId ?? '');
        if (/^[0-9a-f-]{36}$/.test(id)) {
          psql(`select public.commerce_record_sale(o.id, 18, round(o.total * 18 / 118, 2)) from public.orders o where o.id = '${id}' and not o.is_test`);
          finalized.push(id);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return;
      }
      if (req.method === 'GET' && /^\/api\/doc\/[0-9a-f]+\/pdf$/.test(req.url ?? '')) {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'X-Served-By': 'dashboard' }); res.end('%PDF-1.4 e2e'); return;
      }
      // the dashboard's visual editor (2.61), as far as the storefront sees it: a page that frames the store and keeps its messages
      if (req.method === 'GET' && (req.url ?? '').startsWith('/frame?src=')) {
        const src = decodeURIComponent((req.url ?? '').slice('/frame?src='.length));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body><iframe id="f" src="${src.replace(/"/g, '&quot;')}" width="390" height="800"></iframe>
          <script>window.msgs = []; addEventListener('message', (e) => window.msgs.push({ origin: e.origin, data: e.data }));</script></body></html>`);
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((r) => dashboard.listen(DASH_PORT, '127.0.0.1', r));
  const server = run('npx', ['next', 'start', '-p', String(PORT)], {
    SF_DATA: 'pg', SF_DATABASE_URL: `postgres://sf_e2e:sf_e2e@127.0.0.1:5432/${DB}`,
    STOREFRONT_PREVIEW_SECRET: SECRET, STOREFRONT_PLATFORM_HOSTS: 'platform.test',
    PAYMENT_MOCK: '1', PAYMENT_SEAL_KEY: SEAL, STOREFRONT_CRON_SECRET: CRON,
    DASHBOARD_URL: `http://127.0.0.1:${DASH_PORT}`, COMMERCE_SECRET: COMMERCE, ORDER_LINK_SECRET: LINK,
    STORE_ROOT_DOMAIN: 'stores.test',
  });
  await waitFor(server, /Ready|started server|Local:/i, 'next start');

  const pw: any = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.js' as string));
  const { chromium } = pw.default ?? pw;
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP *.test 127.0.0.1'] });
  const results: { name: string; ok: boolean; error?: string }[] = [];
  const errors: string[] = [];
  const picture = png(80, 100, [176, 122, 69]);
  const ga: string[] = [];
  async function phone(width = 390) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'he-IL' });
    await ctx.route('https://cdn.test/**', (r: any) => r.fulfill({ status: 200, contentType: 'image/png', body: picture }));
    await ctx.route('https://www.googletagmanager.com/**', (r: any) => { ga.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'text/javascript', body: '/* gtag */' }); });
    const page = await ctx.newPage();
    page.on('console', (m: any) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(`${page.url()}: ${m.text()}`); });
    page.on('pageerror', (e: Error) => errors.push(`${page.url()}: ${e.message}`));
    return { ctx, page };
  }
  async function step(name: string, fn: () => Promise<void>) {
    try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e) { results.push({ name, ok: false, error: (e as Error).message }); console.log(`not ok - ${name}\n  ${(e as Error).message.split('\n').join('\n  ')}`); }
  }
  const text = async (page: any) => (await page.locator('body').innerText()) as string;

  try {
    await step('a store on its own domain: its name, its published theme, Hebrew RTL — and no word of the platform', async () => {
      const { ctx, page } = await phone();
      const res = await page.goto(url('followme.test'));
      assert.equal(res.status(), 200);
      assert.equal(await page.getAttribute('html', 'lang'), 'he');
      assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
      await page.getByRole('heading', { level: 1, name: 'שקיות FollowMe' }).waitFor();
      const body = await text(page);
      assert.ok(!body.includes('טיוטה חדשה'), 'the public never sees the draft theme');
      assert.ok(!/dream/i.test(await page.content()), 'Dream is never named to a shopper');
      assert.match(body, /פולואו מי בע"מ/);
      assert.match(body, /ח\.פ\.\s*516000001/);
      assert.match(body, /הרצל 10, תל אביב/);
      await page.getByRole('link', { name: 'הצהרת נגישות' }).first().waitFor();
      assert.equal(await page.locator('h2', { hasText: 'שקיות אקולוגיות' }).count(), 0, 'collections show as tiles, not titles');
      await page.getByRole('link', { name: /שקיות אקולוגיות/ }).first().waitFor();
      const csp = res.headers()['content-security-policy'];
      assert.match(csp, /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
      assert.doesNotMatch((await raw('followme.test', '/')).body, /\sstyle="/, 'no inline style attribute in the page (the CSP)');
      const ld = await page.locator('script[type="application/ld+json"]').first().textContent();
      assert.match(ld ?? '', /"@type":"Organization"/);
      await page.screenshot({ path: path.join(SHOTS, 'home-390.png'), fullPage: true });
      await ctx.close();
    });

    await step('cookies: Google Analytics only after "אישור"; "דחייה" leaves nothing', async () => {
      ga.length = 0;
      const { ctx, page } = await phone();
      await page.goto(url('followme.test'));
      const dialog = page.getByRole('dialog', { name: 'עוגיות ומדידה' });
      await dialog.waitFor();
      assert.equal(ga.length, 0, 'nothing of Google before a choice');
      await dialog.getByRole('button', { name: 'דחייה' }).click();
      await dialog.waitFor({ state: 'detached' });
      await page.reload();
      await page.waitForTimeout(400);
      assert.equal(await page.getByRole('dialog', { name: 'עוגיות ומדידה' }).count(), 0, 'the choice is kept');
      assert.equal(ga.length, 0, 'declined: no script');
      await page.getByRole('button', { name: 'הגדרות עוגיות' }).click();
      await page.getByRole('dialog', { name: 'עוגיות ומדידה' }).getByRole('button', { name: 'אישור' }).click();
      await page.waitForFunction(() => !!document.querySelector('script[src*="googletagmanager.com/gtag/js?id=G-TEST1234"]'));
      assert.equal(ga.length, 1, 'agreed: the script of this store\'s measurement id');
      await ctx.close();
    });

    await step('www goes to the primary domain (308, permanent), with the path', async () => {
      const r = await raw('www.followme.test', '/products/tote-bag?x=1');
      assert.equal(r.status, 308);
      assert.equal(r.headers.location, 'https://followme.test/products/tote-bag?x=1');
    });

    await step('an unknown domain: a neutral 404 — no store, no platform', async () => {
      const r = await raw('nobody.test', '/');
      assert.equal(r.status, 404);
      assert.match(r.body, /הדף לא נמצא/);
      assert.doesNotMatch(r.body, /FollowMe|Shoes|dream/i);
      const s = await raw('platform.test', '/');
      assert.equal(s.status, 404, 'the storefront\'s own address shows no store without a preview');
      const bad = await raw('followme.test', '/site/shoes.test/products/tote-bag');
      assert.equal(bad.status, 404, 'the internal address cannot be reached from outside');
      const spoof = await raw('nobody.test', '/', { 'x-sf-host': 'followme.test' });
      assert.equal(spoof.status, 404, 'a header that pretends to choose a store is ignored');
    });

    await step('isolation: the same address in another store is never this product', async () => {
      const { ctx, page } = await phone();
      await page.goto(url('shoes.test', '/products/tote-bag'));
      await page.getByRole('heading', { level: 1, name: 'מגף' }).waitFor();
      await page.goto(url('followme.test', '/products/tote-bag'));
      await page.getByRole('heading', { level: 1, name: 'שקית בד' }).waitFor();
      assert.ok(!(await text(page)).includes('מגף'));
      const r = await raw('shoes.test', '/collections/eco');
      assert.equal(r.status, 404, 'a collection of another business is not here');
      await ctx.close();
    });

    await step('a hidden product is 404 (a real status); a moved address is permanent (308)', async () => {
      const hidden = await raw('followme.test', '/products/secret-bag');
      assert.equal(hidden.status, 404);
      assert.doesNotMatch(hidden.body, /שקית סודית/);
      const moved = await raw('followme.test', '/products/old-tote');
      assert.equal(moved.status, 308);
      assert.equal(moved.headers.location, '/products/tote-bag');
      const nowhere = await raw('followme.test', '/no/such/page');
      assert.equal(nowhere.status, 404);
      assert.match(nowhere.body, /FollowMe Collection/, 'a 404 of a known store keeps its header');
    });

    await step('a product: pictures, sizes / colours, the price and stock of THAT variant, a question on WhatsApp', async () => {
      const { ctx, page } = await phone();
      await page.goto(url('followme.test', '/products/tote-bag'));
      await page.getByRole('heading', { level: 1, name: 'שקית בד' }).waitFor();
      assert.equal(await page.locator('.gallery img').count(), 2);
      assert.equal(await page.locator('.gallery img').first().getAttribute('alt'), 'שקית בד שחורה');
      assert.match((await page.locator('.gallery img').first().getAttribute('srcset')) ?? '', /tote-1-400\.webp 400w, .*tote-1-1600\.webp 1600w/);
      const price = page.locator('.buy-price');
      assert.match(await price.innerText(), /20/);
      await page.getByRole('button', { name: 'M', exact: true }).click();
      await page.getByRole('button', { name: 'שחור', exact: true }).click();
      assert.match(await price.innerText(), /24/, 'M / שחור has its own online price');
      assert.match(page.url(), /variant=aaaaaaaa-0000-4000-8000-000000000113/);
      assert.match(await page.locator('.buy .stock').innerText(), /במלאי/);
      await page.getByRole('button', { name: 'S', exact: true }).click();
      await page.getByRole('button', { name: 'לבן', exact: true }).click();
      assert.match(await page.locator('.buy .stock').innerText(), /אזל המלאי/);
      assert.equal(await page.getByRole('button', { name: 'אזל המלאי' }).isDisabled(), true, 'an out of stock variant cannot be added');
      const wa = await page.getByRole('link', { name: 'שאלה בוואטסאפ' }).getAttribute('href');
      assert.match(wa ?? '', /^https:\/\/wa\.me\/972501234567\?text=/);
      assert.match(decodeURIComponent(wa ?? ''), /שקית בד \(S \/ לבן\)/);
      const body = await text(page);
      assert.match(body, /חומר\s*כותנה/);
      assert.ok(!body.includes('סוד-מסחרי'), 'a field that is not shown on the site never reaches the page');
      assert.match(body, /ארץ ייצור\s*ישראל/);
      assert.equal(await page.getByRole('heading', { level: 2, name: 'מה מקבלים' }).count(), 1, 'the description\'s titles and lists');
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://followme.test/products/tote-bag');
      const lds = await page.locator('script[type="application/ld+json"]').allTextContents();
      const product = JSON.parse(lds.find((t: string) => t.includes('"Product"')) ?? '{}');
      assert.equal(product.name, 'שקית בד');
      assert.equal(product.offers.length, 3, 'one offer per active variant');
      assert.ok(product.offers.some((o: any) => o.price === 24 && o.availability === 'https://schema.org/InStock'));
      assert.ok(product.offers.some((o: any) => o.availability === 'https://schema.org/OutOfStock'));
      assert.ok(lds.some((t: string) => t.includes('"BreadcrumbList"') && t.includes('שקיות אקולוגיות')), 'breadcrumbs through its collection');
      await page.screenshot({ path: path.join(SHOTS, 'product-390.png'), fullPage: true });
      await ctx.close();
    });

    await step('a collection, filters, sort and search', async () => {
      const { ctx, page } = await phone();
      await page.goto(url('followme.test', '/collections/eco'));
      await page.getByRole('heading', { level: 1, name: 'שקיות אקולוגיות' }).waitFor();
      assert.deepEqual(await page.locator('.grid .card-name').allInnerTexts(), ['שקית בד'], 'the hidden product of the collection is not shown');
      await page.goto(url('followme.test', '/collections/all?sort=price_asc'));
      assert.deepEqual(await page.locator('.grid .card-name').allInnerTexts(), ['שקית נייר', 'שקית קרפט', 'שקית בד']);
      await page.getByText('סינון ומיון').click();
      await page.getByRole('checkbox', { name: 'רק מה שבמלאי' }).check();
      await page.getByRole('button', { name: 'הצגה' }).click();
      await page.waitForURL(/stock=1/);
      assert.deepEqual(await page.locator('.grid .card-name').allInnerTexts(), ['שקית קרפט', 'שקית בד'], 'out of stock is filtered out');
      await page.goto(url('followme.test', `/collections/all?${new URLSearchParams([['o.מידה', 'M']]).toString()}`));
      assert.deepEqual(await page.locator('.grid .card-name').allInnerTexts(), ['שקית בד']);
      await page.goto(url('followme.test', '/collections/paper'));
      assert.deepEqual(await page.locator('.grid .card-name').allInnerTexts(), ['שקית נייר', 'שקית קרפט'], 'an automatic collection, by its own sort');
      assert.equal(await page.locator('.card .badge').first().innerText(), 'אזל');
      await page.goto(url('followme.test', '/search'));
      await page.getByRole('searchbox', { name: 'חיפוש' }).fill('קרפט');
      await page.getByRole('button', { name: 'חיפוש', exact: true }).click();
      await page.waitForURL(/q=/);
      assert.deepEqual(await page.locator('.grid .card-name').allInnerTexts(), ['שקית קרפט']);
      assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex, follow', 'a page of results is not indexed');
      await page.screenshot({ path: path.join(SHOTS, 'collection-390.png'), fullPage: true });
      await ctx.close();
    });

    await step('pages and policies: the business\'s own text', async () => {
      const { ctx, page } = await phone();
      await page.goto(url('followme.test', '/policies/returns'));
      await page.getByRole('heading', { level: 1, name: 'ביטולים והחזרות' }).waitFor();
      await page.getByRole('heading', { level: 2, name: 'ביטול עסקה' }).waitFor();
      await page.goto(url('followme.test', '/pages/about'));
      assert.equal(await page.locator('.prose li').count(), 2);
      assert.equal((await raw('followme.test', '/policies/terms')).status, 404, 'a policy that was not written is 404');
      await ctx.close();
    });

    await step('SEO: robots, sitemap, canonical, Search Console, Open Graph', async () => {
      const robots = await raw('followme.test', '/robots.txt');
      assert.equal(robots.status, 200);
      assert.match(robots.body, /Sitemap: https:\/\/followme\.test\/sitemap\.xml/);
      assert.match(robots.body, /Disallow: \/search/);
      const map = await raw('followme.test', '/sitemap.xml');
      assert.equal(map.status, 200);
      assert.match(map.headers['content-type'] ?? '', /xml/);
      for (const loc of ['https://followme.test/', 'https://followme.test/products/tote-bag', 'https://followme.test/products/kraft-bag',
        'https://followme.test/collections/eco', 'https://followme.test/policies/returns', 'https://followme.test/pages/about']) {
        assert.ok(map.body.includes(`<loc>${loc}</loc>`), `the sitemap lists ${loc}`);
      }
      assert.ok(!map.body.includes('secret-bag'), 'never a hidden product');
      const draftRobots = await raw('draft.test', '/robots.txt');
      assert.match(draftRobots.body, /Disallow: \/\n/, 'a store that is not on the air closes the door');
      assert.equal((await raw('draft.test', '/sitemap.xml')).status, 404);
      // 2.60: the Merchant Center feed — the products on the air, as the product page shows them; never a hidden one
      const feed = await raw('followme.test', '/feeds/google.xml');
      assert.equal(feed.status, 200);
      assert.match(feed.body, /^<\?xml[^>]*>\n<rss version="2.0" xmlns:g="http:\/\/base.google.com\/ns\/1.0">/);
      assert.match(feed.body, /<g:link>https:\/\/followme\.test\/products\/tote-bag(\?variant=[^<]+)?<\/g:link>/);
      assert.match(feed.body, /<g:price>\d+\.\d{2} ILS<\/g:price>/);
      assert.match(feed.body, /<g:availability>(in_stock|out_of_stock)<\/g:availability>/);
      assert.ok(!feed.body.includes('secret-bag'), 'never a hidden product');
      assert.equal((await raw('draft.test', '/feeds/google.xml')).status, 404, 'a store that is not on the air has no feed');
      const home = await raw('followme.test', '/');
      assert.match(home.body, /<meta name="google-site-verification" content="gsc-verification-code-1"/);
      assert.match(home.body, /<link rel="canonical" href="https:\/\/followme\.test"/);
      assert.match(home.body, /<meta property="og:site_name" content="FollowMe Collection"/);
      assert.doesNotMatch(home.body, /noindex/);
      // the tab's icon: the store's logo, else none — never a request for a /favicon.ico that does not exist (Lighthouse)
      assert.match(home.body, /<link rel="icon" href="(data:,|https:\/\/[^"]+)"/);
      assert.match((await raw('nowhere.test', '/')).body, /<link rel="icon" href="data:,"/, 'an unknown domain too');
    });

    await step('a store that is not on the air: "בקרוב" — the preview token opens it, and only it', async () => {
      const soon = await raw('draft.test', '/');
      assert.equal(soon.status, 200);
      assert.match(soon.body, /בקרוב/);
      assert.match(soon.body, /noindex/);
      assert.doesNotMatch(soon.body, /מוצר טיוטה/);
      const token = makePreviewToken(DRAFT_STORE, SECRET, Date.now() / 1000 + 3600);
      const { ctx, page } = await phone();
      await page.goto(url('draft.test', `/?preview=${encodeURIComponent(token)}`));
      assert.equal(new URL(page.url()).search, '', 'the token leaves the address');
      await page.getByRole('status').filter({ hasText: 'תצוגה מקדימה' }).waitFor();
      await page.goto(url('draft.test', '/collections/all'));
      assert.deepEqual(await page.locator('.grid .card-name').allInnerTexts(), ['מוצר טיוטה']);
      assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex, nofollow');
      await page.goto(url('platform.test', `/?preview=${encodeURIComponent(token)}`));
      await page.getByRole('status').filter({ hasText: 'תצוגה מקדימה' }).waitFor();
      await page.goto(url('platform.test', '/products/draft-item'));
      await page.getByRole('heading', { level: 1, name: 'מוצר טיוטה' }).waitFor();
      // a token of the draft store does not open another store, and a forged token opens nothing
      await page.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
      assert.equal(await page.getByRole('status').filter({ hasText: 'תצוגה מקדימה' }).count(), 0);
      const forged = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
      const { ctx: c2, page: p2 } = await phone();
      await p2.goto(url('draft.test', `/?preview=${encodeURIComponent(forged)}`));
      await p2.getByRole('heading', { level: 1, name: 'בקרוב' }).waitFor();
      await c2.close();
      await ctx.close();
    });

    await step('a store on a starter kit (2.58): its own sections and font; the owner\'s preview shows where pictures and products will be', async () => {
      // the beauty kit as the dashboard writes it (kitSettings): the store's name filled in, "booking" → WhatsApp (no booking page)
      const kit = JSON.parse(readFileSync(path.resolve(ROOT, '../dream-promotion/kits/beauty.json'), 'utf8'));
      const settings = JSON.parse(JSON.stringify({ kit: kit.id, ...kit.theme }).split('{{name}}').join('Draft Store').split('"booking"').join('"whatsapp"'));
      const sql = (v: unknown) => JSON.stringify(v).replace(/'/g, "''");
      psql(`insert into public.store_theme_versions (store_id, template, settings, note) values ('${DRAFT_STORE}', 'kit', '${sql(settings)}', 'ערכה: ביוטי');
        insert into public.store_pages (store_id, kind, slug, title, body, published) values ('${DRAFT_STORE}', 'page', 'treatments', 'הטיפולים שלנו', '## [שם הטיפול]', false);
        insert into public.store_menus (store_id, kind, items) values ('${DRAFT_STORE}', 'main', '[{"label": "הטיפולים", "href": "/pages/treatments"}, {"label": "לפני ואחרי", "href": "/#before-after"}]');`);
      const token = makePreviewToken(DRAFT_STORE, SECRET, Date.now() / 1000 + 3600);
      const { ctx, page } = await phone();
      await page.goto(url('draft.test', `/?preview=${encodeURIComponent(token)}`));
      await page.getByRole('heading', { level: 1, name: 'הזמן שלך לטפח את עצמך' }).waitFor();
      assert.ok(await page.locator('#before-after').getByRole('heading', { name: 'לפני ואחרי' }).isVisible(), 'the kit\'s gallery, with its anchor');
      // no pictures of the business yet (2.62): the kit's own pictures — the hero, the image and text; the gallery in the preview only
      const hero = page.locator('.hero-media img');
      assert.equal(await hero.getAttribute('src'), '/kit-images/beauty/beauty-hero-wide.webp', 'the kit\'s hero picture');
      assert.ok(await hero.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), 'the picture loads (the proxy lets kit-images/ through)');
      assert.match(await hero.getAttribute('alt') ?? '', /\S/, 'with its alt text');
      assert.equal(await page.locator('#treatments .split-media img').getAttribute('src'), '/kit-images/beauty/beauty-image-text.webp');
      assert.equal(await page.locator('#before-after .gallery-item img').count(), 3, 'the owner\'s preview: the kit\'s gallery pictures, where the business\'s will be');
      assert.equal(await page.locator('#before-after .gallery-empty').count(), 0);
      assert.ok((await page.locator('#care .card-placeholder').count()) > 0, 'no products yet: where they will be — never a made-up product');
      assert.equal(await page.locator('.card-placeholder .card-name').first().innerText(), 'כאן יופיע מוצר');
      const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      assert.match(font, /Frank Ruhl Libre/, 'the kit\'s font');
      assert.equal(await page.locator('.bag-art').first().isVisible(), false, 'not the drawn bag of the first template');
      assert.equal(await page.locator('#f-info').count(), 0, 'no policy published, no checkout: no empty "מידע" heading in the footer');
      await page.screenshot({ path: path.join(SHOTS, 'kit-beauty-home.png'), fullPage: true });
      // the owner's preview: the menu's link to a page not published yet, and the page itself
      await page.locator('.nav-wide').getByRole('link', { name: 'הטיפולים', includeHidden: true }).waitFor({ state: 'attached' });
      await page.goto(url('draft.test', '/pages/treatments'));
      await page.getByRole('heading', { level: 1, name: 'הטיפולים שלנו' }).waitFor();
      await page.screenshot({ path: path.join(SHOTS, 'kit-beauty-preview.png'), fullPage: true });
      await ctx.close();
      // a shopper never sees the newsletter (stage 5), nor any of this before the store is on the air
      const soon = await raw('draft.test', '/');
      assert.match(soon.body, /בקרוב/);
      // a store with no kit (FollowMe, the bags template): no kit picture, its drawing as before
      assert.ok(!/kit-images/.test((await raw('followme.test', '/')).body), 'no kit, no kit picture');
    });

    await step('on the air: a menu link to a page that is not published is left out for shoppers; the owner\'s preview keeps it', async () => {
      const before = psql(`select items::text from public.store_menus where store_id = '${FOLLOWME_STORE}' and kind = 'main'`);
      psql(`insert into public.store_pages (store_id, kind, slug, title, body, published) values ('${FOLLOWME_STORE}', 'page', 'how-to-order', 'איך מזמינים', 'בקרוב.', false);
        update public.store_menus set items = items || '[{"label": "איך מזמינים", "href": "/pages/how-to-order"}]' where store_id = '${FOLLOWME_STORE}' and kind = 'main';`);
      try {
        const shopper = await raw('followme.test', '/');
        assert.match(shopper.body, /אקולוגיות/, 'the links to what is on the site stay');
        assert.doesNotMatch(shopper.body, /איך מזמינים/, 'the link to a page not published is not in the menu');
        assert.equal((await raw('followme.test', '/pages/how-to-order')).status, 404, 'and the page itself is not shown');
        const token = makePreviewToken(FOLLOWME_STORE, SECRET, Date.now() / 1000 + 3600);
        const { ctx, page } = await phone();
        await page.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
        await page.locator('.nav-wide').getByRole('link', { name: 'איך מזמינים', includeHidden: true }).waitFor({ state: 'attached' });
        await ctx.close();
        psql(`update public.store_pages set published = true where store_id = '${FOLLOWME_STORE}' and slug = 'how-to-order';`);
        assert.match((await raw('followme.test', '/')).body, /איך מזמינים/, 'published: the link is back');
      } finally {
        psql(`update public.store_menus set items = '${before.replace(/'/g, "''")}' where store_id = '${FOLLOWME_STORE}' and kind = 'main';`);
      }
    });

    await step('"לחץ לעריכה" (2.61): only the dashboard frames the editor; a click names what to edit, a title is edited in place', async () => {
      const token = makePreviewToken(FOLLOWME_STORE, SECRET, Date.now() / 1000 + 3600);
      const editUrl = url('followme.test', `/?edit=${encodeURIComponent(token)}`);
      const direct = await raw('followme.test', `/?edit=${encodeURIComponent(token)}`);
      assert.equal(direct.status, 200);
      assert.match(String(direct.headers['content-security-policy']), new RegExp(`frame-ancestors http://127\\.0\\.0\\.1:${DASH_PORT}`));
      assert.match(direct.body, /data-edit-section="hero"/);
      assert.equal(direct.headers['set-cookie'], undefined, 'no preview cookie: the token stays in the address');
      const shopper = await raw('followme.test', '/');
      assert.doesNotMatch(shopper.body, /data-edit-/, 'a shopper\'s page has no edit marks');
      assert.match(String(shopper.headers['content-security-policy']), /frame-ancestors 'none'/);
      const forged = await raw('followme.test', '/?edit=x');
      assert.doesNotMatch(forged.body, /data-edit-/);

      const { ctx, page } = await phone(800);
      await page.goto(`http://127.0.0.1:${DASH_PORT}/frame?src=${encodeURIComponent(editUrl)}`);
      const frame = page.frameLocator('#f');
      await frame.locator('[data-edit-section="hero"]').waitFor();
      const msgs = async () => (await page.evaluate(() => (window as any).msgs)) as { origin: string; data: any }[];
      await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.data?.type === 'ready'));
      assert.ok((await msgs()).every((m) => m.origin === 'http://followme.test:' + PORT), 'the messages come from the store');
      // a section: named to the dashboard
      await frame.locator('[data-edit-section="steps"] .step').first().click();
      await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.data?.type === 'field' && m.data.section === 'steps'));
      // the hero's title: edited in place, sent when done
      const title = frame.locator('[data-edit-section="hero"] [data-edit-field="title"]');
      await title.click();
      await page.keyboard.press('End');
      await page.keyboard.type(' חדש');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.data?.type === 'text'));
      const text = (await msgs()).find((m) => m.data.type === 'text')!.data;
      assert.equal(text.section, 'hero'); assert.equal(text.field, 'title'); assert.match(text.value, / חדש$/);
      // a link to another page of the store: the dashboard is asked to go there, the frame stays
      await frame.locator('footer a[href^="/collections/"]').first().click();
      await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.data?.type === 'navigate'));
      assert.match((await msgs()).find((m) => m.data.type === 'navigate')!.data.path, /^\/collections\//);
      // the menus and the business's details: the dashboard opens their editors
      await frame.locator('footer .legal').click();
      await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.data?.type === 'open' && m.data.target === 'settings'));
      await page.screenshot({ path: path.join(SHOTS, 'edit-frame.png') });
      await ctx.close();
    });

    await step('the owner previews the draft theme of a store on the air; the shoppers keep the published one', async () => {
      const token = makePreviewToken(FOLLOWME_STORE, SECRET, Date.now() / 1000 + 3600);
      const { ctx, page } = await phone();
      await page.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
      await page.getByRole('heading', { level: 1, name: 'טיוטה חדשה' }).waitFor();
      await page.goto(url('followme.test', '/?preview=off'));
      await page.getByRole('heading', { level: 1, name: 'שקיות FollowMe' }).waitFor();
      await ctx.close();
      assert.match((await raw('followme.test', '/')).body, /שקיות FollowMe/);
    });

    await step('a domain is "active" in the dashboard only after the storefront served it', async () => {
      await new Promise((r) => setTimeout(r, 500));
      const rows = psql(`select domain || ':' || status || ':' || (last_seen_at is not null) from public.store_domains order by domain`);
      assert.match(rows, /^draft\.test:active:true$/m, 'draft.test was served: active');
      assert.match(rows, /^followme\.test:active:true$/m);
    });

    // ---- stage 3: buying (test) ----------------------------------------------------------------------------------------------
    const TOTE = 'aaaaaaaa-0000-4000-8000-000000000101', S_BLACK = 'aaaaaaaa-0000-4000-8000-000000000111', M_BLACK = 'aaaaaaaa-0000-4000-8000-000000000113';
    const setCart = (page: any, variant: string, qty: number) => page.evaluate(([item, v, q]: [string, string, number]) =>
      fetch('/api/cart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', item, variant: v, qty: q }) }).then((r) => r.json()),
      [TOTE, variant, qty]);
    async function payPage(page: any, how: 'pickup' | 'delivery' = 'pickup') {
      await page.goto(url('followme.test', '/checkout'));
      await page.getByRole('heading', { level: 1, name: 'פרטים ותשלום' }).waitFor();
      await page.getByLabel('שם מלא').fill('דנה כהן');
      await page.getByLabel('טלפון').fill('050-1234567');
      await page.getByLabel('אימייל').fill('dana@example.com');
      await page.getByRole('radio', { name: how === 'pickup' ? /איסוף עצמי/ : /משלוח/ }).check();
      if (how === 'delivery') {
        await page.getByLabel('עיר').fill('תל אביב'); await page.getByLabel('רחוב').fill('הרצל'); await page.getByLabel('מספר בית').fill('5');
      }
      await page.getByRole('checkbox', { name: /קראתי ואני מאשר/ }).check();
      await page.getByRole('button', { name: /לתשלום מאובטח/ }).click();
      await page.waitForURL(/\/pay-mock\/mp_/);
      return new URL(page.url()).pathname.split('/').pop() as string;
    }
    const lastOrder = () => psql(`select id || '|' || provider_page || '|' || payment_status from public.orders where store_id = '${FOLLOWME_STORE}' order by created_at desc limit 1`).split('|');

    await step('buying (test): to the cart, a coupon, the details, the provider\'s page, back — "ההזמנה התקבלה", and no sale', async () => {
      const { ctx, page } = await phone();
      await page.goto(url('followme.test', '/products/tote-bag'));
      await page.getByRole('button', { name: 'S', exact: true }).click();
      await page.getByRole('button', { name: 'שחור', exact: true }).click();
      await page.getByRole('button', { name: 'הוספה לסל' }).click();
      await page.getByRole('status').filter({ hasText: 'נוסף לסל' }).waitFor();
      await page.getByRole('link', { name: 'סל הקניות, 1 פריטים' }).waitFor();
      // a price sent by the browser is ignored: the cart's sums are the database's
      const forged = await page.evaluate(([item, v]: [string, string]) => fetch('/api/cart', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', item, variant: v, qty: 1, price: 1, total: 1 }) }).then((r) => r.json()), [TOTE, S_BLACK]);
      assert.equal(forged.cart.subtotal, 40, '2 × 20, whatever the browser said');
      await page.goto(url('followme.test', '/cart'));
      await page.getByRole('heading', { level: 1, name: 'סל הקניות' }).waitFor();
      assert.equal(await page.locator('.cart-line').count(), 1);
      assert.equal(await page.locator('.stepper output').innerText(), '2');
      await page.getByLabel('קוד קופון').fill('nope');
      await page.getByRole('button', { name: 'החלה' }).click();
      await page.getByText('הקופון הזה לא קיים.').first().waitFor();
      await page.getByLabel('קוד קופון').fill('welcome10');
      await page.getByRole('button', { name: 'החלה' }).click();
      await page.getByText('הקופון WELCOME10 הוחל').waitFor();
      assert.match(await page.locator('.sums').innerText(), /הנחה\s*−\D*4\D/);
      await page.screenshot({ path: path.join(SHOTS, 'cart-390.png'), fullPage: true });
      await page.getByRole('link', { name: 'להמשך לתשלום' }).click();
      await page.getByRole('heading', { level: 1, name: 'פרטים ותשלום' }).waitFor();
      // nothing filled in: every field says what to fix, and nothing is held
      await page.getByRole('button', { name: /לתשלום מאובטח/ }).click();
      await page.getByRole('alert').filter({ hasText: 'יש פרטים שצריך לתקן.' }).waitFor();
      assert.ok((await page.locator('[aria-invalid="true"]').count()) >= 4, 'name, phone, email, terms');
      assert.equal(psql(`select count(*) from public.orders where store_id = '${FOLLOWME_STORE}'`), '0');
      await page.screenshot({ path: path.join(SHOTS, 'checkout-errors-390.png'), fullPage: true });
      await page.getByLabel('שם מלא').fill('דנה כהן');
      await page.getByLabel('טלפון').fill('050-1234567');
      await page.getByLabel('אימייל').fill('dana@example.com');
      await page.getByRole('radio', { name: /משלוח/ }).check();
      await page.getByLabel('עיר').fill('תל אביב'); await page.getByLabel('רחוב').fill('הרצל'); await page.getByLabel('מספר בית').fill('5');
      await page.getByRole('checkbox', { name: /קראתי ואני מאשר/ }).check();
      assert.match(await page.locator('.sum-total').innerText(), /66/, '40 − 4 + 30 for delivery (free only above 100)');
      await page.getByRole('button', { name: /לתשלום מאובטח/ }).click();
      await page.waitForURL(/\/pay-mock\/mp_/);
      await page.getByRole('heading', { level: 1, name: 'תשלום לבדיקה' }).waitFor();
      assert.match(await text(page), /66/);
      assert.equal(psql(`select sum(qty) || ':' || min(status) from public.stock_reservations where variant_id = '${S_BLACK}'`), '2:held', 'the two are held while paying');
      await page.getByRole('button', { name: 'אישור התשלום' }).click();
      await page.waitForURL(/\/checkout\/return\?o=/);
      await page.getByRole('heading', { level: 1, name: 'ההזמנה התקבלה' }).waitFor();
      assert.match(await text(page), /זו הזמנת בדיקה: לא חויב כסף/);
      await page.screenshot({ path: path.join(SHOTS, 'order-390.png'), fullPage: true });
      assert.equal(psql(`select payment_status || ':' || total || ':' || discount || ':' || shipping || ':' || is_test from public.orders where store_id = '${FOLLOWME_STORE}'`),
        'test_paid:66.00:4.00:30.00:true');
      assert.equal(psql(`select count(*) from public.sales`), '0', 'a test order makes no sale');
      assert.equal(psql(`select count(*) from public.stock_movements`), '0', 'and moves no stock');
      assert.equal(psql(`select stock_qty from public.catalog_variants where id = '${S_BLACK}'`), '5');
      assert.equal(psql(`select count(*) from public.stock_reservations where status = 'held'`), '0', 'the hold is released');
      await page.goto(url('followme.test', '/cart'));
      await page.getByText('הסל ריק.').waitFor();
      await page.getByRole('link', { name: 'סל הקניות' }).waitFor();
      await ctx.close();
    });

    await step('the last units: held for the one who pays; the other is told — and gets them when that payment fails', async () => {
      const a = await phone(), b = await phone();
      for (const p of [a.page, b.page]) await p.goto(url('followme.test', `/products/tote-bag?variant=${M_BLACK}`));
      assert.equal((await setCart(a.page, M_BLACK, 2)).ok, true, 'A: both M / שחור');
      await b.page.getByRole('button', { name: 'הוספה לסל' }).click();
      await b.page.getByRole('status').filter({ hasText: 'נוסף לסל' }).waitFor();
      await payPage(a.page);                                      // A is on the payment page: the two are held for A
      await b.page.reload();
      assert.equal(await b.page.getByRole('button', { name: 'אזל המלאי' }).isDisabled(), true, 'the site shows them sold out');
      await b.page.goto(url('followme.test', '/cart'));
      await b.page.getByText('אזל מהמלאי — הסירו אותו מהסל.').waitFor();
      assert.equal(await b.page.getByRole('button', { name: 'יש בסל מוצרים שצריך לעדכן' }).isDisabled(), true);
      const blocked = await b.page.evaluate(() => fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'בני', phone: '0521111111', email: 'b@example.com', method: 'pickup', terms: true }) }).then((r) => r.json()));
      assert.equal(blocked.error, 'stock', 'B cannot pay for them either');
      await a.page.getByRole('button', { name: 'סירוב' }).click();
      await a.page.getByRole('heading', { level: 1, name: 'התשלום לא הושלם' }).waitFor();
      await b.page.reload();
      await b.page.getByRole('link', { name: 'להמשך לתשלום' }).waitFor();
      assert.equal(await b.page.getByText('אזל מהמלאי').count(), 0, 'released: B can have them');
      assert.equal(psql(`select payment_status from public.orders where store_id = '${FOLLOWME_STORE}' order by created_at desc limit 1`), 'failed');
      await a.ctx.close(); await b.ctx.close();
    });

    await step('payment notices: a forged one is refused, a repeat changes nothing, only the provider\'s answer marks paid', async () => {
      const { ctx, page } = await phone();
      await page.goto(url('followme.test', '/products/tote-bag'));
      assert.equal((await setCart(page, S_BLACK, 1)).ok, true);
      const mockPage = await payPage(page);
      const [id, pageId, status] = lastOrder();
      assert.equal(pageId, mockPage); assert.equal(status, 'pending');
      const notice = (extra: Record<string, unknown> = {}) => JSON.stringify({ transaction: { payment_page_request_uid: pageId, more_info: id, status_code: '000', ...extra } });
      const sign = (b: string) => createHmac('sha256', MOCK_KEYS.secret_key).update(b).digest('base64');
      const forged = notice();
      assert.equal((await rawPost('followme.test', '/api/pay/mock/webhook', forged, { hash: 'AAAA', 'user-agent': 'PayPlus' })).status, 401);
      assert.equal(lastOrder()[2], 'pending', 'a forged notice changes nothing');
      const early = notice({ n: 1 });
      assert.equal((await rawPost('followme.test', '/api/pay/mock/webhook', early, { hash: sign(early), 'user-agent': 'PayPlus' })).status, 200);
      assert.equal(lastOrder()[2], 'pending', 'a signed notice, but the provider says it is not paid: nothing changes');
      // the shopper pays on the provider's page (its own notice cannot reach this machine's test names: sent here by hand)
      assert.equal((await rawPost('followme.test', `/api/pay-mock/${pageId}?a=approve`, '')).status, 303);
      const paid = notice({ n: 2 });
      for (let i = 0; i < 3; i++) {
        assert.equal((await rawPost('followme.test', '/api/pay/mock/webhook', paid, { hash: sign(paid), 'user-agent': 'PayPlus' })).status, 200);
      }
      assert.equal(lastOrder()[2], 'test_paid');
      assert.equal(psql(`select count(*) from public.order_events where order_id = '${id}' and kind = 'test_paid'`), '1', 'three copies, one payment');
      assert.equal(psql(`select count(*) from public.payment_events where order_id = '${id}' and kind = 'callback'`), '3', 'forged, early, paid — each logged once');
      assert.equal((await rawPost('shoes.test', '/api/pay/mock/webhook', paid, { hash: sign(paid), 'user-agent': 'PayPlus' })).status, 404, 'another store\'s address');
      const cross = await rawPost('followme.test', '/api/cart', JSON.stringify({ action: 'add', item: TOTE, variant: S_BLACK, qty: 1 }), { origin: 'https://evil.test' });
      assert.equal(cross.status, 403, 'a form of another site cannot fill a cart');
      await ctx.close();
    });

    await step('the cron asks the provider about an order nobody confirmed (the shopper closed the tab)', async () => {
      const { ctx, page } = await phone();
      await page.goto(url('followme.test', '/products/tote-bag'));
      assert.equal((await setCart(page, S_BLACK, 1)).ok, true);
      const pageId = await payPage(page);
      await ctx.close();                                          // paid on the provider's page, never came back
      assert.equal((await rawPost('followme.test', `/api/pay-mock/${pageId}?a=approve`, '')).status, 303);
      const [id] = lastOrder();
      psql(`update public.orders set created_at = now() - interval '11 minutes' where id = '${id}'`);
      assert.equal((await rawPost('platform.test', '/api/cron/payments', '{}', { 'x-cron-secret': 'wrong-secret-0123456789' })).status, 401);
      const r = await rawPost('platform.test', '/api/cron/payments', '{}', { 'x-cron-secret': CRON });
      assert.equal(r.status, 200);
      assert.ok(JSON.parse(r.body).asked >= 1);
      assert.equal(psql(`select payment_status from public.orders where id = '${id}'`), 'test_paid');
      assert.equal(psql(`select count(*) from public.payment_events where order_id = '${id}' and kind = 'poll'`), '1');
    });

    await step('a real order (the platform\'s switch on): the dashboard is told, the sale recorded; the order page, its PDF, a request, /cancel', async () => {
      const BIZ = 'aaaaaaaa-0000-4000-8000-00000000000a', OWNER = 'aaaaaaaa-0000-4000-8000-0000000000f1';
      psql(`update public.platform_flags set enabled = true where key = 'commerce_live';
            update public.payment_accounts set mode = 'live' where business_id = '${BIZ}';`);
      try {
        const { ctx, page } = await phone();
        await page.goto(url('followme.test', '/products/tote-bag'));
        const before = Number(psql(`select stock_qty from public.catalog_variants where id = '${M_BLACK}'`));
        assert.equal((await setCart(page, M_BLACK, 1)).ok, true);
        await payPage(page);
        await page.getByRole('button', { name: 'אישור התשלום' }).click();
        await page.waitForURL(/\/checkout\/return\?o=/);
        await page.getByRole('heading', { level: 1, name: 'ההזמנה התקבלה' }).waitFor();
        assert.doesNotMatch(await text(page), /הזמנת בדיקה/, 'a real order says nothing of a test');
        const token = new URL(page.url()).searchParams.get('o')!;
        const [id] = lastOrder();
        assert.equal(psql(`select is_test || ':' || payment_status from public.orders where id = '${id}'`), 'false:paid');
        // told after the answer went out: the "dashboard" recorded the sale (stock down, a customer)
        for (let i = 0; i < 100 && !finalized.includes(id); i++) await new Promise((r) => setTimeout(r, 100));
        assert.ok(finalized.includes(id), 'the dashboard was told');
        assert.equal(psql(`select channel || ':' || status || ':' || (lead_id is not null) from public.sales where id = '${id}'`), 'online:paid:true');
        assert.equal(Number(psql(`select stock_qty from public.catalog_variants where id = '${M_BLACK}'`)), before - 1, 'the sale took the unit');
        // the customer's page: what happens now; the document comes later
        await page.getByRole('link', { name: 'לעמוד ההזמנה' }).click();
        await page.waitForURL(/\/orders\//);
        await page.getByText('ההזמנה התקבלה ומחכה לטיפול.').waitFor();
        await page.getByText('החשבונית תופיע כאן בקרוב.').waitFor();
        await page.screenshot({ path: path.join(SHOTS, 'order-page-390.png'), fullPage: true });
        // the dashboard issued it (a fixture: the document's own checks are the SQL tests'), shipped it with tracking
        psql(`set session_replication_role = replica;
              insert into public.documents (id, user_id, business_id, doc_type, doc_number, doc_date, before_discount, after_discount, vat_amount, total, vat_rate, sale_id, share_token)
              values ('aaaaaaaa-0000-4000-8000-0000000d0c01', '${OWNER}', '${BIZ}', 320, 1, current_date, 21.19, 21.19, 3.81, 25, 18, '${id}', '${'ab'.repeat(32)}');
              set session_replication_role = origin;
              update public.orders set document_status = 'issued', document_id = 'aaaaaaaa-0000-4000-8000-0000000d0c01', fulfillment_status = 'shipped',
                tracking_number = 'RR123IL', tracking_url = 'https://track.example/RR123IL' where id = '${id}';`);
        await page.reload();
        await page.getByText('ההזמנה נשלחה.').waitFor();
        await page.getByText('RR123IL').first().waitFor();
        assert.equal(await page.getByRole('link', { name: 'המסמך של ההזמנה (PDF)' }).getAttribute('href'), `/orders/${token}/document`);
        const pdf = await raw('followme.test', `/orders/${token}/document`);
        assert.equal(pdf.status, 200);
        assert.match(String(pdf.headers['content-type']), /application\/pdf/);
        assert.match(pdf.body, /^%PDF/);
        assert.ok(!pdf.headers['x-served-by'] && !/127\.0\.0\.1/.test(JSON.stringify(pdf.headers)), 'nothing of the dashboard reaches the customer');
        assert.equal((await raw('followme.test', '/orders/nope/document')).status, 404);
        // the signed link of an email opens the same page; one wrong character does not
        const ref = orderRef(id, LINK)!;
        assert.equal((await raw('followme.test', `/orders/${ref}`)).status, 200);
        assert.equal((await raw('followme.test', `/orders/${ref.slice(0, -1)}${ref.endsWith('x') ? 'y' : 'x'}`)).status, 404);
        assert.equal((await raw('shoes.test', `/orders/${ref}`)).status, 404, 'never through another store');
        // a request to cancel: recorded, told to the owner, no money moved
        await page.getByRole('radio', { name: 'ביטול ההזמנה' }).check();
        await page.getByLabel('פרטים (לא חובה)').fill('הזמנתי בטעות');
        await page.getByRole('button', { name: 'שליחת הבקשה' }).click();
        await page.getByText('בקשת הביטול התקבלה').waitFor();
        assert.equal(psql(`select request_kind || ':' || payment_status from public.orders where id = '${id}'`), 'cancel:paid');
        assert.equal(psql(`select count(*) from public.store_alerts where order_id = '${id}' and kind = 'request'`), '1');
        // /cancel from the footer: the number and the email of the order
        const num = psql(`select number from public.orders where id = '${id}'`);
        await page.goto(url('followme.test', '/'));
        await page.getByRole('contentinfo').getByRole('link', { name: 'ביטול עסקה' }).click();
        await page.getByRole('heading', { level: 1, name: 'ביטול עסקה' }).waitFor();
        await page.getByLabel('מספר הזמנה').fill(num);
        await page.getByLabel('האימייל שאיתו הזמנתם').fill('someone@example.com');
        await page.getByRole('button', { name: 'שליחת הבקשה' }).click();
        await page.getByRole('alert').filter({ hasText: 'לא מצאנו הזמנה' }).waitFor();
        await page.getByLabel('האימייל שאיתו הזמנתם').fill('Dana@Example.com');
        await page.getByRole('button', { name: 'שליחת הבקשה' }).click();
        await page.getByRole('alert').filter({ hasText: 'כבר התקבלה בקשה' }).waitFor();
        await page.screenshot({ path: path.join(SHOTS, 'cancel-390.png'), fullPage: true });
        await ctx.close();
      } finally {
        psql(`update public.platform_flags set enabled = false where key = 'commerce_live';
              update public.payment_accounts set mode = 'test' where business_id = '${BIZ}';`);
      }
    });

    await step('every store\'s own address: <slug>.stores.test — routing, isolation, and a 308 to its own domain once that works', async () => {
      assert.equal(psql(`select string_agg(slug, ',' order by slug) from public.stores`), 'draft,followme,shoes', 'made from the businesses\' names');
      // FollowMe's own domain works (followme.test is active): the subdomain redirects there, with the path, permanently
      const moved = await raw('followme.stores.test', '/products/tote-bag?variant=x');
      assert.equal(moved.status, 308);
      assert.equal(moved.headers.location, 'https://followme.test/products/tote-bag?variant=x');
      // before its own domain works, the subdomain is the store's address: served, canonical to itself, open to crawlers
      psql(`update public.store_domains set status = 'pending' where domain in ('followme.test', 'www.followme.test')`);
      try {
        const home = await raw('followme.stores.test', '/');
        assert.equal(home.status, 200);
        assert.match(home.body, /FollowMe Collection/);
        assert.match(home.body, new RegExp(`<link rel="canonical" href="http://followme\\.stores\\.test:${PORT}"`));
        assert.doesNotMatch(home.body, /noindex/);
        assert.match((await raw('followme.stores.test', '/robots.txt')).body, /Allow: \/\n/);
        assert.equal(psql(`select subdomain_seen_at is not null from public.stores where slug = 'followme'`), 't', 'served: a working address');
      } finally {
        psql(`update public.store_domains set status = 'active' where domain in ('followme.test', 'www.followme.test')`);
      }
      // each address its own store; an unknown one, the root and www are nobody's
      const shoes = await raw('shoes.stores.test', '/');
      assert.equal(shoes.status, 308, 'Shoes has its own working domain too');
      assert.equal(shoes.headers.location, 'https://shoes.test/');
      assert.equal((await raw('nobody.stores.test', '/')).status, 404);
      assert.doesNotMatch((await raw('nobody.stores.test', '/')).body, /FollowMe|Shoes/);
      assert.equal((await raw('stores.test', '/')).status, 404);
      assert.equal((await raw('www.stores.test', '/')).status, 404);
      assert.equal((await raw('a.b.stores.test', '/')).status, 404);
    });

    await step('a password: "בקרוב" for everyone, the store for whoever has the link and the password — never indexed', async () => {
      // the draft's own domain was served earlier (so its subdomain would redirect there): here, before it works
      const draftDomains = psql(`select string_agg(domain || '=' || status, ',') from public.store_domains where store_id = '${DRAFT_STORE}'`);
      psql(`update public.store_domains set status = 'pending' where store_id = '${DRAFT_STORE}'`);
      try {
      const password = psql(`select storefront_password from public.stores where id = '${DRAFT_STORE}'`);
      assert.match(password, /^[0-9a-z]{10}$/, 'a new store gets a password');
      const soon = await raw('draft.stores.test', '/');
      assert.equal(soon.status, 200);
      assert.match(soon.body, /בקרוב/);
      assert.match(soon.body, /noindex/);
      assert.doesNotMatch(soon.body, /מוצר טיוטה/);
      assert.match((await raw('draft.stores.test', '/robots.txt')).body, /Disallow: \/\n/);
      assert.equal((await raw('draft.stores.test', '/sitemap.xml')).status, 404);
      const { ctx, page } = await phone();
      await page.goto(url('draft.stores.test', '/collections/all'));
      await page.getByRole('heading', { level: 1, name: 'בקרוב' }).waitFor();
      await page.getByLabel('יש לכם סיסמה? כניסה לאתר').fill('wrong-password');
      await page.getByRole('button', { name: 'כניסה' }).click();
      await page.getByRole('alert').filter({ hasText: 'הסיסמה לא נכונה.' }).waitFor();
      await page.getByLabel('יש לכם סיסמה? כניסה לאתר').fill(password);
      await page.getByRole('button', { name: 'כניסה' }).click();
      await page.getByRole('status').filter({ hasText: 'נכנסתם עם סיסמה' }).waitFor();
      assert.deepEqual(await page.locator('.grid .card-name').allInnerTexts(), ['מוצר טיוטה'], 'the draft opens behind the password');
      assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex, nofollow', 'and is still not indexed');
      assert.equal(await page.getByRole('status').filter({ hasText: 'תצוגה מקדימה' }).count(), 0, 'not the owner\'s preview');
      const cookie = (await ctx.cookies()).find((c: any) => c.name === 'sf_access');
      assert.ok(cookie && cookie.httpOnly && cookie.domain.includes('draft.stores.test'), 'an httpOnly cookie of this address only');
      await page.screenshot({ path: path.join(SHOTS, 'password-unlocked-390.png'), fullPage: true });
      // the cookie of one store opens no other, even with its value copied
      const other = await raw('shoes.test', '/', { cookie: `sf_access=${cookie.value}` });
      assert.equal(other.status, 200);
      // a new password signs everyone out
      psql(`update public.stores set storefront_password = 'brand-new-1' where id = '${DRAFT_STORE}'`);
      await page.reload();
      await page.getByRole('heading', { level: 1, name: 'בקרוב' }).waitFor();
      // ten wrong tries, then a pause (the database counts)
      let limited = 0;
      for (let i = 0; i < 12; i++) {
        const r = await rawPost('draft.stores.test', '/api/unlock', JSON.stringify({ password: 'nope' }), { origin: `http://draft.stores.test:${PORT}` });
        if (r.status === 429) limited++;
      }
      assert.ok(limited >= 1, 'too many tries are refused');
      await ctx.close();
      // no password: closed to everyone (the owner's preview link still opens it — the step of "בקרוב" above)
      psql(`update public.stores set storefront_password = '' where id = '${DRAFT_STORE}'`);
      const closed = await raw('draft.stores.test', '/');
      assert.match(closed.body, /בקרוב/);
      assert.doesNotMatch(closed.body, /יש לכם סיסמה/);
      psql(`update public.stores set storefront_password = 'brand-new-1' where id = '${DRAFT_STORE}'`);
      // a published store its owner locked: "בקרוב" and noindex at its own domain too, until the password
      psql(`update public.stores set password_lock = true where slug = 'shoes'`);
      try {
        const locked = await raw('shoes.test', '/');
        assert.match(locked.body, /בקרוב/);
        assert.match(locked.body, /noindex/);
        assert.match((await raw('shoes.test', '/robots.txt')).body, /Disallow: \/\n/);
      } finally {
        psql(`update public.stores set password_lock = false where slug = 'shoes'`);
      }
      assert.doesNotMatch((await raw('shoes.test', '/')).body, /noindex/, 'unlocked: open again');
      } finally {
        for (const x of (draftDomains || '').split(',').filter(Boolean)) {
          const [d, st] = x.split('=');
          psql(`update public.store_domains set status = '${st}' where domain = '${d}'`);
        }
      }
    });

    await step('no domain at all: the storefront\'s own address + /s/<slug> opens the store (password before publishing, 308 once its domain works)', async () => {
      // the draft (its own domain not working): "בקרוב" with the password, then the store — noindex, robots closed
      psql(`update public.store_domains set status = 'pending' where store_id = '${DRAFT_STORE}'`);
      psql(`update public.stores set storefront_password = 'platform-pass' where id = '${DRAFT_STORE}'`);
      psql(`delete from public.rate_limits where key like 'unlock:%'`);   // the step above used up this visitor's tries
      try {
        const { ctx, page } = await phone();
        await page.goto(url('platform.test', '/s/draft'));
        assert.equal(new URL(page.url()).pathname, '/', 'the address chose the store, every link stays plain');
        await page.getByRole('heading', { level: 1, name: 'בקרוב' }).waitFor();
        await page.getByLabel('יש לכם סיסמה? כניסה לאתר').fill('platform-pass');
        await page.getByRole('button', { name: 'כניסה' }).click();
        await page.getByRole('status').filter({ hasText: 'נכנסתם עם סיסמה' }).waitFor();
        await page.goto(url('platform.test', '/collections/all'));
        assert.deepEqual(await page.locator('.grid .card-name').allInnerTexts(), ['מוצר טיוטה']);
        assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex, nofollow');
        assert.match(await page.evaluate(() => fetch('/robots.txt').then((r) => r.text())), /Disallow: \/\n/);
        await page.screenshot({ path: path.join(SHOTS, 'platform-address-390.png'), fullPage: true });
        // another /s/… switches the store; FollowMe's own domain works → it goes there (308)
        const moved = await raw('platform.test', '/', { cookie: 'sf_store=followme' });
        assert.equal(moved.status, 308);
        assert.equal(moved.headers.location, 'https://followme.test/');
        await ctx.close();
      } finally {
        psql(`update public.store_domains set status = 'active' where store_id = '${DRAFT_STORE}'`);
      }
      // only the storefront's own address; an unknown address or a store's domain: 404
      assert.equal((await raw('platform.test', '/s/nobody-here')).status, 404);
      assert.equal((await raw('followme.test', '/s/draft')).status, 404);
      assert.equal((await raw('platform.test', '/s/ab')).status, 404);
    });

    await step('phones 375 / 390 / 430 and a desktop: nothing sideways', async () => {
      for (const width of [375, 390, 430, 1280]) {
        const { ctx, page } = await phone(width);
        for (const p of ['/', '/products/tote-bag', '/collections/all', '/policies/returns', '/cart']) {
          await page.goto(url('followme.test', p));
          const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
          assert.ok(sw <= iw, `${p} at ${width}: ${sw} > ${iw}`);
        }
        if (width === 1280) await page.goto(url('followme.test', '/')).then(() => page.screenshot({ path: path.join(SHOTS, 'home-1280.png'), fullPage: true }));
        await ctx.close();
      }
    });

    await step('keyboard: "דלגו לתוכן" first, the menu opens, focus is visible', async () => {
      const { ctx, page } = await phone();
      await page.goto(url('followme.test', '/'));
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'דלגו לתוכן');
      await page.locator('summary[aria-label="פתיחת התפריט"]').click();
      await page.getByRole('navigation', { name: 'תפריט ראשי' }).getByRole('link', { name: 'כל השקיות' }).waitFor();
      await ctx.close();
    });

    await step('no errors in the browser (CSP included)', async () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
    dashboard.close();
    try { process.kill(-server.pid!, 'SIGTERM'); } catch { /* gone */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`# e2e storefront: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
