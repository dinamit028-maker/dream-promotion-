/**
 * The storefront in a real browser (Chromium via Playwright) against a REAL Postgres — every migration of the dashboard
 * and the seed of tests/e2e/seed.sql — through the same sf_* functions the live site calls (SF_DATA=pg, never on Vercel).
 * Chromium maps *.test to this machine, so each store is reached by its own domain: followme.test (+ www), shoes.test,
 * draft.test, and platform.test (the storefront's own address, where only a preview lives).
 *
 * Run: npm run test:e2e   (needs the local Postgres 16 and the preinstalled Chromium; builds and starts the storefront)
 * Screenshots go to tests/e2e/shots/ (not committed).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { makePreviewToken } from '../../src/lib/preview';

const ROOT = path.resolve(__dirname, '../..');
const MIGRATIONS = path.resolve(ROOT, '../dream-promotion/supabase/migrations');
const SHIM = path.resolve(ROOT, '../dream-promotion/tests/sql/supabase-shim.sql');
const PORT = Number(process.env.SF_E2E_PORT ?? 3231);
const DB = process.env.SF_E2E_DB ?? 'sf_e2e';
const SECRET = 'e2e-preview-secret-0123456789abcdef';
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
  const server = run('npx', ['next', 'start', '-p', String(PORT)], {
    SF_DATA: 'pg', SF_DATABASE_URL: `postgres://sf_e2e:sf_e2e@127.0.0.1:5432/${DB}`,
    STOREFRONT_PREVIEW_SECRET: SECRET, STOREFRONT_PLATFORM_HOSTS: 'platform.test',
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
      const wa = await page.getByRole('link', { name: 'לפרטים והזמנה בוואטסאפ' }).getAttribute('href');
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

    await step('phones 375 / 390 / 430 and a desktop: nothing sideways', async () => {
      for (const width of [375, 390, 430, 1280]) {
        const { ctx, page } = await phone(width);
        for (const p of ['/', '/products/tote-bag', '/collections/all', '/policies/returns']) {
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
    try { process.kill(-server.pid!, 'SIGTERM'); } catch { /* gone */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`# e2e storefront: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
