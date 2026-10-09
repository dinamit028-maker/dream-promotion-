/**
 * Dream Commerce stage 1 (2.54) in a real browser (Chromium via Playwright), against the in-memory Supabase of
 * fake-supabase.ts. The stage's phone check, clicked through: a product with sizes and colours is created in the store,
 * counted, described (✨ AI — a suggestion that is approved), given a picture (sizes made in the browser, a signed upload),
 * published; then the register sells one size of it — by its tile and by its barcode, through a held sale and a reload —
 * and the stock of THAT size moves. A cashier sells variants and never reaches the store.
 * Stage 2 (2.55), on a phone: the store is opened, its contact and Google codes saved, the domain connected (the DNS
 * records, the steps in Vercel), the policies written from their drafts (not published while "[…]" is left), a collection
 * picked by hand and one by tag, the menu, the design (a draft, versions, back to an older one, a preview link), and the
 * store goes on the air only when the checklist is complete — the domain counts only after the storefront served it.
 * Stage 3 (2.56, test only): a PayPlus test terminal is connected (its keys never come back), pickup and delivery are set,
 * selling is switched on; a coupon; an order from the site with its lines and timeline; the register shows the units held
 * for an order on the site and does not sell them.
 *
 * Run: npm run test:e2e   (starts `next dev` on port 3219; needs the preinstalled Chromium)
 * Screenshots go to tests/e2e/shots/ (not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';
import { domainRows, normalizeDomain } from '../../src/features/store/store';
import { recordsFor, wwwRecord } from '../../src/features/store/vercel';
import { checkTerminal, keyHint } from '../../src/features/store/checkout';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_COMMERCE_PORT ?? 3219);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-000000000001';
const OWNER = 'a0000000-0000-4000-8000-0000000000a1';
const CASHIER = 'c0000000-0000-4000-8000-0000000000c1';
const CREAM = 'f0000000-0000-4000-8000-0000000000f1';
const PHONE = { width: 390, height: 844 };
// a policy as the server returns it (cleanPageCopy): the law, and the lawyer line it always keeps
const AI_POLICY = { title: 'ביטולים והחזרות', body: '## ביטול עסקה\n\nאפשר לבטל עד 14 ימים מקבלת המוצר. דמי ביטול: עד 5% או 100 ₪, הנמוך מביניהם.\n\n[לבדוק עם עורך דין לפני הפרסום — ואחרי הבדיקה למחוק את השורה הזו.]',
  seoTitle: 'ביטולים והחזרות', seoDescription: 'איך מבטלים הזמנה ומקבלים את הכסף בחזרה.' };
const AI_TEXT = { description: 'חולצת כותנה רכה לכל יום.\n\nמגיעה במידות S ו-M, בשחור ובלבן.', seoTitle: 'חולצת כותנה', seoDescription: 'חולצת כותנה רכה לכל יום — במידות S ו-M.' };

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  return {
    brands: [{ ...base, name: 'SaGabot', onboarded: true, industry: 'אופנה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', vat_rate: 18, pay_link: '', dealer_number: '515123456', legal_name: 'SaGabot בע״מ', street: 'דיזנגוף', house_no: '10', city: 'תל אביב', zip: '' }],
    catalog_items: [{ ...base, id: CREAM, name: 'קרם לחות', price: 120, kind: 'product', active: true, sort: 0, favorite: false, fav_order: 0, image_url: '', track_stock: true, stock_qty: 3, low_stock: 2,
      description: '', publish_online: false, has_variants: false, sku: '', barcode: '', tags: [], custom_fields: {} }],
    catalog_variants: [], catalog_options: [], catalog_media: [], catalog_field_defs: [],
    employees: [], leads: [], sales: [], documents: [], sale_refunds: [], stock_movements: [], register_shifts: [], appointments: [], booking_services: [],
    content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [], push_subscriptions: [],
  };
}

/** a w × h PNG of one colour (no image library: the PNG format by hand — enough for the browser to decode and resize) */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
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

/**
 * 2.70: a tap on the editor's frame where the person sees it — the frame is scaled to fit (CSS transform), so the point is
 * the frame's place + the element's place × the scale (Playwright's own click inside a transformed frame misses it).
 */
async function tapFrame(page: any, sel: string) {
  const f = page.locator('iframe[title^="האתר"]');
  const el = page.frameLocator('iframe[title^="האתר"]').locator(sel);
  await el.waitFor();
  const k = Number(await f.getAttribute('data-scale')) || 1;
  const point = async () => {
    const fb = (await f.boundingBox())!;
    const b = await el.evaluate((e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    return { x: fb.x + b.x * k, y: fb.y + b.y * k };
  };
  // near the top of the screen: below the dashboard's sticky header, above the panel that opens from the bottom on a phone
  let p = await point();
  await f.evaluate((frameEl: Element, dy: number) => {   // the dashboard's own scroller; at once (the page scrolls smoothly)
    let n: Element | null = frameEl.parentElement;
    while (n && !(n.scrollHeight > n.clientHeight && /auto|scroll/.test(getComputedStyle(n).overflowY))) n = n.parentElement;
    const t = n ?? document.scrollingElement!;
    t.scrollTo({ top: t.scrollTop + dy, behavior: 'instant' });
  }, p.y - 160);
  p = await point();
  await page.mouse.click(p.x, p.y);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const pw: any = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.js' as string));
  const { chromium } = pw.default ?? pw;
  const dev = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: 'http://sb.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-test-key', NEXT_TELEMETRY_DISABLED: '1',
      STORE_ROOT_DOMAIN: 'stores.test' },
  });
  const results: { name: string; ok: boolean; error?: string }[] = [];
  const browser = await (async () => { await waitForServer(dev); return chromium.launch(); })();
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@sagabot.test' });
  const errors: string[] = [];
  const aiRequests: any[] = [];
  const frameLoads: string[] = [];
  const picture = png(900, 600, [200, 120, 80]);

  async function open(o: { access: 'full' | 'register'; userId: string; viewport?: { width: number; height: number }; path: string }) {
    const ctx = await browser.newContext({ viewport: o.viewport ?? { width: 1280, height: 800 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(o.userId, 'user@sagabot.test'))]);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    await ctx.route('http://sb.test/**', async (route: any) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      fake.opts.userId = o.userId;
      const r = fake.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
      return route.fulfill({ status: r.status, body: r.body ?? '', headers: { ...(r.headers ?? {}), ...cors } });
    });
    // the pictures' public addresses (the bucket of the real project)
    await ctx.route('https://cdn.test/**', (r: any) => r.fulfill({ status: 200, body: picture, contentType: 'image/png' }));
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'SaGabot', state: 'active' }, businesses: [{ id: BIZ, name: 'SaGabot', state: 'active' }], superAdmin: false, access: o.access } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
    await ctx.route(`${BASE}/api/notify/sale`, (r: any) => r.fulfill({ json: { sent: 0 } }));
    // ✨ the AI: available, and a product's text (what it was asked is kept — it must never carry a price)
    await ctx.route(`${BASE}/api/ai`, (r: any) => {
      if (r.request().method() === 'GET') return r.fulfill({ json: { available: true, model: 'test' } });
      const body = JSON.parse(r.request().postData() ?? '{}');
      aiRequests.push(body);
      if (body.task === 'storePage') return r.fulfill({ json: AI_POLICY });
      if (body.task === 'storeText') return r.fulfill({ json: { text: 'הקטגוריה שלנו.', seoTitle: '', seoDescription: '' } });
      return body.task === 'product' ? r.fulfill({ json: AI_TEXT }) : r.fulfill({ status: 400, json: { code: 'unknown_task' } });
    });
    // the server's picture route (src/app/api/store/media — tested on its own in tests/store-media.test.ts): signed links,
    // then a picture is registered only when every size landed in storage
    await ctx.route(`${BASE}/api/store/media`, (r: any) => {
      const b = JSON.parse(r.request().postData() ?? '{}');
      const ext = b.type === 'image/jpeg' ? 'jpg' : 'webp';
      if (b.action === 'sign') {
        const up = randomUUID();
        return r.fulfill({ json: { uploadId: up, uploads: b.sizes.map((s: number) => ({ size: s, path: `${BIZ}/${b.itemId}/${up}/${s}.${ext}`, token: `tok-${s}` })) } });
      }
      if (b.action === 'register') {
        const folder = `${BIZ}/${b.itemId}/${b.uploadId}`;
        if (!b.sizes.every((s: number) => fake.files.has(`store-media/${folder}/${s}.${ext}`))) return r.fulfill({ status: 400, json: { message: 'התמונה לא הועלתה במלואה' } });
        const sizes = Object.fromEntries(b.sizes.map((s: number) => [String(s), `https://cdn.test/${folder}/${s}.${ext}`]));
        const list = fake.tables.catalog_media;
        const media = { id: randomUUID(), business_id: BIZ, item_id: b.itemId, variant_id: null, kind: 'image', path: folder, url: sizes[String(Math.max(...b.sizes))], sizes,
          width: b.width, height: b.height, alt: b.alt ?? '', position: list.filter((m) => m.item_id === b.itemId).length, created_at: new Date().toISOString() };
        list.push(media);
        const item = fake.tables.catalog_items.find((i) => i.id === b.itemId);
        if (item) item.image_url = sizes['400'];   // the database's catalog_media_main
        return r.fulfill({ json: { media } });
      }
      return r.fulfill({ status: 400, json: { message: 'unknown' } });
    });
    // the store's server routes (src/app/api/store/domains and preview-token — tested on their own in tests/store-routes.test.ts):
    // here as they answer without Vercel's token — the domain recorded with its www and the records to set by hand
    await ctx.route(`${BASE}/api/store/domains`, (r: any) => {
      const b = JSON.parse(r.request().postData() ?? '{}');
      const store = fake.tables.stores?.[0];
      if (!store) return r.fulfill({ status: 404, json: { code: 'no_store', message: 'עוד אין חנות לעסק הזה.' } });
      const mine = () => (fake.tables.store_domains ??= []).filter((d) => d.store_id === store.id);
      if (b.action === 'connect') {
        const d = normalizeDomain(String(b.domain ?? ''));
        if (!d.ok) return r.fulfill({ status: 400, json: { message: d.error } });
        for (const row of domainRows(d)) {
          fake.tables.store_domains.push({ id: randomUUID(), business_id: BIZ, store_id: store.id, domain: row.domain, is_primary: row.isPrimary, status: 'pending',
            last_seen_at: null, last_checked_at: null, vercel: { added: false, manual: true, records: row.isPrimary ? recordsFor(row.domain, d.bare) : [wwwRecord()] } });
        }
      }
      if (b.action === 'remove') fake.tables.store_domains = fake.tables.store_domains.filter((d) => d.id !== b.domainId);
      return r.fulfill({ json: { domains: mine(), vercel: 'not_configured' } });
    });
    await ctx.route(`${BASE}/api/store/preview-token`, (r: any) => {
      const store = fake.tables.stores?.[0];
      return r.fulfill({ json: { url: `https://storefront.test/?preview=${store?.id}.2000000000.sig`, expires: 2_000_000_000,
        token: `${store?.id}.2000000000.sig`, base: 'https://storefront.test' } });
    });
    // the store's page in the visual editor (2.61) — what the storefront's EditBridge sends (tested in the storefront's own e2e):
    // each button names one thing, to the dashboard's origin only
    await ctx.route('https://storefront.test/**', (r: any) => {
      frameLoads.push(r.request().url());
      return r.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html dir="rtl"><body>
        <button id="title">הכותרת</button><button id="steps">איך זה עובד</button><button id="menu">התפריט</button><button id="go">לקולקציה</button>
        <button id="drop">גרירה למעלה</button><button id="block">בלוק</button><button id="add">הוספה כאן</button>
        <script>
          const send = (m) => parent.postMessage(m, ${JSON.stringify(BASE)});
          // 2.65: what the dashboard tells the page (move / remove / rerender), kept for the test to read
          window.got = [];
          addEventListener('message', (e) => { if (e.origin === ${JSON.stringify(BASE)}) window.got.push(e.data); });
          // 2.67: a block of the free section added in the test below (its id: the first free one of "custom")
          document.getElementById('block').onclick = () => send({ type: 'block', section: 'custom-2', id: 'b2' });
          document.getElementById('add').onclick = () => send({ type: 'add', after: 'hero' });
          document.getElementById('drop').onclick = () => send({ type: 'drop', id: 'steps', to: 0 });
          send({ type: 'ready', path: location.pathname });
          document.getElementById('title').onclick = () => send({ type: 'text', section: 'hero', field: 'title', value: 'כותרת שנערכה באתר' });
          document.getElementById('steps').onclick = () => send({ type: 'section', id: 'steps' });
          document.getElementById('menu').onclick = () => send({ type: 'open', target: 'menus:main' });
          document.getElementById('go').onclick = () => send({ type: 'navigate', path: '/collections/all' });
        </script></body></html>` });
    });
    // the terminal's route (src/app/api/store/payments — tested on its own in tests/store-checkout.test.ts): keys checked,
    // sealed on the server, never sent back
    await ctx.route(`${BASE}/api/store/payments`, (r: any) => {
      const info = () => { const a = (fake.tables.payment_accounts ??= [])[0];
        return { connected: Boolean(a), provider: a?.provider ?? null, mode: a?.mode ?? null, hint: a?.hint ?? '', connectedAt: a?.connected_at ?? null, ready: true }; };
      if (r.request().method() === 'GET') return r.fulfill({ json: info() });
      const b = JSON.parse(r.request().postData() ?? '{}');
      if (b.action === 'connect') {
        const t = checkTerminal({ apiKey: String(b.apiKey ?? ''), secretKey: String(b.secretKey ?? ''), pageUid: String(b.pageUid ?? '') });
        if (!t.ok) return r.fulfill({ status: 400, json: { message: t.error } });
        fake.tables.payment_accounts = [{ business_id: BIZ, provider: 'payplus', mode: 'test', sealed: 'v1.sealed-on-the-server', page_uid: t.pageUid, hint: keyHint(t.keys.api_key), connected_at: new Date().toISOString() }];
      }
      if (b.action === 'disconnect') fake.tables.payment_accounts = [];
      return r.fulfill({ json: info() });
    });
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(`${o.access}: ${e.message}`));
    page.on('dialog', (d: any) => d.accept());
    await page.goto(`${BASE}${o.path}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page };
  }
  let current: any = null;
  const step = async (name: string, fn: () => Promise<void>) => {
    if (current) for (let i = 0; i < 3 && await current.getByRole('dialog').count(); i++) await current.keyboard.press('Escape');
    try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false, error: e.message }); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 6).join('\n  ')}`); }
  };
  const dialog = (page: any) => page.getByRole('dialog');
  const tile = (page: any, name: string) => page.locator('section button', { hasText: name }).first();
  const pay = (page: any) => page.getByRole('button', { name: /^לתשלום — / });
  const shirt = () => fake.tables.catalog_items.find((i) => i.name === 'חולצת כותנה');
  const variant = (label: string) => { const [o1, o2] = label.split(' / '); return fake.tables.catalog_variants.find((v) => v.item_id === shirt()?.id && v.option1 === o1 && v.option2 === o2); };
  const variantRow = (page: any, label: string) => page.locator('li', { has: page.locator('strong', { hasText: new RegExp(`^${label}$`) }) });
  const noSideScroll = async (page: any, what: string) => {
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(sw <= cw + 1, `${what}: nothing sideways (${sw} > ${cw})`);
  };

  const { page } = await open({ access: 'full', userId: OWNER, viewport: PHONE, path: '/store/products' });
  current = page;
  try {
    await step('the store on a phone: its own menu, the products of the register, an honest note about the site', async () => {
      await page.getByRole('heading', { name: 'מוצרים' }).waitFor({ timeout: 120_000 });
      await page.getByRole('navigation', { name: 'ניווט חנות' }).waitFor();
      await page.getByText('החנות באתר עוד לא עלתה').waitFor();
      await page.getByRole('link', { name: 'קרם לחות', exact: true }).waitFor();
      assert.equal(await page.getByRole('switch', { name: 'לא באתר: קרם לחות' }).getAttribute('aria-checked'), 'false', 'off by default');
      await noSideScroll(page, 'the products on a phone');
      await page.screenshot({ path: path.join(SHOTS, 'c1-products-phone.png') });
    });

    await step('a new product: created in the one editor, an address in the store from its name, not published', async () => {
      await page.getByRole('button', { name: '+ מוצר חדש' }).click();
      await page.waitForURL(/\/store\/products\/new$/);
      await page.getByRole('heading', { name: 'מוצר חדש' }).waitFor();
      await page.getByLabel('שם (בקופה, במסמכים ובאתר)').fill('חולצת כותנה');
      await page.getByLabel('סוג').selectOption('product');
      await page.getByLabel('מחיר בקופה ₪ (כולל מע״מ)').fill('120');
      await page.getByRole('button', { name: 'יצירת המוצר' }).click();
      await page.waitForURL(/\/store\/products\/[0-9a-f-]{36}$/);
      await page.getByRole('heading', { name: 'חולצת כותנה' }).waitFor();
      const s = shirt()!;
      assert.deepEqual([s.price, s.kind, s.slug, s.publish_online], [120, 'product', 'חולצת-כותנה', false]);
      await noSideScroll(page, 'the editor on a phone');
    });

    await step('sizes and colours: 2 options → 4 variants; S / שחור counted (5) — the item\'s stock is their sum', async () => {
      await page.getByLabel('שם אפשרות 1').fill('מידה');
      await page.getByLabel('ערכים של אפשרות 1').fill('S, M');
      await page.getByRole('button', { name: '+ אפשרות' }).click();
      await page.getByLabel('שם אפשרות 2').fill('צבע');
      await page.getByLabel('ערכים של אפשרות 2').fill('שחור, לבן');
      await page.getByRole('button', { name: 'יצירת וריאנטים' }).click();
      await page.getByText('נוספו 4 וריאנטים ✓').waitFor();
      assert.equal(fake.tables.catalog_variants.length, 4);
      assert.deepEqual(fake.tables.catalog_options.map((o) => [o.position, o.name, o.choices]), [[1, 'מידה', ['S', 'M']], [2, 'צבע', ['שחור', 'לבן']]]);
      assert.equal(shirt()!.has_variants, true);
      const row = variantRow(page, 'S / שחור');
      await row.getByLabel('כמות: S / שחור').fill('5');
      await row.getByRole('button', { name: 'ספירה' }).click();
      await page.getByText('הספירה נשמרה: 5 ✓').waitFor();
      await row.getByText('במלאי 5').waitFor();
      assert.equal(variant('S / שחור')!.stock_qty, 5);
      assert.deepEqual([shirt()!.stock_qty, shirt()!.track_stock], [5, true], 'the item keeps the sum of its variants');
      // a barcode for M / לבן (the register will scan it)
      await variantRow(page, 'M / לבן').getByLabel('ברקוד').fill('7290000000011');
      await page.getByRole('button', { name: 'שמירה', exact: true }).click();
      await page.getByText('נשמר ✓').waitFor();
      assert.equal(variant('M / לבן')!.barcode, '7290000000011');
      await page.screenshot({ path: path.join(SHOTS, 'c2-variants-phone.png'), fullPage: true });
    });

    await step('✨ a description from the AI: a suggestion that is read and approved — it never sees the price', async () => {
      await page.getByRole('button', { name: '✨ תיאור מה-AI' }).click();
      await page.getByText('הצעה מה-AI — לקרוא לפני שמשתמשים').waitFor();
      assert.equal(shirt()!.description, '', 'nothing saved before approving');
      await page.getByRole('button', { name: 'שימוש בטקסט' }).click();
      assert.equal(await page.getByLabel('תיאור המוצר').inputValue(), AI_TEXT.description);
      await page.getByRole('button', { name: 'שמירה', exact: true }).click();
      await page.getByText('נשמר ✓').waitFor();
      // "נשמר ✓" may still be on screen from the previous save: wait for this save itself to land (a slow machine)
      for (let i = 0; i < 100 && shirt()!.description !== AI_TEXT.description; i++) await page.waitForTimeout(100);
      assert.deepEqual([shirt()!.description, shirt()!.seo_title], [AI_TEXT.description, AI_TEXT.seoTitle]);
      const asked = JSON.stringify(aiRequests.at(-1));
      assert.ok(asked.includes('חולצת כותנה') && asked.includes('שחור'), 'the product\'s own words');
      assert.ok(!asked.includes('120'), 'never its price');
    });

    await step('a picture: sizes made in the browser, uploaded with signed links, the main picture of the product', async () => {
      await page.getByLabel('בחירת תמונות').setInputFiles({ name: 'shirt.png', mimeType: 'image/png', buffer: picture });
      await page.getByText('התמונה נוספה ✓').waitFor({ timeout: 60_000 });
      const up = [...fake.files.keys()].filter((k) => k.startsWith(`store-media/${BIZ}/${shirt()!.id}/`));
      assert.deepEqual(up.map((k) => k.split('/').pop()).sort(), ['1600.webp', '400.webp', '800.webp'], 'a 900px picture: 400, 800 and its own size');
      assert.equal(fake.tables.catalog_media.length, 1);
      assert.match(shirt()!.image_url, /\/400\.webp$/, 'the register\'s tile shows the 400 size');
      await page.getByText('ראשית', { exact: true }).waitFor();
    });

    await step('📣 קדם מוצר (2.60): the studio opens with the product\'s picture in the library and a brief of its own words — never its price', async () => {
      const editor = page.url();
      page.once('dialog', (d: any) => void d.accept());
      await page.getByRole('button', { name: 'קדם מוצר' }).click();
      await page.waitForURL(/\/create\?/);
      const u = new URL(page.url());
      assert.equal(u.searchParams.get('kind'), 'post');
      assert.match(u.searchParams.get('brief') ?? '', /חולצת כותנה/);
      assert.doesNotMatch(u.searchParams.get('brief') ?? '', /120/, 'never the price');
      const row = (fake.tables.media ?? []).find((m) => m.id === u.searchParams.get('media'));
      assert.ok(row, 'the picture is in the library');
      assert.match(row.url, new RegExp(`/${BIZ}/${shirt()!.id}/.+/(800|1600)\\.webp$`));
      await page.goto(editor);
      await page.getByText('ראשית', { exact: true }).waitFor({ timeout: 60_000 });
    });

    await step('"באתר": a complete product is published at once; one without a picture and a description is offered to complete them first', async () => {
      await page.getByRole('link', { name: '→ כל המוצרים' }).click();
      await page.waitForURL(/\/store\/products$/);
      await page.getByRole('switch', { name: 'לא באתר: חולצת כותנה' }).click();
      await page.getByRole('switch', { name: 'מפורסם באתר: חולצת כותנה' }).waitFor();
      assert.equal(shirt()!.publish_online, true);
      await page.getByRole('switch', { name: 'לא באתר: קרם לחות' }).click();
      const d = dialog(page);
      await d.getByText('לפני שמפרסמים את "קרם לחות"').waitFor();
      await d.getByRole('button', { name: '✨ תיאור מה-AI' }).waitFor();
      await d.getByRole('button', { name: 'לפרסם בכל זאת' }).click();
      await page.getByRole('switch', { name: 'מפורסם באתר: קרם לחות' }).waitFor();
      assert.equal(fake.tables.catalog_items.find((i) => i.id === CREAM)!.publish_online, true);
      await page.getByText(/4 וריאנטים/).waitFor();
      await page.screenshot({ path: path.join(SHOTS, 'c3-published-phone.png') });
    });
  } finally { await page.context().close(); current = null; }

  const { page: reg } = await open({ access: 'full', userId: OWNER, path: '/register' });
  current = reg;
  try {
    await step('the register: the product\'s tile asks for the size / colour; THAT variant\'s stock moves', async () => {
      await tile(reg, 'חולצת כותנה').waitFor({ timeout: 120_000 });
      await reg.getByRole('button', { name: 'הכל', exact: true }).click().catch(() => undefined);
      await tile(reg, 'חולצת כותנה').click();
      const d = dialog(reg);
      await d.getByText('בחירת מידה / צבע').waitFor();
      await d.getByRole('button', { name: /S \/ שחור/ }).click();
      await reg.getByText('חולצת כותנה · S / שחור').first().waitFor();
      await reg.screenshot({ path: path.join(SHOTS, 'c4-register-variant.png') });
      await pay(reg).click();
      await dialog(reg).getByRole('button', { name: 'אשראי' }).click();
      await dialog(reg).getByText('העסקה נשמרה').waitFor();
      const sale = fake.tables.sales.at(-1)!;
      assert.deepEqual([sale.items[0].itemId, sale.items[0].variantId, sale.items[0].name], [shirt()!.id, variant('S / שחור')!.id, 'חולצת כותנה · S / שחור']);
      assert.equal(variant('S / שחור')!.stock_qty, 4, 'S / שחור: 5 → 4');
      assert.equal(shirt()!.stock_qty, 4, 'the item\'s sum: 5 → 4');
      const mv = fake.tables.stock_movements.at(-1)!;
      assert.deepEqual([mv.reason, mv.delta, mv.variant_id, mv.qty_after], ['sale', -1, variant('S / שחור')!.id, 4]);
      await dialog(reg).getByRole('button', { name: 'עסקה חדשה' }).click();
    });

    await step('a scanned barcode adds its size / colour at once; the sale is held, survives a reload, and keeps the variant', async () => {
      const search = reg.getByLabel('חיפוש');
      await search.fill('7290000000011');
      await search.press('Enter');
      await reg.getByText('חולצת כותנה · M / לבן').first().waitFor();
      assert.equal(await search.inputValue(), '', 'the search is cleared for the next scan');
      await reg.getByRole('button', { name: 'השהיית העסקה' }).click();
      await reg.getByText('⏸ עסקה מושהית אחת').waitFor();
      await reg.reload({ waitUntil: 'domcontentloaded' });
      await reg.getByText('⏸ עסקה מושהית אחת').waitFor({ timeout: 60_000 });
      await reg.getByText('⏸ עסקה מושהית אחת').click();
      await dialog(reg).getByRole('button', { name: 'המשך' }).click();
      await reg.getByText('חולצת כותנה · M / לבן').first().waitFor();
      await pay(reg).click();
      await dialog(reg).getByRole('button', { name: 'אשראי' }).click();
      await dialog(reg).getByText('העסקה נשמרה').waitFor();
      const sale = fake.tables.sales.at(-1)!;
      assert.equal(sale.items[0].variantId, variant('M / לבן')!.id, 'the held line kept its variant');
      assert.equal(variant('M / לבן')!.stock_qty, -1, 'sold before it was counted: below zero, as the register always allowed');
      assert.equal(shirt()!.stock_qty, 3);
      await dialog(reg).getByRole('button', { name: 'עסקה חדשה' }).click();
    });

    await step('the price list: "באתר" and the editor next to every item; the variants\' stock at a glance', async () => {
      await reg.getByRole('button', { name: /מחירון ומלאי/ }).click();
      await reg.getByRole('switch', { name: 'מפורסם באתר: חולצת כותנה' }).waitFor();
      await reg.getByText(/S \/ שחור: 4/).waitFor();
      await reg.getByRole('button', { name: 'מלאי לפי וריאנט' }).click();
      await dialog(reg).getByRole('heading', { name: 'חולצת כותנה' }).waitFor();
      // 5 counted on S / שחור, one S / שחור and one M / לבן sold: the item's 3 = 4 + (−1) — every unit is on a variant
      assert.equal(await dialog(reg).getByText(/לא משויכות לאף וריאנט/).count(), 0);
      await reg.keyboard.press('Escape');
    });
  } finally { await reg.context().close(); current = null; }

  const { page: st } = await open({ access: 'full', userId: OWNER, viewport: PHONE, path: '/store/settings' });
  // 2.74: after a change the shoppers see, the dashboard asks the storefront to drop what it keeps (its own route signs it)
  let refreshes = 0;
  st.on('request', (r: any) => { if (new URL(r.url()).pathname === '/api/store/revalidate' && r.method() === 'POST') refreshes++; });
  current = st;
  const store = () => fake.tables.stores?.[0];
  const block = (page: any, title: string) => page.locator('section', { has: page.getByRole('heading', { name: title, exact: true }) });
  try {
    await step('stage 2 — the store opens from Settings: one per business, a draft — ready at once with the kit of its field (2.58)', async () => {
      await st.getByRole('heading', { name: 'פתיחת חנות' }).waitFor({ timeout: 120_000 });
      assert.equal(await st.getByLabel('שם החנות').inputValue(), 'SaGabot', 'the brand\'s name to start from');
      await st.getByText(/ערכת ההקמה "אופנה"/).waitFor();
      const items = fake.tables.catalog_items.length;
      await st.getByRole('button', { name: 'פתיחת החנות' }).click();
      await st.getByRole('heading', { name: 'הגדרות ודומיין' }).waitFor();
      await st.getByText('האתר מוכן — עכשיו מוסיפים מוצרים.').waitFor();
      assert.deepEqual([fake.tables.stores.length, store().business_id, store().status, store().template], [1, BIZ, 'draft', 'kit']);
      // a store is never empty: the kit of the brand's field ("אופנה") — its pages and policies as drafts, and not one product
      assert.deepEqual((fake.tables.store_theme_versions ?? []).map((v) => [v.status, v.template, v.settings.kit]), [['published', 'kit', 'fashion']],
        'the store\'s first theme is the kit\'s (the site itself stays closed)');
      const pages = fake.tables.store_pages ?? [];
      assert.deepEqual(pages.filter((g) => g.kind === 'page').map((g) => g.slug).sort(), ['about', 'contact', 'faq', 'size-guide']);
      assert.deepEqual(pages.filter((g) => g.kind === 'policy').map((g) => g.policy).sort(), ['accessibility', 'privacy', 'returns', 'shipping', 'terms']);
      assert.ok(pages.every((g) => !g.published), 'nothing is published by a kit');
      assert.deepEqual((fake.tables.catalog_collections ?? []).map((c) => c.slug).sort(), ['accessories', 'men', 'new', 'sale', 'women']);
      assert.deepEqual((fake.tables.store_menus ?? []).find((m) => m.kind === 'main')!.items.map((l: any) => l.label), ['חדש', 'נשים', 'גברים', 'אקססוריז', 'מבצעים']);
      assert.equal(fake.tables.catalog_items.length, items, 'a kit adds no product');
      await st.screenshot({ path: path.join(SHOTS, 'c5-store-opened-kit-phone.png'), fullPage: true });
      // the steps below check each screen by hand on a bare store (as before 2.58): the kit's rows are taken away here
      fake.tables.store_theme_versions = []; fake.tables.store_pages = []; fake.tables.store_menus = []; fake.tables.catalog_collections = [];
      store().template = 'bags';
      await st.reload({ waitUntil: 'domcontentloaded' });
      await st.getByRole('heading', { name: 'הגדרות ודומיין' }).waitFor({ timeout: 60_000 });
      const check = block(st, 'לפני שעולים לאוויר');
      await check.getByText('פרטי העסק (שם, מספר עוסק / ח.פ., כתובת) — קיים').waitFor();
      await check.getByText('דרך ליצור קשר (טלפון, וואטסאפ או מייל) — חסר').waitFor();
      assert.equal(await st.getByRole('button', { name: 'העלאת החנות לאוויר' }).isDisabled(), true, 'not before the checklist is complete');
      await noSideScroll(st, 'the store\'s settings on a phone');
      await st.screenshot({ path: path.join(SHOTS, 'c5-store-settings-phone.png'), fullPage: true });
    });

    await step('the store\'s own address: sagabot.stores.test, "מוגן בסיסמה", open / copy link + password, the address and the password', async () => {
      await st.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
      const ad = block(st, 'כתובת האתר');
      await ad.getByText('sagabot.stores.test', { exact: true }).waitFor();
      await ad.getByText('מוגן בסיסמה', { exact: true }).waitFor();
      assert.equal(await ad.getByRole('link', { name: 'פתח את האתר' }).getAttribute('href'), 'https://sagabot.stores.test');
      assert.equal(await ad.getByRole('link', { name: 'פתח את האתר' }).getAttribute('target'), '_blank');
      await ad.getByRole('button', { name: 'העתק קישור + סיסמה' }).click();
      await ad.getByRole('button', { name: 'הועתק ✓' }).waitFor();
      assert.equal(await st.evaluate(() => navigator.clipboard.readText()), `${store().name}\nhttps://sagabot.stores.test\nסיסמה: e2epass123`);
      // the address: reserved names and a taken one are refused before saving; a free one is saved after a confirmation
      const slug = ad.getByLabel('הכתובת של החנות');
      await slug.fill('admin');
      await ad.getByRole('button', { name: 'שמירת הכתובת' }).click();
      await ad.getByText('השם הזה שמור למערכת. בחרו שם אחר.').waitFor();
      await slug.fill('taken-one');
      await ad.getByRole('button', { name: 'שמירת הכתובת' }).click();
      await ad.getByText(/כבר של חנות אחרת\. אפשר למשל: taken-one-2/).waitFor();
      assert.equal(store().slug, 'sagabot', 'nothing saved');
      await slug.fill('SaGabot-Shop');
      await ad.getByRole('button', { name: 'שמירת הכתובת' }).click();
      await ad.getByText('הכתובת נשמרה.').waitFor();
      assert.equal(store().slug, 'sagabot-shop');
      await ad.getByText('sagabot-shop.stores.test', { exact: true }).waitFor();
      // no password: a draft is closed (only the preview link); a new password: protected again
      const pw = ad.getByLabel('סיסמה לאתר');
      await pw.fill('');
      await ad.getByRole('button', { name: 'שמירת הסיסמה' }).click();
      await ad.getByText('טיוטה', { exact: true }).waitFor();
      await ad.getByRole('button', { name: 'העתק קישור', exact: true }).waitFor();
      await ad.getByRole('button', { name: 'סיסמה חדשה' }).click();
      assert.match(await pw.inputValue(), /^[a-z2-9]{10}$/);
      await ad.getByRole('button', { name: 'שמירת הסיסמה' }).click();
      await ad.getByText('מוגן בסיסמה', { exact: true }).waitFor();
      assert.match(store().storefront_password, /^[a-z2-9]{10}$/);
      await noSideScroll(st, 'the store\'s address on a phone');
      await st.screenshot({ path: path.join(SHOTS, 'c5b-store-address-phone.png'), fullPage: true });
    });

    await step('details and contact: WhatsApp in the international form, Google\'s codes from the whole tag', async () => {
      await st.getByLabel('טלפון', { exact: true }).fill('03-1234567');
      await st.getByLabel('וואטסאפ', { exact: true }).fill('050-1234567');
      await st.getByLabel('מייל', { exact: true }).fill('bad@');
      await st.getByRole('button', { name: 'שמירת הפרטים' }).click();
      await st.getByText('כתובת מייל לא תקינה.').waitFor();
      assert.equal(store().phone, '', 'nothing saved with a bad field');
      await st.getByLabel('מייל', { exact: true }).fill('hi@sagabot.test');
      await st.getByLabel('Google Analytics — מזהה מדידה').fill('g-test1234');
      await st.getByLabel('Search Console — קוד אימות').fill('<meta name="google-site-verification" content="AbC_def-1234567890xyz" />');
      await st.getByRole('button', { name: 'שמירת הפרטים' }).click();
      await st.getByText('נשמר.', { exact: true }).waitFor();
      assert.deepEqual([store().phone, store().whatsapp, store().email, store().ga4_id, store().gsc_code],
        ['03-1234567', '972501234567', 'hi@sagabot.test', 'G-TEST1234', 'AbC_def-1234567890xyz']);
      assert.equal(await st.getByLabel('וואטסאפ', { exact: true }).inputValue(), '972501234567');
      await block(st, 'לפני שעולים לאוויר').getByText('דרך ליצור קשר (טלפון, וואטסאפ או מייל) — קיים').waitFor();
    });

    await step('the domain: recorded with its www, the DNS records and the steps in Vercel — never "פעיל" from here', async () => {
      await st.getByLabel('הדומיין').fill('https://www.FollowMeCollection.com/');
      await st.getByRole('button', { name: 'חיבור' }).click();
      const dom = block(st, 'דומיין');
      await dom.locator('li', { hasText: 'www.followmecollection.com' }).getByText('ממתין לחיבור').waitFor();
      assert.deepEqual(fake.tables.store_domains.map((d) => [d.domain, d.is_primary, d.status]),
        [['followmecollection.com', true, 'pending'], ['www.followmecollection.com', false, 'pending']]);
      assert.equal(await dom.getByText('ממתין לחיבור').count(), 2);
      await dom.getByRole('cell', { name: '76.76.21.21' }).waitFor();
      await dom.getByText('החיבור ל-Vercel נעשה ביד').waitFor();
      await noSideScroll(st, 'the domain on a phone');
      await st.screenshot({ path: path.join(SHOTS, 'c6-store-domain-phone.png'), fullPage: true });
    });

    await step('policies from the checklist: the draft has "[…]" — saved, but not published until completed', async () => {
      await block(st, 'לפני שעולים לאוויר').getByRole('link', { name: 'כותבים ומפרסמים בעמודים' }).first().click();
      await st.waitForURL(/\/store\/pages$/);
      await st.getByRole('heading', { name: 'ביטולים והחזרות' }).waitFor();
      await st.getByText(/NEEDS_LEGAL_VERIFICATION/).first().waitFor();
      assert.match(await st.getByLabel('טקסט', { exact: true }).inputValue(), /\[לבדוק עם עורך דין/);
      // 2.59: the AI writes the policy by itself (it still has "[…]") — a proposal beside the text, taken only on "שימוש בטקסט"
      await st.getByText(/הצעה מה-AI/).waitFor();
      const asked = aiRequests.find((b) => b.task === 'storePage');
      assert.equal(asked?.payload?.policy, 'returns');
      assert.ok(!('phone' in (asked?.payload ?? {})) && !('store' in (asked?.payload ?? {})), 'the store\'s details are read on the server, not sent from here');
      assert.doesNotMatch(await st.getByLabel('טקסט', { exact: true }).inputValue(), /14 ימים/, 'nothing goes into the text before the owner takes it');
      await st.getByRole('button', { name: 'שימוש בטקסט' }).click();
      assert.match(await st.getByLabel('טקסט', { exact: true }).inputValue(), /14 ימים[\s\S]*\[לבדוק עם עורך דין לפני הפרסום/);
      assert.equal((fake.tables.store_pages ?? []).length, 0, 'and nothing is saved by it');
      await st.getByRole('switch', { name: 'העמוד באתר' }).click();
      await st.getByRole('button', { name: 'שמירה', exact: true }).click();
      await st.getByText(/סוגריים מרובעים/).first().waitFor();
      assert.equal((fake.tables.store_pages ?? []).length, 0, 'not published with "[…]" left');
      const write = async (title: string, text: string, refusedFirst = false) => {
        await st.getByLabel('טקסט', { exact: true }).fill(text);
        if (!(await st.getByRole('switch', { name: 'העמוד באתר' }).getAttribute('aria-checked') === 'true')) await st.getByRole('switch', { name: 'העמוד באתר' }).click();
        // 2.58: a policy goes on the site only after "קראתי ואני מאשר/ת"
        if (refusedFirst) {
          await st.getByRole('button', { name: 'שמירה', exact: true }).click();
          await st.getByText(/סמנו "קראתי ואני מאשר\/ת"/).waitFor();
          assert.equal((fake.tables.store_pages ?? []).filter((g) => g.published).length, 0, 'not published without it');
        }
        await st.getByRole('checkbox', { name: /קראתי ואני מאשר/ }).check();
        await st.getByRole('button', { name: 'שמירה', exact: true }).click();
        await st.getByText('העמוד נשמר ומוצג באתר.').waitFor();
        await st.getByRole('heading', { name: 'עמודים', exact: true }).waitFor();
        assert.ok(fake.tables.store_pages.some((g) => g.title === title && g.published), title);
      };
      await write('ביטולים והחזרות', '## ביטול עסקה\n\nאפשר לבטל לפי חוק הגנת הצרכן.\n\n- פונים בטלפון 03-1234567', true);
      for (const [kind, title] of [['privacy', 'מדיניות פרטיות'], ['accessibility', 'הצהרת נגישות']] as const) {
        await st.locator('li', { hasText: `/policies/${kind}` }).getByRole('button', { name: 'כתיבה' }).click();
        await st.getByRole('heading', { name: title }).waitFor();
        await write(title, `## ${title}\n\nטקסט מלא של העסק.`);
      }
      assert.deepEqual(fake.tables.store_pages.map((g) => [g.kind, g.policy, g.slug, g.published]),
        [['policy', 'returns', 'policy-returns', true], ['policy', 'privacy', 'policy-privacy', true], ['policy', 'accessibility', 'policy-accessibility', true]]);
      await noSideScroll(st, 'the pages on a phone');
      await st.screenshot({ path: path.join(SHOTS, 'c7-store-pages-phone.png'), fullPage: true });
    });

    await step('collections: products picked by hand in their own order; one automatic by tag (a tag is required)', async () => {
      await st.goto(`${BASE}/store/collections`, { waitUntil: 'domcontentloaded' });
      await st.getByText('עוד אין קולקציות.').waitFor({ timeout: 60_000 });
      await st.getByRole('button', { name: '+ קולקציה חדשה' }).click();
      await st.getByLabel('שם', { exact: true }).fill('שקיות נייר');
      assert.equal(await st.getByLabel('כתובת באתר').inputValue(), 'שקיות-נייר', 'the address from the name');
      await st.getByRole('button', { name: /^חולצת כותנה/ }).click();
      await st.getByRole('button', { name: /^קרם לחות/ }).click();
      await st.getByRole('button', { name: 'להזיז למעלה: קרם לחות' }).click();
      await st.getByRole('switch', { name: 'הקולקציה באתר' }).click();
      await st.getByRole('button', { name: 'שמירה', exact: true }).click();
      await st.getByText('הקולקציה נשמרה.').waitFor();
      const paper = fake.tables.catalog_collections.find((c) => c.slug === 'שקיות-נייר')!;
      assert.deepEqual([paper.title, paper.kind, paper.publish_online, paper.business_id], ['שקיות נייר', 'manual', true, BIZ]);
      const names = (fake.tables.catalog_collection_items ?? []).filter((x) => x.collection_id === paper.id).sort((a, b) => a.position - b.position)
        .map((x) => fake.tables.catalog_items.find((i) => i.id === x.item_id)?.name);
      assert.deepEqual(names, ['קרם לחות', 'חולצת כותנה'], 'in the order chosen');

      await st.getByRole('button', { name: '+ קולקציה חדשה' }).click();
      await st.getByLabel('שם', { exact: true }).fill('כותנה');
      await st.getByRole('radio', { name: 'אוטומטית לפי תגית' }).click();
      await st.getByRole('button', { name: 'שמירה', exact: true }).click();
      await st.getByText('קולקציה אוטומטית צריכה לפחות תגית אחת.').waitFor();
      await st.getByLabel('תגית אחרת').fill('כותנה');
      await st.getByRole('button', { name: 'הוספה', exact: true }).click();
      await st.getByRole('button', { name: 'שמירה', exact: true }).click();
      await st.getByText('הקולקציה נשמרה.').waitFor();
      const auto = fake.tables.catalog_collections.find((c) => c.slug === 'כותנה')!;
      assert.deepEqual([auto.kind, auto.rules, auto.sort, auto.publish_online], ['auto', { tags: ['כותנה'] }, 'newest', false]);
      assert.equal(fake.tables.catalog_collection_items.filter((x) => x.collection_id === auto.id).length, 0, 'no hand-picked rows');
      await st.getByRole('button', { name: 'להזיז למעלה: כותנה' }).click();
      for (let i = 0; i < 50 && (auto.position !== 0 || paper.position !== 1); i++) await st.waitForTimeout(100);
      assert.deepEqual([auto.position, paper.position], [0, 1], 'the order of the collections on the site');
      await noSideScroll(st, 'the collections on a phone');
      await st.screenshot({ path: path.join(SHOTS, 'c8-store-collections-phone.png'), fullPage: true });
    });

    await step('menus: the store\'s own addresses to choose from; a link that is not https is refused', async () => {
      await st.goto(`${BASE}/store/navigation`, { waitUntil: 'domcontentloaded' });
      const main = block(st, 'תפריט ראשי');
      await main.getByText(/ריק — האתר מציג/).waitFor({ timeout: 60_000 });
      await main.getByRole('button', { name: '+ קישור' }).click();
      await main.getByLabel('לאן').selectOption('/collections/שקיות-נייר');
      assert.equal(await main.getByLabel('שם הקישור').inputValue(), 'שקיות נייר', 'a destination brings its name');
      await main.getByRole('button', { name: '+ קישור' }).click();
      await main.getByLabel('לאן').nth(1).selectOption('__other__');
      await main.getByLabel('שם הקישור').nth(1).fill('אינסטגרם');
      await main.getByLabel('כתובת', { exact: true }).fill('http://instagram.com/sagabot');
      await main.getByRole('button', { name: 'שמירת התפריט' }).click();
      await main.getByText(/https:\/\//).first().waitFor();
      assert.equal((fake.tables.store_menus ?? []).length, 0);
      await main.getByLabel('כתובת', { exact: true }).fill('https://instagram.com/sagabot');
      await main.getByRole('button', { name: 'שמירת התפריט' }).click();
      await main.getByText('התפריט נשמר. הוא מופיע באתר מיד.').waitFor();
      const menu = fake.tables.store_menus.find((m) => m.kind === 'main')!;
      assert.deepEqual(menu.items, [{ label: 'שקיות נייר', href: '/collections/שקיות-נייר' }, { label: 'אינסטגרם', href: 'https://instagram.com/sagabot' }]);
      assert.equal(menu.store_id, store().id);
      await noSideScroll(st, 'the menus on a phone');
    });

    await step('design: a draft, published as version 1; version 2; version 1 comes back; a preview link opens in a new window', async () => {
      await st.goto(`${BASE}/store/design`, { waitUntil: 'domcontentloaded' });
      await st.getByText(/עוד לא פורסם עיצוב/).waitFor({ timeout: 60_000 });
      const hero = st.locator('li', { has: st.getByRole('button', { name: 'פתיח', exact: true }) });
      await hero.getByLabel('כותרת', { exact: true }).fill('השקית שלכם, הלוגו שלכם');
      await st.getByRole('switch', { name: 'להציג: תמונה וטקסט' }).click();
      await st.getByRole('button', { name: 'להזיז למעלה: יצירת קשר' }).click();
      await st.getByLabel('כפתורים').fill('#123456');
      await st.getByRole('button', { name: 'שמירת טיוטה' }).click();
      await st.getByText(/הטיוטה נשמרה/).waitFor();
      const versions = () => fake.tables.store_theme_versions ?? [];
      assert.deepEqual(versions().map((v) => [v.version, v.status]), [[1, 'draft']]);
      const saved = versions()[0].settings;
      assert.equal(saved.colors.primary, '#123456');
      assert.equal(saved.sections.find((x: any) => x.id === 'hero').settings.title, 'השקית שלכם, הלוגו שלכם');
      assert.equal(saved.sections.find((x: any) => x.id === 'about').hidden, true);
      assert.deepEqual(saved.sections.map((x: any) => x.id).slice(-2), ['contact', 'faq'], 'contact moved above the questions');
      const refreshesBefore = refreshes;
      await st.getByRole('button', { name: 'פרסום באתר' }).click();
      await st.getByText('גרסה 1 פורסמה באתר.').waitFor();
      assert.deepEqual(versions().map((v) => [v.version, v.status]), [[1, 'published']]);
      for (let i = 0; i < 30 && refreshes === refreshesBefore; i++) await st.waitForTimeout(100);
      assert.equal(refreshes, refreshesBefore + 1, '2.74: the storefront is asked to refresh, once');

      await hero.getByLabel('כותרת', { exact: true }).fill('גרסה שנייה');
      await st.getByRole('button', { name: 'פרסום באתר' }).click();
      await st.getByText('גרסה 2 פורסמה באתר.').waitFor();
      assert.deepEqual(versions().map((v) => [v.version, v.status]).sort(), [[1, 'archived'], [2, 'published']]);
      await block(st, 'גרסאות').getByRole('button', { name: 'להחזיר לאתר' }).click();
      await st.getByText('גרסה 1 חזרה לאתר.').waitFor();
      assert.deepEqual(versions().map((v) => [v.version, v.status]).sort(), [[1, 'published'], [2, 'archived']]);

      const [popup] = await Promise.all([st.waitForEvent('popup'), st.getByRole('button', { name: 'תצוגה מקדימה של הטיוטה' }).click()]);
      await popup.waitForURL(/^https:\/\/storefront\.test\/\?preview=/);
      assert.ok(popup.url().includes(store().id), 'the store worked in now');
      await popup.close();
      await noSideScroll(st, 'the design on a phone');
      await st.screenshot({ path: path.join(SHOTS, 'c9-store-design-phone.png'), fullPage: true });
    });

    await step('"לחץ לעריכה" (2.61): the store in a frame — a title edited on the page is saved as the draft, a section opens its panel, the menus their editor', async () => {
      await st.goto(`${BASE}/store/design`, { waitUntil: 'domcontentloaded' });
      await st.getByRole('button', { name: '✏️ עריכה על האתר' }).click();
      await st.getByRole('heading', { name: 'עריכה על האתר' }).waitFor();
      const frame = st.frameLocator('iframe[title^="האתר"]');
      await frame.locator('#title').waitFor();
      assert.match(frameLoads.at(-1)!, /^https:\/\/storefront\.test\/\?edit=/, 'the frame opens with the edit token');
      const versions = () => fake.tables.store_theme_versions ?? [];
      const draft = () => versions().find((v) => v.status === 'draft');
      // a message from anywhere but the frame changes nothing
      await st.evaluate(() => window.postMessage({ type: 'text', section: 'hero', field: 'title', value: 'זיוף' }, '*'));
      await tapFrame(st, '#title');
      await st.getByText('נשמר כטיוטה ✓').waitFor();
      // "נשמר כטיוטה ✓" is also the state before any change: wait for the save itself (half a second after the edit)
      const heroTitle = () => draft()?.settings.sections.find((x: any) => x.id === 'hero')?.settings.title;
      for (let i = 0; i < 100 && heroTitle() !== 'כותרת שנערכה באתר'; i++) await st.waitForTimeout(100);
      assert.equal(heroTitle(), 'כותרת שנערכה באתר');
      assert.equal(versions().find((v) => v.status === 'published')!.version, 1, 'the site keeps the published version');
      // a section: its panel; moved down — the page moves it at once (no new frame), the draft is saved behind it (2.65)
      const loads = frameLoads.length;
      const before = draft()!.settings.sections.map((x: any) => x.id);
      const order = () => draft()!.settings.sections.map((x: any) => x.id).join(',');
      const got = () => frame.locator('body').evaluate(() => (window as any).got as any[]);
      const savedAs = async (want: (ids: string[]) => boolean) => { for (let i = 0; i < 100 && !want(order().split(',')); i++) await st.waitForTimeout(100); };
      await tapFrame(st, '#steps');
      await st.getByRole('heading', { name: 'איך זה עובד' }).waitFor();
      await st.getByRole('button', { name: 'להזיז למטה' }).click();
      await savedAs((ids) => ids.indexOf('steps') === before.indexOf('steps') + 1);
      const ids = order().split(',');
      assert.equal(ids.indexOf('steps'), before.indexOf('steps') + 1, 'the steps moved one down');
      assert.ok((await got()).some((m: any) => m.type === 'move' && m.id === 'steps'), 'the page was told to move it');
      assert.equal(frameLoads.length, loads, 'no new frame');
      // dragged on the page to the top: the page says where, the dashboard moves it and tells the page
      await tapFrame(st, '#drop');
      await savedAs((ids) => ids[0] === 'steps');
      assert.equal(order().split(',')[0], 'steps', 'dropped first');
      assert.ok((await got()).some((m: any) => m.type === 'move' && m.id === 'steps' && m.to === 0));
      // undo / redo: back to where it was, and forward again — saved as the draft, the page's content swapped in place
      await st.getByRole('button', { name: /ביטול הפעולה האחרונה/ }).click();
      await savedAs((ids) => ids.indexOf('steps') === before.indexOf('steps') + 1);
      assert.equal(order().split(',').indexOf('steps'), before.indexOf('steps') + 1, 'undo');
      await st.keyboard.press('Control+Shift+Z');
      await savedAs((ids) => ids[0] === 'steps');
      assert.equal(order().split(',')[0], 'steps', 'redo (the keyboard)');
      for (let i = 0; i < 50 && !(await got()).some((m: any) => m.type === 'rerender'); i++) await st.waitForTimeout(100);
      assert.ok((await got()).some((m: any) => m.type === 'rerender'), 'the page swaps its content after the save');
      assert.equal(frameLoads.length, loads, 'still no new frame');
      // the panel's list: dragged with the keyboard (space, an arrow, space) — the hero to the second place
      await st.getByRole('button', { name: 'סגירה' }).first().click();
      const handle = st.getByRole('button', { name: 'גרירת "פתיח"' });
      await handle.focus();
      const heroAt = order().split(',').indexOf('hero');
      await handle.scrollIntoViewIfNeeded();   // as a person sees it: the list in view while it moves
      for (const key of ['Space', 'ArrowDown', 'Space']) { await st.keyboard.press(key); await st.waitForTimeout(400); }
      await savedAs((ids) => ids.indexOf('hero') === heroAt + 1);
      assert.equal(order().split(',').indexOf('hero'), heroAt + 1, 'moved one down by the keyboard');
      // 2.66 (PR-3b): a tablet's width; a section hidden on a phone; "עיצוב כללי" — on the page at once ("style"), then saved
      await st.getByRole('button', { name: 'טאבלט' }).click();
      // 2.70: a tablet's real width (820), scaled down to the phone's space — the whole page, smaller
      const tab = st.locator('iframe[title^="האתר"]');
      assert.equal(await tab.evaluate((f: HTMLIFrameElement) => f.style.width), '820px');
      assert.ok(Number(await tab.getAttribute('data-scale')) < 0.5, 'scaled down on a phone');
      assert.equal(await frame.locator('body').evaluate(() => window.innerWidth), 820, 'the page sees a tablet');
      await tapFrame(st, '#steps');   // a finger on the smaller page: where the button is seen
      await st.getByRole('heading', { name: 'איך זה עובד' }).waitFor();
      await st.getByRole('button', { name: '✓ טלפון' }).click();
      const stepsHidden = () => draft()!.settings.sections.find((x: any) => x.id === 'steps')?.hiddenOn;
      for (let i = 0; i < 100 && !stepsHidden(); i++) await st.waitForTimeout(100);
      assert.deepEqual(stepsHidden(), ['base'], 'hidden on a phone only');
      await st.getByRole('button', { name: 'סגירה' }).first().click();
      // on a phone the panel is below the site (its other copy, beside it, is hidden): the visible one
      await st.locator('summary:visible', { hasText: 'עיצוב כללי' }).click();
      await st.getByLabel('ראש האתר').locator('visible=true').selectOption('compact');
      for (let i = 0; i < 50 && !(await got()).some((m: any) => m.type === 'style'); i++) await st.waitForTimeout(100);
      const style = (await got()).find((m: any) => m.type === 'style');
      assert.match(style.classes, /\bv-h-compact\b/, 'the page gets the header class at once');
      for (let i = 0; i < 100 && draft()!.settings.chrome?.header !== 'compact'; i++) await st.waitForTimeout(100);
      assert.deepEqual(draft()!.settings.chrome, { header: 'compact' }, 'saved as the business\'s choice');
      assert.equal(await st.getByRole('button', { name: 'שכפול' }).count(), 0, 'a closed template: no duplicating');
      await noSideScroll(st, 'the visual editor on a phone');
      await st.screenshot({ path: path.join(SHOTS, 'c9b-visual-editor-phone.png'), fullPage: true });
      // another page of the store; then the menus open their own editor
      await tapFrame(st, '#go');
      await st.waitForFunction(() => (document.querySelector('iframe[title^="האתר"]') as HTMLIFrameElement | null)?.src.includes('/collections/all?edit='));
      // "פרסום באתר": the draft goes on the air (a version, as in the classic editor)
      await st.getByRole('button', { name: 'פרסום באתר' }).click();
      await st.getByText(/גרסה \d+ פורסמה באתר\./).waitFor();
      assert.equal(draft(), undefined, 'no draft left');
      await tapFrame(st, '#menu');
      await st.waitForURL(/\/store\/navigation$/);
    });

    await step('starter kits (2.58): the gallery; a kit is applied as a draft — it creates what is missing and asks before replacing', async () => {
      await st.goto(`${BASE}/store/design?kits=1`, { waitUntil: 'domcontentloaded' });
      await st.getByRole('heading', { name: 'ערכות הקמה' }).waitFor({ timeout: 60_000 });
      await st.locator('li', { has: st.getByText('ביוטי וקליניקה', { exact: true }) }).getByRole('button', { name: 'ערכה מלאה' }).click();
      await st.getByRole('heading', { name: 'ערכת "ביוטי וקליניקה"' }).waitFor();
      const menu = () => fake.tables.store_menus.find((m) => m.kind === 'main')!.items;
      const mainBefore = structuredClone(menu());
      const published = fake.tables.store_theme_versions.find((v) => v.status === 'published')!;
      const items = fake.tables.catalog_items.length;
      // the main menu the business made is asked about — and stays, unless ticked
      await st.getByText('להחליף את התפריט הראשי').waitFor();
      await noSideScroll(st, 'a kit\'s plan on a phone');
      await st.screenshot({ path: path.join(SHOTS, 'c9b-store-kit-plan-phone.png'), fullPage: true });
      const calls = fake.applyKitCalls;
      await st.getByRole('button', { name: 'החלת הערכה (כטיוטה)' }).click();
      await st.getByText('האתר מוכן — עכשיו מוסיפים מוצרים.').waitFor();
      assert.equal(fake.applyKitCalls, calls + 1, '2.73: the whole kit in one call (store_apply_kit — one transaction)');
      assert.deepEqual(menu(), mainBefore, 'not ticked: the business\'s menu stays');
      const draft = fake.tables.store_theme_versions.find((v) => v.status === 'draft')!;
      assert.deepEqual([draft.template, draft.settings.kit, draft.note], ['kit', 'beauty', 'ערכה: ביוטי וקליניקה'], 'the kit is a draft');
      assert.equal(fake.tables.store_theme_versions.find((v) => v.status === 'published')!.id, published.id, 'the site keeps the published version');
      assert.equal(fake.tables.store_pages.find((g) => g.slug === 'treatments')?.published, false, 'its pages are drafts');
      assert.equal(fake.tables.catalog_items.length, items, 'no product');
      await st.getByText(/ערכה: ביוטי וקליניקה/).first().waitFor();
      // 2.62: the hero has no picture of the business — the editor says the kit's picture is on the site, not "אין"
      await st.goto(`${BASE}/store/design`, { waitUntil: 'domcontentloaded' });
      // (the hero is the section the editor opens with)
      await st.getByText('באתר מוצגת עכשיו תמונה של הערכה. תמונה שתעלו תחליף אותה.').waitFor({ timeout: 60_000 });
      await st.getByText('של הערכה', { exact: true }).waitFor();
      // 2.63: the design choices — the kit's shown as "(של הערכה)"; the business's choice is the only thing saved, and goes back
      const look = block(st, 'עיצוב האתר');
      const header = look.getByLabel('ראש האתר');
      assert.equal(await header.inputValue(), 'centered-logo', 'the beauty kit\'s header');
      await header.selectOption('transparent-overlay');
      await st.getByRole('button', { name: 'שמירת טיוטה' }).click();
      await st.getByText(/הטיוטה נשמרה/).waitFor();
      const saved = () => fake.tables.store_theme_versions.find((v) => v.status === 'draft')!.settings;
      assert.deepEqual(saved().chrome, { header: 'transparent-overlay' }, 'only what the business picked');
      assert.equal(saved().design, undefined, 'nothing else of the design');
      await look.getByRole('button', { name: 'חזרה לברירת המחדל של הערכה' }).click();
      assert.equal(await header.inputValue(), 'centered-logo');
      await st.getByRole('button', { name: 'שמירת טיוטה' }).click();
      await st.waitForFunction(() => !document.body.textContent?.includes('יש שינויים שלא נשמרו'));
      for (let i = 0; i < 50 && saved().chrome !== undefined; i++) await st.waitForTimeout(100);
      assert.equal(saved().chrome, undefined, 'back to the kit\'s: nothing saved');
      // a section's layout: the hero, the kit's "editorial"
      assert.equal(await st.getByLabel('פריסה').first().inputValue(), 'editorial');
      // 2.64 (PR-2): a kit's preview opens the store in that kit (nothing saved); "החלפת עיצוב" writes the look only
      await st.goto(`${BASE}/store/design?kits=1`, { waitUntil: 'domcontentloaded' });
      await st.getByRole('heading', { name: 'ערכות הקמה' }).waitFor({ timeout: 60_000 });
      const fashionCard = st.locator('li').filter({ hasText: /^אופנה/ });   // its name first (a badge may follow it)
      const versionsBefore = fake.tables.store_theme_versions.length;
      const [pop] = await Promise.all([st.waitForEvent('popup'), fashionCard.getByRole('button', { name: 'תצוגה מקדימה' }).click()]);
      await pop.waitForURL(/^https:\/\/storefront\.test\/\?preview=.*&kit=fashion&kitmode=design$/);
      await pop.close();
      assert.equal(fake.tables.store_theme_versions.length, versionsBefore, 'a preview saves nothing');
      const counts = () => JSON.stringify([fake.tables.store_pages.length, fake.tables.catalog_collections?.length ?? 0, fake.tables.store_menus.map((m) => m.items)]);
      const before = counts();
      await fashionCard.getByRole('button', { name: 'החלפת עיצוב' }).click();
      await st.getByRole('heading', { name: 'החלפת עיצוב: "אופנה"' }).waitFor();
      await st.getByText('מה נשאר כמו שהוא').waitFor();
      await st.getByText('להחליף את טיוטת העיצוב').click();
      // a database before migration 3900 (no store_apply_kit): the steps of 2.58, the same result
      fake.applyKitRpc = false;
      const callsBefore = fake.applyKitCalls;
      await st.getByRole('button', { name: 'החלפת העיצוב (כטיוטה)' }).click();
      await st.getByText('האתר מוכן — עכשיו מוסיפים מוצרים.').waitFor();
      assert.equal(fake.applyKitCalls, callsBefore, 'written step by step');
      fake.applyKitRpc = true;
      const drafted = fake.tables.store_theme_versions.find((v) => v.status === 'draft')!;
      assert.deepEqual([drafted.template, drafted.settings.kit, drafted.note], ['kit', 'fashion', 'עיצוב: אופנה']);
      assert.equal(drafted.settings.sections.find((x: any) => x.id === 'treatments')?.type, 'imageText', 'the home page stays the store\'s (the beauty sections)');
      assert.equal(counts(), before, 'no page, collection or menu written');
      // the menus screen names a link to what is not on the site
      await st.goto(`${BASE}/store/navigation`, { waitUntil: 'domcontentloaded' });
      await st.getByRole('heading', { name: 'תפריטים', exact: true }).waitFor({ timeout: 60_000 });
      // the kit's footer was created (the business had none): its pages are drafts, so their links are named
      await block(st, 'קישורים שלא מופיעים באתר').getByText('הטיפולים', { exact: false }).first().waitFor();
      // back to the published version for the steps below: the draft of the kit is replaced by a new edit later, or stays
    });

    await step('a free section (2.67): added in the visual editor with columns; a block clicked on the page opens its fields; blocks move between columns', async () => {
      await st.goto(`${BASE}/store/design`, { waitUntil: 'domcontentloaded' });
      await st.getByRole('button', { name: '✏️ עריכה על האתר' }).click();
      await st.getByRole('heading', { name: 'עריכה על האתר' }).waitFor({ timeout: 60_000 });
      const frame = st.frameLocator('iframe[title^="האתר"]');
      await frame.locator('#block').waitFor();
      const draft = () => fake.tables.store_theme_versions.find((v) => v.status === 'draft');
      const free = () => draft()?.settings.sections.find((x: any) => x.id === 'custom-2');
      const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await st.waitForTimeout(100); assert.ok(ok()); };
      // 2.69 (PR-3e): "+ חלק חדש" opens the library — by category, a picture for each kind
      await st.getByRole('button', { name: '+ חלק חדש' }).locator('visible=true').click();
      await st.getByText('בסוף עמוד הבית', { exact: false }).locator('visible=true').waitFor();
      assert.ok(await st.locator('img[src="/section-previews/custom.jpg"]').locator('visible=true').count() === 1);
      await st.screenshot({ path: path.join(SHOTS, 'c9d-add-gallery-phone.png'), fullPage: true });
      await st.getByRole('button', { name: 'הוספת חלק חופשי (עמודות)' }).locator('visible=true').click();
      await st.getByRole('heading', { name: 'חלק חופשי (עמודות)' }).waitFor();
      await until(() => Boolean(free()));
      assert.deepEqual(free().columns.map((c: any) => [c.id, c.span, c.blocks.map((b: any) => b.type)]),
        [['c1', 6, ['heading', 'paragraph', 'button']], ['c2', 6, ['image']]], 'words and a button beside a picture');
      // a block clicked on the page: its fields here; a text typed is saved as the draft
      await tapFrame(st, '#block');
      await st.getByRole('heading', { name: 'בלוק: פסקה' }).waitFor();
      await st.getByLabel('הטקסט').fill('מה שחשוב לדעת עלינו.');
      await until(() => free()?.columns[0].blocks[1].settings.text === 'מה שחשוב לדעת עלינו.');
      // a link that is not right: said here, never saved as is (the storefront's check)
      await st.getByRole('button', { name: '← לעמודות' }).click();
      await st.getByRole('button', { name: /^כפתור/ }).click();
      await st.getByLabel('לאן הוא מוביל').fill('javascript:alert(1)');
      await st.getByText('הקישור לא תקין — הכפתור לא יופיע עד שיתוקן.').waitFor();
      await st.getByLabel('לאן הוא מוביל').fill('/collections/all');
      await st.getByRole('button', { name: '← לעמודות' }).click();
      // a third column, a third of the row; the picture dragged into it with the keyboard (space, an arrow, space)
      await st.getByRole('button', { name: '+ עמודה' }).click();
      await until(() => free()?.columns.length === 3);
      // 2.70: a width per screen — half on a phone (side by side), two thirds on a tablet
      await st.getByLabel('הרוחב של עמודה 1 (טלפון)').selectOption('6');
      await until(() => free()?.columns[0].spanBase === 6);
      await st.getByRole('button', { name: 'עיצוב לטאבלט' }).click();
      await st.getByLabel('הרוחב של עמודה 1 (טאבלט)').selectOption('8');
      await until(() => free()?.columns[0].span === 8);
      assert.equal(free().columns[0].spanBase, 6, 'the phone\'s stays');
      await st.getByRole('button', { name: 'עיצוב לטלפון' }).click();
      const handle = st.getByRole('button', { name: 'גרירת "תמונה"' });
      await handle.scrollIntoViewIfNeeded();
      await handle.focus();
      for (const key of ['Space', 'ArrowDown', 'Space']) { await st.keyboard.press(key); await st.waitForTimeout(400); }
      await until(() => free()?.columns[2].blocks.some((b: any) => b.type === 'image'));
      assert.deepEqual(free().columns.map((c: any) => c.blocks.length), [3, 0, 1], 'from its column into the empty one');
      // a new block at the end of a column, then undo: one step back
      await st.getByLabel('בלוק חדש בעמודה 2').selectOption('badge');
      await st.getByRole('button', { name: 'הוספת בלוק לעמודה 2' }).click();
      await st.getByRole('heading', { name: 'בלוק: תגית' }).waitFor();
      await until(() => free()?.columns[1].blocks[0]?.type === 'badge');
      await st.getByRole('button', { name: /ביטול הפעולה האחרונה/ }).click();
      await until(() => free()?.columns[1].blocks.length === 0);
      const got = await frame.locator('body').evaluate(() => (window as any).got as any[]);
      assert.ok(got.some((m: any) => m.type === 'select' && m.id === 'custom-2' && m.block), 'the page is told which block is open');
      // 2.68 (PR-3d): the section's own design — on the page at once ("sectionStyle"), then saved; a tablet its own, and back
      await st.getByLabel('ריווח למעלה ולמטה (טלפון)').selectOption('l');
      await until(() => free()?.style?.padY === 'l');
      const sx = async () => ((await frame.locator('body').evaluate(() => (window as any).got as any[])).filter((m: any) => m.type === 'sectionStyle').at(-1));
      assert.deepEqual(await sx(), { type: 'sectionStyle', id: 'custom-2', classes: ['sx-py-l'] });
      await st.getByRole('button', { name: 'עיצוב לטאבלט' }).click();
      assert.equal(await st.locator('iframe[title^="האתר"]').evaluate((f: HTMLIFrameElement) => f.style.width), '820px', 'the site in a tablet\'s width');
      await st.getByLabel('רקע (טאבלט)').selectOption('dark');
      await until(() => free()?.responsive?.md?.surface === 'dark');
      assert.deepEqual((await sx()).classes, ['sx-py-l', 'sx-md-sf-dark']);
      await st.getByText('• רק בטאבלט').waitFor();
      await st.getByRole('button', { name: /^חזרה לטלפון/ }).click();
      await until(() => free()?.responsive === undefined);
      assert.deepEqual(free().style, { padY: 'l' }, 'the phone\'s stays');
      await st.getByRole('button', { name: 'עיצוב לטלפון' }).click();
      // "+ חלק חדש כאן" on the page (after the hero): the library, then the section right there, with its starting words
      const gotNow = await frame.locator('body').evaluate(() => (window as any).got as any[]);
      assert.ok(gotNow.some((m: any) => m.type === 'config' && m.add === true), 'the page was told sections may be added');
      await tapFrame(st, '#add');
      await st.getByText('אחרי "פתיח"', { exact: false }).waitFor();
      await st.getByRole('button', { name: 'הוספת שאלות נפוצות' }).click();
      await st.getByRole('heading', { name: 'שאלות נפוצות' }).waitFor();
      await until(() => draft()!.settings.sections.findIndex((x: any) => x.id === 'faq-2') === draft()!.settings.sections.findIndex((x: any) => x.id === 'hero') + 1);
      const faq = draft()!.settings.sections.find((x: any) => x.id === 'faq-2');
      assert.ok(faq.settings.items.length > 0 && faq.settings.title, 'with words to start from (the kit\'s, or the library\'s)');
      // 2.71 (the spec's 39–40): the footer's look in its own panel; the product card in a products section
      await st.getByRole('button', { name: 'סגירה' }).first().click();
      await st.getByRole('button', { name: 'עיצוב התחתית' }).locator('visible=true').click();
      await st.getByRole('heading', { name: 'תחתית האתר' }).waitFor();
      await st.getByRole('button', { name: 'עריכת הקישורים בתחתית' }).waitFor();
      await st.getByLabel('תחתית האתר').selectOption('dark');
      await until(() => draft()!.settings.chrome?.footer === 'dark');
      await st.getByRole('button', { name: 'סגירה' }).first().click();
      await st.getByRole('button', { name: /^מוצרים נבחרים/ }).locator('visible=true').first().click();
      await st.getByLabel('כרטיס מוצר').selectOption('compact');
      await until(() => draft()!.settings.commerce?.productCard === 'compact');
      const styled = (await frame.locator('body').evaluate(() => (window as any).got as any[])).filter((m: any) => m.type === 'style').at(-1);
      assert.match(styled.classes, /\bv-pc-compact\b/, 'the page is told at once');
      await noSideScroll(st, 'the free section\'s panel on a phone');
      await st.screenshot({ path: path.join(SHOTS, 'c9c-blocks-phone.png'), fullPage: true });
    });

    await step('on the air: only with the checklist complete — the domain counts once the storefront served it', async () => {
      await st.goto(`${BASE}/store/settings`, { waitUntil: 'domcontentloaded' });
      const check = block(st, 'לפני שעולים לאוויר');
      await check.getByText('כתובת פעילה (הכתובת של החנות או דומיין משלכם) — חסר').waitFor({ timeout: 60_000 });
      for (const ok of ['מדיניות ביטולים והחזרות — קיים', 'מדיניות פרטיות — קיים', 'הצהרת נגישות — קיים', 'לפחות מוצר אחד באתר — קיים']) await check.getByText(ok).waitFor();
      assert.equal(await st.getByRole('button', { name: 'העלאת החנות לאוויר' }).isDisabled(), true);
      // the storefront served followmecollection.com (sf_domain_seen): DNS and the certificate work
      Object.assign(fake.tables.store_domains.find((d) => d.is_primary)!, { status: 'active', last_seen_at: new Date().toISOString() });
      await st.reload({ waitUntil: 'domcontentloaded' });
      await block(st, 'דומיין').getByText('פעיל', { exact: true }).waitFor({ timeout: 60_000 });
      await block(st, 'לפני שעולים לאוויר').getByText('כתובת פעילה (הכתובת של החנות או דומיין משלכם) — קיים').waitFor();
      await st.getByRole('button', { name: 'העלאת החנות לאוויר' }).click();
      await st.getByText('החנות באוויר.', { exact: true }).first().waitFor();
      assert.equal(store().status, 'published');
      assert.ok(store().published_at);
      await st.goto(`${BASE}/store/products`, { waitUntil: 'domcontentloaded' });
      await st.getByText(/^החנות באוויר: מוצר שמסומן "באתר" מוצג בה/).waitFor({ timeout: 60_000 });
      await st.screenshot({ path: path.join(SHOTS, 'c10-store-live-phone.png') });
    });

    await step('stage 3 — selling (test): a PayPlus test terminal, pickup and delivery, then the switch', async () => {
      await st.goto(`${BASE}/store/selling`, { waitUntil: 'domcontentloaded' });
      // 2.57: real sales stay closed until the platform's switch (commerce_live) — the screen says so, and stays in test
      await st.getByText(/^מכירה אמיתית עוד סגורה במערכת/).waitFor({ timeout: 60_000 });
      await block(st, 'מיילים ללקוחות').getByLabel('הדומיין שממנו יוצאים המיילים').waitFor();
      const sw = block(st, 'המכירה באתר');
      await sw.getByText('חיבור מסוף סליקה (PayPlus, סביבת בדיקה)').waitFor();
      assert.equal(await sw.getByRole('switch').isDisabled(), true, 'not before a terminal and a way to get the goods');
      const term = block(st, 'מסוף סליקה — PayPlus (סביבת בדיקה)');
      await term.getByLabel('API key').fill('abcd-1234-efgh');
      await term.getByLabel('Secret key').fill('abcd-1234-efgh');
      await term.getByLabel('Payment page UID').fill('1b2c3d4e-0000-4000-8000-1234567890ab');
      await term.getByRole('button', { name: 'חיבור המסוף' }).click();
      await term.getByText(/שני ערכים שונים/).waitFor();
      assert.equal((fake.tables.payment_accounts ?? []).length, 0, 'nothing saved');
      await term.getByLabel('Secret key').fill('zzzz-9999-yyyy');
      await term.getByRole('button', { name: 'חיבור המסוף' }).click();
      await term.getByText('מחובר', { exact: true }).waitFor();
      await term.getByText(/מפתח שמסתיים ב-\s*efgh/).waitFor();
      assert.equal(await term.getByLabel('Secret key').count(), 0, 'the keys are not shown again');
      assert.ok(!(await st.content()).includes('zzzz-9999-yyyy'), 'the secret is nowhere on the page');
      const ship = block(st, 'איך מקבלים את ההזמנה');
      await ship.getByRole('switch', { name: 'איסוף עצמי' }).click();
      await ship.getByLabel('איפה ומתי אוספים').fill('דיזנגוף 10, תל אביב');
      await ship.getByRole('switch', { name: 'משלוח עד הבית' }).click();
      await ship.getByLabel('מחיר משלוח (₪)').fill('30');
      await ship.getByLabel('משלוח חינם מעל (₪, לא חובה)').fill('300');
      await ship.getByRole('button', { name: 'שמירה' }).click();
      await st.getByText('נשמר.', { exact: true }).waitFor();
      assert.deepEqual([store().pickup_enabled, store().pickup_note, store().delivery_enabled, Number(store().delivery_price), Number(store().free_delivery_over)],
        [true, 'דיזנגוף 10, תל אביב', true, 30, 300]);
      await sw.getByRole('switch').click();
      await st.getByText(/^המכירה באתר פעילה \(בדיקה\)/).waitFor();
      assert.equal(store().checkout_enabled, true);
      await noSideScroll(st, 'selling on a phone');
      await st.screenshot({ path: path.join(SHOTS, 'c11-store-selling-phone.png'), fullPage: true });
    });

    await step('a coupon: 10% until a date; the database counts its uses; switched off with one tap', async () => {
      await st.goto(`${BASE}/store/coupons`, { waitUntil: 'domcontentloaded' });
      const nw = block(st, 'קופון חדש');
      await nw.getByLabel('קוד').fill('welcome10');
      await nw.getByLabel('כמה אחוזים').fill('10');
      await nw.getByLabel('בתוקף עד (לא חובה)').fill('2099-12-31');
      await nw.getByRole('button', { name: 'שמירת הקופון' }).click();
      await st.getByText('הקופון WELCOME10 נשמר.').waitFor();
      const c = fake.tables.store_coupons.find((x) => x.code === 'WELCOME10')!;
      assert.equal(c.kind, 'percent'); assert.equal(Number(c.value), 10); assert.equal(c.store_id, store().id);
      const list = block(st, 'הקופונים');
      await list.getByText('10% הנחה', { exact: false }).waitFor();
      await list.getByRole('switch', { name: 'קופון WELCOME10 פעיל' }).click();
      await list.getByText('כבוי', { exact: true }).waitFor();
      assert.equal(fake.tables.store_coupons.find((x) => x.code === 'WELCOME10')!.active, false);
    });

    await step('orders: a test order from the site — its sum, its customer, its lines and its timeline; read only', async () => {
      const id = randomUUID();
      fake.tables.orders = [{ id, business_id: BIZ, store_id: store().id, number: 1001, is_test: true, payment_status: 'test_paid', fulfillment_status: 'unfulfilled',
        currency: 'ILS', subtotal: 240, discount: 24, shipping: 30, total: 246, coupon_code: 'WELCOME10', customer_name: 'דנה כהן', customer_phone: '0501234567',
        customer_email: 'dana@example.com', delivery_method: 'delivery', address: { city: 'תל אביב', street: 'הרצל', house: '5', apartment: '' }, notes: 'בבקשה להשאיר ליד הדלת',
        provider: 'payplus', created_at: '2026-10-06T09:00:00Z', paid_at: '2026-10-06T09:03:00Z', expires_at: '2026-10-06T09:15:00Z' },
        { id: randomUUID(), business_id: BIZ, store_id: store().id, number: 1002, is_test: true, payment_status: 'failed', currency: 'ILS', subtotal: 120, discount: 0,
          shipping: 0, total: 120, coupon_code: '', customer_name: 'בני', customer_phone: '0521111111', customer_email: 'b@example.com', delivery_method: 'pickup',
          address: {}, notes: '', provider: 'payplus', created_at: '2026-10-06T10:00:00Z', paid_at: null, expires_at: '2026-10-06T10:15:00Z' }];
      fake.tables.order_lines = [{ id: randomUUID(), order_id: id, business_id: BIZ, name: 'חולצת כותנה', variant_label: 'M / שחור', sku: 'TS-M-B', unit_price: 120, qty: 2, line_total: 240, image_url: '', position: 1 }];
      fake.tables.order_events = [
        { id: 1, order_id: id, business_id: BIZ, kind: 'created', data: {}, at: '2026-10-06T09:00:00Z' },
        { id: 2, order_id: id, business_id: BIZ, kind: 'payment_page', data: {}, at: '2026-10-06T09:00:02Z' },
        { id: 3, order_id: id, business_id: BIZ, kind: 'test_paid', data: { txn: 't-1', amount: 246, late: false }, at: '2026-10-06T09:03:00Z' }];
      await st.goto(`${BASE}/store/orders`, { waitUntil: 'domcontentloaded' });
      await st.getByText('#1001 · דנה כהן').waitFor({ timeout: 60_000 });
      await st.getByText('שולם (בדיקה)').first().waitFor();
      await st.getByRole('tab', { name: 'לא שולמו' }).click();
      await st.getByText('#1002 · בני').waitFor();
      assert.equal(await st.getByText('#1001 · דנה כהן').count(), 0);
      await st.getByRole('tab', { name: 'הכול' }).click();
      await st.getByText('#1001 · דנה כהן').click();
      await st.waitForURL(new RegExp(`/store/orders/${id}$`));
      await st.getByText('הזמנת בדיקה: לא חויב כסף, לא נוצרה מכירה, המלאי לא זז ולא הופק מסמך.').waitFor({ timeout: 60_000 });
      await st.getByText('2 × חולצת כותנה — M / שחור').waitFor();
      await st.getByText(/משלוח: הרצל 5, תל אביב/).waitFor();
      await st.getByText(/התשלום אושר ע״י חברת הסליקה \(סביבת בדיקה\)/).waitFor();
      assert.equal(await st.getByRole('button', { name: /שולם|החזר|ביטול/ }).count(), 0, 'nothing here changes an order');
      await noSideScroll(st, 'an order on a phone');
      await st.screenshot({ path: path.join(SHOTS, 'c12-store-order-phone.png'), fullPage: true });
    });

    await step('stage 4 — a real order: its document blocked (the reason, "נסו שוב"), the customer\'s request, shipped with tracking, a refund only after confirming', async () => {
      const id = randomUUID(), sale = id;
      fake.tables.orders.push({ id, business_id: BIZ, store_id: store().id, number: 1003, is_test: false, payment_status: 'paid', fulfillment_status: 'unfulfilled',
        document_status: 'blocked', document_error: 'חסרים פרטי העסק למסמכים (מספר עוסק בן 9 ספרות) — ממלאים ב"הגדרות".', sale_id: sale, lead_id: randomUUID(),
        request_kind: 'cancel', request_note: 'הזמנתי בטעות', requested_at: '2026-10-06T11:10:00Z', refunded_total: 0, tracking_number: '', tracking_url: '',
        stock_short: [{ name: 'חולצת כותנה', variant: 'L / לבן', qty: 1, available: 0 }],
        currency: 'ILS', subtotal: 120, discount: 0, shipping: 30, total: 150, coupon_code: '', customer_name: 'נועה לוי', customer_phone: '0547777777',
        customer_email: 'noa@example.com', delivery_method: 'delivery', address: { city: 'חיפה', street: 'הנביאים', house: '3', apartment: '' }, notes: '',
        provider: 'payplus', created_at: '2026-10-06T11:00:00Z', paid_at: '2026-10-06T11:02:00Z', expires_at: '2026-10-06T11:15:00Z' });
      fake.tables.order_lines.push({ id: randomUUID(), order_id: id, business_id: BIZ, name: 'חולצת כותנה', variant_label: 'L / לבן', sku: 'TS-L-W', unit_price: 120, qty: 1, line_total: 120, image_url: '', position: 1 });
      fake.tables.order_events.push({ id: 50, order_id: id, business_id: BIZ, kind: 'paid', data: { late: true, short: true }, at: '2026-10-06T11:02:00Z' },
        { id: 51, order_id: id, business_id: BIZ, kind: 'sale_recorded', data: {}, at: '2026-10-06T11:02:05Z' },
        { id: 52, order_id: id, business_id: BIZ, kind: 'document_blocked', data: { error: 'חסרים פרטי העסק' }, at: '2026-10-06T11:02:06Z' });
      fake.tables.email_outbox = [{ id: randomUUID(), business_id: BIZ, order_id: id, kind: 'order_confirmation', ref: '', status: 'sent', last_error: '', sent_at: '2026-10-06T11:02:10Z', created_at: '2026-10-06T11:02:00Z' }];
      fake.tables.sales.push({ id: sale, business_id: BIZ, user_id: OWNER, channel: 'online', status: 'paid', method: 'card', subtotal: 150, discount: 0, total: 150, vat_rate: 18, vat_amount: 22.88,
        items: [{ name: 'חולצת כותנה — L / לבן', price: 120, qty: 1, kind: 'product' }, { name: 'משלוח', price: 30, qty: 1, kind: 'service' }], created_at: '2026-10-06T11:02:05Z', paid_at: '2026-10-06T11:02:00Z' });
      await st.goto(`${BASE}/store/orders/${id}`, { waitUntil: 'domcontentloaded' });
      await st.getByText(/חסרים פרטי העסק למסמכים/).first().waitFor({ timeout: 60_000 });
      await block(st, 'מסמך').getByRole('button', { name: 'נסו שוב' }).waitFor();
      await st.getByText(/הלקוח ביקש לבטל את ההזמנה .*הזמנתי בטעות/).waitFor();
      // 2.79: paid after its hold ran out, and the shirt was gone by then — said on the order and in its timeline
      await st.getByText(/חסר במלאי: חולצת כותנה \(L \/ לבן\) — הוזמנה 1, אין\./).waitFor();
      await st.getByText(/אחרי שזמן השמירה עבר, וחסר מלאי/).waitFor();
      await block(st, 'מיילים ללקוח').getByText(/נשלח ✓/).waitFor();
      // shipped, with its tracking: the customer gets an email (queued — "נשלח" only with the provider's id)
      const ful = block(st, 'טיפול בהזמנה');
      await ful.getByLabel('מצב').selectOption('shipped');
      await ful.getByLabel('קישור למעקב (לא חובה)').fill('http://track');
      await ful.getByRole('button', { name: 'שמירה' }).click();
      await ful.getByText('קישור המעקב צריך להתחיל ב-https://').waitFor();
      await ful.getByLabel('מספר מעקב (לא חובה)').fill('RR123IL');
      await ful.getByLabel('קישור למעקב (לא חובה)').fill('https://track.example/RR123IL');
      await ful.getByRole('button', { name: 'שמירה' }).click();
      await ful.getByText('נשלח.', { exact: true }).or(ful.getByText(/עכשיו: נשלח/)).first().waitFor();
      const o = fake.tables.orders.find((x) => x.id === id)!;
      assert.deepEqual([o.fulfillment_status, o.tracking_number], ['shipped', 'RR123IL']);
      await block(st, 'מיילים ללקוח').getByText('ממתין לשליחה').waitFor();
      // a refund: nothing until the owner confirms it was done at the payment company
      const rf = block(st, 'החזר');
      await rf.getByText('אפשר להחזיר עד ₪150').waitFor();
      assert.equal(await rf.getByRole('button', { name: 'רישום ההחזר' }).isDisabled(), true, 'not before the confirmation');
      await rf.getByRole('checkbox', { name: /ההחזר בוצע בממשק של חברת הסליקה/ }).check();
      assert.equal(await rf.getByRole('button', { name: 'רישום ההחזר' }).isDisabled(), false);
      await noSideScroll(st, 'a real order on a phone');
      await st.screenshot({ path: path.join(SHOTS, 'c12b-store-order-live-phone.png'), fullPage: true });
    });

    await step('the register: units held for an order on the site are shown, and not sold here', async () => {
      const cream = fake.tables.catalog_items.find((i) => i.id === CREAM)!;
      fake.tables.stock_reservations = [{ id: randomUUID(), business_id: BIZ, order_id: randomUUID(), item_id: CREAM, variant_id: null, qty: Number(cream.stock_qty),
        status: 'held', expires_at: new Date(Date.now() + 10 * 60_000).toISOString() }];
      const before = Number(cream.stock_qty), sales = fake.tables.sales.length;
      const { ctx, page: r } = await open({ access: 'full', userId: OWNER, path: '/register' });
      try {
        await tile(r, 'קרם לחות').waitFor({ timeout: 120_000 });
        await tile(r, 'קרם לחות').getByText(`שמור להזמנה באתר: ${before}`).waitFor();
        await tile(r, 'קרם לחות').click();
        await pay(r).click();
        await dialog(r).getByRole('button', { name: 'אשראי' }).click();
        await r.getByText(/קרם לחות: היחידות שמורות להזמנה באתר/).first().waitFor();
        assert.equal(fake.tables.sales.length, sales, 'no sale');
        assert.equal(Number(cream.stock_qty), before, 'the stock did not move');
        await r.screenshot({ path: path.join(SHOTS, 'c13-register-held.png') });
      } finally { await ctx.close(); fake.tables.stock_reservations = []; }
    });
  } finally { await st.context().close(); current = null; }

  await step('a cashier: sells a size / colour, never reaches the store or its editor', async () => {
    const { ctx, page: p } = await open({ access: 'register', userId: CASHIER, path: '/store/products' });
    try {
      await p.waitForURL(/\/register$/, { timeout: 120_000 });
      const nav = p.getByRole('complementary', { name: 'ניווט ראשי' });
      assert.deepEqual(await nav.getByRole('link').allInnerTexts(), ['קופה'], 'no "חנות" for a cashier');
      await tile(p, 'חולצת כותנה').waitFor({ timeout: 60_000 });
      await p.getByRole('button', { name: 'הכל', exact: true }).click().catch(() => undefined);
      await tile(p, 'חולצת כותנה').click();
      await dialog(p).getByRole('button', { name: /M \/ שחור/ }).click();
      await pay(p).click();
      await dialog(p).getByRole('button', { name: 'אשראי' }).click();
      await dialog(p).getByText('העסקה נשמרה').waitFor();
      assert.equal(fake.tables.sales.at(-1)!.items[0].variantId, variant('M / שחור')!.id);
      assert.equal(await p.getByRole('switch').count(), 0, 'no "באתר" in the cashier\'s register');
      await p.goto(`${BASE}/store/settings`, { waitUntil: 'domcontentloaded' });
      await p.waitForURL(/\/register$/, { timeout: 60_000 });
    } finally { await ctx.close(); }
  });

  await step('no errors in the browser', async () => { assert.deepEqual(errors, []); });

  await browser.close();
  try { process.kill(-dev.pid!, 'SIGTERM'); } catch { dev.kill('SIGTERM'); }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n# e2e commerce: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
