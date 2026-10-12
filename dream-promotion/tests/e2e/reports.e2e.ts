/**
 * The missing reports and tax withheld at source (docs/FINANCE_ADDITIONS_HE.md T8; 2.94) in a real browser (Chromium via Playwright),
 * against the in-memory Supabase of fake-supabase.ts. The rules themselves are tested on Postgres (tests/sql/reports.check.sql:
 * every report's total against finance_summary, the cards against the invoices' balances, a location; stock-compare.sh 4900: the
 * same ledger and summary without and with the migration). Here the screens are clicked through:
 *   before migration 4900 nothing of it is offered (no reports to pick, no "ניכוי במקור" on a receipt, no advances in the settings);
 *   a receipt with tax withheld at source: its amount comes off the transfer, the percent kept — and the money screens leave it out;
 *   by customer → a click opens the customer's card (the opening balance, the charge, the payments — tax withheld too — the balance);
 *   sales by item and by treatment type; suppliers paid and not yet → a supplier's card; tax withheld by customer, for the year;
 *   every table as CSV (Excel's Hebrew) and as PDF (the table the screen sends); profit and loss against a year before;
 *   the advances' percent in the settings → an estimate, marked as one; a service's treatment type in the product editor;
 *   a customer's card from an address (the CRM's link); a phone: the reports fit.
 *
 * Run: npx -y tsx tests/e2e/reports.e2e.ts   (starts `next dev` on port 3229; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (rep* — not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_REPORTS_PORT ?? 3229);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000000e9';
const OWNER = 'a0000000-0000-4000-8000-0000000000e9';
const DANA = 'e0000000-0000-4000-8000-0000000000e1';
const LASER = 'f0000000-0000-4000-8000-0000000000e1';
const CREAM = 'f0000000-0000-4000-8000-0000000000e2';
const TYPE = '70000000-0000-4000-8000-0000000000e1';
const INV = '90000000-0000-4000-8000-0000000000e1';
const PHONE_VIEW = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  const issuer = { name: 'קליניקת לייזר בע״מ', dealerNumber: '515123456', entityType: 'company' };
  const line = (name: string, net: number, qty: number, itemId: string) => ({ name, qty, unitPriceExVat: net / qty, discountExVat: 0, totalExVat: net, vatRate: 18, kind: 1, itemId });
  return {
    brands: [{ ...base, name: 'קליניקת לייזר', onboarded: true, industry: 'קוסמטיקה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'company', vat_rate: 18, pay_link: '', dealer_number: '515123456', legal_name: 'קליניקת לייזר בע״מ',
      street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [], business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }],
    business_locations: [{ id: BIZ, business_id: BIZ, name: 'ראשי', kind: 'clinic', address: '', phone: '', hours: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' }],
    registers: [{ id: BIZ, business_id: BIZ, location_id: BIZ, name: 'קופה 1', device: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' }],
    treatment_types: [{ id: TYPE, business_id: BIZ, name: 'לייזר', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' }],
    catalog_items: [
      { ...base, id: LASER, name: 'טיפול לייזר', price: 1180, kind: 'service', active: true, sort: 0, favorite: true, fav_order: 0, image_url: '', track_stock: false, stock_qty: 0,
        low_stock: 0, has_variants: false, sku: '', barcode: '', publish_online: false, track_serials: false, treatment_type_id: TYPE },
      { ...base, id: CREAM, name: 'קרם הרגעה', price: 118, kind: 'product', active: true, sort: 1, favorite: true, fav_order: 1, image_url: '', track_stock: false, stock_qty: 0,
        low_stock: 0, has_variants: false, sku: '', barcode: '', publish_online: false, track_serials: false, treatment_type_id: null },
    ],
    catalog_variants: [], catalog_options: [], stock_levels: [], stock_transfers: [], stock_counts: [], stock_reservations: [], stock_movements: [],
    catalog_serials: [], catalog_serial_events: [], price_lists: [], price_list_items: [], sku_series: [],
    leads: [{ ...base, id: DANA, name: 'דנה כהן', phone: '0521234567', source: 'ידני', status: 'חדש', date: '2026-01-01', tags: [], value: 0, notes: '' }],
    // Dana's invoice (laser, ₪1,180 — open), Yossi's tax invoice-receipt (two creams, paid in cash)
    documents: [
      { ...base, id: INV, doc_type: 305, doc_number: 1, link_no: 1, issued_at: `${TODAY}T08:00:00Z`, doc_date: TODAY, customer_name: 'דנה כהן', customer_phone: '0521234567', customer_dealer: '',
        lead_id: DANA, before_discount: 1000, discount: 0, after_discount: 1000, vat_amount: 180, total: 1180, vat_rate: 18, lines: [line('טיפול לייזר', 1000, 1, LASER)], payments: [],
        print_count: 1, share_token: 'a'.repeat(64), issuer, source: 'direct', due_date: TODAY, notes: '', location_id: BIZ },
      { ...base, id: '90000000-0000-4000-8000-0000000000e2', doc_type: 320, doc_number: 1, link_no: 2, issued_at: `${TODAY}T09:00:00Z`, doc_date: TODAY, customer_name: 'יוסי לוי',
        customer_phone: '', customer_dealer: '', lead_id: null, before_discount: 200, discount: 0, after_discount: 200, vat_amount: 36, total: 236, vat_rate: 18,
        lines: [line('קרם הרגעה', 200, 2, CREAM)], payments: [{ method: 1, amount: 236, date: TODAY, m: 'cash' }], print_count: 1, share_token: 'b'.repeat(64), issuer, source: 'direct', notes: '', location_id: BIZ },
    ],
    payments: [{ id: '80000000-0000-4000-8000-0000000000e1', business_id: BIZ, user_id: OWNER, direction: 'in', amount: 236, method: 'cash', paid_on: TODAY, source: 'document',
      document_id: '90000000-0000-4000-8000-0000000000e2', applies_to: null, sale_id: null, lead_id: null, reference: {}, note: '', created_at: `${TODAY}T09:00:00Z`, location_id: BIZ },
      // the electricity, paid by card (the database writes this row when a paid expense is saved)
      { id: '80000000-0000-4000-8000-0000000000e2', business_id: BIZ, user_id: OWNER, direction: 'out', amount: 354, method: 'card', paid_on: TODAY, source: 'expense',
        expense_id: '60000000-0000-4000-8000-0000000000e2', note: 'חברת החשמל', created_at: `${TODAY}T10:00:00Z`, location_id: BIZ }],
    // a supplier's invoice not paid yet, and the electricity paid by card
    expenses: [
      { ...base, id: '60000000-0000-4000-8000-0000000000e1', expense_number: 1, status: 'confirmed', supplier_name: 'ספק ציוד', supplier_dealer: '516000017', supplier_doc_type: 'tax_invoice',
        supplier_doc_number: '7101', allocation_number: '', doc_date: TODAY, category: 'supplies', description: '', amount_before_vat: 500, vat_amount: 90, total: 590, vat_deductible_pct: 100,
        paid_on: null, payment_method: null, file_path: '', stock_lines: [], void_reason: '', location_id: BIZ },
      { ...base, id: '60000000-0000-4000-8000-0000000000e2', expense_number: 2, status: 'confirmed', supplier_name: 'חברת החשמל', supplier_dealer: '', supplier_doc_type: 'tax_invoice',
        supplier_doc_number: '', allocation_number: '', doc_date: TODAY, category: 'utilities', description: '', amount_before_vat: 300, vat_amount: 54, total: 354, vat_deductible_pct: 100,
        paid_on: TODAY, payment_method: 'card', file_path: '', stock_lines: [], void_reason: '', location_id: BIZ },
    ],
    stores: [], store_domains: [], store_theme_versions: [], store_pages: [], store_menus: [],
    employees: [], sales: [], register_shifts: [], booking_services: [], appointments: [],
    sale_refunds: [], content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [],
    push_subscriptions: [], quotes: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [],
    payment_requests: [], payment_plans: [], payment_plan_items: [], client_packages: [], client_package_uses: [], client_sessions: [], client_treatments: [],
    catalog_media: [], catalog_field_defs: [], catalog_collections: [], debt_reminders: [], debt_reminder_stops: [], recurring_plans: [], recurring_charges: [],
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
  for (const p of ['/finance/reports', '/finance/receivables', '/finance/income', '/finance/settings', '/register']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@laser.test' });
  const errors: string[] = [];
  const said: string[] = [];
  const calls: string[] = [];
  const pdfBodies: any[] = [];

  async function context(viewport: { width: number; height: number }) {
    const phone = viewport.width < 600;
    const ctx = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', acceptDownloads: true,
      ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@laser.test'))]);
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
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'קליניקת לייזר', state: 'active' },
      businesses: [{ id: BIZ, name: 'קליניקת לייזר', state: 'active' }], superAdmin: false, access: 'full' } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
    await ctx.route(`${BASE}/api/notify/sale`, (r: any) => r.fulfill({ json: { sent: 0 } }));
    await ctx.route(`${BASE}/api/finance/tax/status`, (r: any) => r.fulfill({ json: { mode: 'unconfigured', configured: false, connection: null, message: 'החיבור לרשות המסים לא הוגדר.' } }));
    await ctx.route(`${BASE}/api/client-file/**`, (r: any) => r.fulfill({ status: 403, json: { code: 'no_access', message: 'אין גישה' } }));
    await ctx.route(`${BASE}/api/store/**`, (r: any) => r.fulfill({ json: { ok: true, domains: [], vercel: 'not_configured', connected: false } }));
    // the PDF of a report: the server draws what the screen sends (tests/reports.test.ts proves the drawing and the route's gates)
    await ctx.route(`${BASE}/api/finance/report-pdf`, async (r: any) => {
      pdfBodies.push(JSON.parse(r.request().postData() ?? 'null'));
      return r.fulfill({ status: 200, body: '%PDF-1.4\n%test\n', headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' } });
    });
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
      await page.screenshot({ path: path.join(SHOTS, `rep-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
    finally { clearTimeout(timer); }
  };
  const dialog = (p: any = page) => p.getByRole('dialog').last();
  const shot = async (name: string, p: any = page) => { await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, name), fullPage: true }); };
  const reports = async (p: any = page) => { await goto('/finance/reports', p); await p.getByText('רווח והפסד (הערכה)').first().waitFor({ timeout: 120_000 }); };
  const pick = async (label: string, p: any = page) => {
    await p.getByRole('group', { name: 'איזה דוח' }).getByRole('button', { name: label, exact: true }).click();
  };
  const table = (title: string, p: any = page) => p.getByRole('table', { name: title });
  const cells = async (t: any): Promise<string[]> => { await t.waitFor(); return (await t.locator('tr').allInnerTexts()).map((x: string) => x.replace(/\s+/g, ' ').trim()); };
  /** a CSV of the table: the browser's download, read back */
  const csvOf = async (title: string, p: any = page) => {
    const [d] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: `${title} — הורדת CSV` }).click()]);
    return { name: d.suggestedFilename() as string, text: readFileSync(await d.path(), 'utf8') };
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
  const openReceipt = async () => {
    await goto('/finance/receivables');
    await page.getByText('דנה כהן · חשבונית מס 1').first().click({ timeout: 120_000 });
    await dialog().getByRole('button', { name: 'קבלה על תשלום' }).click();
    await dialog().getByRole('heading', { name: 'תשלום על חשבונית מס 1' }).waitFor();
    return dialog();
  };

  try {
    await step('before migration 4900: no reports to pick, no tax withheld on a receipt, no advances in the settings', async () => {
      fake.reportsTables = false;
      await reports();
      await page.getByRole('table', { name: 'רווח והפסד מול התקופה המקבילה' }).waitFor();
      assert.equal(await page.getByRole('group', { name: 'איזה דוח' }).count(), 0, 'only the summary');
      const d = await openReceipt();
      await page.waitForTimeout(800);
      assert.equal(await d.getByRole('button', { name: '+ ניכוי במקור' }).count(), 0, 'no tax withheld');
      assert.equal(await d.getByLabel('אמצעי תשלום 1').locator('option[value="withholding"]').count(), 0);
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      await goto('/finance/settings');
      await page.getByText('פרטי העסק על המסמכים').waitFor({ timeout: 120_000 });
      await page.waitForTimeout(800);
      assert.equal(await page.getByText('מקדמות מס הכנסה').count(), 0, 'no advances');
      fake.reportsTables = true;
    });

    await step('a receipt with tax withheld at source: off the transfer, the percent kept; the money screens leave it out', async () => {
      const d = await openReceipt();
      await d.getByRole('button', { name: '+ ניכוי במקור' }).click();
      await d.getByLabel('סכום תשלום 2').fill('59');
      assert.equal(await d.getByLabel('סכום תשלום 1').inputValue(), '1121', 'the transfer is what is left');
      await d.getByLabel('אחוז ניכוי במקור 2').fill('5');
      await shot('rep-1-receipt.png');
      await d.getByRole('button', { name: 'הפקת קבלה' }).click();
      await page.getByText(/הופקה קבלה מס׳ 1 · ₪1,180/).waitFor();
      const r = fake.tables.documents.find((x) => x.doc_type === 400)!;
      assert.deepEqual(r.payments.map((p: any) => [p.method, p.m, p.amount, p.pct ?? null]), [[4, 'transfer', 1121, null], [9, 'withholding', 59, 5]]);
      const w = fake.tables.payments.find((p) => p.document_id === r.id && p.method === 'withholding')!;
      assert.equal(w.applies_to, INV);
      assert.deepEqual(w.reference, { pct: 5 });
      assert.equal(fake.receivables().find((x) => x.id === INV)!.balance, 0, 'it paid the invoice');
      for (let i = 0; i < 3 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
      // the receipt says it: "ניכוי במקור (5%)"
      await goto('/finance/documents');
      await page.getByText('קבלה 1').first().click({ timeout: 120_000 });
      await dialog().getByText('ניכוי במקור (5%)').waitFor();
      await page.keyboard.press('Escape');
      // the income screen: what came in is money only (1,121 + 236); tax withheld on its own
      await goto('/finance/income');
      await page.getByText('נכנס בפועל').waitFor({ timeout: 120_000 });
      await page.getByText('₪1,357').first().waitFor();
      await page.getByText('ניכוי במקור ₪59 — לא כסף, לא בסכומים').waitFor();
      await page.getByText(/ניכוי במקור 5%/).first().waitFor();
    });

    await step('by customer → the customer\'s card: the charge, the payments (tax withheld too), the balance', async () => {
      await reports();
      await pick('לפי לקוח');
      const t = table('הכנסות לפי לקוח');
      await t.waitFor();
      const rows = await cells(t);
      assert.ok(rows.some((r) => /דנה כהן/.test(r) && /1,000\.00/.test(r) && /1,180\.00/.test(r)), rows.join(' | '));
      assert.ok(rows.some((r) => /יוסי לוי/.test(r) && /200\.00/.test(r)), rows.join(' | '));
      assert.ok(/סה״כ.*1,200\.00.*216\.00.*1,416\.00/.test(rows.at(-1)!), rows.at(-1));
      await shot('rep-2-customers.png');
      await t.getByRole('button', { name: /דנה כהן/ }).click();
      const l = table('כרטסת לקוח — דנה כהן');
      await l.waitFor();
      const lr = await cells(l);
      assert.ok(lr.some((r) => /יתרת פתיחה/.test(r)), 'the opening balance');
      assert.ok(lr.some((r) => /חיוב/.test(r) && /חשבונית מס 1/.test(r) && /1,180\.00/.test(r)), lr.join(' | '));
      assert.ok(lr.some((r) => /תשלום · ניכוי במקור/.test(r) && /59\.00/.test(r)), lr.join(' | '));
      assert.ok(/יתרת סגירה.*1,180\.00.*1,180\.00.*0\.00/.test(lr.at(-1)!), lr.at(-1));
      await shot('rep-3-ledger.png');
    });

    await step('every table as CSV (Excel\'s Hebrew) and as PDF (the table the screen shows)', async () => {
      const c = await csvOf('כרטסת לקוח — דנה כהן');
      assert.ok(c.text.startsWith('﻿"תאריך","פעולה","מסמך","חובה","זכות","יתרה"'), c.text.slice(0, 80));
      assert.ok(c.text.includes('"תשלום · ניכוי במקור","קבלה 1","","59.00"'), c.text);
      // (the file's Hebrew name: headless Chromium names a download with a Hebrew name "download" — the name is checked in tests/reports.test.ts)
      const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'כרטסת לקוח — דנה כהן — הורדת PDF' }).click()]);
      assert.equal(readFileSync(await d.path(), 'utf8').slice(0, 5), '%PDF-', 'the file the server answered');
      const b = pdfBodies.at(-1);
      assert.equal(b.title, 'כרטסת לקוח — דנה כהן');
      assert.deepEqual(b.columns.map((x: any) => x.label), ['תאריך', 'פעולה', 'מסמך', 'חובה', 'זכות', 'יתרה']);
      assert.ok(b.rows.some((r: string[]) => r[1] === 'תשלום · ניכוי במקור' && r[4] === '59.00'), JSON.stringify(b.rows));
      assert.match(b.subtitle, /\d{2}\/\d{2}\/\d{4} – \d{2}\/\d{2}\/\d{4} · דנה כהן$/);
      await page.getByText('ה-PDF ירד.').waitFor();
    });

    await step('sales by item and by treatment type; suppliers paid and not yet → a supplier\'s card', async () => {
      await pick('לפי פריט וטיפול');
      const types = await cells(table('מכירות לפי סוג טיפול'));
      assert.ok(types.some((r) => /לייזר/.test(r) && /1,000\.00/.test(r)), types.join(' | '));
      assert.ok(types.some((r) => /בלי סוג טיפול/.test(r) && /200\.00/.test(r)), types.join(' | '));
      const items = await cells(table('מכירות לפי פריט ושירות'));
      assert.ok(items.some((r) => /קרם הרגעה/.test(r) && /מוצר/.test(r) && /\b2\b/.test(r) && /200\.00/.test(r)), items.join(' | '));
      await pick('ספקים והוצאות');
      const s = table('הוצאות לפי ספק');
      await s.waitFor();
      await page.getByText('עוד לא שולם').waitFor();
      const sr = await cells(s);
      assert.ok(/סה״כ.*944\.00.*354\.00.*590\.00/.test(sr.at(-1)!), sr.at(-1));
      await s.getByRole('button', { name: /ספק ציוד/ }).click();
      const l = await cells(table('כרטסת ספק — ספק ציוד'));
      assert.ok(l.some((r) => /חשבונית ספק/.test(r) && /7101/.test(r) && /590\.00/.test(r)), l.join(' | '));
      assert.ok(/יתרת סגירה.*590\.00/.test(l.at(-1)!), l.at(-1));
    });

    await step('tax withheld at source by customer, for the year', async () => {
      await pick('ניכוי במקור');
      await page.getByRole('button', { name: /^להציג את \d{4}$/ }).click();
      const t = await cells(table('ניכוי במקור לפי לקוח'));
      assert.ok(t.some((r) => /דנה כהן/.test(r) && /59\.00/.test(r)), t.join(' | '));
      const rows = await cells(table('ניכוי במקור — קבלות'));
      assert.ok(rows.some((r) => /קבלה 1/.test(r) && /חשבונית מס 1/.test(r) && /5%/.test(r)), rows.join(' | '));
      const c = await csvOf('ניכוי במקור לפי לקוח');
      assert.ok(c.text.includes('"דנה כהן","","1","59.00"'), c.text);
      await shot('rep-4-withholding.png');
    });

    await step('profit and loss against the same period a year before', async () => {
      await pick('סיכום');
      const t = await cells(table('רווח והפסד מול התקופה המקבילה'));
      assert.ok(t.some((r) => /הכנסות \(לפני מע״מ\).*1,200\.00.*0\.00.*1,200\.00/.test(r)), t.join(' | '));
      assert.ok(/רווח משוער/.test(t.at(-1)!), t.at(-1));
      await page.getByText('ניכוי במקור (לא כסף — שילם חשבוניות)').waitFor();
    });

    await step('the advances: no percent yet → the settings → an estimate, marked as one', async () => {
      await pick('מקדמות');
      await page.getByText('לא נקבע שיעור מקדמה').waitFor();
      await goto('/finance/settings');
      const f = page.getByLabel('שיעור המקדמה % (מפנקס המקדמות; ריק = לא מוצג)');
      await f.fill('101');
      await page.getByRole('button', { name: 'שמירת ההגדרות' }).click();
      await page.getByRole('alert').filter({ hasText: 'שיעור המקדמה' }).waitFor();
      await f.fill('7.5');
      await page.getByRole('button', { name: 'שמירת ההגדרות' }).click();
      await page.getByText(/ההגדרות נשמרו/).waitFor();
      assert.equal(Number(fake.tables.business_finance_profile[0].advance_pct), 7.5);
      await reports();
      await pick('מקדמות');
      await page.getByText('הערכה בלבד', { exact: true }).waitFor();
      // 2.97 — the accountant (11.10.2026): ₪1,200 × 7.5% = ₪90, less the ₪59 withheld at source in the period = ₪31
      await page.getByText('₪31').first().waitFor();
      await page.getByText(/= ₪90 − ניכוי במקור ₪59/).waitFor();
      const t = await cells(table('מקדמות מס הכנסה — הערכה'));
      assert.ok(t.some((r) => /מקדמה לפני קיזוז.*90\.00/.test(r)) && t.some((r) => /ניכוי במקור בתקופה.*59\.00/.test(r))
        && t.some((r) => /מקדמה משוערת \(אחרי קיזוז הניכוי במקור\).*31\.00/.test(r)) && t.some((r) => /7\.5%/.test(r)), t.join(' | '));
      await shot('rep-5-advances.png');
    });

    await step('a service\'s treatment type in the product editor (a product has none)', async () => {
      await goto('/register');
      await page.getByRole('heading', { name: 'קופה' }).waitFor({ timeout: 120_000 });
      await page.getByRole('button', { name: /^מחירון ומלאי/ }).first().click();
      await page.locator('div.p-3', { hasText: 'טיפול לייזר' }).first().getByRole('button', { name: 'עריכה: טיפול לייזר' }).click();
      const ed = dialog();
      const type = ed.getByLabel('סוג טיפול (לדוח המכירות לפי סוג טיפול)');
      await type.waitFor();
      assert.equal(await type.inputValue(), TYPE);
      await type.selectOption('');
      await ed.getByRole('button', { name: 'שמירה', exact: true }).click();
      for (let i = 0; i < 50 && fake.tables.catalog_items.find((x) => x.id === LASER)!.treatment_type_id !== null; i++) await page.waitForTimeout(100);
      assert.equal(fake.tables.catalog_items.find((x) => x.id === LASER)!.treatment_type_id, null, 'saved without a type');
      await page.keyboard.press('Escape');
      await page.locator('div.p-3', { hasText: 'קרם הרגעה' }).first().getByRole('button', { name: 'עריכה: קרם הרגעה' }).click();
      await dialog().getByRole('heading', { name: 'קרם הרגעה', exact: true }).waitFor();
      await page.waitForTimeout(600);
      assert.equal(await dialog().getByLabel('סוג טיפול (לדוח המכירות לפי סוג טיפול)').count(), 0, 'a product: no treatment type');
      await page.keyboard.press('Escape');
      fake.tables.catalog_items.find((x) => x.id === LASER)!.treatment_type_id = TYPE;
    });

    await step('a customer\'s card from an address (the CRM\'s "כרטסת")', async () => {
      await goto(`/finance/reports?view=cledger&key=l:${DANA}`);
      await table('כרטסת לקוח — דנה כהן').waitFor({ timeout: 120_000 });
      await page.getByRole('button', { name: 'לקוח אחר' }).click();
      await page.getByLabel('חיפוש לקוח לכרטסת').fill('דנה');
      await page.getByRole('button', { name: /^דנה כהן/ }).click();
      await table('כרטסת לקוח — דנה כהן').waitFor();
    });

    await step('a phone: the reports fit (the tables scroll inside their cards)', async () => {
      const { page: phone } = await context(PHONE_VIEW);
      await reports(phone);
      await fits(phone, 'reports · summary');
      await pick('לפי לקוח', phone);
      await table('הכנסות לפי לקוח', phone).waitFor();
      await fits(phone, 'reports · by customer');
      await table('הכנסות לפי לקוח', phone).getByRole('button', { name: /דנה כהן/ }).click();
      await table('כרטסת לקוח — דנה כהן', phone).waitFor();
      await fits(phone, 'reports · the card');
      await shot('rep-6-phone.png', phone);
      await pick('ספקים והוצאות', phone);
      await table('הוצאות לפי ספק', phone).waitFor();
      await fits(phone, 'reports · suppliers');
    });

    assert.deepEqual(errors, [], `page errors: ${errors.join(' · ')}`);
  } finally {
    await browser.close().catch(() => null);
    try { process.kill(-dev.pid!, 'SIGTERM'); } catch { /* gone */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (errors.length) console.log(`page errors: ${errors.join(' · ')}`);
  process.exit(failed.length || errors.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
