/**
 * Manual journal entries, one-sided (docs/FINANCE_ADDITIONS_HE.md T13א; 2.96) in a real browser (Chromium via Playwright), against
 * the in-memory Supabase of fake-supabase.ts. The rules themselves are tested on Postgres (tests/sql/journal.check.sql: every kind,
 * the totals of the money summary and of every report, the cards, a location, closed books, who may record; concurrency.sh §21;
 * stock-compare.sh 5100: the summary and the reports the same without entries). Here the screens are clicked through:
 *   before migration 5100 nothing of it is offered (no menu item, the screen says what is missing);
 *   the owner records an income entry on Dana's card (the VAT at the rate in one tap, the explanation required, what it does shown
 *   before it is recorded), an expense of a supplier by name and number, a VAT entry on inputs and an "other" entry;
 *   the money screens say how much of each number is manual (profit and loss, the VAT working paper, the lobby); the reports carry
 *   them — by customer, the customer's card and the supplier's card ("פקודה ידנית" with its explanation), by item, by supplier;
 *   a reversing entry (once, with a reason): the entry stays, marked, and the reports net it out; the audit log has every entry;
 *   closed books: refused on the screen, and by the database when they were closed meanwhile; not an owner: nothing to record;
 *   a reversal of an earlier period's entry names it, and that period shows the entry undone;
 *   an exempt dealer: no VAT; the entries as CSV and in the accountant's package; a phone: the screen and the form fit.
 *
 * Run: npx -y tsx tests/e2e/journal.e2e.ts   (starts `next dev` on port 3233; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (jr* — not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_JOURNAL_PORT ?? 3233);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000000d5';
const OWNER = 'a0000000-0000-4000-8000-0000000000d5';
const DANA = 'e0000000-0000-4000-8000-0000000000d1';
const LASER = 'f0000000-0000-4000-8000-0000000000d1';
const CREAM = 'f0000000-0000-4000-8000-0000000000d2';
const INV = '90000000-0000-4000-8000-0000000000d1';
const PHONE_VIEW = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const dmy = (d: string) => d.split('-').reverse().join('/');

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
    treatment_types: [],
    catalog_items: [
      { ...base, id: LASER, name: 'טיפול לייזר', price: 1180, kind: 'service', active: true, sort: 0, favorite: true, fav_order: 0, image_url: '', track_stock: false, stock_qty: 0,
        low_stock: 0, has_variants: false, sku: '', barcode: '', publish_online: false, track_serials: false, treatment_type_id: null },
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
      { ...base, id: '90000000-0000-4000-8000-0000000000d2', doc_type: 320, doc_number: 1, link_no: 2, issued_at: `${TODAY}T09:00:00Z`, doc_date: TODAY, customer_name: 'יוסי לוי',
        customer_phone: '', customer_dealer: '', lead_id: null, before_discount: 200, discount: 0, after_discount: 200, vat_amount: 36, total: 236, vat_rate: 18,
        lines: [line('קרם הרגעה', 200, 2, CREAM)], payments: [{ method: 1, amount: 236, date: TODAY, m: 'cash' }], print_count: 1, share_token: 'b'.repeat(64), issuer, source: 'direct', notes: '', location_id: BIZ },
    ],
    payments: [{ id: '80000000-0000-4000-8000-0000000000d1', business_id: BIZ, user_id: OWNER, direction: 'in', amount: 236, method: 'cash', paid_on: TODAY, source: 'document',
      document_id: '90000000-0000-4000-8000-0000000000d2', applies_to: null, sale_id: null, lead_id: null, reference: {}, note: '', created_at: `${TODAY}T09:00:00Z`, location_id: BIZ },
      { id: '80000000-0000-4000-8000-0000000000d2', business_id: BIZ, user_id: OWNER, direction: 'out', amount: 354, method: 'card', paid_on: TODAY, source: 'expense',
        expense_id: '60000000-0000-4000-8000-0000000000d2', note: 'חברת החשמל', created_at: `${TODAY}T10:00:00Z`, location_id: BIZ }],
    // a supplier's invoice not paid yet, and the electricity paid by card
    expenses: [
      { ...base, id: '60000000-0000-4000-8000-0000000000d1', expense_number: 1, status: 'confirmed', supplier_name: 'ספק ציוד', supplier_dealer: '516000017', supplier_doc_type: 'tax_invoice',
        supplier_doc_number: '7101', allocation_number: '', doc_date: TODAY, category: 'equipment', description: '', amount_before_vat: 500, vat_amount: 90, total: 590, vat_deductible_pct: 100,
        paid_on: null, payment_method: null, file_path: '', stock_lines: [], void_reason: '', location_id: BIZ },
      { ...base, id: '60000000-0000-4000-8000-0000000000d2', expense_number: 2, status: 'confirmed', supplier_name: 'חברת החשמל', supplier_dealer: '', supplier_doc_type: 'tax_invoice',
        supplier_doc_number: '', allocation_number: '', doc_date: TODAY, category: 'utilities', description: '', amount_before_vat: 300, vat_amount: 54, total: 354, vat_deductible_pct: 100,
        paid_on: TODAY, payment_method: 'card', file_path: '', stock_lines: [], void_reason: '', location_id: BIZ },
    ],
    journal_entries: [],
    stores: [], store_domains: [], store_theme_versions: [], store_pages: [], store_menus: [],
    employees: [], sales: [], register_shifts: [], booking_services: [], appointments: [],
    sale_refunds: [], content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [],
    push_subscriptions: [], quotes: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [],
    payment_requests: [], payment_plans: [], payment_plan_items: [], client_packages: [], client_package_uses: [], client_sessions: [], client_treatments: [],
    catalog_media: [], catalog_field_defs: [], catalog_collections: [], debt_reminders: [], debt_reminder_stops: [], recurring_plans: [], recurring_charges: [],
    bank_deposits: [], bank_deposit_cheques: [], bank_statements: [], bank_lines: [], bank_matches: [], cheque_reminders: [],
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
  for (const p of ['/finance/journal', '/finance/reports', '/finance', '/finance/accountant']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@laser.test' });
  const errors: string[] = [];
  const said: string[] = [];
  const calls: string[] = [];

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
      await page.screenshot({ path: path.join(SHOTS, `jr-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
    finally { clearTimeout(timer); }
  };
  const dialog = (p: any = page) => p.getByRole('dialog').last();
  const shot = async (name: string, p: any = page) => { await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, name), fullPage: true }); };
  const menu = (p: any = page) => p.getByRole('complementary', { name: 'ניווט כספים' });
  const journal = async (p: any = page) => { await goto('/finance/journal', p); await p.getByText('תנועה שלא נוצרה ממסמך').waitFor({ timeout: 120_000 }); };
  const entry = (n: number, p: any = page) => p.locator(`li[data-entry="${n}"]`);
  const entries = () => (fake.tables.journal_entries ?? []) as Record<string, any>[];
  const reports = async () => { await goto('/finance/reports'); await page.getByText('רווח והפסד (הערכה)').first().waitFor({ timeout: 120_000 }); };
  const pick = async (label: string) => { await page.getByRole('group', { name: 'איזה דוח' }).getByRole('button', { name: label, exact: true }).click(); };
  const table = (title: string, p: any = page) => p.getByRole('table', { name: title });
  const cells = async (t: any): Promise<string[]> => { await t.waitFor(); return (await t.locator('tr').allInnerTexts()).map((x: string) => x.replace(/\s+/g, ' ').trim()); };
  /** a line of the summary's lists ("dt … dd"): its text, one line */
  const summaryLine = async (label: string) => (await page.locator('div').filter({ has: page.locator('dt', { hasText: label }) }).last().innerText()).replace(/\s+/g, ' ');
  /** the form of a new entry, open */
  const newEntry = async (p: any = page) => {
    await p.getByRole('button', { name: '+ פקודה ידנית' }).click();
    const d = dialog(p);
    await d.getByRole('heading', { name: 'פקודה ידנית' }).waitFor();
    return d;
  };
  const record = async (d: any, n: number) => {
    await d.getByRole('button', { name: 'רישום הפקודה' }).click();
    await page.getByText(`פקודה ${n} נרשמה`).first().waitFor();
    await entry(n).waitFor();
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
    await step('before migration 5100: no "פקודות יומן" in the menu, the screen says what is missing', async () => {
      fake.journalTables = false;
      await goto('/finance');
      await menu().getByRole('link', { name: 'דוחות', exact: true }).waitFor({ timeout: 120_000 });
      await page.waitForTimeout(1000);
      assert.equal(await menu().getByRole('link', { name: 'פקודות יומן' }).count(), 0, 'no menu item');
      await goto('/finance/journal');
      await page.getByText(/מיגרציה 20261011005100/).waitFor({ timeout: 120_000 });
      assert.equal(await page.getByRole('button', { name: '+ פקודה ידנית' }).count(), 0);
      fake.journalTables = true;
    });

    await step('after it: "פקודות יומן" under דוחות ורואה חשבון — no entries yet, the owner may record', async () => {
      await goto('/finance');
      const link = menu().getByRole('link', { name: 'פקודות יומן' });
      await link.waitFor({ timeout: 120_000 });
      await link.click();
      await page.waitForURL('**/finance/journal');
      await page.getByText('אין פקודות ידניות בתקופה הזו.').first().waitFor({ timeout: 120_000 });
      await page.getByRole('button', { name: '+ פקודה ידנית' }).waitFor();
    });

    await step('an income entry on Dana\'s card: the VAT at the rate in one tap, the explanation required, what it does — recorded once', async () => {
      const d = await newEntry();
      assert.equal(await d.getByRole('radio', { name: 'הכנסה' }).getAttribute('aria-checked'), 'true', 'income first');
      await d.getByLabel('סכום לפני מע״מ').fill('200');
      await d.getByRole('button', { name: 'לפי 18%: ₪36' }).click();
      assert.equal(await d.getByLabel('מע״מ', { exact: true }).inputValue(), '36');
      await d.getByRole('radio', { name: 'לקוח' }).click();
      await d.getByLabel('חיפוש לקוח').fill('דנה');
      await d.getByRole('button', { name: /דנה כהן/ }).click();
      await d.getByText('מקושר לכרטיס של דנה כהן').waitFor();
      await d.getByText('הכנסות +₪200 · מע״מ עסקאות +₪36').waitFor();
      // no explanation: the screen says so, nothing is sent
      await d.getByRole('button', { name: 'רישום הפקודה' }).click();
      await d.getByText('הסבר — חובה (מה הפקודה ולמה)').waitFor();
      assert.equal(entries().length, 0, 'nothing recorded');
      await d.getByLabel('הסבר (חובה)').fill('תיקון הכנסה מחודש קודם');
      await shot('jr-1-income.png');
      await record(d, 1);
      assert.ok(said.some((m) => /^לרשום את הפקודה\? הכנסות \+₪200 · מע״מ עסקאות \+₪36\. פקודה שנרשמה לא נמחקת/.test(m)), said.join(' | '));
      const [j] = entries();
      assert.deepEqual([j.number, j.entry_date, j.kind, j.amount, j.vat, j.vat_side, j.category, j.party_kind, j.lead_id, j.party_name, j.location_id, j.reverses],
        [1, TODAY, 'income', 200, 36, 'output', null, 'customer', DANA, 'דנה כהן', BIZ, null]);
      const li = entry(1);
      await li.getByText('תיקון הכנסה מחודש קודם').waitFor();
      await li.getByText('לקוח: דנה כהן').waitFor();
      await li.getByText('₪200 + מע״מ ₪36').waitFor();
      await li.getByRole('button', { name: 'פקודה הפוכה' }).waitFor();
    });

    await step('an expense of a supplier (name and number), a VAT entry on inputs and an "other" entry', async () => {
      let d = await newEntry();
      await d.getByRole('radio', { name: 'הוצאה' }).click();
      await d.getByLabel('סכום לפני מע״מ').fill('100');
      await d.getByLabel('מע״מ', { exact: true }).fill('18');
      await d.getByLabel('סוג הוצאה').selectOption('equipment');
      await d.getByRole('radio', { name: 'ספק' }).click();
      await d.getByLabel('שם הספק').fill('ספק ציוד');
      await d.getByLabel('מספר עוסק').fill('516000017');
      await d.getByLabel('הסבר (חובה)').fill('הפרשה לתיקון ציוד');
      await d.getByText('הוצאות +₪100 · מע״מ תשומות +₪18').waitFor();
      await record(d, 2);
      // VAT on inputs: no amount before VAT, a side to pick
      d = await newEntry();
      await d.getByRole('radio', { name: 'מע״מ', exact: true }).click();
      assert.equal(await d.getByLabel('סכום לפני מע״מ').count(), 0, 'VAT only');
      await d.getByLabel('סכום המע״מ', { exact: true }).fill('20');
      await d.getByLabel('הסבר (חובה)').fill('תיקון מע״מ תשומות מדוח קודם');
      await d.getByRole('button', { name: 'רישום הפקודה' }).click();
      await d.getByText('מע״מ עסקאות או מע״מ תשומות?').waitFor();
      await d.getByRole('radio', { name: 'מע״מ תשומות' }).click();
      assert.equal(await d.getByRole('radiogroup', { name: 'שייך ל' }).count(), 0, 'a VAT entry belongs to nobody');
      await record(d, 3);
      // "other": no VAT, changes no number
      d = await newEntry();
      await d.getByRole('radio', { name: 'אחר' }).click();
      assert.equal(await d.getByLabel('מע״מ', { exact: true }).count(), 0, 'no VAT');
      await d.getByLabel('סכום', { exact: true }).fill('300');
      await d.getByText('לא משנה הכנסות, הוצאות או מע״מ — רק ברשימה ובכרטסת').first().waitFor();
      await d.getByLabel('הסבר (חובה)').fill('העברה בין סיווגים');
      await record(d, 4);
      const by = (n: number) => entries().find((x) => x.number === n)!;
      assert.deepEqual([by(2).kind, by(2).amount, by(2).vat, by(2).vat_side, by(2).category, by(2).party_kind, by(2).party_name, by(2).party_dealer], ['expense', 100, 18, 'input', 'equipment', 'supplier', 'ספק ציוד', '516000017']);
      assert.deepEqual([by(3).kind, by(3).amount, by(3).vat, by(3).vat_side, by(3).party_kind], ['vat', 0, 20, 'input', null]);
      assert.deepEqual([by(4).kind, by(4).amount, by(4).vat, by(4).vat_side], ['other', 300, 0, null]);
      await page.getByText('הכנסות מפקודות').waitFor();
      const stats = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
      assert.match(stats, /הכנסות מפקודות ₪200 מע״מ עסקאות ₪36/);
      assert.match(stats, /הוצאות מפקודות ₪100 מע״מ תשומות ₪38/);
      assert.match(stats, /פקודות בתקופה 4/);
      await shot('jr-2-list.png');
    });

    await step('the money screens say how much of each number is manual: profit and loss, the VAT working paper, the lobby', async () => {
      await reports();
      assert.match(await summaryLine('מתוכן פקודות יומן ידניות — הכנסות'), /₪200/);
      assert.match(await summaryLine('מתוכן פקודות יומן ידניות — הוצאות'), /₪100/);
      assert.match(await summaryLine('מתוכן פקודות יומן ידניות — מע״מ עסקאות'), /₪36/);
      assert.match(await summaryLine('מתוכן פקודות יומן ידניות — מע״מ תשומות'), /₪38/);
      // the numbers themselves are finance_summary's (the fake mirrors the database; journal.check.sql proves the database)
      const s = fake.summary(TODAY, TODAY);
      assert.deepEqual([s.revenue.net, s.revenue.vat, s.expenses.net, s.expenses.vatDeductible, s.vatPayable, s.profit], [1400, 252, 900, 182, 70, 500]);
      await shot('jr-3-reports.png');
      await goto('/finance');
      await page.getByText('מתוכן פקודות ידניות ₪200').waitFor({ timeout: 120_000 });
      await page.getByText('ופקודות ידניות ₪100').waitFor();
    });

    await step('the reports: by customer and the customer\'s card, by item, by supplier and the supplier\'s card — "פקודה ידנית"', async () => {
      await reports();
      await pick('לפי לקוח');
      const t = table('הכנסות לפי לקוח');
      const rows = await cells(t);
      assert.ok(rows.some((r) => /דנה כהן/.test(r) && /1,200\.00/.test(r) && /216\.00/.test(r) && /1,416\.00/.test(r)), rows.join(' | '));
      assert.ok(/סה״כ.*1,400\.00.*252\.00.*1,652\.00/.test(rows.at(-1)!), rows.at(-1));
      await page.getByText(/כולל פקודות יומן ידניות: ₪200\./).waitFor();
      await t.getByRole('button', { name: /דנה כהן/ }).click();
      const l = await cells(table('כרטסת לקוח — דנה כהן'));
      assert.ok(l.some((r) => /פקודה ידנית — תיקון הכנסה מחודש קודם/.test(r) && /פקודה 1/.test(r) && /236\.00/.test(r)), l.join(' | '));
      assert.ok(/יתרת סגירה.*1,416\.00/.test(l.at(-1)!), l.at(-1));
      await shot('jr-4-card.png');
      await pick('לפי פריט וטיפול');
      const items = await cells(table('מכירות לפי פריט ושירות'));
      assert.ok(items.some((r) => /פקודות יומן ידניות/.test(r) && /200\.00/.test(r)), items.join(' | '));
      assert.ok(/סה״כ.*1,400\.00/.test(items.at(-1)!), items.at(-1));
      await pick('ספקים והוצאות');
      const s = table('הוצאות לפי ספק');
      const sr = await cells(s);
      assert.ok(sr[0].includes('פקודות ידניות'), sr[0]);
      // ספק ציוד: the invoice (590, not paid) and the entry (118) — the entry is in the total, never owed
      assert.ok(sr.some((r) => /ספק ציוד/.test(r) && /708\.00/.test(r) && /590\.00/.test(r) && /118\.00/.test(r)), sr.join(' | '));
      await s.getByRole('button', { name: /ספק ציוד/ }).click();
      const sl = await cells(table('כרטסת ספק — ספק ציוד'));
      assert.ok(sl.some((r) => /פקודה ידנית — הפרשה לתיקון ציוד/.test(r) && /פקודה 2/.test(r) && /118\.00/.test(r)), sl.join(' | '));
      assert.ok(/יתרת סגירה.*708\.00/.test(sl.at(-1)!), sl.at(-1));
    });

    await step('a reversing entry: once, with a reason — the entry stays, marked; the reports net it out', async () => {
      await journal();
      await entry(1).getByRole('button', { name: 'פקודה הפוכה' }).click();
      const d = dialog();
      await d.getByRole('heading', { name: 'פקודה הפוכה לפקודה 1' }).waitFor();
      await d.getByText('הכנסות −₪200 · מע״מ עסקאות −₪36').waitFor();
      await d.getByRole('button', { name: 'רישום הפקודה ההפוכה' }).click();
      await d.getByText('סיבה — חובה').waitFor();
      await d.getByLabel('סיבה (חובה)').fill('נרשמה פעמיים');
      await d.getByRole('button', { name: 'רישום הפקודה ההפוכה' }).click();
      await page.getByText('פקודה 5 הופכת את פקודה 1').first().waitFor();
      await entry(1).getByText('בוטלה בפקודה 5').waitFor();
      await entry(5).getByText('הופכת את פקודה 1').waitFor();
      assert.equal(await entry(1).getByRole('button', { name: 'פקודה הפוכה' }).count(), 0, 'reversed once');
      assert.equal(await entry(5).getByRole('button', { name: 'פקודה הפוכה' }).count(), 0, 'a reversal is not reversed');
      const one = entries().find((x) => x.number === 1)!, five = entries().find((x) => x.number === 5)!;
      assert.deepEqual([five.kind, five.amount, five.vat, five.vat_side, five.lead_id, five.reverses, five.explanation], ['income', -200, -36, 'output', DANA, one.id, 'נרשמה פעמיים']);
      assert.equal(one.amount, 200, 'the entry itself never changes');
      await shot('jr-5-reversed.png');
      await reports();
      await page.getByText('מתוכן פקודות יומן ידניות — הוצאות').waitFor();
      assert.equal(await page.getByText('מתוכן פקודות יומן ידניות — הכנסות').count(), 0, '200 − 200: nothing manual in the income');
      await pick('לפי לקוח');
      await table('הכנסות לפי לקוח').getByRole('button', { name: /דנה כהן/ }).click();
      const l = await cells(table('כרטסת לקוח — דנה כהן'));
      assert.equal(l.filter((r) => /פקודה ידנית/.test(r)).length, 2, l.join(' | '));
      assert.ok(/יתרת סגירה.*1,180\.00/.test(l.at(-1)!), l.at(-1));
    });

    await step('the audit log has every entry (the accountant\'s screen)', async () => {
      await goto('/finance/accountant');
      await page.getByText('יומן ביקורת כספי').waitFor({ timeout: 120_000 });
      await page.getByText(/נרשמה פקודה ידנית · מס׳ 1 · ₪200 · תיקון הכנסה מחודש קודם/).waitFor();
      await page.getByText(/נרשמה פקודה ידנית · מס׳ 4 · ₪300 · העברה בין סיווגים/).waitFor();
      await page.getByText(/נרשמה פקודה הפוכה · מס׳ 5 .*נרשמה פעמיים/).waitFor();
      assert.deepEqual(fake.tables.finance_audit_log.filter((r) => r.action.startsWith('journal.')).map((r) => [r.action, r.details.number]),
        [['journal.created', 1], ['journal.created', 2], ['journal.created', 3], ['journal.created', 4], ['journal.reversed', 5]]);
    });

    await step('closed books: refused by the database when closed meanwhile, then on the screen', async () => {
      await journal();
      await entry(5).waitFor();
      fake.finance.lockedUntil = TODAY; // the books were closed on another device after this screen opened
      let d = await newEntry();
      await d.getByLabel('סכום לפני מע״מ').fill('50');
      await d.getByLabel('הסבר (חובה)').fill('בדיקת ספרים סגורים');
      await d.getByRole('button', { name: 'רישום הפקודה' }).click();
      await d.getByText('הספרים סגורים לתקופה הזו — אי אפשר להפיק או לשנות בה מסמכים והוצאות.').waitFor();
      assert.equal(entries().length, 5, 'nothing recorded');
      await page.keyboard.press('Escape');
      await journal();
      await page.getByText('ספרים סגורים עד', { exact: true }).waitFor();
      d = await newEntry();
      await d.getByLabel('סכום לפני מע״מ').fill('50');
      await d.getByLabel('הסבר (חובה)').fill('בדיקת ספרים סגורים');
      await d.getByRole('button', { name: 'רישום הפקודה' }).click();
      await d.getByText(`הספרים סגורים עד ${dmy(TODAY)} — פקודה בתאריך מאוחר יותר`).waitFor();
      await page.keyboard.press('Escape');
      await entry(2).getByRole('button', { name: 'פקודה הפוכה' }).click();
      d = dialog();
      await d.getByLabel('סיבה (חובה)').fill('בדיקה');
      await d.getByRole('button', { name: 'רישום הפקודה ההפוכה' }).click();
      await d.getByText(`הספרים סגורים עד ${dmy(TODAY)}`).waitFor();
      assert.equal(entries().length, 5, 'nothing recorded');
      await page.keyboard.press('Escape');
      fake.finance.lockedUntil = null;
    });

    await step('not an owner (an editor): the entries, but nothing to record or reverse', async () => {
      fake.owner = false; fake.tables.business_members[0].role = 'editor';
      try {
        await journal();
        await entry(5).waitFor();
        await page.getByText('רק הבעלים (ורואה חשבון שצורף לעסק) רושמים פקודות.').waitFor();
        assert.equal(await page.getByRole('button', { name: '+ פקודה ידנית' }).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'פקודה הפוכה' }).count(), 0);
      } finally { fake.owner = true; fake.tables.business_members[0].role = 'owner'; }
    });

    await step('the entries as CSV, and in the accountant\'s package (פקודות-יומן.csv)', async () => {
      await journal();
      await entry(5).waitFor();
      const [c] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'פקודות יומן ידניות — הורדת CSV' }).click()]);
      const text = readFileSync(await c.path(), 'utf8');
      assert.ok(text.startsWith('﻿"מס׳","תאריך","סוג","לפני מע״מ","מע״מ","הסבר","לקוח / ספק","ביטול"'), text.slice(0, 120));
      assert.ok(text.includes('"תיקון הכנסה מחודש קודם","לקוח: דנה כהן","בוטלה ב-5"'), text);
      assert.ok(text.includes('"נרשמה פעמיים","לקוח: דנה כהן","הופכת את 1"'), text);
      await goto('/finance/accountant');
      await page.getByRole('button', { name: 'הורדת החבילה (ZIP)' }).waitFor({ timeout: 120_000 });
      const [z] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.getByRole('button', { name: 'הורדת החבילה (ZIP)' }).click()]);
      const zip = await JSZip.loadAsync(readFileSync(await z.path()));
      const name = Object.keys(zip.files).find((f) => f.endsWith('/פקודות-יומן.csv'));
      assert.ok(name, Object.keys(zip.files).join(' | '));
      assert.ok((await zip.file(name!)!.async('string')).includes('העברה בין סיווגים'));
    });

    await step('an exempt dealer: no VAT entry and no VAT on an entry', async () => {
      const s = fake.tables.register_settings[0];
      Object.assign(s, { entity_type: 'exempt_dealer', business_type: 'exempt' });
      try {
        await journal();
        const d = await newEntry();
        assert.equal(await d.getByRole('radio', { name: 'מע״מ', exact: true }).count(), 0, 'no VAT kind');
        assert.equal(await d.getByLabel('מע״מ', { exact: true }).count(), 0, 'no VAT field');
        await d.getByLabel('סכום', { exact: true }).waitFor();
        await page.keyboard.press('Escape');
      } finally { Object.assign(s, { entity_type: 'company', business_type: 'licensed' }); }
    });

    await step('a reversal of an earlier period\'s entry names it; that period shows the entry undone', async () => {
      const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 70);   // always before the VAT period on the screen
      const day = d.toISOString().slice(0, 10);
      const six = '30000000-0000-4000-8000-0000000000d6', seven = '30000000-0000-4000-8000-0000000000d7';
      const base = { business_id: BIZ, location_id: BIZ, kind: 'other', vat: 0, vat_side: null, category: null, party_kind: null, lead_id: null, party_name: '', party_dealer: '', user_id: OWNER };
      fake.tables.journal_entries.push({ ...base, id: six, number: 6, entry_date: day, amount: 50, explanation: 'הפרשה מתקופה קודמת', reverses: null, created_at: `${day}T08:00:00Z` },
        { ...base, id: seven, number: 7, entry_date: TODAY, amount: -50, explanation: 'ביטול ההפרשה', reverses: six, created_at: `${TODAY}T08:00:00Z` });
      await journal();
      await entry(7).getByText('הופכת את פקודה 6').waitFor();
      assert.equal(await entry(6).count(), 0, 'the entry itself is of an earlier period');
      await page.getByLabel('מתאריך').fill(day);
      await entry(6).getByText('בוטלה בפקודה 7').waitFor();
      assert.equal(await entry(6).getByRole('button', { name: 'פקודה הפוכה' }).count(), 0, 'undone once');
    });

    await step('a phone: the list and the form fit', async () => {
      const { page: phone } = await context(PHONE_VIEW);
      await journal(phone);
      await entry(5, phone).waitFor();
      await fits(phone, 'journal');
      await shot('jr-6-phone.png', phone);
      const d = await newEntry(phone);
      await d.getByRole('radio', { name: 'הוצאה' }).click();
      await d.getByRole('radio', { name: 'ספק' }).click();
      await fits(phone, 'journal · a new entry');
      await shot('jr-7-phone-form.png', phone);
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
