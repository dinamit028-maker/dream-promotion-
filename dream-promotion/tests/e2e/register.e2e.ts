/**
 * The register in a real browser (Chromium via Playwright), against the in-memory Supabase of fake-supabase.ts.
 * Covers what was never clicked through before: a sale with change, holding and resuming a sale (also after a
 * reload), a refund with its credit invoice and stock, close of day with a cash refund, commissions, an invoice
 * to a business, stock deliveries, full screen at 1920, and the cashier's register-only screen.
 *
 * Run: npm run test:e2e   (starts `next dev` on port 3217; needs the preinstalled Chromium)
 * Screenshots go to tests/e2e/shots/ (not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_PORT ?? 3217);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-000000000001';
const OWNER = 'a0000000-0000-4000-8000-0000000000a1';
const CASHIER = 'c0000000-0000-4000-8000-0000000000c1';
const CREAM = 'f0000000-0000-4000-8000-0000000000f1';
const LASER = 'f0000000-0000-4000-8000-0000000000f2';
const DANA = 'd0000000-0000-4000-8000-0000000000d1';

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  return {
    brands: [{ ...base, name: 'SaGabot', onboarded: true, industry: 'קוסמטיקה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', vat_rate: 18, pay_link: '', dealer_number: '515123456', legal_name: 'SaGabot בע״מ', street: 'דיזנגוף', house_no: '10', city: 'תל אביב', zip: '' }],
    catalog_items: [
      { ...base, id: CREAM, name: 'קרם לחות', price: 120, kind: 'product', active: true, sort: 0, favorite: true, fav_order: 0, image_url: '', track_stock: true, stock_qty: 3, low_stock: 2 },
      { ...base, id: LASER, name: 'לייזר רגליים', price: 300, kind: 'service', active: true, sort: 1, favorite: true, fav_order: 1, image_url: '', track_stock: false, stock_qty: 0, low_stock: 2 },
    ],
    employees: [{ ...base, id: 'e0000000-0000-4000-8000-0000000000e1', name: 'שגית', active: true, token: 't'.repeat(32), commission_service_pct: 0, commission_product_pct: 0 }],
    leads: [{ ...base, id: DANA, name: 'דנה כהן', phone: '0521234567', source: 'ידני', status: 'חדש', date: '2026-01-01', tags: [], value: 0, notes: '' }],
    sales: [], documents: [], sale_refunds: [], stock_movements: [], register_shifts: [], appointments: [], booking_services: [],
    content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [], push_subscriptions: [],
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
  const results: { name: string; ok: boolean; error?: string }[] = [];
  const browser = await (async () => { await waitForServer(dev); return chromium.launch(); })();
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@sagabot.test' });
  const notified: string[] = [];
  const errors: string[] = [];

  async function open(o: { access: 'full' | 'register'; userId: string; viewport?: { width: number; height: number }; path?: string }) {
    const ctx = await browser.newContext({ viewport: o.viewport ?? { width: 1440, height: 900 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(o.userId, 'user@sagabot.test'))]);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    await ctx.route('http://sb.test/**', async (route: any) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      fake.opts.userId = o.userId;
      const r = fake.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
      return route.fulfill({ status: r.status, body: r.body ?? '', headers: { ...(r.headers ?? {}), ...cors } });
    });
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'SaGabot', state: 'active' }, businesses: [{ id: BIZ, name: 'SaGabot', state: 'active' }], superAdmin: false, access: o.access } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
    await ctx.route(`${BASE}/api/notify/sale`, (r: any) => { notified.push(JSON.parse(r.request().postData() ?? '{}').saleId); return r.fulfill({ json: { sent: 1 } }); });
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(`${o.access}: ${e.message}`));
    page.on('dialog', (d: any) => d.type() === 'prompt' ? d.accept((page as any).__promptAnswers?.shift() ?? '') : d.accept());
    await page.goto(`${BASE}${o.path ?? '/register'}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page };
  }
  let current: any = null;
  const step = async (name: string, fn: () => Promise<void>) => {
    // a step that failed may leave a dialog open — the next one starts from a clean screen
    if (current) for (let i = 0; i < 3 && await current.getByRole('dialog').count(); i++) await current.keyboard.press('Escape');
    try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false, error: e.message }); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 6).join('\n  ')}`); }
  };
  const tile = (page: any, name: string) => page.locator('section button', { hasText: name }).first();
  const pay = (page: any) => page.getByRole('button', { name: /^לתשלום — / });
  const dialog = (page: any) => page.getByRole('dialog');
  const newSale = async (page: any) => { await dialog(page).getByRole('button', { name: 'עסקה חדשה' }).click(); await dialog(page).waitFor({ state: 'detached' }); };

  const { page } = await open({ access: 'full', userId: OWNER });
  current = page;
  try {
    await page.getByRole('heading', { name: 'קופה' }).waitFor({ timeout: 120_000 });
    await tile(page, 'קרם לחות').waitFor({ timeout: 60_000 });
    await page.getByLabel('מוכר/מטפל').selectOption({ label: 'שגית' });

    await step('a sale in cash: change, low-stock warning, document, notification', async () => {
      await tile(page, 'קרם לחות').click();
      await pay(page).click();
      await dialog(page).getByRole('button', { name: 'מזומן' }).click();
      await dialog(page).getByRole('button', { name: '₪200' }).click();
      await dialog(page).getByRole('button', { name: 'אישור' }).click();
      await dialog(page).getByText('העסקה נשמרה').waitFor();
      await dialog(page).getByText('עודף: ₪80').waitFor();
      await dialog(page).getByText(/מלאי נמוך: קרם לחות \(נשארו 2\)/).waitFor();
      await dialog(page).getByText(/הופקה חשבונית מס \/ קבלה מס׳ 1/).waitFor();
      await page.screenshot({ path: path.join(SHOTS, '1-sale-done.png') });
      const s = fake.tables.sales[0];
      assert.equal(s.total, 120); assert.equal(s.items[0].itemId, CREAM); assert.equal(s.items[0].kind, 'product'); assert.equal(s.employee_name, 'שגית');
      assert.equal(fake.tables.catalog_items.find((i) => i.id === CREAM)!.stock_qty, 2, 'stock 3 → 2');
      assert.equal(fake.tables.documents.length, 1);
      assert.deepEqual(notified, [s.id], 'the managers were notified');
      await newSale(page);
    });

    await step('hold a sale, sell another, resume the held one — and it survives a reload', async () => {
      await tile(page, 'לייזר רגליים').click();
      await page.getByRole('button', { name: 'השהיית העסקה' }).click();
      await page.getByText('⏸ עסקה מושהית אחת').waitFor();
      assert.equal(await page.getByText('הקישו על שירות או מוצר').count(), 1, 'the cart is empty again');
      await tile(page, 'קרם לחות').click();
      await pay(page).click();
      await dialog(page).getByRole('button', { name: 'אשראי' }).click();
      await dialog(page).getByText('העסקה נשמרה').waitFor();
      await newSale(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('⏸ עסקה מושהית אחת').waitFor({ timeout: 60_000 });
      await page.getByText('⏸ עסקה מושהית אחת').click();
      await dialog(page).getByRole('button', { name: 'המשך' }).click();
      await pay(page).getByText('₪300').waitFor();
      await pay(page).click();
      await dialog(page).getByRole('button', { name: 'Bit / PayBox' }).click();
      await dialog(page).getByText('העסקה נשמרה').waitFor();
      await newSale(page);
      assert.equal(await page.getByText(/עסקה מושהית/).count(), 0, 'nothing is held any more');
      assert.equal(fake.tables.sales.length, 3);
      assert.equal(fake.tables.catalog_items.find((i) => i.id === CREAM)!.stock_qty, 1);
    });

    await step('refund of the cash sale: money back, credit invoice, stock back, net income', async () => {
      await page.getByRole('button', { name: 'מכירות ודוחות' }).click();
      await page.getByRole('button', { name: /פרטי עסקה: ללא שם ₪120/ }).first().waitFor();
      const cashSale = fake.tables.sales[0];
      await page.locator(`button[aria-label="פרטי עסקה: ללא שם ₪120"]`).last().click();
      await dialog(page).getByRole('button', { name: 'החזר כספי' }).click();
      await dialog(page).getByText('החזר: ₪120').waitFor();
      await page.screenshot({ path: path.join(SHOTS, '2-refund.png') });
      await dialog(page).getByRole('button', { name: 'אישור ההחזר' }).click();
      await dialog(page).getByText(/ההחזר נרשם: ₪120 במזומן · הופקה חשבונית מס זיכוי מס׳ 1/).waitFor();
      await dialog(page).getByText('הוחזר במלואו').waitFor();
      const r = fake.tables.sale_refunds[0];
      assert.deepEqual([r.sale_id, r.amount, r.method, r.restock], [cashSale.id, 120, 'cash', true]);
      const credit = fake.tables.documents.find((d) => d.doc_type === 330)!;
      assert.equal(credit.refund_id, r.id); assert.equal(credit.base_doc_number, 1); assert.equal(credit.total, 120);
      assert.equal(fake.tables.catalog_items.find((i) => i.id === CREAM)!.stock_qty, 2, 'the cream is back on the shelf');
      await page.keyboard.press('Escape');
      await page.getByText('מכירות ₪540 · החזרים −₪120').waitFor();
      await page.getByText('הוחזר במלואו').first().waitFor();
    });

    await step('close of day: opening cash + cash sales − cash refunds, balanced, report printed', async () => {
      await page.getByRole('button', { name: 'סגירת יום' }).click();
      await page.getByLabel('מזומן בפתיחה ₪').fill('500');
      await page.getByRole('button', { name: 'פתיחת יום' }).click();
      await page.getByText('מתוכו החזרים במזומן').waitFor();
      await page.getByText('צריך להיות במגירה').waitFor();
      await page.getByLabel(/כמה מזומן יש במגירה בפועל/).fill('500');
      await page.getByText('✓ הקופה מאוזנת').waitFor();
      await page.screenshot({ path: path.join(SHOTS, '3-close-of-day.png') });
      const [report] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'סגירת יום והדפסה' }).click()]);
      await report.waitForFunction(() => document.body?.innerHTML.includes('סגירת יום'), null, { timeout: 30_000 });
      const html = await report.content();
      assert.match(html, /דוח סגירת יום/); assert.match(html, /החזרים/);
      await report.close();
      const sh = fake.tables.register_shifts[0];
      assert.deepEqual([sh.opening_cash, sh.expected_cash, sh.counted_cash, sh.difference], [500, 500, 500, 0], '500 + 120 cash − 120 refunded');
      await page.getByText('סגירות קודמות').waitFor();
    });

    await step('commissions: percents saved per employee, the month\'s report', async () => {
      await page.getByRole('button', { name: 'עמלות' }).click();
      await page.getByLabel('אחוז עמלה על טיפולים: שגית').fill('30');
      await page.getByLabel('אחוז עמלה על מוצרים: שגית').fill('10');
      await page.getByLabel('אחוז עמלה על טיפולים: שגית').focus();
      await page.getByText(/נשמר: שגית · מוצרים 10%/).waitFor();
      const emp = fake.tables.employees[0];
      assert.deepEqual([emp.commission_service_pct, emp.commission_product_pct], [30, 10]);
      // 300 laser → 254.24 before VAT × 30% = 76.27; creams 2 × 101.69 − 101.69 refunded = 101.69 × 10% = 10.17
      await page.getByRole('cell', { name: '₪86.44' }).first().waitFor();
      await page.screenshot({ path: path.join(SHOTS, '4-commissions.png') });
    });

    await step('stock: a delivery through adjust_stock, the movement history', async () => {
      await page.getByRole('button', { name: /מחירון ומלאי/ }).click();
      (page as any).__promptAnswers = ['10', 'ספק אקמה'];
      await page.getByRole('button', { name: '+ קבלת סחורה' }).click();
      await page.getByText('📦 במלאי 12').waitFor();
      await page.getByRole('button', { name: 'היסטוריה' }).click();
      await dialog(page).getByText('קבלת סחורה · ספק אקמה').waitFor();
      await dialog(page).getByText('החזר למלאי').waitFor();
      await page.screenshot({ path: path.join(SHOTS, '5-stock.png') });
      await page.keyboard.press('Escape');
      assert.equal(fake.tables.catalog_items.find((i) => i.id === CREAM)!.stock_qty, 12);
    });

    await step('an invoice to a business: number checked, details on the document and the contact', async () => {
      await page.getByRole('button', { name: 'מכירה' }).click();
      await tile(page, 'לייזר רגליים').click();
      await page.getByRole('button', { name: 'בחר לקוח' }).click();
      await dialog(page).getByLabel('חיפוש לקוח').fill('דנה');
      await dialog(page).getByRole('button', { name: /דנה כהן/ }).click();
      await page.getByRole('button', { name: '🧾 חשבונית לעסק' }).click();
      await page.getByLabel('שם העסק לחשבונית').fill('סלון דנה בע״מ');
      await page.getByLabel('מספר עוסק או ח.פ').fill('520013955');
      await page.getByText(/ספרת הביקורת לא מתאימה/).waitFor();
      assert.equal(await pay(page).isDisabled(), true, 'no payment with a wrong number');
      await page.getByLabel('מספר עוסק או ח.פ').fill('520013954');
      await page.getByLabel('כתובת: רחוב ומספר').fill('הרצל 5');
      await page.getByLabel('כתובת: עיר').fill('חולון');
      await pay(page).click();
      await dialog(page).getByRole('button', { name: 'העברה' }).click();
      await dialog(page).getByText('העסקה נשמרה').waitFor();
      await newSale(page);
      const doc = fake.tables.documents.filter((d) => d.doc_type === 320).at(-1)!;
      assert.deepEqual([doc.customer_name, doc.customer_dealer, doc.customer_street, doc.customer_city], ['סלון דנה בע״מ', '520013954', 'הרצל 5', 'חולון']);
      const dana = fake.tables.leads.find((l) => l.id === DANA)!;
      assert.deepEqual([dana.billing_dealer, dana.billing_city], ['520013954', 'חולון'], 'next time it is filled in by itself');
    });

    await step('full screen at 1920: no menus, the register uses the whole width', async () => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.getByRole('button', { name: 'מסך מלא' }).click();
      await page.getByRole('button', { name: 'יציאה ממסך מלא' }).waitFor();
      assert.equal(await page.getByRole('complementary', { name: 'ניווט ראשי' }).count(), 0, 'the side menu is gone');
      const w = (await page.locator('main').boundingBox())!.width;
      assert.ok(w > 1880, `the register is ${w}px wide`);
      await page.screenshot({ path: path.join(SHOTS, '6-fullscreen-1920.png') });
      await page.getByRole('button', { name: 'יציאה ממסך מלא' }).click();
      await page.getByRole('complementary', { name: 'ניווט ראשי' }).waitFor();
      const w2 = (await page.locator('main').boundingBox())!.width;
      assert.ok(w2 > 1500, `without full screen the register still uses the wide screen (${w2}px)`);
    });
  } finally { await page.context().close(); current = null; }

  await step('a cashier: the register only — no reports, no totals, no other screens', async () => {
    const { ctx, page: p } = await open({ access: 'register', userId: CASHIER, viewport: { width: 1280, height: 800 }, path: '/dashboard' });
    try {
      await p.waitForURL(/\/register$/, { timeout: 120_000 });
      await tile(p, 'קרם לחות').waitFor({ timeout: 60_000 });
      for (const t of ['מכירות ודוחות', 'סגירת יום', 'עמלות', 'מחירון ומלאי', 'הגדרות', 'מסמכים']) assert.equal(await p.getByRole('button', { name: t, exact: true }).count(), 0, `no "${t}"`);
      assert.equal(await p.getByText(/היום: ₪/).count(), 0, 'no income on screen');
      const nav = p.getByRole('complementary', { name: 'ניווט ראשי' });
      assert.deepEqual(await nav.getByRole('link').allInnerTexts(), ['קופה']);
      await tile(p, 'קרם לחות').click();
      await pay(p).click();
      await dialog(p).getByRole('button', { name: 'אשראי' }).click();
      await dialog(p).getByText('העסקה נשמרה').waitFor();
      assert.equal(await dialog(p).getByRole('button', { name: 'צפייה במסמך' }).count(), 0, 'documents stay with the owner');
      await p.screenshot({ path: path.join(SHOTS, '7-cashier.png') });
      assert.equal(fake.tables.sales.at(-1)!.user_id, CASHIER);
    } finally { await ctx.close(); }
  });

  await step('no errors in the browser', async () => { assert.deepEqual(errors, []); });

  await browser.close();
  try { process.kill(-dev.pid!, 'SIGTERM'); } catch { dev.kill('SIGTERM'); }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n# e2e: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
