/**
 * Advanced items and the comparison of locations (docs/FINANCE_ADDITIONS_HE.md T12ג + T12ד; 2.93) in a real browser (Chromium via
 * Playwright), against the in-memory Supabase of fake-supabase.ts. The rules themselves are tested on Postgres
 * (tests/sql/items-lists.check.sql, concurrency.sh §19, stock-compare.sh 4800); a business with one location is compared picture
 * by picture in single-location.e2e.ts. Here the screens are clicked through:
 *   before migration 4800 nothing of it is shown (the editor, the register, "מחירונים" says what is missing);
 *   the product editor: serial numbers on, units in by number (a scanner's lines), the list and a unit's history; "+ קבלה" is gone;
 *   a SKU from a series (a new one, made in the editor): the next free code — never one a product has;
 *   the register sells by number — the picker, a scanned number; a number sold elsewhere meanwhile is refused (the DoD: never twice);
 *   the sale's document names the numbers; a refund names the ones that came back (and they are in stock again);
 *   a transfer by number between locations, received with a number missing and its reason; a count does not list such a product;
 *   the stock screen finds a unit by its number, with its history;
 *   price lists: a customer group's and a location's — the register prices by the customer's group, else the branch's, else the base;
 *   a document's line too ("לפי מחירון …");
 *   "השוואת סניפים" in the reports: each location's revenue, profit, sales and stock — the same as the money screens;
 *   a phone: the price lists and the serial picker fit.
 *
 * Run: npx -y tsx tests/e2e/items.e2e.ts   (starts `next dev` on port 3228; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (itm* — not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';
import { ils } from '../../src/features/register/money';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_ITEMS_PORT ?? 3228);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000000f8';
const OWNER = 'a0000000-0000-4000-8000-0000000000f8';
const L2 = 'c0000000-0000-4000-8000-0000000000f2';     // סניף חיפה (a branch, with its register)
const R2 = 'd0000000-0000-4000-8000-0000000000f2';
const CREAM = 'f0000000-0000-4000-8000-0000000000f1';
const PHONE = 'f0000000-0000-4000-8000-0000000000f2';
const CASE = 'f0000000-0000-4000-8000-0000000000f3';
const DANA = 'e0000000-0000-4000-8000-0000000000f1';
const PHONE_VIEW = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  const place = (id: string, name: string, kind: string, sort: number) => ({ id, business_id: BIZ, name, kind, address: '', phone: '', hours: '', active: true, sort, created_at: `2026-01-0${sort + 1}T00:00:00Z` });
  const item = (id: string, name: string, price: number, sort: number, extra: Record<string, unknown> = {}) => ({ ...base, id, name, price, kind: 'product', active: true, sort, favorite: true,
    fav_order: sort, image_url: '', track_stock: true, stock_qty: 0, low_stock: 1, has_variants: false, sku: '', barcode: '', publish_online: false, track_serials: false, ...extra });
  return {
    brands: [{ ...base, name: 'תכשיטי לייט', onboarded: true, industry: 'תכשיטים', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'company', vat_rate: 18, pay_link: '', dealer_number: '515123456', legal_name: 'תכשיטי לייט בע״מ',
      street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [], business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }],
    business_locations: [place(BIZ, 'ראשי', 'store', 0), place(L2, 'סניף חיפה', 'branch', 1)],
    registers: [{ id: BIZ, business_id: BIZ, location_id: BIZ, name: 'קופה 1', device: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' },
      { id: R2, business_id: BIZ, location_id: L2, name: 'קופה 1', device: '', active: true, sort: 0, created_at: '2026-01-02T00:00:00Z' }],
    // 10 creams at the main location; a phone (serial numbers are turned on here) — and a case whose SKU is PH-0002
    catalog_items: [item(CREAM, 'קרם לחות', 120, 0, { stock_qty: 10, sku: 'CR-1', barcode: '7290000000011' }), item(PHONE, 'טלפון', 1500, 1, { barcode: '7290000000099' }),
      item(CASE, 'כיסוי', 50, 2, { sku: 'PH-0002', track_stock: false })],
    catalog_variants: [], catalog_options: [], stock_levels: [], stock_transfers: [], stock_counts: [], stock_reservations: [], stock_movements: [],
    catalog_serials: [], catalog_serial_events: [], price_lists: [], price_list_items: [], sku_series: [],
    leads: [{ ...base, id: DANA, name: 'דנה כהן', phone: '0521234567', source: 'ידני', status: 'חדש', date: '2026-01-01', tags: ['סיטונאי'], value: 0, notes: '' }],
    stores: [], store_domains: [], store_theme_versions: [], store_pages: [], store_menus: [],
    employees: [], sales: [], register_shifts: [], booking_services: [], appointments: [],
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
  for (const p of ['/register', '/prices', '/stock', '/finance/reports', '/finance/documents']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@jewels.test' });
  const errors: string[] = [];
  const said: string[] = [];
  const calls: string[] = [];

  async function context(viewport: { width: number; height: number }) {
    const phone = viewport.width < 600;
    const ctx = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@jewels.test'))]);
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
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'תכשיטי לייט', state: 'active' },
      businesses: [{ id: BIZ, name: 'תכשיטי לייט', state: 'active' }], superAdmin: false, access: 'full' } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
    await ctx.route(`${BASE}/api/notify/sale`, (r: any) => r.fulfill({ json: { sent: 0 } }));
    await ctx.route(`${BASE}/api/finance/tax/status`, (r: any) => r.fulfill({ json: { mode: 'unconfigured', configured: false, connection: null, message: 'החיבור לרשות המסים לא הוגדר.' } }));
    await ctx.route(`${BASE}/api/client-file/**`, (r: any) => r.fulfill({ status: 403, json: { code: 'no_access', message: 'אין גישה' } }));
    await ctx.route(`${BASE}/api/store/**`, (r: any) => r.fulfill({ json: { ok: true, domains: [], vercel: 'not_configured', connected: false } }));
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(e.message));
    page.on('dialog', (d: any) => { said.push(d.message()); return d.accept(); });
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
      await page.screenshot({ path: path.join(SHOTS, `itm-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
    finally { clearTimeout(timer); }
  };
  const dialog = (p: any = page) => p.getByRole('dialog').last();
  const shot = async (name: string, p: any = page) => { await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, name) }); };
  const registerReady = async (p: any = page) => {
    await p.getByRole('heading', { name: 'קופה' }).waitFor({ timeout: 120_000 });
    await p.locator('section button', { hasText: 'קרם לחות' }).first().waitFor({ timeout: 60_000 });
  };
  const regTab = async (label: string, p: any = page) => { await p.getByRole('button', { name: new RegExp(`^${label}`) }).first().click(); await p.waitForTimeout(400); };
  const tile = (name: string, p: any = page) => p.locator('section button', { hasText: name }).first();
  const standAt = async (id: string, p: any = page) => { await p.evaluate(([k, v]: string[]) => localStorage.setItem(k, v), [`dp-register:${BIZ}`, id]); };
  const serial = (s: string) => fake.tables.catalog_serials.find((x) => x.serial === s)!;
  const at = (loc: string, item: string) => fake.stockAt(loc, item, null);
  /** a field's value once the screen has set it (the answer of the database comes a moment after the click) */
  const valueIs = async (field: any, want: string, what: string) => {
    for (let i = 0; i < 50 && await field.inputValue() !== want; i++) await page.waitForTimeout(100);
    assert.equal(await field.inputValue(), want, what);
  };
  /** pay in cash, the exact amount — and the answer: the saved sale, or the error in the window */
  const payCash = async (p: any = page) => {
    await p.getByRole('button', { name: /^לתשלום — / }).click();
    await dialog(p).getByRole('button', { name: 'מזומן' }).click();
    await dialog(p).getByRole('button', { name: 'בדיוק' }).click();
    await dialog(p).getByRole('button', { name: 'אישור' }).click();
  };
  const openEditor = async (name: string) => {
    await goto('/register');
    await registerReady();
    await regTab('מחירון ומלאי');
    await page.locator('div.p-3', { hasText: name }).first().getByRole('button', { name: `עריכה: ${name}` }).click();
    await dialog().getByRole('heading', { name, exact: true }).waitFor({ timeout: 60_000 });
    return dialog();
  };
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

  try {
    await step('before migration 4800: no serial numbers, SKU series or price lists — and "מחירונים" says what is missing', async () => {
      fake.itemsTables = false;
      const ed = await openEditor('טלפון');
      await ed.getByRole('heading', { name: 'קודים ופרטים' }).waitFor();
      await page.waitForTimeout(800);
      assert.equal(await ed.getByRole('heading', { name: 'מספרים סידוריים' }).count(), 0, 'no serial numbers');
      assert.equal(await ed.getByRole('button', { name: 'מק״ט אוטומטי' }).count(), 0, 'no SKU series');
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('link', { name: /מחירונים/ }).count(), 0, 'no price lists in the register');
      await goto('/prices');
      await page.getByText('צריך להריץ את מיגרציה 20261011004800').waitFor({ timeout: 120_000 });
      fake.itemsTables = true;
    });

    await step('the product editor: serial numbers on, units in by number, the list and a unit\'s history', async () => {
      const ed = await openEditor('טלפון');
      const panel = ed.getByRole('region', { name: 'מספרים סידוריים' });
      await panel.waitFor();
      await panel.getByRole('switch', { name: 'מספר סידורי לכל יחידה' }).click();
      await panel.getByLabel('המספרים הסידוריים').waitFor();
      assert.equal(fake.tables.catalog_items.find((i) => i.id === PHONE)!.track_serials, true);
      assert.ok(said.some((m) => /לכל יחידה יהיה מספר משלה/.test(m)), 'asked first');
      // a scanner types every number and Enter
      await panel.getByLabel('המספרים הסידוריים').fill('A100\nA101\nA102\nA103\n');
      await panel.getByLabel('הערה לקליטה').fill('ספק אלקטרו');
      await panel.getByRole('button', { name: 'קליטה — יחידות חדשות' }).click();
      await ed.getByText('נקלטו 4 יחידות ✓ — במלאי 4').waitFor();
      assert.deepEqual(fake.tables.catalog_serials.map((x) => [x.serial, x.status, x.location_id]), ['A100', 'A101', 'A102', 'A103'].map((s) => [s, 'in_stock', BIZ]));
      assert.equal(at(BIZ, PHONE), 4);
      const moves = fake.tables.stock_movements.filter((m) => m.item_id === PHONE);
      assert.deepEqual(moves.map((m) => [m.reason, m.delta, m.note]), [['receive', 4, 'קליטה · A100, A101, A102, A103 · ספק אלקטרו']]);
      await panel.locator('li[data-serial="A101"]').getByRole('button', { name: 'היסטוריה' }).click();
      await panel.getByRole('list', { name: 'ההיסטוריה של A101' }).getByText(/נקלט · .*ספק אלקטרו/).waitFor();
      // a delivery without numbers is gone — only "קליטה עם מספרים"
      assert.equal(await ed.getByRole('button', { name: '+ קבלה' }).count(), 0, 'no "+ קבלה" for a product with numbers');
      assert.equal(await ed.getByRole('switch', { name: 'פרסם באתר' }).isDisabled(), true, 'not on the site');
      await shot('itm1-serials.png');
    });

    await step('a SKU from a series made in the editor: the next free code — never one a product has', async () => {
      const ed = await openEditor('טלפון');
      await ed.getByRole('button', { name: 'מק״ט אוטומטי' }).click();
      const auto = ed.getByRole('group', { name: 'מק״ט אוטומטי' });
      await auto.getByLabel('שם הסדרה').fill('טלפונים');
      await auto.getByLabel('קידומת').fill('ph');
      await auto.getByText('PH-0001, PH-0002…').waitFor();
      await auto.getByRole('button', { name: 'שמירת הסדרה' }).click();
      await auto.getByRole('button', { name: 'קבלת מק״ט' }).click();
      await valueIs(ed.getByLabel('מק״ט (SKU)'), 'PH-0001', 'the first code of the series');
      // the next one skips PH-0002 (the case has it)
      await ed.getByRole('button', { name: 'מק״ט אוטומטי' }).click();
      await ed.getByRole('group', { name: 'מק״ט אוטומטי' }).getByRole('button', { name: 'קבלת מק״ט' }).click();
      await valueIs(ed.getByLabel('מק״ט (SKU)'), 'PH-0003', 'PH-0002 is the case\'s');
      await ed.getByRole('button', { name: 'שמירה', exact: true }).click();
      await ed.getByText('נשמר ✓').waitFor();
      assert.equal(fake.tables.catalog_items.find((i) => i.id === PHONE)!.sku, 'PH-0003');
      assert.deepEqual(fake.tables.sku_series.map((x) => [x.name, x.prefix, x.next_no]), [['טלפונים', 'PH', 4]]);
      await page.keyboard.press('Escape');
    });

    await step('the register sells by number: the picker and a scanned number; one sold elsewhere meanwhile is refused (DoD)', async () => {
      await regTab('מכירה');
      await tile('טלפון').click();
      const pick = dialog();
      await pick.getByRole('heading', { name: 'טלפון' }).waitFor();
      await pick.getByRole('button', { name: 'A100' }).click();
      await pick.getByRole('button', { name: 'סיום' }).click();
      // a reader at the counter types the number and Enter
      await page.getByLabel('חיפוש', { exact: true }).fill('a101');
      await page.getByLabel('חיפוש', { exact: true }).press('Enter');
      const nums = page.getByRole('group', { name: 'המספרים הסידוריים: טלפון' }).first();
      await nums.getByRole('button', { name: 'הסרת A101' }).waitFor();
      await nums.getByRole('button', { name: 'הסרת A100' }).waitFor();
      await shot('itm2-register-serials.png');
      await payCash();
      await dialog().getByText('העסקה נשמרה').waitFor();
      const sale = fake.tables.sales.at(-1)!;
      assert.deepEqual(sale.items.map((l: any) => [l.name, l.qty, l.serials]), [['טלפון', 2, ['A100', 'A101']]]);
      assert.deepEqual([serial('A100').status, serial('A101').status, serial('A100').sale_id], ['sold', 'sold', sale.id]);
      assert.equal(at(BIZ, PHONE), 2);
      // the sale's document names the numbers
      const doc = fake.tables.documents.find((d) => d.sale_id === sale.id)!;
      assert.match(doc.lines[0].name, /^טלפון · מס׳ סידורי: A100, A101$/);
      await dialog().getByRole('button', { name: 'עסקה חדשה' }).click();
      // A102 in the cart — and sold meanwhile at another register: the payment is refused, by its number
      await tile('טלפון').click();
      await dialog().getByRole('button', { name: 'A102' }).click();
      await dialog().getByRole('button', { name: 'סיום' }).click();
      const other = fake.handle('POST', 'http://sb.test/rest/v1/sales', { prefer: 'return=representation' }, JSON.stringify({
        user_id: OWNER, items: [{ name: 'טלפון', price: 1500, qty: 1, itemId: PHONE, kind: 'product', serials: ['A102'] }], subtotal: 1500, total: 1500,
        vat_rate: 18, vat_amount: 228.81, method: 'card', status: 'paid', paid_at: new Date().toISOString(), register_id: BIZ }));
      assert.equal(other.status, 201);
      await payCash();
      await dialog().getByText('המספר A102 כבר נמכר — מספר סידורי לא נמכר פעמיים.').waitFor();
      assert.equal(fake.tables.sales.filter((s) => (s.items as any[]).some((l) => (l.serials ?? []).includes('A102'))).length, 1, 'A102 sold once');
      await page.keyboard.press('Escape');
      await page.getByRole('group', { name: 'המספרים הסידוריים: טלפון' }).first().getByRole('button', { name: 'הסרת A102' }).click();
    });

    await step('a refund names the numbers that came back — they are in stock again', async () => {
      await regTab('מכירות ודוחות');
      await page.getByRole('button', { name: 'פרטי עסקה: ללא שם ₪3,000' }).click();
      const d = dialog();
      await d.getByRole('button', { name: 'החזר כספי' }).click();
      await d.getByRole('radio', { name: 'לפי פריטים' }).click();
      await d.getByRole('group', { name: 'המספרים שחזרו: טלפון' }).getByRole('button', { name: 'A101' }).click();
      await d.getByText('החזר: ₪1,500').waitFor();
      await d.getByRole('button', { name: 'אישור ההחזר' }).click();
      await d.getByText(/ההחזר נרשם: ₪1,500/).first().waitFor();
      const r = fake.tables.sale_refunds.at(-1)!;
      assert.deepEqual(r.items.map((l: any) => [l.qty, l.serials]), [[1, ['A101']]]);
      assert.deepEqual([serial('A101').status, serial('A101').sale_id, serial('A100').status], ['in_stock', null, 'sold']);
      assert.equal(at(BIZ, PHONE), 2, 'A101 and A103 in stock');
      const credit = fake.tables.documents.find((x) => x.doc_type === 330)!;
      assert.match(credit.lines[0].name, /מס׳ סידורי: A101/);
      await d.getByText(/טלפון · מס׳ סידורי: A101/).first().waitFor();
      await page.keyboard.press('Escape');
    });

    await step('a transfer by number: on the way, received with a number missing and its reason', async () => {
      await goto('/stock?tab=transfers');
      await page.getByRole('heading', { name: 'מלאי' }).waitFor({ timeout: 120_000 });
      await page.getByRole('tab', { name: 'העברות' }).click();
      await page.getByRole('button', { name: '+ העברה חדשה' }).click();
      const d = dialog();
      await d.getByLabel('מוצר להעברה').selectOption({ label: 'טלפון (2)' });
      await d.getByRole('button', { name: 'הוספה' }).click();
      const chips = d.getByRole('group', { name: 'המספרים שעוברים: טלפון' });
      await chips.getByRole('button', { name: 'A101' }).click();
      await chips.getByRole('button', { name: 'A103' }).click();
      await d.getByText('נבחרו 2').waitFor();
      await d.getByRole('button', { name: 'שליחה' }).click();
      await page.getByText('העברה 1 נשלחה — היחידות בדרך.').waitFor();
      const t = fake.tables.stock_transfers[0];
      assert.deepEqual([t.lines[0].qty, t.lines[0].serials], [2, ['A101', 'A103']]);
      assert.deepEqual([serial('A101').status, serial('A103').status, at(BIZ, PHONE)], ['in_transit', 'in_transit', 0]);
      await page.getByText('A101, A103').first().waitFor();
      await page.getByRole('button', { name: 'קבלה בסניף חיפה' }).click();
      const r = dialog();
      await r.getByRole('group', { name: 'לא הגיעו: טלפון' }).getByRole('button', { name: 'A103' }).click();
      await r.getByRole('button', { name: 'אישור קבלה' }).click();
      await r.getByRole('alert').waitFor();                               // a number missing needs its reason
      await r.getByLabel('למה: טלפון').fill('נאבד בדרך');
      await r.getByRole('button', { name: 'אישור קבלה' }).click();
      await page.getByText('העברה 1 התקבלה — פער אחד נרשם.').waitFor();
      assert.deepEqual([serial('A101').status, serial('A101').location_id, serial('A103').status], ['in_stock', L2, 'removed']);
      assert.deepEqual([at(L2, PHONE), at(BIZ, PHONE)], [1, 0]);
      await page.getByText(/לא הגיעו: A103/).first().waitFor();
      await shot('itm3-transfer.png');
    });

    await step('a count does not list a product with numbers; the stock screen finds a unit by its number, with its history', async () => {
      await page.getByRole('tab', { name: 'ספירות' }).click();
      await page.getByRole('button', { name: '+ ספירה חדשה' }).click();
      await dialog().getByRole('button', { name: 'פתיחת הספירה' }).click();
      await page.getByRole('heading', { name: 'ספירה 1' }).waitFor();
      await page.getByLabel('נספרו: קרם לחות').waitFor();
      assert.equal(await page.getByLabel('נספרו: טלפון').count(), 0, 'not counted — checked by number');
      await page.getByRole('tab', { name: 'מספרים סידוריים' }).click();
      await page.getByLabel('מספר סידורי לחיפוש').fill('a101');
      await page.getByLabel('מספר סידורי לחיפוש').press('Enter');
      const hist = page.getByRole('list', { name: 'ההיסטוריה של A101' });
      await hist.waitFor();
      assert.deepEqual((await hist.locator('li').allTextContents()).map((x: string) => x.split(' · ')[1]),
        ['הגיע בהעברה', 'יצא בהעברה', 'הוחזר', 'נמכר', 'נקלט'], 'newest first');
      await page.getByRole('list', { name: 'תוצאות החיפוש' }).getByText('סניף חיפה', { exact: true }).waitFor();
      await shot('itm4-serial-search.png');
    });

    await step('price lists: a customer group\'s and a location\'s; the register prices by the customer\'s, else the branch\'s', async () => {
      await goto('/prices');
      await page.getByRole('heading', { name: 'מחירונים' }).waitFor({ timeout: 120_000 });
      await page.getByRole('button', { name: '+ מחירון חדש' }).click();
      await page.getByLabel('שם', { exact: true }).fill('סיטונאי');
      await page.getByLabel('למי').selectOption('group');
      await page.getByLabel('התגית של הלקוחות').fill('סיטונאי');
      await page.getByRole('button', { name: 'שמירה', exact: true }).click();
      await page.getByText('המחירון נוצר ✓ — עכשיו המחירים שלו').waitFor();
      await page.getByLabel('מחיר בסיטונאי: קרם לחות').fill('100');
      await page.getByRole('button', { name: 'שמירת המחירים' }).click();
      await page.getByText('נשמרו 1 מחירים ✓').waitFor();
      await page.getByRole('button', { name: '+ מחירון חדש' }).click();
      await page.getByLabel('שם', { exact: true }).fill('סניף חיפה');
      await page.getByLabel('למי').selectOption('location');
      await page.getByLabel('הסניף', { exact: true }).selectOption(L2);
      await page.getByRole('button', { name: 'שמירה', exact: true }).click();
      await page.getByLabel('מחיר בסניף חיפה: קרם לחות').fill('110');
      await page.getByRole('button', { name: 'שמירת המחירים' }).click();
      await page.getByText('נשמרו 1 מחירים ✓').waitFor();
      assert.deepEqual(fake.tables.price_lists.map((l) => [l.name, l.kind, l.tag, l.location_id]), [['סיטונאי', 'group', 'סיטונאי', null], ['סניף חיפה', 'location', null, L2]]);
      assert.deepEqual(fake.tables.price_list_items.map((p) => p.price), [100, 110]);
      await shot('itm5-price-lists.png');
      // the main register: the base price; the customer of the group: the group's
      await goto('/register');
      await registerReady();
      await tile('קרם לחות').click();
      const line = page.locator('aside li', { hasText: 'קרם לחות' }).first();
      await line.getByText('₪120', { exact: true }).first().waitFor();
      await page.locator('aside').getByRole('button', { name: 'בחר לקוח' }).click();
      await dialog().getByLabel('חיפוש לקוח').fill('דנה');
      await dialog().getByRole('button', { name: /דנה כהן/ }).click();
      await line.getByText('מחירון סיטונאי').waitFor();
      await line.getByText(/^₪100/).first().waitFor();
      await page.locator('aside').getByRole('button', { name: 'עסקה חדשה' }).click();
      // the branch's register, no customer: the branch's list
      await standAt(R2);
      await goto('/register');
      await registerReady();
      await tile('קרם לחות').click();
      await page.locator('aside li', { hasText: 'קרם לחות' }).first().getByText('מחירון סניף חיפה').waitFor();
      await standAt(BIZ);
    });

    await step('a document\'s line by the price list of its customer', async () => {
      await goto('/finance/documents');
      await page.getByRole('button', { name: '+ מסמך חדש' }).click({ timeout: 120_000 });
      const d = dialog();
      await d.getByLabel('חיפוש לקוח').fill('דנה');
      await d.getByRole('button', { name: /דנה כהן/ }).click();
      await d.getByLabel('תיאור שורה 1').fill('קרם לחות');
      await d.getByLabel('כמות שורה 1').click();
      await d.getByText('לפי מחירון סיטונאי · אפשר לשנות את המחיר').waitFor();
      assert.equal(await d.getByLabel('מחיר שורה 1').inputValue(), '100');
      await page.keyboard.press('Escape');
    });

    await step('"השוואת סניפים" in the reports: each location\'s revenue, profit, sales and stock', async () => {
      await goto('/finance/reports');
      await page.getByText(/^השוואת סניפים · /).waitFor({ timeout: 120_000 });
      const row = (name: string) => page.locator(`tr[data-location="${name}"] td`).allTextContents();
      const main = await row('ראשי'), branch = await row('סניף חיפה');
      // the main location: the register's sale of two phones (its tax invoice-receipt) less the credit of one — as the documents say
      const net = fake.tables.documents.filter((d) => (d.location_id ?? BIZ) === BIZ)
        .reduce((a, d) => a + (d.doc_type === 320 || d.doc_type === 305 ? Number(d.after_discount) : d.doc_type === 330 ? -Number(d.after_discount) : 0), 0);
      assert.ok(net > 1000 && main[1].startsWith(ils(Math.round(net * 100) / 100)), `revenue at the main location: ${main[1]} (the documents: ${net})`);
      assert.match(main[3], /^2 · ₪4,500/, `two sales at the main location (one of them at another register): ${main[3]}`);
      assert.match(branch[5], /^1$/, `one phone at the branch: ${branch[5]}`);
      // the same numbers as the money screens with the location picked at the top
      const c = fake.rpc('location_compare', { p_from: '2026-01-01', p_to: '2099-12-31' }).body;
      assert.deepEqual(c.locations.map((l: any) => l.name), ['ראשי', 'סניף חיפה']);
      await page.getByRole('button', { name: 'ייצוא CSV' }).waitFor();
      await shot('itm6-compare.png');
      // with one active location the comparison is not shown
      const l2 = fake.tables.business_locations.find((l) => l.id === L2)!;
      l2.active = false;
      await goto('/finance/reports');
      await page.getByText('רווח והפסד (הערכה)').waitFor({ timeout: 120_000 });
      await page.waitForTimeout(800);
      assert.equal(await page.getByText(/^השוואת סניפים/).count(), 0, 'one location: no comparison');
      l2.active = true;
    });

    await step('a phone: the price lists and the serial picker fit', async () => {
      const { ctx, page: p } = await context(PHONE_VIEW);
      await goto('/prices', p);
      await p.getByRole('heading', { name: 'מחירונים' }).waitFor({ timeout: 120_000 });
      await p.getByRole('tab', { name: 'סיטונאי' }).click();
      await p.getByLabel('מחיר בסיטונאי: קרם לחות').waitFor();
      await fits(p, 'the price lists at 390');
      await goto('/register', p);
      await registerReady(p);
      await tile('טלפון', p).click();
      await dialog(p).getByRole('heading', { name: 'טלפון' }).waitFor();
      await fits(p, 'the serial picker at 390');
      await shot('itm7-phone-picker.png', p);
      await ctx.close();
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
