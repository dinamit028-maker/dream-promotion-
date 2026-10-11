/**
 * Stock by location (docs/FINANCE_ADDITIONS_HE.md T12ב; 2.92) in a real browser (Chromium via Playwright), against the in-memory
 * Supabase of fake-supabase.ts. The rules themselves are tested on Postgres (tests/sql/stock-locations.check.sql, concurrency.sh §18,
 * stock-compare.sh); a business with one location is compared picture by picture in single-location.e2e.ts. Here the screens are
 * clicked through:
 *   before migration 4700 the stock screen says so; "מלאי" is in the menu (after "קופה") with more than one location;
 *   "לפי סניף": every location's count and the total, low stock at a location with a transfer from where there is to spare;
 *   a transfer from that suggestion: on the way, received with a gap and its reason; another one cancelled (the units go back);
 *   a count of a location: a line found by its barcode, a sale after the line does not count against it, the summary, the owner
 *   approves and only then the difference moves;
 *   the register at a branch: the branch's units, a delivery there, the history says where; a unit held for the site is held at the
 *   store's location only (the branch sells it, the main register does not);
 *   the product editor receives at a location picked; the store sells from the location set for its orders;
 *   a phone: the stock screen fits; a member limited to the branch: its stock only, counts without the owner's approval.
 *
 * Run: npx -y tsx tests/e2e/stock-locations.e2e.ts   (starts `next dev` on port 3227; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (stk* — not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_STOCK_PORT ?? 3227);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000000e7';
const OWNER = 'a0000000-0000-4000-8000-0000000000e7';
const L2 = 'c0000000-0000-4000-8000-0000000000e2';     // סניף חיפה (a branch, with its register)
const L3 = 'c0000000-0000-4000-8000-0000000000e3';     // מחסן (a warehouse, no register)
const R2 = 'd0000000-0000-4000-8000-0000000000e2';
const CREAM = 'f0000000-0000-4000-8000-0000000000e1';
const SHIRT = 'f0000000-0000-4000-8000-0000000000e2';
const S = 'f1000000-0000-4000-8000-0000000000e1';
const M = 'f1000000-0000-4000-8000-0000000000e2';
const STORE = '5a000000-0000-4000-8000-0000000000e7';
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  const place = (id: string, name: string, kind: string, sort: number) => ({ id, business_id: BIZ, name, kind, address: '', phone: '', hours: '', active: true, sort, created_at: `2026-01-0${sort + 1}T00:00:00Z` });
  return {
    brands: [{ ...base, name: 'קליניקה לייט', onboarded: true, industry: 'קוסמטיקה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'company', vat_rate: 18, pay_link: '', dealer_number: '515123456', legal_name: 'קליניקה לייט בע״מ',
      street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [], business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }],
    business_locations: [place(BIZ, 'ראשי', 'store', 0), place(L2, 'סניף חיפה', 'branch', 1), place(L3, 'מחסן', 'warehouse', 2)],
    registers: [{ id: BIZ, business_id: BIZ, location_id: BIZ, name: 'קופה 1', device: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' },
      { id: R2, business_id: BIZ, location_id: L2, name: 'קופה 1', device: '', active: true, sort: 0, created_at: '2026-01-02T00:00:00Z' }],
    // 10 creams: 9 at the main location, 1 at the branch (its alert level is 2); shirts S 4 and M 1, all at the main location
    catalog_items: [
      { ...base, id: CREAM, name: 'קרם לחות', price: 120, kind: 'product', active: true, sort: 0, favorite: true, fav_order: 0, image_url: '', track_stock: true, stock_qty: 10, low_stock: 2,
        has_variants: false, sku: 'CR-1', barcode: '7290000000011' },
      { ...base, id: SHIRT, name: 'חולצה', price: 90, kind: 'product', active: true, sort: 1, favorite: true, fav_order: 1, image_url: '', track_stock: true, stock_qty: 5, low_stock: 1,
        has_variants: true, sku: 'SH', barcode: '' },
    ],
    catalog_variants: [
      { ...base, id: S, item_id: SHIRT, option1: 'S', option2: '', option3: '', price: null, online_price: null, sku: 'SH-S', barcode: '7290000000028', low_stock: null, active: true, position: 0, stock_qty: 4, media_id: null },
      { ...base, id: M, item_id: SHIRT, option1: 'M', option2: '', option3: '', price: null, online_price: null, sku: 'SH-M', barcode: '', low_stock: null, active: true, position: 1, stock_qty: 1, media_id: null },
    ],
    catalog_options: [{ ...base, id: 'f2000000-0000-4000-8000-0000000000e1', item_id: SHIRT, position: 1, name: 'מידה', values: ['S', 'M'] }],
    stock_levels: [{ business_id: BIZ, location_id: L2, item_id: CREAM, variant_id: null, qty: 1, updated_at: '2026-01-01T00:00:00Z' }],
    stock_transfers: [], stock_counts: [], stock_reservations: [], stock_movements: [],
    stores: [{ ...base, id: STORE, name: 'החנות של קליניקה לייט', status: 'draft', template: 'kit', lang: 'he', logo_url: '', description: '', phone: '', whatsapp: '', email: '', address: '',
      ga4_id: '', gsc_code: '', show_stock_count: false, slug: 'clinic-lite', storefront_password: '', password_lock: false, location_id: null, updated_at: '2026-01-01T00:00:00Z' }],
    store_domains: [], store_theme_versions: [], store_pages: [], store_menus: [],
    employees: [], leads: [], sales: [], register_shifts: [], booking_services: [], appointments: [],
    documents: [], payments: [], expenses: [], sale_refunds: [], content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [],
    push_subscriptions: [], quotes: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [],
    payment_requests: [], payment_plans: [], payment_plan_items: [], client_packages: [], client_package_uses: [], client_sessions: [], client_treatments: [], treatment_types: [],
    catalog_media: [], catalog_field_defs: [], catalog_collections: [],
    tax_allocation_rules: [{ version: 4, effective_from: '2026-06-01', threshold_before_vat: 5000, doc_types: [305, 320], requires_customer_dealer: true, verified: false, source_note: 'מקורות משניים' }],
  };
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
  if (process.env.E2E_DEV_LOG) { const { createWriteStream } = await import('node:fs'); const log = createWriteStream(process.env.E2E_DEV_LOG); dev.stdout?.pipe(log); dev.stderr?.pipe(log); }
  const results: { name: string; ok: boolean; error?: string }[] = [];
  const browser = await (async () => { await waitForServer(dev); return chromium.launch(); })();
  for (const p of ['/stock', '/register', '/store/settings']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@clinic.test' });
  const errors: string[] = [];
  const said: string[] = [];          // window.alert / confirm / prompt texts
  const answers: string[] = [];       // what to type into the next window.prompt
  const calls: string[] = [];

  async function context(viewport: { width: number; height: number }) {
    const phone = viewport.width < 600;
    const ctx = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@clinic.test'))]);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    await ctx.route('http://sb.test/**', async (route: any) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const where = `${req.method()} ${req.url().replace('http://sb.test', '').slice(0, 140)}`;
      try {
        const r = fake.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
        calls.push(`${r.status} ${where}${r.status >= 400 ? ` ${String(r.body ?? '').slice(0, 160)}` : ''}`); calls.splice(0, calls.length - 14);
        return route.fulfill({ status: r.status, body: r.body ?? '', headers: { ...(r.headers ?? {}), ...cors } });
      } catch (e: any) {
        calls.push(`THROW ${where}: ${e?.message}`);
        return route.fulfill({ status: 500, json: { message: `fake: ${e?.message}` }, headers: cors });
      }
    });
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'קליניקה לייט', state: 'active' },
      businesses: [{ id: BIZ, name: 'קליניקה לייט', state: 'active' }], superAdmin: false, access: 'full' } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
    await ctx.route(`${BASE}/api/notify/sale`, (r: any) => r.fulfill({ json: { sent: 0 } }));
    await ctx.route(`${BASE}/api/finance/tax/status`, (r: any) => r.fulfill({ json: { mode: 'unconfigured', configured: false, connection: null, message: 'החיבור לרשות המסים לא הוגדר.' } }));
    await ctx.route(`${BASE}/api/client-file/**`, (r: any) => r.fulfill({ status: 403, json: { code: 'no_access', message: 'אין גישה' } }));
    await ctx.route(`${BASE}/api/store/domains`, (r: any) => r.fulfill({ json: { domains: [], vercel: 'not_configured' } }));
    await ctx.route(`${BASE}/api/store/revalidate`, (r: any) => r.fulfill({ json: { ok: true } }));
    await ctx.route(`${BASE}/api/store/preview-token`, (r: any) => r.fulfill({ json: { url: 'https://storefront.test/?preview=x', expires: 2_000_000_000, token: 'x', base: 'https://storefront.test' } }));
    await ctx.route(`${BASE}/api/store/payments`, (r: any) => r.fulfill({ json: { connected: false, provider: null, mode: null, hint: '', connectedAt: null, ready: false, liveOpen: false, verifiedAt: null, linksLive: false } }));
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(e.message));
    page.on('dialog', (d: any) => { said.push(d.message()); return d.type() === 'prompt' && answers.length ? d.accept(answers.shift()) : d.accept(); });
    return { ctx, page };
  }
  const { page } = await context(DESK);
  const goto = async (to: string, p: any = page) => {
    try { return await p.goto(`${BASE}${to}`, { waitUntil: 'domcontentloaded' }); }
    catch (e: any) { if (!/ERR_ABORTED/.test(String(e?.message))) throw e; return p.goto(`${BASE}${to}`, { waitUntil: 'domcontentloaded' }); }
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    for (let i = 0; i < 4 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('the step did not end in 150s')), 150_000); });
    try { await Promise.race([fn(), late]); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false, error: e.message }); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}\n  last requests:\n    ${calls.join('\n    ')}`);
      await page.screenshot({ path: path.join(SHOTS, `stk-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
    finally { clearTimeout(timer); }
  };
  const dialog = (p: any = page) => p.getByRole('dialog').last();
  const shot = async (name: string, p: any = page) => { await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, name) }); };
  const stockReady = async (p: any = page) => { await p.getByRole('heading', { name: /^(מלאי|ספירת מלאי)$/ }).waitFor({ timeout: 120_000 }); };
  const tabIn = async (label: string, p: any = page) => { await p.getByRole('tab', { name: label }).click(); await p.waitForTimeout(300); };
  const registerReady = async (p: any = page) => {
    await p.getByRole('heading', { name: 'קופה' }).waitFor({ timeout: 120_000 });
    await p.locator('section button', { hasText: 'קרם לחות' }).first().waitFor({ timeout: 60_000 });
  };
  const regTab = async (label: string, p: any = page) => { await p.getByRole('button', { name: new RegExp(`^${label}`) }).first().click(); await p.waitForTimeout(400); };
  const at = (loc: string, item: string, variant: string | null = null) => fake.stockAt(loc, item, variant);
  /** the device stands at this register (remembered on the device, as the picker does) */
  const standAt = async (id: string, p: any = page) => { await p.evaluate(([k, v]: string[]) => localStorage.setItem(k, v), [`dp-register:${BIZ}`, id]); };
  /** a cash sale of one cream at the register this device stands at */
  const sellCream = async (p: any = page) => {
    await p.locator('section button', { hasText: 'קרם לחות' }).first().click();
    await p.getByRole('button', { name: /^לתשלום — / }).click();
    await dialog(p).getByRole('button', { name: 'מזומן' }).click();
    await dialog(p).getByRole('button', { name: 'בדיוק' }).click();
    await dialog(p).getByRole('button', { name: 'אישור' }).click();
  };
  /** nothing sideways, every control on the screen */
  const fits = async (p: any, what: string) => {
    const bad: string[] = await p.evaluate(`(() => {
      const w = window.innerWidth, out = [];
      if (document.documentElement.scrollWidth > w + 1) out.push('the page scrolls sideways: ' + document.documentElement.scrollWidth);
      const shown = function (e) { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const inScroller = function (e) { for (let p = e.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
      Array.from(document.querySelectorAll('button, a, input, select, textarea')).filter(function (e) { return shown(e) && !inScroller(e); })
        .filter(function (e) { const b = e.getBoundingClientRect(); return b.left < -1 || b.right > w + 1; })
        .forEach(function (e) { out.push('off screen: "' + (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30) + '"'); });
      return out.slice(0, 8);
    })()`);
    assert.deepEqual(bad, [], `${what}: ${bad.join(' · ')}`);
  };
  /** the table of "לפי סניף": a product's row → its cells (each location, then the total) */
  const rowOf = async (name: string) => (await page.locator('tbody tr', { has: page.locator('td', { hasText: new RegExp(`^${name}$`) }) }).first().locator('td').allTextContents()).slice(1);

  try {
    await step('before migration 4700: the stock screen says so', async () => {
      fake.stockTables = false;
      await goto('/stock');
      await page.getByText('מלאי לפי סניף עוד לא הופעל במסד הנתונים (מיגרציה 20261011004700).').waitFor({ timeout: 120_000 });
      fake.stockTables = true;
    });

    await step('"מלאי" is in the menu right after "קופה"; "לפי סניף": every location\'s count and the total', async () => {
      await goto('/stock');
      await stockReady();
      const menu = await page.locator('aside nav a').allTextContents();
      const k = menu.indexOf('קופה');
      assert.ok(k >= 0 && menu[k + 1] === 'מלאי', `the menu: ${menu.join(' · ')}`);
      assert.deepEqual(await page.getByRole('tab').allTextContents(), ['לפי סניף', 'העברות', 'ספירות']);
      await page.locator('thead th', { hasText: 'מחסן' }).waitFor();
      assert.deepEqual(await page.locator('thead th').allTextContents(), ['מוצר', 'ראשי', 'סניף חיפה', 'מחסן', 'סה״כ']);
      assert.deepEqual(await rowOf('קרם לחות'), ['9', '1', '0', '10']);
      assert.deepEqual(await rowOf('S'), ['4', '0', '0', '4'], 'a variant: its own row');
      // low stock where it is low — and where to bring it from
      await page.getByText('⚠️ מלאי נמוך').waitFor();
      const branch = page.locator('li', { hasText: 'קרם לחות · סניף חיפה' }).first();
      await branch.getByText('נשארו 1').waitFor();
      await branch.getByRole('button', { name: 'להעביר 2 מראשי' }).waitFor();
      await page.locator('li', { hasText: 'קרם לחות · מחסן' }).first().getByRole('button', { name: 'להעביר 3 מראשי' }).waitFor();
      await shot('stk1-by-location.png');
    });

    await step('a transfer from the suggestion: on the way, then received with a gap and its reason', async () => {
      await page.locator('li', { hasText: 'קרם לחות · סניף חיפה' }).first().getByRole('button', { name: 'להעביר 2 מראשי' }).click();
      const d = dialog();
      await d.getByRole('heading', { name: 'העברה חדשה' }).waitFor();
      assert.equal(await d.getByLabel('מ', { exact: true }).inputValue(), BIZ);
      assert.equal(await d.getByLabel('אל', { exact: true }).inputValue(), L2);
      assert.equal(await d.getByLabel('כמה: קרם לחות').inputValue(), '2');
      await d.getByRole('button', { name: 'שליחה' }).click();
      await page.getByText('העברה 1 נשלחה — היחידות בדרך.').waitFor();
      const t = fake.tables.stock_transfers[0];
      assert.deepEqual([t.number, t.status, t.from_location, t.to_location, t.lines.map((l: any) => [l.name, l.qty])], [1, 'sent', BIZ, L2, [['קרם לחות', 2]]]);
      assert.deepEqual([at(BIZ, CREAM), at(L2, CREAM)], [7, 1], 'the units left the main location; the branch does not have them yet');
      const card = page.locator('div.p-3', { hasText: 'העברה 1 · מראשי אל סניף חיפה' }).first();
      await card.getByText('בדרך').waitFor();
      await card.getByRole('button', { name: 'קבלה בסניף חיפה' }).click();
      const r = dialog();
      await r.getByRole('heading', { name: 'קבלת העברה 1' }).waitFor();
      await r.getByLabel('הגיעו: קרם לחות').fill('1');
      await r.getByRole('button', { name: 'אישור קבלה' }).click();
      await r.getByRole('alert').waitFor();                         // a gap needs its reason
      assert.equal(fake.tables.stock_transfers[0].status, 'sent');
      await r.getByLabel('למה: קרם לחות').fill('נשבר בדרך');
      await r.getByRole('button', { name: 'אישור קבלה' }).click();
      await page.getByText('העברה 1 התקבלה — פער אחד נרשם.').waitFor();
      assert.equal(fake.tables.stock_transfers[0].status, 'received');
      assert.deepEqual([at(BIZ, CREAM), at(L2, CREAM), fake.tables.catalog_items.find((i) => i.id === CREAM)!.stock_qty], [7, 2, 9]);
      const moves = fake.tables.stock_movements.filter((m) => m.transfer_id === t.id).map((m) => [m.reason, m.location_id, m.delta, m.location_after]);
      assert.deepEqual(moves, [['transfer', BIZ, -2, 7], ['transfer', L2, 2, 3], ['adjust', L2, -1, 2]], 'a move on each side, and the gap with its reason');
      assert.match(fake.tables.stock_movements.find((m) => m.reason === 'adjust')!.note, /פער בהעברה 1: נשבר בדרך/);
      await card.getByText('התקבלה').first().waitFor();
      await card.getByText('2 · הגיעו 1 — נשבר בדרך').waitFor();
      await shot('stk2-transfer-received.png');
      // the note that goes with the goods: internal, not a tax document
      const [note] = await Promise.all([page.waitForEvent('popup'), card.getByRole('button', { name: '🖨️ תעודת העברה' }).click()]);
      await note.waitForFunction(() => document.body?.innerHTML.includes('תעודת העברה פנימית'), null, { timeout: 30_000 });
      const html = await note.content();
      assert.match(html, /קליניקה לייט — תעודת העברה פנימית מס׳ 1/);
      assert.match(html, /לא מסמך מס · התקבלה/);
      assert.match(html, /ראשי.*סניף חיפה/s);
      assert.match(html, /נשבר בדרך/);
      await note.close();
    });

    await step('a transfer cancelled before it arrives: the units go back', async () => {
      await page.getByRole('button', { name: '+ העברה חדשה' }).click();
      const d = dialog();
      await d.getByLabel('אל', { exact: true }).selectOption({ label: 'מחסן' });
      // each product with what the source has of it
      const options = await d.getByLabel('מוצר להעברה').locator('option').allTextContents();
      assert.ok(options.includes('חולצה · S (4)') && options.includes('קרם לחות (7)'), options.join(' | '));
      await d.getByLabel('מוצר להעברה').selectOption(`${SHIRT}|${S}`);
      await d.getByRole('button', { name: 'הוספה' }).click();
      await d.getByLabel('כמה: חולצה · S').fill('3');
      await d.getByRole('button', { name: 'שליחה' }).click();
      await page.getByText('העברה 2 נשלחה — היחידות בדרך.').waitFor();
      assert.deepEqual([at(BIZ, SHIRT, S), at(BIZ, SHIRT)], [1, 2]);
      answers.push('טעות בסניף');
      await page.locator('div.p-3', { hasText: 'העברה 2 · מראשי אל מחסן' }).first().getByRole('button', { name: 'ביטול העברה' }).click();
      await page.getByText('העברה 2 בוטלה — היחידות חזרו לראשי.').waitFor();
      assert.deepEqual([fake.tables.stock_transfers[1].status, fake.tables.stock_transfers[1].cancel_reason, at(BIZ, SHIRT, S), at(L3, SHIRT, S)], ['cancelled', 'טעות בסניף', 4, 0]);
    });

    await step('a count of the branch: a line by its barcode, a sale after it does not count against it; the owner approves', async () => {
      await tabIn('ספירות');
      await page.getByRole('button', { name: '+ ספירה חדשה' }).click();
      const d = dialog();
      await d.getByLabel('איפה סופרים').selectOption({ label: 'סניף חיפה' });
      await d.getByRole('button', { name: 'פתיחת הספירה' }).click();
      await page.getByRole('heading', { name: 'ספירה 1 · סניף חיפה' }).waitFor();
      // the barcode scanner types the code and Enter: the cream's line
      await page.getByLabel('ברקוד או מק״ט').fill('7290000000011');
      await page.getByLabel('ברקוד או מק״ט').press('Enter');
      await page.getByText('נמצא: קרם לחות').waitFor();
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'נספרו: קרם לחות', 'the line is ready to type');
      await page.keyboard.type('5');
      await page.keyboard.press('Enter');                               // saved (blur)
      await page.getByText(/^1 מתוך \d+ נספרו/).waitFor();
      const c = fake.tables.stock_counts[0];
      assert.equal(Object.values(c.lines as Record<string, any>)[0].counted, 5);
      assert.equal(c.status, 'open');
      // a sale at the branch after the line was counted: the count is of that moment, so the sale is not a gap
      await new Promise((r) => setTimeout(r, 20));
      fake.handle('POST', 'http://sb.test/rest/v1/sales', {}, JSON.stringify({ id: 'e7000000-0000-4000-8000-000000000001', user_id: OWNER, register_id: R2, channel: 'pos',
        items: [{ name: 'קרם לחות', price: 120, qty: 1, itemId: CREAM }], subtotal: 120, discount: 0, total: 120, vat_rate: 18, vat_amount: 18.31, method: 'cash', status: 'paid', payments: [] }));
      assert.equal(at(L2, CREAM), 1);
      await page.getByRole('button', { name: 'סיכום פערים' }).click();
      await page.getByText('נספרו 5 · במערכת 2').waitFor();
      assert.deepEqual([at(L2, CREAM), fake.tables.stock_counts[0].status], [1, 'open'], 'nothing moves before the owner approves');
      await shot('stk3-count-summary.png');
      await page.getByRole('button', { name: 'אישור ורישום הפערים' }).click();
      await page.getByText('ספירה 1 אושרה — פער אחד נרשם.').waitFor();
      assert.deepEqual([at(L2, CREAM), fake.tables.stock_counts[0].status], [4, 'approved'], 'the 5 counted, less the one sold after');
      const m = fake.tables.stock_movements.filter((x) => x.count_id === c.id).map((x) => [x.reason, x.location_id, x.delta]);
      assert.deepEqual(m, [['count', L2, 3]]);
      await page.getByText('1 פערים נרשמו').waitFor();
    });

    await step('the register at the branch: its units, a delivery there, the history says where', async () => {
      await goto('/register');
      await standAt(R2);
      await goto('/register');
      await registerReady();
      await regTab('מחירון ומלאי');
      await page.getByText('הכמויות כאן הן של סניף חיפה (הסניף של הקופה).').waitFor();
      const card = page.locator('div.p-3', { hasText: 'קרם לחות' }).first();
      await card.getByText('📦 במלאי 4').waitFor();
      answers.push('3', 'ספק א');
      await card.getByRole('button', { name: '+ קבלת סחורה' }).click();
      await card.getByText('📦 במלאי 7').waitFor();
      assert.ok(said.some((s) => s === 'כמה יחידות של "קרם לחות" התקבלו בסניף חיפה?'), said.join(' | '));
      assert.deepEqual([at(L2, CREAM), at(BIZ, CREAM)], [7, 7], 'the delivery is the branch\'s');
      await card.getByRole('button', { name: 'היסטוריה' }).click();
      const h = dialog();
      await h.getByText(/קבלת סחורה · סניף חיפה · ספק א/).waitFor();
      await h.getByText('נשארו 7').first().waitFor();
      await h.getByText(/ספירת מלאי · סניף חיפה/).waitFor();
      await shot('stk4-register-history.png');
      await page.keyboard.press('Escape');
      // the link to the stock screen
      await page.getByRole('link', { name: /מלאי בכל הסניפים, העברות וספירות/ }).waitFor();
    });

    await step('units held for the site are held at the store\'s location only: the branch sells, the main register does not', async () => {
      fake.tables.stock_reservations.push({ id: 'e7100000-0000-4000-8000-000000000001', business_id: BIZ, order_id: 'e7200000-0000-4000-8000-000000000001', item_id: CREAM, variant_id: null,
        qty: 7, status: 'held', expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), created_at: new Date().toISOString() });
      await regTab('מכירה');
      await sellCream();
      await dialog().getByText('העסקה נשמרה').waitFor();
      assert.deepEqual([at(L2, CREAM), at(BIZ, CREAM)], [6, 7], 'the branch sold its own unit');
      await dialog().getByRole('button', { name: 'עסקה חדשה' }).click();
      await page.getByLabel('הקופה של המכשיר הזה').selectOption({ label: 'קופה 1 · ראשי' });
      await page.waitForTimeout(500);
      await sellCream();
      await dialog().getByText(/היחידות שמורות להזמנה באתר/).waitFor();
      assert.equal(at(BIZ, CREAM), 7, 'all 7 at the main location are held for the site');
      await page.keyboard.press('Escape');
      fake.tables.stock_reservations.length = 0;
    });

    await step('the product editor receives at a location picked; the total and the location are shown', async () => {
      await regTab('מחירון ומלאי');
      await page.locator('div.p-3', { hasText: 'קרם לחות' }).first().getByRole('button', { name: 'עריכה: קרם לחות' }).click();
      const d = dialog();
      await d.getByLabel('הסניף של קבלה וספירה').waitFor({ timeout: 60_000 });
      await d.getByLabel('הסניף של קבלה וספירה').selectOption({ label: 'מחסן' });
      await d.getByText('📦 אזל במחסן · סה״כ 13').waitFor();
      await d.getByLabel('כמות: קרם לחות').fill('4');
      await d.getByRole('button', { name: '+ קבלה' }).first().click();
      await d.getByText('נוספו 4 יחידות במחסן ✓').waitFor();
      await d.getByText('📦 במלאי 4 במחסן · סה״כ 17').waitFor();
      assert.deepEqual([at(L3, CREAM), at(BIZ, CREAM), at(L2, CREAM)], [4, 7, 6]);
      await shot('stk5-editor.png');
      await page.keyboard.press('Escape');
    });

    await step('the store sells from the location set for its orders', async () => {
      await goto('/store/settings');
      await page.getByRole('heading', { name: 'המלאי של האתר' }).waitFor({ timeout: 120_000 });
      const pick = page.getByLabel('המלאי של האתר — מסניף');
      assert.equal(await pick.inputValue(), BIZ, 'none set: the main location');
      await pick.selectOption({ label: 'סניף חיפה' });
      await page.getByRole('button', { name: 'שמירת הפרטים' }).click();
      await page.getByText('נשמר.').waitFor();
      assert.equal(fake.tables.stores[0].location_id, L2);
      assert.equal(fake.shipLocation(), L2);
    });

    await step('a phone: the stock screen fits', async () => {
      const { ctx, page: p } = await context(PHONE);
      await goto('/stock', p);
      await stockReady(p);
      await p.locator('thead th', { hasText: 'מחסן' }).waitFor();
      await fits(p, 'the stock by location on a phone');
      await shot('stk6-phone-by-location.png', p);
      await tabIn('ספירות', p);
      await p.getByText('ספירה 1 · סניף חיפה').waitFor();
      await fits(p, 'the counts on a phone');
      await shot('stk6-phone-counts.png', p);
      await ctx.close();
    });

    await step('a member limited to the branch: its stock only, a count waits for the owner', async () => {
      fake.memberLocations = [L2];
      fake.owner = false;
      await goto('/stock');
      await page.getByRole('heading', { name: 'ספירת מלאי' }).waitFor({ timeout: 120_000 });
      assert.equal(await page.getByRole('tab').count(), 0, 'one location to work in: counts only');
      assert.equal(await page.locator('aside nav a', { hasText: /^מלאי$/ }).count(), 0, 'no "מלאי" in its menu');
      await page.getByText('ספירה 1').first().waitFor();
      await page.getByRole('button', { name: '+ ספירה חדשה' }).click();
      assert.equal(await dialog().getByLabel('איפה סופרים').count(), 0, 'its own location — nothing to choose');
      await dialog().getByRole('button', { name: 'פתיחת הספירה' }).click();
      await page.getByRole('heading', { name: 'ספירה 2' }).waitFor();
      assert.equal(fake.tables.stock_counts[1].location_id, L2);
      await page.getByLabel('נספרו: קרם לחות').fill('6');
      await page.getByLabel('נספרו: קרם לחות').press('Enter');
      await page.getByRole('button', { name: 'סיכום פערים' }).click();
      await page.getByText('רק הבעלים מאשרים ספירה. הספירה שמורה ומחכה לאישור.').waitFor();
      assert.equal(await page.getByRole('button', { name: 'אישור ורישום הפערים' }).count(), 0);
      // its register shows the branch's units
      await goto('/register');
      await registerReady();
      await regTab('מחירון ומלאי');
      await page.locator('div.p-3', { hasText: 'קרם לחות' }).first().getByText('📦 במלאי 6').waitFor();
      fake.memberLocations = null;
      fake.owner = true;
    });

    await step('no error in the browser', async () => { assert.deepEqual(errors, []); });
  } finally {
    await browser.close();
    try { process.kill(-dev.pid!, 'SIGTERM'); } catch { /* already gone */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
