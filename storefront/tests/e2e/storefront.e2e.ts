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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { makePreviewToken, makeRevalidateToken } from '../../src/lib/preview';
import { money } from '../../src/lib/format';
import { sealKeys } from '../../src/lib/seal';
import { orderRef } from '../../src/lib/order-link';
import { LIBRARY } from '../../src/lib/builder-registry';

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
/** visual regression (2.72): the share of a picture's pixels that may change clearly before it fails */
const VISUAL_MAX = 0.004;
const visualRatios: [string, number][] = [];
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

/**
 * 2.74: what the dashboard does after a change the shoppers see (its /api/store/revalidate) — the storefront drops what it
 * keeps of every store (shared-cache.ts). The steps below that write to the database directly call it after each write.
 */
async function refreshAll() {
  for (const id of psql(`select coalesce(string_agg(id::text, ','), '') from public.stores`).split(',').filter(Boolean)) {
    const r = await rawPost('platform.test', '/api/revalidate', JSON.stringify({ token: makeRevalidateToken(id, SECRET, Date.now() / 1000 + 60) }));
    assert.equal(r.status, 200, `refresh ${id}`);
  }
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
  const paylinksTold: string[] = [];   // 2.88: "a payment link was paid" (the dashboard's /api/finance/paylinks/finalize)
  const dashboard = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/finance/paylinks/finalize' && req.headers['x-commerce-secret'] === COMMERCE) {
        paylinksTold.push(String(JSON.parse(body || '{}').requestId ?? ''));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return;
      }
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
  // 2.74: what the storefront keeps (shared-cache.ts) lives in .next/cache — never from an earlier run (the same ids)
  rmSync(path.join(ROOT, '.next/cache/fetch-cache'), { recursive: true, force: true });
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
      await refreshAll();
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
        await refreshAll();
        assert.match((await raw('followme.test', '/')).body, /איך מזמינים/, 'published: the link is back');
      } finally {
        psql(`update public.store_menus set items = '${before.replace(/'/g, "''")}' where store_id = '${FOLLOWME_STORE}' and kind = 'main';`);
        await refreshAll();
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

      // 2.65 (PR-3a): no reload — the dashboard's "move" / "remove" / "rerender", and a drag on the page that only says where
      const post = (m: unknown) => page.evaluate((msg: unknown) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage(msg, '*'), m);
      const order = () => frame.locator('main > [data-edit-section]').evaluateAll((els: Element[]) => els.map((e: Element) => (e as HTMLElement).dataset.editSection));
      await frame.locator('body').evaluate(() => { (window as any).stayed = true; });   // gone if the page loads again
      const stayed = () => frame.locator('body').evaluate(() => (window as any).stayed === true);
      const first = await order();
      const last = first[first.length - 1]!;
      await post({ type: 'move', id: last, to: 0 });
      await frame.locator(`main > [data-edit-section]:first-of-type[data-edit-section="${last}"]`).waitFor();
      assert.deepEqual(await order(), [last, ...first.slice(0, -1)], 'moved at once');
      assert.ok(await stayed(), 'the same page');
      await post({ type: 'remove', id: last });
      await frame.locator(`[data-edit-section="${last}"]`).waitFor({ state: 'detached' });
      // a drag with the mouse: the handle of the chosen section, dropped at the top — the page names the place, moves nothing itself
      await frame.locator('[data-edit-section="steps"] .band-title').click();
      const handle = frame.locator('[data-edit-section="steps"] .edit-drag');
      await handle.waitFor();
      const box = (await handle.boundingBox())!;
      const top = (await frame.locator('main > [data-edit-section]').first().boundingBox())!;
      const before = await order();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 10, top.y + 5, { steps: 12 });
      assert.equal(await frame.locator('.edit-drop-line').count(), 1, 'a line shows where it will land');
      await page.mouse.up();
      await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.data?.type === 'drop' && m.data.id === 'steps'));
      const drop = (await msgs()).find((m) => m.data.type === 'drop')!.data;
      assert.equal(drop.to, 0, 'dropped first');
      assert.deepEqual(await order(), before, 'the page waits for the dashboard');
      // the dashboard saved a draft: the page fetches itself and swaps its content — the new text, no new page
      const DRAFT = 'aaaaaaaa-0000-4000-8000-000000000142';
      const was = psql(`select settings::text from public.store_theme_versions where id = '${DRAFT}'`);
      try {
        psql(`update public.store_theme_versions set settings = jsonb_set(settings, '{sections,0,settings,title}', '"כותרת שנשמרה עכשיו"') where id = '${DRAFT}'`);
        await post({ type: 'rerender', rev: 1 });
        await frame.getByRole('heading', { level: 1, name: 'כותרת שנשמרה עכשיו' }).waitFor();
        assert.ok(await stayed(), 'swapped in place, not loaded again');
      } finally {
        psql(`update public.store_theme_versions set settings = '${was.replace(/'/g, "''")}' where id = '${DRAFT}'`);
      }
      // a message from anyone else: nothing
      await frame.locator('body').evaluate(() => window.postMessage({ type: 'remove', id: 'hero' }, '*'));
      await page.waitForTimeout(200);
      assert.equal(await frame.locator('[data-edit-section="hero"]').count(), 1, 'only the dashboard is heard');
      await ctx.close();
    });

    await step('devices and live design (2.66): "style" at once (checked by the page); a section hidden on a phone; the kit\'s second hero picture', async () => {
      const DRAFT = 'aaaaaaaa-0000-4000-8000-000000000142';
      const was = psql(`select template || '|' || settings::text from public.store_theme_versions where id = '${DRAFT}'`);
      const kit = JSON.parse(readFileSync(path.resolve(ROOT, '../dream-promotion/kits/fashion.json'), 'utf8'));
      const { design: _d, chrome: _c, commerceDesign: _m, ...theme } = kit.theme;
      const settings = JSON.parse(JSON.stringify({ kit: 'fashion', ...theme }).split('{{name}}').join('FollowMe'));
      settings.sections = settings.sections.map(({ variant: _v, ...x }: any) => (x.id === 'hero' ? { ...x, settings: { ...x.settings, kitImage: 2 } }
        : x.id === 'story' ? { ...x, hiddenOn: ['base'] } : x));
      psql(`update public.store_theme_versions set template = 'kit', settings = '${JSON.stringify(settings).replace(/'/g, "''")}' where id = '${DRAFT}'`);
      try {
        const token = makePreviewToken(FOLLOWME_STORE, SECRET, Date.now() / 1000 + 3600);
        const { ctx, page } = await phone();
        await page.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
        assert.equal(await page.locator('.hero-media img').first().getAttribute('src'), '/kit-images/fashion/fashion-hero-wide-2.webp', 'the kit\'s second wide picture');
        assert.equal(await page.locator('#story').isVisible(), false, 'hidden on a phone');
        await ctx.close();
        const desk = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        const dp = await desk.newPage();
        await dp.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
        assert.equal(await dp.locator('#story').isVisible(), true, 'shown on a computer');
        await desk.close();
        // the visual editor: "style" — the variables and the classes at once, and only valid ones
        const edit = await phone(800);
        await edit.page.goto(`http://127.0.0.1:${DASH_PORT}/frame?src=${encodeURIComponent(url('followme.test', `/?edit=${encodeURIComponent(token)}`))}`);
        const frame = edit.page.frameLocator('#f');
        await frame.locator('[data-edit-section="hero"]').waitFor();
        await edit.page.waitForFunction(() => (window as any).msgs.some((m: any) => m.data?.type === 'ready'));
        const post = (m: unknown) => edit.page.evaluate((msg: unknown) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage(msg, '*'), m);
        const colors = { background: '#ffffff', surface: '#ffffff', text: '#111111', muted: '#5c5c5c', primary: '#0a3d62', accent: '#b0413e', accentSoft: '#f6eeee', border: '#e6e6e6' };
        const classes = 'v-sp-compact v-hs-normal v-btn-solid v-ct-normal v-card-border v-h-compact v-f-dark v-pc-classic v-cc-grid v-pp-classic';
        await post({ type: 'style', colors, font: 'rubik', radius: 'none', classes });
        await frame.locator('body.v-h-compact.v-f-dark').waitFor();
        const vars = await frame.locator('html').evaluate((h: Element) => [getComputedStyle(h).getPropertyValue('--c-primary').trim(), getComputedStyle(h).getPropertyValue('--radius').trim()]);
        assert.deepEqual(vars, ['#0a3d62', '0'], 'the colour and the corners at once');
        await post({ type: 'style', colors: { ...colors, primary: 'red;}' }, font: 'rubik', radius: 'none', classes: 'evil v-h-<x>' });
        await edit.page.waitForTimeout(300);
        assert.equal(await frame.locator('html').evaluate((h: Element) => getComputedStyle(h).getPropertyValue('--c-primary').trim()), '#0a3d62', 'a bad value is not taken');
        assert.ok(!((await frame.locator('body').getAttribute('class')) ?? '').includes('evil'));
        await edit.ctx.close();
      } finally {
        const [tpl, ...rest] = was.split('|');
        psql(`update public.store_theme_versions set template = '${tpl}', settings = '${rest.join('|').replace(/'/g, "''")}' where id = '${DRAFT}'`);
      }
    });

    await step('a free section (2.67): columns side by side on a computer, one under the other on a phone; only checked values; a block click names the block', async () => {
      const DRAFT = 'aaaaaaaa-0000-4000-8000-000000000142';
      const was = psql(`select template || '|' || settings::text from public.store_theme_versions where id = '${DRAFT}'`);
      const settings = { sections: [
        { id: 'hero', type: 'hero', settings: { title: 'FollowMe' } },
        { id: 'free', type: 'custom', settings: {}, columns: [
          { id: 'c1', span: 8, blocks: [
            { id: 'b1', type: 'badge', settings: { text: 'חדש בחנות' } },
            { id: 'b2', type: 'heading', settings: { text: 'הסיפור שלנו', size: 'xl' } },
            { id: 'b3', type: 'paragraph', settings: { text: 'פסקה ראשונה.\n\nפסקה שנייה.' } },
            { id: 'b4', type: 'button', settings: { label: 'לכל המוצרים', href: '/collections/all', style: 'ghost' } },
            { id: 'b5', type: 'button', settings: { label: 'רע', href: 'javascript:alert(1)' } },
          ] },
          { id: 'c2', span: 4, blocks: [{ id: 'b6', type: 'image', settings: { image: '', alt: '' } }, { id: 'b7', type: 'script', settings: {} }] },
        ] },
      ] };
      psql(`update public.store_theme_versions set template = 'kit', settings = '${JSON.stringify(settings).replace(/'/g, "''")}' where id = '${DRAFT}'`);
      try {
        const token = makePreviewToken(FOLLOWME_STORE, SECRET, Date.now() / 1000 + 3600);
        const desk = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        const dp = await desk.newPage();
        await dp.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
        const free = dp.locator('#free');
        await free.getByRole('heading', { level: 2, name: 'הסיפור שלנו' }).waitFor();
        assert.equal(await free.locator('.blk-p p').count(), 2, 'a paragraph per empty line');
        assert.equal(await free.locator('.blk-tag').innerText(), 'חדש בחנות');
        const hrefs = await free.locator('a').evaluateAll((as: Element[]) => as.map((a) => a.getAttribute('href')));
        assert.deepEqual(hrefs, ['/collections/all', '/collections/all'], 'a bad link is the default — never javascript:');
        assert.equal(await free.locator('a.btn-ghost').count(), 1);
        assert.equal(await free.locator('.blk-img-empty').count(), 1, 'the owner sees where a picture will be');
        assert.equal(await free.locator('script, [data-edit-block]').count(), 0, 'no unknown block, no edit marks in a preview');
        const [a, b] = await Promise.all([free.locator('.blk-span-8').boundingBox(), free.locator('.blk-span-4').boundingBox()]);
        assert.ok(Math.abs(a!.y - b!.y) < 2 && a!.width > b!.width * 1.7, 'side by side, 8 and 4 of 12');
        assert.ok(a!.x > b!.x, 'the first column on the right (RTL)');
        await desk.close();
        const { ctx, page } = await phone();
        await page.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
        const [m1, m2] = await Promise.all([page.locator('#free .blk-span-8').boundingBox(), page.locator('#free .blk-span-4').boundingBox()]);
        assert.ok(m2!.y > m1!.y + m1!.height - 1 && Math.abs(m1!.width - m2!.width) < 2, 'one under the other on a phone');
        await ctx.close();
        // 2.70: a width for the phone — half and half, side by side; a computer its own (9 + 3)
        const per = JSON.parse(JSON.stringify(settings));
        per.sections[1].columns[0] = { ...per.sections[1].columns[0], spanBase: 6, spanLg: 9 };
        per.sections[1].columns[1] = { ...per.sections[1].columns[1], spanBase: 6, spanLg: 3 };
        psql(`update public.store_theme_versions set settings = '${JSON.stringify(per).replace(/'/g, "''")}' where id = '${DRAFT}'`);
        const p2 = await phone();
        await p2.page.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
        const [q1, q2] = await Promise.all([p2.page.locator('#free .blk-b-6').first().boundingBox(), p2.page.locator('#free .blk-b-6').nth(1).boundingBox()]);
        assert.ok(Math.abs(q1!.y - q2!.y) < 2 && Math.abs(q1!.width - q2!.width) < 2, 'side by side on a phone');
        await p2.ctx.close();
        const d2 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        const dp2 = await d2.newPage();
        await dp2.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
        const [w1, w2] = await Promise.all([dp2.locator('#free .blk-l-9').boundingBox(), dp2.locator('#free .blk-l-3').boundingBox()]);
        assert.ok(w1!.width > w2!.width * 2.5, 'a computer: 9 and 3');
        await d2.close();
        psql(`update public.store_theme_versions set settings = '${JSON.stringify(settings).replace(/'/g, "''")}' where id = '${DRAFT}'`);
        // a shopper's page has no placeholder (the draft is not theirs anyway); the edit frame: a block names itself
        const edit = await phone(800);
        await edit.page.goto(`http://127.0.0.1:${DASH_PORT}/frame?src=${encodeURIComponent(url('followme.test', `/?edit=${encodeURIComponent(token)}`))}`);
        const frame = edit.page.frameLocator('#f');
        await frame.locator('[data-edit-block="b2"]').waitFor();
        await edit.page.waitForFunction(() => (window as any).msgs.some((m: any) => m.data?.type === 'ready'));
        await frame.locator('[data-edit-block="b2"]').click();
        await edit.page.waitForFunction(() => (window as any).msgs.some((m: any) => m.data?.type === 'block'));
        const got = ((await edit.page.evaluate(() => (window as any).msgs)) as { data: any }[]).find((m) => m.data.type === 'block')!.data;
        assert.deepEqual(got, { type: 'block', section: 'free', id: 'b2' });
        assert.equal(await frame.locator('.edit-block-selected').getAttribute('data-edit-block'), 'b2');
        await edit.page.evaluate(() => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage({ type: 'select', id: 'free', block: 'b4' }, '*'));
        await frame.locator('[data-edit-block="b4"].edit-block-selected').waitFor();
        // 2.69: "+ חלק חדש כאן" — only after the dashboard said sections may be added; it names the section to add after
        assert.equal(await frame.locator('.edit-add').count(), 0, 'not before the dashboard allows it');
        await edit.page.evaluate(() => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage({ type: 'config', add: true }, '*'));
        await frame.locator('[data-edit-section="free"] .edit-add').click();
        await edit.page.waitForFunction(() => (window as any).msgs.some((m: any) => m.data?.type === 'add'));
        assert.deepEqual(((await edit.page.evaluate(() => (window as any).msgs)) as { data: any }[]).find((m) => m.data.type === 'add')!.data, { type: 'add', after: 'free' });
        await edit.page.screenshot({ path: path.join(SHOTS, 'edit-blocks.png') });
        await edit.ctx.close();
      } finally {
        const [tpl, ...rest] = was.split('|');
        psql(`update public.store_theme_versions set template = '${tpl}', settings = '${rest.join('|').replace(/'/g, "''")}' where id = '${DRAFT}'`);
      }
    });

    await step('a section\'s own design (2.68): spacing and a background on a phone, other ones on a computer; at once in the editor, only valid classes', async () => {
      const DRAFT = 'aaaaaaaa-0000-4000-8000-000000000142';
      const was = psql(`select template || '|' || settings::text from public.store_theme_versions where id = '${DRAFT}'`);
      const settings = { sections: [
        { id: 'hero', type: 'hero', settings: { title: 'FollowMe' } },
        { id: 'about', type: 'text', settings: { title: 'עלינו', text: 'כמה מילים.' },
          style: { padY: 'none', surface: 'dark', align: 'center' }, responsive: { lg: { padY: 'xl', surface: 'accentSoft', width: 'narrow' }, md: { padY: '99px' } } },
      ] };
      psql(`update public.store_theme_versions set template = 'kit', settings = '${JSON.stringify(settings).replace(/'/g, "''")}' where id = '${DRAFT}'`);
      try {
        const token = makePreviewToken(FOLLOWME_STORE, SECRET, Date.now() / 1000 + 3600);
        const look = (p: any) => p.locator('main > div:has(> .band)').first().evaluate((w: Element) => {
          const b = w.firstElementChild as HTMLElement, cs = getComputedStyle(b);
          const root = getComputedStyle(document.documentElement);
          return { cls: w.className, pad: cs.paddingTop, bg: cs.backgroundColor, align: cs.textAlign, text: root.getPropertyValue('--c-text').trim(),
            wrap: getComputedStyle(b.querySelector('.wrap')!).maxWidth };
        });
        const { ctx, page } = await phone();
        await page.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
        const ph = await look(page);
        assert.equal(ph.cls, 'sx-py-none sx-sf-dark sx-al-center sx-lg-py-xl sx-lg-sf-accent-soft sx-lg-w-narrow', 'a value off the scale is not there');
        assert.deepEqual([ph.pad, ph.align], ['0px', 'center']);
        assert.notEqual(ph.bg, 'rgba(0, 0, 0, 0)', 'a dark background');
        await ctx.close();
        const desk = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        const dp = await desk.newPage();
        await dp.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
        const dk = await look(dp);
        assert.deepEqual([dk.pad, dk.align, dk.wrap], ['112px', 'center', '760px'], 'a computer: its own spacing and width; the alignment from the phone');
        assert.notEqual(dk.bg, ph.bg, 'its own background');
        await desk.close();
        // the visual editor: "sectionStyle" — the classes at once, and only of the scales' shape
        const edit = await phone(800);
        await edit.page.goto(`http://127.0.0.1:${DASH_PORT}/frame?src=${encodeURIComponent(url('followme.test', `/?edit=${encodeURIComponent(token)}`))}`);
        const frame = edit.page.frameLocator('#f');
        await frame.locator('[data-edit-section="about"]').waitFor();
        await edit.page.waitForFunction(() => (window as any).msgs.some((m: any) => m.data?.type === 'ready'));
        const post = (m: unknown) => edit.page.evaluate((msg: unknown) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage(msg, '*'), m);
        await post({ type: 'sectionStyle', id: 'about', classes: ['sx-py-xl', 'sx-sf-primary'] });
        await frame.locator('[data-edit-section="about"].sx-py-xl.sx-sf-primary').waitFor();
        const cls = await frame.locator('[data-edit-section="about"]').getAttribute('class');
        assert.ok(!/sx-sf-dark|sx-lg-/.test(cls!), 'the old ones are gone');
        await post({ type: 'sectionStyle', id: 'about', classes: ['sx-py-l', 'evil'] });
        await edit.page.waitForTimeout(300);
        assert.equal(await frame.locator('[data-edit-section="about"].sx-py-xl').count(), 1, 'a class off the shape: nothing changes');
        await edit.ctx.close();
      } finally {
        const [tpl, ...rest] = was.split('|');
        psql(`update public.store_theme_versions set template = '${tpl}', settings = '${rest.join('|').replace(/'/g, "''")}' where id = '${DRAFT}'`);
      }
    });

    // 2.74: what the storefront keeps for shoppers (shared-cache.ts) and what it never keeps
    await step('the shared cache: a store\'s details stay until the dashboard\'s signed refresh; a preview, a price and stock are always read', async () => {
      const name = psql(`select name from public.stores where id = '${FOLLOWME_STORE}'`);
      const item = psql(`select id || '|' || slug || '|' || coalesce(online_price::text, 'null') || '|' || coalesce(online_price, price) from public.catalog_items where business_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and publish_online and not has_variants order by name limit 1`);
      const [itemId, slug, online, price] = item.split('|');
      const shopper = async (p = '/') => (await raw('followme.test', p)).body;
      await refreshAll();
      assert.match(await shopper(), new RegExp(name));   // read once: now kept
      try {
        psql(`update public.stores set name = 'שם חדש לבדיקה' where id = '${FOLLOWME_STORE}'`);
        assert.match(await shopper(), new RegExp(name), 'kept: the old name until the refresh');
        assert.doesNotMatch(await shopper(), /שם חדש לבדיקה/);
        // the owner's preview reads the database
        const { ctx, page } = await phone();
        await page.goto(url('followme.test', `/?preview=${encodeURIComponent(makePreviewToken(FOLLOWME_STORE, SECRET, Date.now() / 1000 + 3600))}`));
        assert.match(await text(page), /שם חדש לבדיקה/, 'a preview: the database, at once');
        await ctx.close();
        // a refresh nobody signed, or signed as a preview: refused, nothing dropped
        assert.equal((await rawPost('followme.test', '/api/revalidate', JSON.stringify({ token: makePreviewToken(FOLLOWME_STORE, SECRET, Date.now() / 1000 + 60) }))).status, 401);
        assert.equal((await rawPost('followme.test', '/api/revalidate', JSON.stringify({ token: 'x' }))).status, 401);
        assert.doesNotMatch(await shopper(), /שם חדש לבדיקה/);
        await refreshAll();
        assert.match(await shopper(), /שם חדש לבדיקה/, 'after the refresh: the new name');
        // a price is never kept: changed at the register, shown at the next visit
        psql(`update public.catalog_items set online_price = ${Number(price) + 7} where id = '${itemId}'`);
        assert.ok((await shopper(`/products/${encodeURI(slug)}`)).includes(money(Number(price) + 7)), 'the new price at once, with no refresh');
      } finally {
        psql(`update public.stores set name = '${name.replace(/'/g, "''")}' where id = '${FOLLOWME_STORE}'`);
        psql(`update public.catalog_items set online_price = ${online} where id = '${itemId}'`);
        await refreshAll();
      }
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

    await step('variants (2.63): FollowMe\'s own store and products in the fashion and the beauty kit — each one its header, hero, cards, footer and product page; the shoppers keep the published one', async () => {
      const DRAFT = 'aaaaaaaa-0000-4000-8000-000000000142';
      const before = psql(`select template || '|' || settings::text from public.store_theme_versions where id = '${DRAFT}'`);
      const sqlq = (v: unknown) => JSON.stringify(v).replace(/'/g, "''");
      // the kit as the dashboard writes it (kitSettings): its texts and sections — no design, no variants: those come from the kit
      const asWritten = (id: string) => {
        const kit = JSON.parse(readFileSync(path.resolve(ROOT, `../dream-promotion/kits/${id}.json`), 'utf8'));
        const { design: _d, chrome: _c, commerceDesign: _m, ...theme } = kit.theme;
        theme.sections = theme.sections.map(({ variant: _v, ...sec }: any) => sec);
        return JSON.parse(JSON.stringify({ kit: kit.id, ...theme }).split('{{name}}').join('FollowMe').split('"booking"').join('"whatsapp"'));
      };
      const token = makePreviewToken(FOLLOWME_STORE, SECRET, Date.now() / 1000 + 3600);
      const desktop = async () => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'he-IL' });
        await ctx.route('https://cdn.test/**', (r: any) => r.fulfill({ status: 200, contentType: 'image/png', body: picture }));
        const page = await ctx.newPage();
        page.on('pageerror', (e: Error) => errors.push(`${page.url()}: ${e.message}`));
        return { ctx, page };
      };
      const product = psql(`select slug from public.catalog_items where business_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and publish_online order by name limit 1`);
      try {
        const seen = new Set<string>();
        for (const [id, expect] of [
          ['fashion', { body: ['v-h-transparent-overlay', 'v-f-minimal', 'v-pc-editorial', 'v-pp-gallery-left', 'v-sp-airy', 'v-btn-underline', 'v-hs-display'], hero: 'hero--full-image' }],
          ['beauty', { body: ['v-h-centered-logo', 'v-f-centered', 'v-pc-minimal', 'v-pp-gallery-right', 'v-btn-soft', 'v-card-soft'], hero: 'hero--editorial' }],
          ['furniture', { body: ['v-h-minimal', 'v-f-multi-column', 'v-pc-minimal', 'v-pp-wide', 'v-btn-outline'], hero: 'hero--editorial' }],
          ['bags', { body: ['v-h-commerce-wide', 'v-f-multi-column', 'v-pc-classic', 'v-pp-classic'], hero: 'hero--split' }],
          ['services', { body: ['v-h-centered-logo', 'v-f-multi-column', 'v-pc-horizontal', 'v-pp-compact', 'v-card-soft'], hero: 'hero--split' }],
          ['retail', { body: ['v-h-search-heavy', 'v-f-dark', 'v-pc-compact', 'v-sp-compact', 'v-card-shadow'], hero: 'hero--slider' }],
          ['general', { body: ['v-h-compact', 'v-f-minimal', 'v-pc-classic'], hero: 'hero--centered' }],
        ] as const) {
          psql(`update public.store_theme_versions set template = 'kit', settings = '${sqlq(asWritten(id))}' where id = '${DRAFT}'`);
          for (const open of [phone, desktop]) {
            const { ctx, page } = await open();
            await page.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
            await page.locator(`section.${expect.hero}`).waitFor();
            const cls = (await page.getAttribute('body', 'class')) ?? '';
            for (const c of expect.body) assert.ok(cls.split(' ').includes(c), `${id}: <body> has ${c} (${cls})`);
            seen.add(`${cls}|${expect.hero}`);
            if (id === 'retail') {
              assert.equal(await page.locator('.hero-slides img').count(), 2, 'retail: both wide pictures in the slider');
              assert.equal(await page.locator('form.header-search input[name="q"]').count(), 1, 'retail: a search field in the header');
            }
            const hero = page.locator('.hero-media img').first();
            assert.match((await hero.getAttribute('src')) ?? '', new RegExp(`^/kit-images/${id}/`), `${id}: the kit's hero picture`);
            assert.ok(await hero.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), `${id}: it loads`);
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(400);
            const w = open === phone ? 'phone' : 'desktop';
            await page.screenshot({ path: path.join(SHOTS, `variants-${id}-home-${w}.png`), fullPage: true });
            if (product) {
              await page.goto(url('followme.test', `/products/${encodeURIComponent(product)}`));
              await page.locator('.product').waitFor();
              await page.screenshot({ path: path.join(SHOTS, `variants-${id}-product-${w}.png`), fullPage: true });
            }
            await page.goto(url('followme.test', '/collections'));
            await page.locator('.tiles').waitFor();
            await page.screenshot({ path: path.join(SHOTS, `variants-${id}-collections-${w}.png`), fullPage: true });
            const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
            assert.ok(sw <= cw, `${id} ${w}: nothing sideways (${sw} > ${cw})`);
            await ctx.close();
          }
        }
        assert.equal(seen.size, 7, 'seven kits, seven different sites');
        // the business's own choice wins over the kit's: a saved header and hero layout, the rest from the kit
        const own = asWritten('fashion');
        own.chrome = { header: 'centered-logo' };
        own.sections = own.sections.map((x: any) => (x.id === 'hero' ? { ...x, variant: 'split' } : x));
        psql(`update public.store_theme_versions set settings = '${sqlq(own)}' where id = '${DRAFT}'`);
        const { ctx, page } = await phone();
        await page.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
        await page.locator('section.hero--split').waitFor();
        const cls = (await page.getAttribute('body', 'class')) ?? '';
        assert.ok(cls.includes('v-h-centered-logo') && cls.includes('v-f-minimal'), `the business's header, the kit's footer (${cls})`);
        await ctx.close();
      } finally {
        const [tpl, ...rest] = before.split('|');
        psql(`update public.store_theme_versions set template = '${tpl}', settings = '${rest.join('|').replace(/'/g, "''")}' where id = '${DRAFT}'`);
      }
      // the shoppers: the published version, the look of 2.61 — no variant at all
      const shopper = await raw('followme.test', '/');
      assert.match(shopper.body, /class="v-sp-normal v-hs-normal v-btn-solid v-ct-normal v-card-border v-h-classic v-f-classic v-pc-classic v-cc-grid v-pp-classic"/);
      assert.match(shopper.body, /class="hero hero--split/);
    });

    await step('a kit\'s preview (2.64): FollowMe — its products, prices and details — on three kits and in full, with the token only; nothing in the database changes', async () => {
      const snapshot = () => psql(`select md5(string_agg(t, '|' order by t)) from (
          select 'v' || id || status || template || settings::text as t from public.store_theme_versions where store_id = '${FOLLOWME_STORE}'
          union all select 'p' || id || title || body || published::text from public.store_pages where store_id = '${FOLLOWME_STORE}'
          union all select 'm' || kind || items::text from public.store_menus where store_id = '${FOLLOWME_STORE}'
          union all select 'c' || id || title || slug from public.catalog_collections where business_id = 'aaaaaaaa-0000-4000-8000-00000000000a'
          union all select 'i' || id || name || price::text from public.catalog_items where business_id = 'aaaaaaaa-0000-4000-8000-00000000000a') x`);
      const before = snapshot();
      const token = makePreviewToken(FOLLOWME_STORE, SECRET, Date.now() / 1000 + 3600);
      const { ctx, page } = await phone();
      const looks = new Set<string>();
      for (const [kit, header] of [['fashion', 'v-h-transparent-overlay'], ['beauty', 'v-h-centered-logo'], ['retail', 'v-h-search-heavy']] as const) {
        await page.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}&kit=${kit}&kitmode=design`));
        await page.locator('.preview-bar', { hasText: 'שום דבר לא נשמר' }).waitFor();
        assert.equal(new URL(page.url()).search, '', 'the address loses the token and the kit');
        const cls = (await page.getAttribute('body', 'class')) ?? '';
        assert.ok(cls.includes(header), `${kit}: its header (${cls})`);
        looks.add(cls);
        assert.match(await text(page), /טיוטה חדשה/, `${kit}: the store's own hero text (the draft's)`);
        // another page of the store: still the kit, with the store's own product and price
        await page.goto(url('followme.test', '/collections/all'));
        assert.ok(((await page.getAttribute('body', 'class')) ?? '').includes(header), `${kit}: the choice stays from page to page`);
        assert.match(await text(page), /שקית בד/);
        await page.screenshot({ path: path.join(SHOTS, `kit-preview-${kit}-phone.png`), fullPage: true });
      }
      assert.equal(looks.size, 3, 'three different looks');
      // the full kit: its own home page, with the store's name; then back to the store's own draft
      await page.goto(url('followme.test', '/?kit=beauty&kitmode=full'));
      await page.locator('.preview-bar', { hasText: 'הערכה המלאה' }).waitFor();
      assert.ok(await page.locator('#before-after').count() === 1, 'the beauty kit\'s own sections');
      await page.getByRole('link', { name: 'חזרה לטיוטה שלכם' }).click();
      await page.getByRole('heading', { level: 1, name: 'טיוטה חדשה' }).waitFor();
      assert.ok(!((await page.getAttribute('body', 'class')) ?? '').includes('v-h-centered-logo'));
      await ctx.close();
      // a shopper who brings the cookie (no token): nothing different
      const shopper = await raw('followme.test', '/', { cookie: 'sf_kit=fashion:design' });
      assert.match(shopper.body, /class="v-sp-normal v-hs-normal v-btn-solid v-ct-normal v-card-border v-h-classic/);
      assert.ok(!/שום דבר לא נשמר/.test(shopper.body));
      assert.equal(snapshot(), before, 'the database is exactly as it was');
    });

    // 2.72 (the spec's section 87): what every kit looks like, held against saved pictures — FollowMe's own data (its
    // products, prices, collections and menus) in each kit in full: the home page on a computer and on a phone, a product,
    // the collection, the footer. Pictures differ a little from run to run (fonts, image decoding): a picture fails only
    // when more than VISUAL_MAX of its pixels changed clearly. `npm run visual:update` saves new ones after a change meant.
    await step('visual regression: 7 kits — home (computer, phone), a product, the collection, the footer — against their saved pictures', async () => {
      const dir = path.join(__dirname, 'visual');
      const update = Boolean(process.env.VISUAL_UPDATE);
      mkdirSync(dir, { recursive: true });
      const token = makePreviewToken(FOLLOWME_STORE, SECRET, Date.now() / 1000 + 3600);
      const product = psql(`select slug from public.catalog_items where business_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and publish_online order by name limit 1`);
      const kits = readdirSync(path.resolve(ROOT, '../dream-promotion/kits')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
      const desk = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 0.5, locale: 'he-IL' });
      const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'he-IL' });
      for (const c of [desk, mob]) await c.route('https://cdn.test/**', (r: any) => r.fulfill({ status: 200, contentType: 'image/png', body: picture }));
      const [dp, mp] = [await desk.newPage(), await mob.newPage()];
      const cmp = await (await browser.newContext()).newPage();   // compares two pictures in a canvas (no image library)
      await cmp.evaluate('window.__name = (f) => f');   // tsx names the functions it hands the page with a helper of its own
      const ready = async (p: any) => {
        await p.evaluate(() => document.querySelectorAll('.preview-bar, .consent').forEach((e) => e.remove()));
        await p.evaluate(() => document.fonts.ready);
        await p.waitForFunction(() => Array.from(document.images).filter((i) => { const r = i.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }).every((i) => i.complete));
      };
      const failed: string[] = [];
      const check = async (name: string, shot: Buffer) => {
        const file = path.join(dir, `${name}.jpg`);
        if (update) { writeFileSync(file, shot); return; }
        if (!existsSync(file)) { failed.push(`${name}: no saved picture — npm run visual:update`); return; }
        const r = await cmp.evaluate(async ([a, b]: string[]) => {
          const load = (src: string) => new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
          const [x, y] = await Promise.all([load(a), load(b)]);
          if (x.width !== y.width || x.height !== y.height) return { size: `${x.width}x${x.height} ≠ ${y.width}x${y.height}`, ratio: 1, diff: '' };
          const px = (img: HTMLImageElement) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d')!; g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height); };
          const [p, q] = [px(x), px(y)];
          const out = new ImageData(p.width, p.height);
          let n = 0;
          for (let i = 0; i < p.data.length; i += 4) {
            const d = Math.max(Math.abs(p.data[i] - q.data[i]), Math.abs(p.data[i + 1] - q.data[i + 1]), Math.abs(p.data[i + 2] - q.data[i + 2]));
            const bad = d > 48; if (bad) n++;
            out.data[i] = bad ? 255 : p.data[i] / 3; out.data[i + 1] = bad ? 0 : p.data[i + 1] / 3; out.data[i + 2] = bad ? 0 : p.data[i + 2] / 3; out.data[i + 3] = 255;
          }
          const c = document.createElement('canvas'); c.width = p.width; c.height = p.height; c.getContext('2d')!.putImageData(out, 0, 0);
          return { size: '', ratio: n / (p.width * p.height), diff: c.toDataURL('image/png') };
        }, [`data:image/jpeg;base64,${readFileSync(file).toString('base64')}`, `data:image/jpeg;base64,${shot.toString('base64')}`]);
        visualRatios.push([name, r.ratio]);
        if (r.size || r.ratio > VISUAL_MAX) {
          writeFileSync(path.join(SHOTS, `visual-${name}.actual.jpg`), shot);
          if (r.diff) writeFileSync(path.join(SHOTS, `visual-${name}.diff.png`), Buffer.from(r.diff.split(',')[1], 'base64'));
          failed.push(`${name}: ${r.size || `${(r.ratio * 100).toFixed(2)}% of the pixels changed`} (tests/e2e/shots/visual-${name}.diff.png)`);
        }
      };
      const shoot = (p: any, opts: Record<string, unknown> = {}) => p.screenshot({ type: 'jpeg', quality: 80, animations: 'disabled', caret: 'hide', ...opts });
      await dp.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
      await mp.goto(url('followme.test', `/?preview=${encodeURIComponent(token)}`));
      for (const kit of kits) {
        for (const p of [dp, mp]) { await p.goto(url('followme.test', `/?kit=${kit}&kitmode=full`)); await p.locator('.preview-bar').waitFor(); await ready(p); }
        await check(`${kit}-home-computer`, await shoot(dp));
        await check(`${kit}-home-phone`, await shoot(mp));
        await dp.goto(url('followme.test', `/products/${product}`)); await ready(dp);
        await check(`${kit}-product-computer`, await shoot(dp));
        await dp.goto(url('followme.test', '/collections/all')); await ready(dp);
        await check(`${kit}-collection-computer`, await shoot(dp));
        const footer = dp.locator('footer.site-footer');
        await footer.scrollIntoViewIfNeeded(); await ready(dp);
        await check(`${kit}-footer-computer`, await footer.screenshot({ type: 'jpeg', quality: 80, animations: 'disabled' }));
      }
      await desk.close(); await mob.close();
      if (update) console.log(`# visual: ${kits.length * 5} pictures saved in tests/e2e/visual`);
      else console.log(`# visual: the largest change ${(Math.max(...visualRatios.map((x) => x[1])) * 100).toFixed(3)}% (${visualRatios.sort((a, b) => b[1] - a[1])[0][0]})`);
      assert.deepEqual(failed, [], failed.join('\n'));
    });

    // the kits' gallery pictures (2.66, `npm run kit-shots`): each kit in full, on a store named "החנות שלכם" with no product —
    // the real renderer, the kit's own pictures, where products will be — saved small for the dashboard's gallery
    if (process.env.KIT_SHOTS) await step('the kits\' gallery pictures, from the real renderer', async () => {
      const name = psql(`select name from public.stores where id = '${DRAFT_STORE}'`);
      const menus = psql(`select coalesce(json_agg(json_build_object('kind', kind, 'items', items)), '[]') from public.store_menus where store_id = '${DRAFT_STORE}'`);
      const setMenus = (rows: { kind: string; items: unknown }[]) => psql(`delete from public.store_menus where store_id = '${DRAFT_STORE}';`
        + rows.map((m) => `insert into public.store_menus (store_id, kind, items) values ('${DRAFT_STORE}', '${m.kind}', '${JSON.stringify(m.items).replace(/'/g, "''")}');`).join(''));
      const out = path.resolve(ROOT, '../dream-promotion/public/kit-previews');
      mkdirSync(out, { recursive: true });
      psql(`update public.stores set name = 'החנות שלכם' where id = '${DRAFT_STORE}'`);
      try {
        const token = makePreviewToken(DRAFT_STORE, SECRET, Date.now() / 1000 + 3600);
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 0.5, locale: 'he-IL' });
        const page = await ctx.newPage();
        await page.goto(url('draft.test', `/?preview=${encodeURIComponent(token)}`));
        // 2.71: every kit in the dashboard's kits/ — a new kit gets its picture with no change here
        const kitIds = readdirSync(path.resolve(ROOT, '../dream-promotion/kits')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
        for (const kit of kitIds) {
          // the kit's own menus (a booking link → the contact page, as a kit applied with no booking page)
          const k = JSON.parse(readFileSync(path.resolve(ROOT, `../dream-promotion/kits/${kit}.json`), 'utf8'));
          const fix = (items: { label: string; href: string }[]) => items.map((l) => ({ ...l, href: l.href === 'booking' ? '/pages/contact' : l.href }));
          setMenus([{ kind: 'main', items: fix(k.menus.main) }, { kind: 'footer', items: fix(k.menus.footer) }]);
          await page.goto(url('draft.test', `/?kit=${kit}&kitmode=full`));
          await page.locator('.preview-bar').waitFor();
          await page.evaluate(() => document.querySelector('.preview-bar')?.remove());   // the picture is of the site, not of the preview
          await page.waitForFunction(() => Array.from(document.images).filter((i) => i.loading !== 'lazy').every((i) => i.complete));
          await page.screenshot({ path: path.join(out, `${kit}.jpg`), type: 'jpeg', quality: 72 });
        }
        await ctx.close();
      } finally {
        psql(`update public.stores set name = '${name.replace(/'/g, "''")}' where id = '${DRAFT_STORE}'`);
        setMenus(JSON.parse(menus));
      }
    });

    // 2.69: the pictures of "+ הוספה" — one per kind of section, with its starting words, on the neutral kit
    if (process.env.KIT_SHOTS) await step('the section library\'s pictures, from the real renderer', async () => {
      const rows = psql(`select coalesce(json_agg(json_build_object('id', id, 'template', template, 'settings', settings)), '[]') from public.store_theme_versions where store_id = '${DRAFT_STORE}'`);
      const out = path.resolve(ROOT, '../dream-promotion/public/section-previews');
      mkdirSync(out, { recursive: true });
      const settings = { kit: 'general', sections: LIBRARY.map((x) => ({ id: `t-${x.type.toLowerCase()}`, type: x.type, settings: x.starter, ...(x.columns ? { columns: x.columns } : {}) })) };
      psql(`update public.store_theme_versions set template = 'kit', settings = '${JSON.stringify(settings).replace(/'/g, "''")}' where store_id = '${DRAFT_STORE}'`);
      try {
        const token = makePreviewToken(DRAFT_STORE, SECRET, Date.now() / 1000 + 3600);
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 0.5, locale: 'he-IL' });
        const page = await ctx.newPage();
        await page.goto(url('draft.test', `/?edit=${encodeURIComponent(token)}`));
        await page.locator('[data-edit-section="t-hero"]').waitFor();
        // the site, not the editor's marks; nor the header that stays at the top of the window
        await page.evaluate(() => { document.documentElement.classList.remove('edit-mode'); document.querySelector('header.site-header')?.remove(); document.querySelector('.announcement')?.remove(); });
        for (const x of LIBRARY) {
          const el = page.locator(`[data-edit-section="t-${x.type.toLowerCase()}"]`);
          await el.scrollIntoViewIfNeeded();
          await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete));
          const box = (await el.boundingBox())!;
          assert.ok(box.height > 40, `${x.type} is shown`);
          await page.screenshot({ path: path.join(out, `${x.type}.jpg`), type: 'jpeg', quality: 70,
            clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 800) } });
        }
        await ctx.close();
      } finally {
        for (const r of JSON.parse(rows) as { id: string; template: string; settings: unknown }[]) {
          psql(`update public.store_theme_versions set template = '${r.template}', settings = '${JSON.stringify(r.settings).replace(/'/g, "''")}' where id = '${r.id}'`);
        }
      }
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

    await step('payment links (2.88): a page for the dashboard only, the notice signed and once — THE SAME WEBHOOK TWICE PAYS ONCE —, a decline, the cron, "בדיקת חיבור", a real one', async () => {
      const BIZ = 'aaaaaaaa-0000-4000-8000-00000000000a', OWNER = 'aaaaaaaa-0000-4000-8000-0000000000f1';
      const INV = 'aaaaaaaa-0000-4000-8000-0000000d0c05';
      const DASH = `http://127.0.0.1:${DASH_PORT}`;
      // an open tax invoice of FollowMe (a fixture: the document's own checks are the SQL tests'), and its terminal checked
      psql(`set session_replication_role = replica;
            insert into public.documents (id, user_id, business_id, doc_type, doc_number, doc_date, before_discount, after_discount, vat_amount, total, vat_rate, customer_name,
              customer_phone, customer_email, lines, payments)
            values ('${INV}', '${OWNER}', '${BIZ}', 305, 9, current_date, 100, 100, 18, 118, 18, 'דנה כהן', '0501234567', 'dana@example.com',
              '[{"name": "הדפסה על שקיות", "qty": 1, "totalExVat": 100}]', '[]');
            set session_replication_role = origin;
            update public.payment_accounts set verified_at = now() where business_id = '${BIZ}';`);
      const link = (amount: number) => psql(`select public.paylink_create('${BIZ}', '${OWNER}', 'document', '${INV}', ${amount}, 7, '${DASH}', 'link')->>'id'`);
      const ask = (body: unknown, secret = COMMERCE) => rawPost('platform.test', '/api/paylink', JSON.stringify(body), { 'x-commerce-secret': secret });
      const status = (id: string) => psql(`select status || ':' || is_test || ':' || receipt_status from public.payment_requests where id = '${id}'`);
      const sign = (b: string) => createHmac('sha256', MOCK_KEYS.secret_key).update(b).digest('base64');
      const notice = (id: string, pageId: string, extra: Record<string, unknown> = {}) =>
        JSON.stringify({ transaction: { payment_page_request_uid: pageId, more_info: id, status_code: '000', ...extra } });

      // 1. only the dashboard's server asks for a page (the shared secret); the page is the link's: its amount, its label
      const a = link(30);
      assert.equal((await ask({ action: 'page', request: a, returnUrl: `${DASH}/pay/x` }, 'wrong-secret-0123456789')).status, 401);
      assert.equal((await ask({ action: 'page', request: a, returnUrl: 'javascript:alert(1)' })).status, 400);
      const p1 = JSON.parse((await ask({ action: 'page', request: a, returnUrl: `${DASH}/pay/ref-a` })).body);
      assert.equal(p1.ok, true);
      assert.match(p1.url, /\/pay-mock\/mp_/);
      const p2 = JSON.parse((await ask({ action: 'page', request: a, returnUrl: `${DASH}/pay/ref-a` })).body);
      assert.equal(p2.url, p1.url, 'an open page of the last minutes is given again');
      const pageA = psql(`select pages->0->>'page' from public.payment_requests where id = '${a}'`);
      const { ctx, page } = await phone();
      await page.goto(p1.url);
      await page.getByRole('heading', { level: 1, name: 'תשלום לבדיקה' }).waitFor();
      assert.match(await text(page), /חשבונית מס מס׳ 9 — /);
      assert.match(await text(page), /30/);
      await page.screenshot({ path: path.join(SHOTS, 'paylink-mock-390.png'), fullPage: true });
      await ctx.close();
      // 2. the notice: forged → refused; signed but not paid yet → nothing; paid → once, however many copies
      const forged = notice(a, pageA);
      assert.equal((await rawPost('platform.test', '/api/paylink/mock/webhook', forged, { hash: 'AAAA', 'user-agent': 'PayPlus' })).status, 401);
      const early = notice(a, pageA, { n: 1 });
      assert.equal((await rawPost('platform.test', '/api/paylink/mock/webhook', early, { hash: sign(early), 'user-agent': 'PayPlus' })).status, 200);
      assert.equal(status(a), 'sent:true:none', 'the provider says not paid yet: nothing changes');
      assert.equal((await rawPost('platform.test', `/api/pay-mock/${pageA}?a=approve`, '')).status, 303);
      const paid = notice(a, pageA, { n: 2 });
      for (let i = 0; i < 2; i++) {
        assert.equal((await rawPost('followme.test', '/api/paylink/mock/webhook', paid, { hash: sign(paid), 'user-agent': 'PayPlus' })).status, 200, 'on any host');
      }
      assert.equal(status(a), 'paid:true:none', 'paid (test): no receipt');
      assert.equal(psql(`select count(*) from public.finance_audit_log where entity_id = '${a}' and action = 'paylink.test_paid'`), '1', 'THE SAME WEBHOOK TWICE: paid once');
      assert.equal(psql(`select count(*) from public.payment_events where request_id = '${a}' and kind = 'callback'`), '3', 'forged, early, paid — each logged once');
      assert.equal(psql(`select count(*) from public.payments where applies_to = '${INV}'`), '0', 'a test payment: nothing in the ledger');
      for (let i = 0; i < 50 && !paylinksTold.includes(a); i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(paylinksTold.filter((x) => x === a).length, 1, 'the dashboard was told once (the owner\'s alert)');
      assert.equal(JSON.parse((await ask({ action: 'page', request: a, returnUrl: `${DASH}/pay/ref-a` })).body).error, 'paid', 'a paid link opens no page');
      // 3. declined → failed (never paid); the customer tries again with the same link
      const b = link(20);
      const pb = JSON.parse((await ask({ action: 'page', request: b, returnUrl: `${DASH}/pay/ref-b` })).body);
      const pageB = pb.url.split('/pay-mock/')[1];
      assert.equal((await rawPost('platform.test', `/api/pay-mock/${pageB}?a=decline`, '')).status, 303);
      const declined = notice(b, pageB, { status_code: '001' });
      assert.equal((await rawPost('platform.test', '/api/paylink/mock/webhook', declined, { hash: sign(declined), 'user-agent': 'PayPlus' })).status, 200);
      assert.equal(status(b), 'failed:true:none', 'a failed payment shows as failed');
      const again = JSON.parse((await ask({ action: 'page', request: b, returnUrl: `${DASH}/pay/ref-b` })).body);
      assert.equal(again.ok, true); assert.notEqual(again.url, pb.url, 'a new page');
      assert.equal(status(b), 'sent:true:none', 'open again');
      // 4. nobody came back and no notice arrived: the cron asks the provider (also about a link)
      const pageB2 = again.url.split('/pay-mock/')[1];
      assert.equal((await rawPost('platform.test', `/api/pay-mock/${pageB2}?a=approve`, '')).status, 303);
      psql(`update public.payment_requests set pages = jsonb_set(pages, '{1,at}', to_jsonb(now() - interval '11 minutes')) where id = '${b}'`);
      const cron = await rawPost('platform.test', '/api/cron/payments', '{}', { 'x-cron-secret': CRON });
      assert.equal(cron.status, 200);
      assert.ok(JSON.parse(cron.body).links.asked >= 1);
      assert.equal(status(b), 'paid:true:none');
      // 5. back on the dashboard's page: it asks the storefront to confirm (nothing open: the status as it is)
      assert.equal(JSON.parse((await ask({ action: 'confirm', request: b })).body).status, 'paid');
      // 6. "בדיקת חיבור": a page with the terminal's keys → verified
      psql(`update public.payment_accounts set verified_at = null where business_id = '${BIZ}'`);
      assert.deepEqual(JSON.parse((await ask({ action: 'check', business: BIZ })).body), { ok: true });
      assert.equal(psql(`select verified_at is not null from public.payment_accounts where business_id = '${BIZ}'`), 't');
      // 7. a real link (the platform's switch of links on, a live terminal — here only): paid → the receipt waits for the dashboard
      psql(`update public.platform_flags set enabled = true where key = 'payment_links_live';
            update public.payment_accounts set mode = 'live' where business_id = '${BIZ}';
            update public.payment_accounts set verified_at = now() where business_id = '${BIZ}';`);
      try {
        const c = link(50);
        const pc = JSON.parse((await ask({ action: 'page', request: c, returnUrl: `${DASH}/pay/ref-c` })).body);
        const pageC = pc.url.split('/pay-mock/')[1];
        assert.equal((await rawPost('platform.test', `/api/pay-mock/${pageC}?a=approve`, '')).status, 303);
        const real = notice(c, pageC);
        for (let i = 0; i < 2; i++) await rawPost('platform.test', '/api/paylink/mock/webhook', real, { hash: sign(real), 'user-agent': 'PayPlus' });
        assert.equal(status(c), 'paid:false:pending', 'a real payment: its receipt is the dashboard\'s to issue, now');
        for (let i = 0; i < 50 && !paylinksTold.includes(c); i++) await new Promise((r) => setTimeout(r, 100));
        assert.equal(paylinksTold.filter((x) => x === c).length, 1, 'told once — the receipt is issued once');
        assert.equal(psql(`select count(*) from public.finance_audit_log where entity_id = '${c}' and action = 'paylink.paid'`), '1');
      } finally {
        psql(`update public.platform_flags set enabled = false where key = 'payment_links_live';
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
      await refreshAll();
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
      await refreshAll();
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
      await refreshAll();
      const closed = await raw('draft.stores.test', '/');
      assert.match(closed.body, /בקרוב/);
      assert.doesNotMatch(closed.body, /יש לכם סיסמה/);
      psql(`update public.stores set storefront_password = 'brand-new-1' where id = '${DRAFT_STORE}'`);
      await refreshAll();
      // a published store its owner locked: "בקרוב" and noindex at its own domain too, until the password
      psql(`update public.stores set password_lock = true where slug = 'shoes'`);
      await refreshAll();
      try {
        const locked = await raw('shoes.test', '/');
        assert.match(locked.body, /בקרוב/);
        assert.match(locked.body, /noindex/);
        assert.match((await raw('shoes.test', '/robots.txt')).body, /Disallow: \/\n/);
      } finally {
        psql(`update public.stores set password_lock = false where slug = 'shoes'`);
        await refreshAll();
      }
      assert.doesNotMatch((await raw('shoes.test', '/')).body, /noindex/, 'unlocked: open again');
      } finally {
        for (const x of (draftDomains || '').split(',').filter(Boolean)) {
          const [d, st] = x.split('=');
          psql(`update public.store_domains set status = '${st}' where domain = '${d}'`);
          await refreshAll();
        }
      }
    });

    await step('no domain at all: the storefront\'s own address + /s/<slug> opens the store (password before publishing, 308 once its domain works)', async () => {
      // the draft (its own domain not working): "בקרוב" with the password, then the store — noindex, robots closed
      psql(`update public.store_domains set status = 'pending' where store_id = '${DRAFT_STORE}'`);
      await refreshAll();
      psql(`update public.stores set storefront_password = 'platform-pass' where id = '${DRAFT_STORE}'`);
      await refreshAll();
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
        await refreshAll();
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
