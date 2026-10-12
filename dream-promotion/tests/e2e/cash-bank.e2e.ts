/**
 * The money desks, deposits, cheques and the bank's reconciliation (T9), and an order, a delivery note and a return note (T10) —
 * docs/FINANCE_ADDITIONS_HE.md; 2.95 — in a real browser (Chromium via Playwright), against the in-memory Supabase of
 * fake-supabase.ts. The rules themselves are tested on Postgres (tests/sql/cash-bank.check.sql, concurrency.sh §20,
 * stock-compare.sh 5000). Here the screens are clicked through:
 *   before migration 5000 nothing of it is offered; after it both switches start off — no menu group, no goods documents;
 *   the owner turns them on in the settings → "קופות ובנק" in the menu, an order and a delivery note in the composer;
 *   the desks: cash, cheques (the one due soon marked), card, transfers, Bit; a deposit of cash and a cheque leaves the desk; more
 *   cash than the desk holds is refused; the report of the cheques deposited (CSV); a deposit cancelled with a reason comes back;
 *   the bank: a CSV in the banks' Windows-1255 Hebrew, its columns found; the same file again adds nothing; a suggestion is saved
 *   only when approved (the DoD); a bank fee handled with a note; a match chosen by hand, then undone with a reason;
 *   an order → a delivery note of part of it (the goods go out) → the invoice in one click (nothing moves again, it names its note);
 *   the rest delivered → a return note (back in stock); a clinic (the switch off) sees none of the goods documents (the DoD);
 *   a phone: the desks and the bank fit.
 *
 * Run: npx -y tsx tests/e2e/cash-bank.e2e.ts   (starts `next dev` on port 3232; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (cash* — not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_CASH_PORT ?? 3232);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000000f5';
const OWNER = 'a0000000-0000-4000-8000-0000000000f5';
const DANA = 'e0000000-0000-4000-8000-0000000000f1';
const CREAM = 'f0000000-0000-4000-8000-0000000000f5';
const PHONE_VIEW = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const day = (n: number) => { const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dmy = (d: string) => d.split('-').reverse().join('/');
const rid = (n: number) => `90000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const pid = (n: number) => `80000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  const issuer = { name: 'חנות שגב בע״מ', dealerNumber: '515123456', entityType: 'company' };
  // the receipts of the desks: each a tax invoice-receipt (320) and its row in the ledger
  const receipts: [number, string, number, string, string, Record<string, string>?][] = [
    [1, 'אורי', 590, 'cash', TODAY], [2, 'בני', 1000, 'cheque', TODAY, { number: '1001', bank: '12', branch: '600', dueDate: day(2) }],
    [3, 'גלית', 500, 'cheque', TODAY, { number: '1002', bank: '10', dueDate: day(20) }], [4, 'דורית', 300, 'card', TODAY], [5, 'דנה כהן', 236, 'transfer', TODAY],
    [6, 'הדר', 118, 'bit', TODAY], [7, 'ורד', 77, 'transfer', day(-10)],
  ];
  const code: Record<string, number> = { cash: 1, cheque: 2, card: 3, transfer: 4, bit: 9 };
  const before = (t: number) => Math.round((t / 1.18) * 100) / 100;
  return {
    brands: [{ ...base, name: 'חנות שגב', onboarded: true, industry: 'אופנה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'company', vat_rate: 18, pay_link: '', dealer_number: '515123456', legal_name: 'חנות שגב בע״מ',
      street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [], business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }],
    business_locations: [{ id: BIZ, business_id: BIZ, name: 'ראשי', kind: 'store', address: '', phone: '', hours: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' }],
    registers: [{ id: BIZ, business_id: BIZ, location_id: BIZ, name: 'קופה 1', device: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' }],
    catalog_items: [{ ...base, id: CREAM, name: 'קרם לחות', price: 118, kind: 'product', active: true, sort: 0, favorite: true, fav_order: 0, image_url: '', track_stock: true,
      stock_qty: 10, low_stock: 2, has_variants: false, sku: '', barcode: '', publish_online: false, track_serials: false }],
    catalog_variants: [], catalog_options: [], stock_levels: [], stock_transfers: [], stock_counts: [], stock_reservations: [], stock_movements: [],
    catalog_serials: [], catalog_serial_events: [], price_lists: [], price_list_items: [], sku_series: [], treatment_types: [],
    leads: [{ ...base, id: DANA, name: 'דנה כהן', phone: '0521234567', source: 'ידני', status: 'חדש', date: '2026-01-01', tags: [], value: 0, notes: '' }],
    documents: receipts.map(([n, who, total, m, on, cheque]) => ({ ...base, id: rid(n), doc_type: 320, doc_number: n, link_no: n, issued_at: `${on}T08:0${n}:00Z`, doc_date: on,
      customer_name: who, customer_phone: '', customer_dealer: '', lead_id: who === 'דנה כהן' ? DANA : null, before_discount: before(total), discount: 0,
      after_discount: before(total), vat_amount: Math.round((total - before(total)) * 100) / 100, total, vat_rate: 18,
      lines: [{ name: 'פריט', qty: 1, unitPriceExVat: before(total), discountExVat: 0, totalExVat: before(total), vatRate: 18, kind: 1 }],
      payments: [{ method: code[m], amount: total, date: on, m, ...(cheque ? { cheque } : {}) }], print_count: 1, share_token: String(n).repeat(64).slice(0, 64), issuer,
      source: 'direct', notes: '', location_id: BIZ, base_doc_type: null, base_doc_number: null })),
    payments: receipts.map(([n, , total, m, on, cheque]) => ({ id: pid(n), business_id: BIZ, user_id: OWNER, direction: 'in', amount: total, method: m, paid_on: on, source: 'document',
      document_id: rid(n), applies_to: null, sale_id: null, lead_id: null, reference: cheque ?? {}, note: '', created_at: `${on}T08:0${n}:00Z`, location_id: BIZ })),
    expenses: [], stores: [], store_domains: [], store_theme_versions: [], store_pages: [], store_menus: [],
    employees: [], sales: [], register_shifts: [], booking_services: [], appointments: [],
    sale_refunds: [], content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [],
    push_subscriptions: [], quotes: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [],
    payment_requests: [], payment_plans: [], payment_plan_items: [], client_packages: [], client_package_uses: [], client_sessions: [], client_treatments: [],
    catalog_media: [], catalog_field_defs: [], catalog_collections: [], debt_reminders: [], debt_reminder_stops: [], recurring_plans: [], recurring_charges: [],
    bank_deposits: [], bank_deposit_cheques: [], bank_statements: [], bank_lines: [], bank_matches: [], cheque_reminders: [],
    tax_allocation_rules: [{ version: 4, effective_from: '2026-06-01', threshold_before_vat: 5000, doc_types: [305, 320], requires_customer_dealer: true, verified: false, source_note: 'מקורות משניים' }],
  };
}

/** a file of the bank as an older export writes it: Windows-1255 Hebrew, the bank's title above the header, debit and credit apart */
function bankFile(): Buffer {
  const text = ['בנק לאומי - תנועות בחשבון', 'תאריך,תיאור,אסמכתא,חובה,זכות,יתרה',
    `${dmy(TODAY)},העברה מדנה,111,,236.00,1236.00`, `${dmy(TODAY)},הפקדה בסניף,222,,"1,590.00",2826.00`,
    `${dmy(TODAY)},עמלת ניהול,,12.50,,2813.50`, `${dmy(TODAY)},העברה מורד,333,,77.00,2890.50`].join('\r\n') + '\r\n';
  return Buffer.from(Array.from(text, (c) => (c >= 'א' && c <= 'ת' ? c.charCodeAt(0) - 0x5d0 + 0xe0 : c.charCodeAt(0))));
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
  for (const p of ['/finance/cash', '/finance/bank', '/finance/documents', '/finance/settings']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@shop.test' });
  const errors: string[] = [];
  const said: string[] = [];
  const calls: string[] = [];

  async function context(viewport: { width: number; height: number }) {
    const phone = viewport.width < 600;
    const ctx = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', acceptDownloads: true,
      ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@shop.test'))]);
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
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'חנות שגב', state: 'active' },
      businesses: [{ id: BIZ, name: 'חנות שגב', state: 'active' }], superAdmin: false, access: 'full' } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
    await ctx.route(`${BASE}/api/notify/sale`, (r: any) => r.fulfill({ json: { sent: 0 } }));
    await ctx.route(`${BASE}/api/finance/tax/status`, (r: any) => r.fulfill({ json: { mode: 'unconfigured', configured: false, connection: null, message: 'החיבור לרשות המסים לא הוגדר.' } }));
    await ctx.route(`${BASE}/api/client-file/**`, (r: any) => r.fulfill({ status: 403, json: { code: 'no_access', message: 'אין גישה' } }));
    await ctx.route(`${BASE}/api/store/**`, (r: any) => r.fulfill({ json: { ok: true, domains: [], vercel: 'not_configured', connected: false } }));
    await ctx.route(`${BASE}/api/finance/report-pdf`, (r: any) => r.fulfill({ status: 200, body: '%PDF-1.4\n%test\n', headers: { 'content-type': 'application/pdf' } }));
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
      await page.screenshot({ path: path.join(SHOTS, `cash-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
    finally { clearTimeout(timer); }
  };
  const dialog = (p: any = page) => p.getByRole('dialog').last();
  const shot = async (name: string, p: any = page) => { await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, name), fullPage: true }); };
  const menu = (p: any = page) => p.getByRole('complementary', { name: 'ניווט כספים' });
  const settings = async () => { await goto('/finance/settings'); await page.getByText('פרטי העסק על המסמכים').waitFor({ timeout: 120_000 }); await page.waitForTimeout(600); };
  const desks = async (p: any = page) => { await goto('/finance/cash', p); await p.getByText('קופת מזומן').waitFor({ timeout: 120_000 }); };
  const bank = async (p: any = page) => { await goto('/finance/bank', p); await p.getByRole('button', { name: 'העלאת קובץ מהבנק' }).waitFor({ timeout: 120_000 }); };
  const card = (label: string) => page.getByRole('button').filter({ hasText: label }).first();
  const lineOf = (text: string) => page.locator('li[data-line]').filter({ hasText: text }).first();
  const docs = async () => { await goto('/finance/documents'); await page.getByRole('button', { name: '+ מסמך חדש' }).waitFor({ timeout: 120_000 }); };
  const openDoc = async (label: string) => { await docs(); await page.getByText(label).first().click({ timeout: 60_000 }); await dialog().getByRole('heading', { name: label }).waitFor(); return dialog(); };
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
    await step('before migration 5000: no switches in the settings, no menu group, the screens say what is missing', async () => {
      fake.cashTables = false;
      await settings();
      assert.equal(await page.getByText('מה מופעל בכספים').count(), 0, 'no switches');
      assert.equal(await menu().getByText('קופות ובנק').count(), 0, 'no menu group');
      await goto('/finance/cash');
      await page.getByText(/מיגרציה 20261011005000/).waitFor({ timeout: 120_000 });
      fake.cashTables = true;
    });

    await step('after it: both switches off — the menu as it was, no order or delivery note to issue', async () => {
      await settings();
      await page.getByText('מה מופעל בכספים').waitFor();
      assert.equal(await page.getByRole('checkbox', { name: /קופות, הפקדות והתאמת בנק/ }).isChecked(), false);
      assert.equal(await page.getByRole('checkbox', { name: /מכירת מוצרים/ }).isChecked(), false);
      assert.equal(await menu().getByText('קופות ובנק').count(), 0, 'off: no group');
      await docs();
      assert.equal(await page.getByRole('button', { name: 'תעודת משלוח', exact: true }).count(), 0, 'no delivery note filter');
      await page.getByRole('button', { name: '+ מסמך חדש' }).click();
      const d = dialog();
      await d.getByRole('radiogroup', { name: 'סוג המסמך' }).waitFor();
      assert.equal(await d.getByRole('radio', { name: 'הזמנה' }).count(), 0, 'no order');
      assert.equal(await d.getByRole('radio', { name: 'תעודת משלוח' }).count(), 0, 'no delivery note');
      await goto('/finance/cash');
      await page.getByText('קופות, הפקדות והתאמת בנק — כבוי').waitFor({ timeout: 120_000 });
    });

    await step('the owner turns them on → "קופות ובנק" in the menu; the switches are kept in the profile', async () => {
      await settings();
      await page.getByRole('checkbox', { name: /קופות, הפקדות והתאמת בנק/ }).check();
      await page.getByLabel(/תזכורת לצ׳ק/).fill('3');
      await page.getByRole('checkbox', { name: /מכירת מוצרים/ }).check();
      await page.getByRole('button', { name: 'שמירת ההגדרות' }).click();
      await page.getByText(/ההגדרות נשמרו/).waitFor();
      const fp = fake.tables.business_finance_profile[0];
      assert.deepEqual([fp.cash_drawers, fp.sells_products, fp.cheque_remind_days], [true, true, 3]);
      await menu().getByText('קופות ובנק').waitFor();
      await menu().getByText('קופות ובנק').click();
      await menu().getByRole('link', { name: 'קופות והפקדות' }).waitFor();
      await menu().getByRole('link', { name: 'התאמת בנק' }).waitFor();
    });

    await step('the desks: cash, cheques (the one due soon marked), card, transfers, Bit — from the ledger', async () => {
      await desks();
      await card('קופת מזומן').getByText('₪590', { exact: true }).waitFor();
      await card('קופת צ׳קים').getByText('₪1,500', { exact: true }).waitFor();
      await card('קופת צ׳קים').getByText(/2 צ׳קים · 1 לפירעון בקרוב/).waitFor();
      await card('קופת אשראי').getByText('₪300', { exact: true }).waitFor();
      await card('קופת Bit / PayBox').getByText('₪118', { exact: true }).waitFor();
      await page.getByRole('tab', { name: /צ׳קים \(2\)/ }).click();
      const soon = page.locator('li').filter({ hasText: 'צ׳ק 1001' }).first();
      await soon.getByText('לפירעון בקרוב').waitFor();
      await soon.getByText(`לפירעון ${dmy(day(2))}`).waitFor();
      assert.equal(await page.locator('li').filter({ hasText: 'צ׳ק 1002' }).first().getByText('לפירעון בקרוב').count(), 0, 'the far one is not marked');
      await shot('cash-1-desks.png');
    });

    await step('a deposit: cash and a cheque leave the desk; more cash than the desk holds is refused', async () => {
      await desks();
      await page.getByRole('button', { name: '+ הפקדה לבנק' }).click();
      let d = dialog();
      await d.getByLabel('מזומן להפקדה').fill('400');
      await d.locator('label').filter({ hasText: 'צ׳ק 1001' }).getByRole('checkbox').check();
      await d.getByText('סה״כ להפקדה: ₪1,400').waitFor();
      await d.getByRole('button', { name: 'רישום ההפקדה' }).click();
      await page.getByText('הפקדה 1 נרשמה').waitFor();
      assert.equal(fake.tables.bank_deposits.length, 1);
      assert.deepEqual(fake.tables.bank_deposit_cheques.map((x) => [x.payment_id, x.active]), [[pid(2), true]]);
      await page.getByText('הפקדה 1', { exact: false }).first().waitFor();
      await card('קופת מזומן').getByText('₪190', { exact: true }).waitFor();
      await card('קופת צ׳קים').getByText('₪500', { exact: true }).waitFor();
      await page.getByRole('button', { name: '+ הפקדה לבנק' }).click();
      d = dialog();
      await d.getByLabel('מזומן להפקדה').fill('1000');
      await d.getByRole('button', { name: 'רישום ההפקדה' }).click();
      await d.getByText(/בקופת המזומן רשומים רק ₪190/).waitFor();
      assert.equal(fake.tables.bank_deposits.length, 1, 'nothing recorded');
    });

    await step('the report of the cheques deposited (CSV); a deposit cancelled with a reason comes back', async () => {
      await desks();
      await page.getByRole('tab', { name: /צ׳קים/ }).click();
      const t = page.getByRole('table', { name: 'צ׳קים שהופקדו' });
      await t.waitFor();
      assert.match((await t.innerText()).replace(/\s+/g, ' '), /1001.*בני.*1,000\.00/);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'צ׳קים שהופקדו — הורדת CSV' }).click()]);
      assert.match(readFileSync(await dl.path(), 'utf8'), /"1001","12","600"/);
      await page.getByRole('tab', { name: 'הפקדות' }).click();
      await page.getByRole('button', { name: 'ביטול ההפקדה' }).click();
      const d = dialog();
      await d.getByLabel('סיבה').fill('נרשמה בטעות');
      await d.getByRole('button', { name: 'ביטול ההפקדה' }).click();
      await page.getByText('ההפקדה בוטלה — הכסף והצ׳קים חזרו לקופה').waitFor();
      await page.getByText('בוטלה · נרשמה בטעות').waitFor();
      await card('קופת מזומן').getByText('₪590', { exact: true }).waitFor();
      // all of it again, for the bank: 590 in cash and the cheque of 1,000
      await page.getByRole('button', { name: '+ הפקדה לבנק' }).click();
      const n = dialog();
      await n.getByRole('button', { name: 'הכל' }).click();
      await n.locator('label').filter({ hasText: 'צ׳ק 1001' }).getByRole('checkbox').check();
      await n.getByRole('button', { name: 'רישום ההפקדה' }).click();
      await page.getByText('הפקדה 2 נרשמה').waitFor();
      assert.equal(fake.tables.bank_deposits.find((x) => x.number === 2)!.cash, 590);
    });

    await step('the bank: a Windows-1255 file read by its column names; the same file again adds nothing', async () => {
      await bank();
      for (const round of [1, 2]) {
        await page.getByRole('button', { name: 'העלאת קובץ מהבנק' }).click();
        const d = dialog();
        await d.getByLabel('קובץ מהבנק').setInputFiles({ name: 'tnuot.csv', mimeType: 'text/csv', buffer: bankFile() });
        await d.getByText('4 שורות', { exact: false }).first().waitFor();
        await d.getByText(/נכנס ₪1,903 · יצא ₪12\.5/).waitFor();
        await d.getByRole('button', { name: /ייבוא 4 שורות/ }).click();
        await page.getByText(round === 1 ? 'נוספו 4 שורות חדשות' : 'נוספו 0 שורות חדשות (4 כבר היו)').waitFor();
      }
      assert.equal(fake.tables.bank_lines.length, 4);
      await page.getByRole('tab', { name: 'לטיפול (4)' }).waitFor();
      await shot('cash-2-bank.png');
    });

    await step('a suggestion is saved only when the owner approves it (the DoD); a deposit meets its line', async () => {
      await bank();
      const l1 = lineOf('העברה מדנה');
      await l1.getByText(/הצעה: חשבונית מס \/ קבלה 5 · דנה כהן/).waitFor();
      await lineOf('הפקדה בסניף').getByText(/הצעה: הפקדה 2/).waitFor();
      assert.equal(fake.tables.bank_matches.length, 0, 'suggested, not saved');
      await l1.getByRole('button', { name: 'אישור' }).click();
      await page.getByText('ההתאמה נשמרה').first().waitFor();
      await lineOf('הפקדה בסניף').getByRole('button', { name: 'אישור' }).click();
      await page.getByRole('tab', { name: 'לטיפול (2)' }).waitFor();
      assert.deepEqual(fake.tables.bank_matches.map((m) => [m.payment_id ?? m.deposit_id, m.active]),
        [[pid(5), true], [fake.tables.bank_deposits.find((x) => x.number === 2)!.id, true]]);
      await page.getByRole('tab', { name: 'הותאמו (2)' }).click();
      await lineOf('הפקדה בסניף').getByText(/✓ הפקדה 2/).waitFor();
    });

    await step('a bank fee handled with a note; a match chosen by hand, then undone with a reason', async () => {
      await bank();
      await lineOf('עמלת ניהול').getByRole('button', { name: 'טופל בלי התאמה' }).click();
      await dialog().getByLabel('הערה').fill('עמלת בנק חודשית');
      await dialog().getByRole('button', { name: 'שמירה' }).click();
      await page.getByText('השורה סומנה כטופלה').waitFor();
      const l = lineOf('העברה מורד');
      assert.equal(await l.getByText(/הצעה:/).count(), 0, 'ten days apart: no suggestion');
      await l.getByRole('button', { name: 'התאמה ידנית' }).click();
      const d = dialog();
      await d.getByLabel('חיפוש').fill('77');
      await d.locator('label').filter({ hasText: 'ורד' }).getByRole('checkbox').check();
      await d.getByText('שווה לשורה ✓').waitFor();
      await d.getByRole('button', { name: 'אישור ההתאמה' }).click();
      await page.getByRole('tab', { name: 'לטיפול (0)' }).waitFor();
      await page.getByRole('tab', { name: 'הותאמו (3)' }).click();
      await lineOf('העברה מורד').getByRole('button', { name: 'ביטול ההתאמה' }).click();
      await dialog().getByLabel('סיבה').fill('לא אותה העברה');
      await dialog().getByRole('button', { name: 'שמירה' }).click();
      await page.getByText('ההתאמה בוטלה').waitFor();
      const undone = fake.tables.bank_matches.find((m) => m.payment_id === pid(7))!;
      assert.deepEqual([undone.active, undone.undo_reason], [false, 'לא אותה העברה'], 'kept in the history, with its reason');
      assert.equal(fake.tables.bank_lines.find((x) => x.description === 'העברה מורד')!.status, 'open');
    });

    await step('an order → a delivery note of part of it (out of stock) → the invoice in one click (nothing again, naming its note)', async () => {
      await docs();
      await page.getByRole('button', { name: '+ מסמך חדש' }).click();
      const c = dialog();
      await c.getByRole('radio', { name: 'הזמנה' }).click();
      await c.getByLabel('שם הלקוח').fill('רונית');
      await c.getByLabel('תיאור שורה 1').fill('קרם לחות');
      await c.getByLabel('כמות שורה 1').fill('3');
      await c.getByLabel('מחיר שורה 1').fill('118');
      await c.getByRole('button', { name: 'הפקת הזמנה' }).click();
      await page.getByText(/הופקה הזמנה מס׳ 1/).waitFor();
      const order = fake.tables.documents.find((x) => x.doc_type === 100)!;
      assert.deepEqual([order.total, order.lines[0].itemId], [354, CREAM]);
      assert.equal(fake.tables.catalog_items[0].stock_qty, 10, 'an order moves nothing');
      // the order is open on the screen: its delivery note, two of three
      const o = dialog();
      await o.getByRole('heading', { name: 'הזמנה 1' }).waitFor();
      await o.getByRole('button', { name: 'תעודת משלוח מההזמנה' }).click();
      const f = dialog();
      await f.getByLabel('כמות: קרם לחות').fill('2');
      await f.getByText(/הפריטים יורדים מהמלאי/).waitFor();
      await f.getByRole('button', { name: 'הפקת תעודת משלוח' }).click();
      await page.getByText('הופקה תעודת משלוח מס׳ 1').waitFor();
      const dn = fake.tables.documents.find((x) => x.doc_type === 200)!;
      assert.deepEqual([dn.base_doc_type, dn.base_doc_number, dn.total, dn.lines[0].qty], [100, 1, 236, 2]);
      assert.equal(fake.tables.catalog_items[0].stock_qty, 8, 'the delivery note took two out');
      await o.getByText('תעודת משלוח 1').first().waitFor();
      // the delivery note: printed with its order and the receiver's line; the invoice in one click
      const n = await openDoc('תעודת משלוח 1');
      await n.getByText('על פי הזמנה מס׳ 1').waitFor();
      await n.getByText(/קיבלתי את הסחורה המפורטת לעיל/).waitFor();
      await shot('cash-3-delivery-note.png');
      await n.getByRole('button', { name: 'הפקת חשבונית' }).click();
      const inv = dialog();
      await inv.getByRole('radio', { name: 'חשבונית מס', exact: true }).waitFor();
      await inv.getByText(/המלאי כבר ירד בתעודת המשלוח/).waitFor();
      await inv.getByRole('button', { name: 'הפקת חשבונית מס' }).click();
      await page.getByText('הופקה חשבונית מס מס׳ 1 · ₪236').waitFor();
      const i = fake.tables.documents.find((x) => x.doc_type === 305)!;
      assert.deepEqual([i.base_doc_type, i.base_doc_number, i.total, i.lines[0].itemId], [200, 1, 236, CREAM], 'it names its note (fields 1256/1257)');
      assert.equal(fake.tables.catalog_items[0].stock_qty, 8, 'nothing moved again');
      await n.getByText('חויבה: חשבונית מס 1').waitFor();
      assert.equal(await n.getByRole('button', { name: 'הפקת חשבונית' }).count(), 0, 'invoiced once');
      assert.equal(await n.getByRole('button', { name: 'תעודת החזרה' }).count(), 0, 'after the invoice, a credit invoice — not a return note');
      assert.equal(await n.getByRole('button', { name: 'ביטול מסמך' }).count(), 0, 'a note an invoice was made from stays');
      const iv = await openDoc('חשבונית מס 1');
      await iv.getByText('על פי תעודת משלוח מס׳ 1').waitFor();
    });

    await step('the rest delivered → a return note brings it back to stock', async () => {
      const o = await openDoc('הזמנה 1');
      await o.getByRole('button', { name: 'תעודת משלוח מההזמנה' }).click();
      const f = dialog();
      assert.equal(await f.getByLabel('כמות: קרם לחות').inputValue(), '1', 'what is left of the order');
      await f.getByRole('button', { name: 'הפקת תעודת משלוח' }).click();
      await page.getByText('הופקה תעודת משלוח מס׳ 2').waitFor();
      assert.equal(fake.tables.catalog_items[0].stock_qty, 7);
      // all of the order went out: the order's card reloads what was made from it, and the button goes (waited for — not counted at once)
      await o.getByRole('button', { name: 'תעודת משלוח מההזמנה' }).waitFor({ state: 'detached' });
      const n = await openDoc('תעודת משלוח 2');
      await n.getByRole('button', { name: 'תעודת החזרה' }).click();
      const r = dialog();
      await r.getByText(/הפריטים חוזרים למלאי/).waitFor();
      await r.getByRole('button', { name: 'הפקת תעודת החזרה' }).click();
      await page.getByText('הופקה תעודת החזרה מס׳ 1').waitFor();
      const ret = fake.tables.documents.find((x) => x.doc_type === 210)!;
      assert.deepEqual([ret.base_doc_type, ret.base_doc_number, ret.lines[0].qty], [200, 2, 1]);
      assert.equal(fake.tables.catalog_items[0].stock_qty, 8, 'back in stock');
      await n.getByText('תעודת החזרה 1').first().waitFor();
      assert.equal(await n.getByRole('button', { name: 'הפקת חשבונית' }).count(), 0, 'nothing left to invoice');
    });

    await step('a clinic (the switch off) sees no order, delivery note or return note to issue or filter (the DoD)', async () => {
      await settings();
      await page.getByRole('checkbox', { name: /מכירת מוצרים/ }).uncheck();
      await page.getByRole('button', { name: 'שמירת ההגדרות' }).click();
      await page.getByText(/ההגדרות נשמרו/).waitFor();
      await docs();
      for (const name of ['הזמנה', 'תעודת משלוח', 'תעודת החזרה']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, `no "${name}" filter`);
      await page.getByRole('button', { name: '+ מסמך חדש' }).click();
      await dialog().getByRole('radiogroup', { name: 'סוג המסמך' }).waitFor();
      assert.equal(await dialog().getByRole('radio', { name: 'הזמנה' }).count(), 0);
      assert.equal(await dialog().getByRole('radio', { name: 'תעודת משלוח' }).count(), 0);
    });

    await step('a phone: the desks and the bank fit', async () => {
      const { ctx, page: phone } = await context(PHONE_VIEW);
      try {
        await desks(phone);
        await phone.getByText('קופת צ׳קים').waitFor();
        await fits(phone, 'the desks');
        await shot('cash-4-phone-desks.png', phone);
        await bank(phone);
        await phone.getByRole('tab', { name: /לטיפול/ }).waitFor();
        await fits(phone, 'the bank');
        await shot('cash-5-phone-bank.png', phone);
      } finally { await ctx.close(); }
    });
  } finally {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
    if (errors.length) console.log(`page errors:\n  ${[...new Set(errors)].slice(0, 6).join('\n  ')}`);
    await browser.close();
    try { process.kill(-dev.pid!, 'SIGTERM'); } catch { /* gone */ }
    process.exitCode = failed.length ? 1 : 0;
  }
}
void main();
