/**
 * Dream Commerce stage 1 (2.54) in a real browser (Chromium via Playwright), against the in-memory Supabase of
 * fake-supabase.ts. The stage's phone check, clicked through: a product with sizes and colours is created in the store,
 * counted, described (✨ AI — a suggestion that is approved), given a picture (sizes made in the browser, a signed upload),
 * published; then the register sells one size of it — by its tile and by its barcode, through a held sale and a reload —
 * and the stock of THAT size moves. A cashier sells variants and never reaches the store.
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

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_COMMERCE_PORT ?? 3219);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-000000000001';
const OWNER = 'a0000000-0000-4000-8000-0000000000a1';
const CASHIER = 'c0000000-0000-4000-8000-0000000000c1';
const CREAM = 'f0000000-0000-4000-8000-0000000000f1';
const PHONE = { width: 390, height: 844 };
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

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const pw: any = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.js' as string));
  const { chromium } = pw.default ?? pw;
  const dev = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: 'http://sb.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-test-key', NEXT_TELEMETRY_DISABLED: '1' },
  });
  const results: { name: string; ok: boolean; error?: string }[] = [];
  const browser = await (async () => { await waitForServer(dev); return chromium.launch(); })();
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@sagabot.test' });
  const errors: string[] = [];
  const aiRequests: any[] = [];
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
