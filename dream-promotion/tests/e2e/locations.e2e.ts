/**
 * Locations and registers (docs/FINANCE_ADDITIONS_HE.md T12א; 2.91) in a real browser (Chromium via Playwright), against the
 * in-memory Supabase of fake-supabase.ts. The rules themselves are tested on Postgres (tests/sql/locations.check.sql — the DoD's
 * "a cashier of A does not see B" —, concurrency.sh §17, locations-compare.sh); a business with one location is compared picture
 * by picture in single-location.e2e.ts. Here the screens are clicked through:
 *   before migration 4600 the screen says so; one location: no switch, no register picker, no location field;
 *   the owner adds a location (its first register comes with it) and a register; a name used twice is refused;
 *   the switch at the top: one location's rows only, and back to "כל הסניפים"; on a phone it fits;
 *   the register picker: this device is "קופה 2", its sale and the sale's document go there (the document names its location);
 *   close of day per register: קופה 2 opens its own day while קופה 1's is open;
 *   the location field: an appointment and an expense of "כל הסניפים" go to the location chosen (the free hours are its own);
 *   a member limited to one location: no switch, only its register and rows, no owner's buttons;
 *   closing a register with an open day is refused; closing a location brings the business back to one.
 *
 * Run: npx -y tsx tests/e2e/locations.e2e.ts   (starts `next dev` on port 3226; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (loc* — not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_LOCATIONS_PORT ?? 3226);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000000f1';
const OWNER = 'a0000000-0000-4000-8000-0000000000f1';
const DANA = 'd0000000-0000-4000-8000-0000000000f1';
const CREAM = 'f0000000-0000-4000-8000-0000000000f1';
const SVC = 'e0000000-0000-4000-8000-0000000000f1';
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const day = (n: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const at = (d: string, hm: string) => new Date(`${d}T${hm}:00+03:00`).toISOString();
const TOMORROW = day(1);

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  return {
    brands: [{ ...base, name: 'קליניקה לייט', onboarded: true, industry: 'קוסמטיקה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'company', vat_rate: 18, pay_link: '', dealer_number: '515123456', legal_name: 'קליניקה לייט בע״מ',
      street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [], business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }],
    catalog_items: [{ ...base, id: CREAM, name: 'קרם לחות', price: 120, kind: 'product', active: true, sort: 0, favorite: true, fav_order: 0, image_url: '', track_stock: false, stock_qty: 0, low_stock: 2 }],
    employees: [],
    leads: [{ ...base, id: DANA, name: 'דנה כהן', phone: '0521234567', source: 'ידני', status: 'נסגר', date: '2026-09-01', tags: [], value: 0, notes: '' }],
    // the main location's sale and day from this morning — rows from before locations (no location, no register)
    sales: [{ ...base, id: '90000000-0000-4000-8000-0000000000f1', lead_id: DANA, appointment_id: null, customer_name: 'דנה כהן', customer_phone: '0521234567', channel: 'pos',
      items: [{ name: 'טיפול פנים', price: 300, qty: 1, kind: 'service' }], subtotal: 300, discount: 0, total: 300, vat_rate: 18, vat_amount: 45.76, method: 'cash',
      payments: [], status: 'paid', note: '', paid_at: at(today, '08:30'), created_at: at(today, '08:30'), employee_id: null, employee_name: '' }],
    register_shifts: [{ ...base, id: '90000000-0000-4000-8000-0000000000f2', opened_at: at(today, '08:00'), opening_cash: 200, closed_at: null, counted_cash: null,
      expected_cash: null, difference: null, note: '', employee_name: '' }],
    booking_services: [{ ...base, id: SVC, name: 'טיפול פנים', minutes: 60, price: 300, active: true, sort: 0 }],
    booking_settings: [{ ...base, slug: null, enabled: false, title: 'קליניקה לייט', address: '', phone: '', message: '', slot_minutes: 30, min_notice_minutes: 0, max_days_ahead: 30,
      hours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['09:00', '19:00']]])), closed_dates: [] }],
    appointments: [{ ...base, id: '90000000-0000-4000-8000-0000000000f3', service_id: SVC, lead_id: DANA, service_name: 'טיפול פנים', name: 'מיכל לוי', phone: '0509998877',
      email: '', note: '', start_at: at(TOMORROW, '10:00'), end_at: at(TOMORROW, '11:00'), status: 'booked', source: 'manual' }],
    documents: [], payments: [], expenses: [], sale_refunds: [], stock_movements: [], content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [],
    push_subscriptions: [], quotes: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [],
    payment_requests: [], payment_plans: [], payment_plan_items: [], client_packages: [], client_package_uses: [], client_sessions: [], client_treatments: [], treatment_types: [],
    business_locations: [], registers: [],
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
  for (const p of ['/register', '/settings/locations', '/appointments', '/finance/expenses', '/finance']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@clinic.test' });
  const errors: string[] = [];
  const said: string[] = [];          // window.alert / confirm texts
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
    await ctx.route(`${BASE}/api/store/payments`, (r: any) => r.fulfill({ json: { connected: false, provider: null, mode: null, hint: '', connectedAt: null, ready: false, liveOpen: false, verifiedAt: null, linksLive: false } }));
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
      await page.screenshot({ path: path.join(SHOTS, `loc-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
    finally { clearTimeout(timer); }
  };
  const dialog = (p: any = page) => p.getByRole('dialog').last();
  const shot = async (name: string, p: any = page) => { await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, name) }); };
  /** the switch at the top (a computer's header, or a phone's) */
  const theSwitch = (p: any = page) => p.locator('select[aria-label="הסניף שעובדים בו"]:visible');
  const picker = (p: any = page) => p.getByLabel('הקופה של המכשיר הזה');
  const registerReady = async (p: any = page) => {
    await p.getByRole('heading', { name: 'קופה' }).waitFor({ timeout: 120_000 });
    await p.locator('section button', { hasText: 'קרם לחות' }).first().waitFor({ timeout: 60_000 });
  };
  /** pick in the switch: the app reloads, and the database answers for that location */
  const pickLocation = async (label: string) => {
    await Promise.all([page.waitForEvent('framenavigated', { timeout: 60_000 }), theSwitch().selectOption({ label })]);
    await registerReady();
  };
  const tab = async (label: string, p: any = page) => { await p.getByRole('button', { name: new RegExp(`^${label}`) }).first().click(); await p.waitForTimeout(300); };
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
  const loc = (name: string) => fake.tables.business_locations.find((l) => l.name === name)!;
  const reg = (name: string, location: string) => fake.tables.registers.find((r) => r.name === name && r.location_id === location)!;

  try {
    await step('before migration 4600: the screen says so, and the register is as it was', async () => {
      fake.locationTables = false;
      await goto('/settings/locations');
      await page.getByText('סניפים וקופות עוד לא הופעלו במסד הנתונים (מיגרציה 20261010004600).').waitFor({ timeout: 120_000 });
      await goto('/register');
      await registerReady();
      assert.equal(await theSwitch().count(), 0, 'no switch');
      assert.equal(await picker().count(), 0, 'no register picker');
      fake.locationTables = true;
    });

    await step('one location (after 4600): no switch, no register picker, no location field — as before', async () => {
      await goto('/register');
      await registerReady();
      await page.waitForTimeout(800);
      assert.equal(await theSwitch().count(), 0, 'no switch');
      assert.equal(await picker().count(), 0, 'no register picker');
      await goto('/appointments');
      await page.getByText('מיכל לוי').first().waitFor({ timeout: 60_000 });
      await page.getByRole('button', { name: '+ תור' }).click();
      await dialog().getByRole('heading', { name: 'תור חדש' }).waitFor();
      assert.equal(await dialog().getByLabel('סניף', { exact: true }).count(), 0, 'no location field');
      await page.keyboard.press('Escape');
      await goto('/settings/locations');
      await page.getByText('לעסק יש סניף אחד וקופה אחת').waitFor({ timeout: 60_000 });
      await page.getByText('ראשי').first().waitFor();
      await page.getByText('קופה 1').first().waitFor();
      await shot('loc1-one.png');
    });

    await step('the owner adds a location (its first register comes with it) and a register; a name used twice is refused', async () => {
      await page.getByRole('button', { name: '+ סניף חדש' }).click();
      const d = dialog();
      await d.getByRole('heading', { name: 'סניף חדש' }).waitFor();
      await d.getByLabel('שם').fill('סניף הצפון');
      await d.getByRole('radio', { name: 'סניף' }).click();
      await d.getByLabel('כתובת').fill('הנשיא 5, חיפה');
      await d.getByLabel('טלפון').fill('04-8123456');
      await d.getByRole('button', { name: 'הוספת הסניף' }).click();
      await page.getByText('"סניף הצפון" נוסף. בראש המסך אפשר לבחור בו.').waitFor();
      const north = loc('סניף הצפון');
      assert.deepEqual([north.kind, north.address, north.phone, north.active], ['branch', 'הנשיא 5, חיפה', '04-8123456', true]);
      assert.ok(reg('קופה 1', north.id), 'a place that sells gets its first register');
      // the switch appears at the top at once
      await theSwitch().waitFor();
      const options = await theSwitch().locator('option').allTextContents();
      assert.deepEqual(options, ['כל הסניפים', 'ראשי', 'סניף הצפון']);
      // a register for the main location: "קופה 2" is offered
      await page.getByRole('button', { name: '+ קופה' }).first().click();
      await dialog().getByRole('heading', { name: 'קופה חדשה' }).waitFor();
      assert.equal(await dialog().getByLabel('שם הקופה').inputValue(), 'קופה 2');
      await dialog().getByLabel('המכשיר (לא חובה)').fill('טאבלט בדלפק');
      await dialog().getByRole('button', { name: 'הוספת הקופה' }).click();
      await page.getByText('"קופה 2" נוספה.').waitFor();
      assert.equal(reg('קופה 2', BIZ).device, 'טאבלט בדלפק');
      // the same name again
      await page.getByRole('button', { name: '+ סניף חדש' }).click();
      await dialog().getByLabel('שם').fill(' סניף הצפון ');
      await dialog().getByRole('button', { name: 'הוספת הסניף' }).click();
      await dialog().getByRole('alert').getByText('כבר יש סניף בשם הזה.').waitFor();
      await dialog().getByRole('button', { name: 'ביטול' }).click();
      assert.equal(fake.tables.business_locations.length, 2);
      await shot('loc2-two.png');
    });

    await step('the switch: one location\'s rows only, and back to "כל הסניפים"', async () => {
      await goto('/register');
      await registerReady();
      await pickLocation('סניף הצפון');
      assert.equal(fake.currentLocation, loc('סניף הצפון').id);
      await theSwitch().waitFor();
      assert.equal(await theSwitch().inputValue(), loc('סניף הצפון').id, 'the switch shows the location picked');
      await tab('מכירות ודוחות');
      await page.waitForTimeout(600);
      assert.equal(await page.getByText('דנה כהן · טיפול פנים').count(), 0, 'the main location\'s sale is not shown in סניף הצפון');
      await pickLocation('כל הסניפים');
      assert.equal(fake.currentLocation, null);
      await tab('מכירות ודוחות');
      await page.getByText('דנה כהן · טיפול פנים').first().waitFor();
      await page.getByText(/שולם · קופה 1 · ראשי/).first().waitFor();       // several registers: each sale says where
      await shot('loc3-sales-all.png');
    });

    await step('a phone: the switch fits at the top, and nothing goes sideways', async () => {
      const { ctx, page: p } = await context(PHONE);
      await goto('/register', p);
      await registerReady(p);
      await theSwitch(p).waitFor();
      await picker(p).waitFor();
      await fits(p, 'the register on a phone');
      await shot('loc4-phone-register.png', p);
      await goto('/finance', p);
      await p.getByRole('heading', { name: 'לובי כספים' }).waitFor({ timeout: 120_000 });
      await theSwitch(p).waitFor();
      await fits(p, 'the money on a phone');
      await shot('loc4-phone-finance.png', p);
      await goto('/settings/locations', p);
      await p.getByText('הנשיא 5, חיפה').first().waitFor({ timeout: 60_000 });
      await fits(p, 'locations and registers on a phone');
      await shot('loc4-phone-locations.png', p);
      await ctx.close();
    });

    await step('the register picker: this device is "קופה 2", its sale and the sale\'s document go there', async () => {
      await goto('/register');
      await registerReady();
      const labels = await picker().locator('option').allTextContents();
      assert.deepEqual(labels, ['קופה 1 · ראשי', 'קופה 2 · ראשי', 'קופה 1 · סניף הצפון']);
      await picker().selectOption({ label: 'קופה 2 · ראשי' });
      assert.equal(await page.evaluate((k: string) => localStorage.getItem(k), `dp-register:${BIZ}`), reg('קופה 2', BIZ).id, 'the device remembers its register');
      await page.locator('section button', { hasText: 'קרם לחות' }).first().click();
      await page.getByRole('button', { name: /^לתשלום — / }).click();
      await dialog().getByRole('button', { name: 'מזומן' }).click();
      await dialog().getByRole('button', { name: 'בדיוק' }).click();
      await dialog().getByRole('button', { name: 'אישור' }).click();
      await dialog().getByText('העסקה נשמרה').waitFor();
      await dialog().getByText(/הופקה חשבונית מס \/ קבלה מס׳ 1/).waitFor();
      const s = fake.tables.sales.find((x) => x.total === 120)!;
      assert.deepEqual([s.register_id, s.location_id], [reg('קופה 2', BIZ).id, BIZ]);
      const doc = fake.tables.documents.find((x) => x.sale_id === s.id)!;
      assert.equal(doc.location_id, BIZ, 'the document is the sale\'s location');
      assert.deepEqual(doc.issuer.location, { name: 'ראשי', address: '', phone: '' }, 'two active locations: the document names its location');
      assert.equal(doc.doc_number, 1, 'one series of numbers for the business');
      await dialog().getByRole('button', { name: 'עסקה חדשה' }).click();
      // the printed document says where
      await tab('מסמכים');
      await page.getByText(/חשבונית מס \/ קבלה 1/).first().click();
      await dialog().getByText('סניף: ראשי').first().waitFor();
      await shot('loc5-document.png');
      await page.keyboard.press('Escape');
    });

    await step('close of day per register: קופה 2 opens its own day while קופה 1\'s is open', async () => {
      await tab('סגירת יום');
      await page.getByText('☀️ פתיחת יום · קופה 2 · ראשי').waitFor();
      await page.getByLabel('מזומן בפתיחה ₪').fill('100');
      await page.getByRole('button', { name: 'פתיחת יום' }).click();
      await page.getByText(/🌙 סגירת יום · .* · קופה 2 · ראשי/).waitFor();
      const open = fake.tables.register_shifts.filter((x) => !x.closed_at);
      assert.equal(open.length, 2, 'two registers, two open days');
      assert.deepEqual(open.map((x) => x.register_id ?? BIZ).sort(), [BIZ, reg('קופה 2', BIZ).id].sort());
      // קופה 2's drawer: its opening cash and its own cash sale only (not קופה 1's sale of this morning)
      await page.getByText('צריך להיות במגירה').waitFor();
      await page.getByText('₪220').first().waitFor();
      await shot('loc6-shift-register2.png');
      await picker().selectOption({ label: 'קופה 1 · ראשי' });
      await page.getByText(/🌙 סגירת יום · .* · קופה 1 · ראשי/).waitFor();
      await page.getByText('₪500').first().waitFor();          // 200 at the opening + the 300 cash sale of this morning
    });

    await step('the location field: an appointment and an expense of "כל הסניפים" go to the location chosen', async () => {
      const north = loc('סניף הצפון').id;
      await goto('/appointments');
      await page.getByText('מיכל לוי').first().waitFor({ timeout: 60_000 });
      await page.getByRole('button', { name: '+ תור' }).click();
      const d = dialog();
      await d.getByRole('heading', { name: 'תור חדש' }).waitFor();
      await d.getByLabel('תאריך').fill(TOMORROW);
      // the main location: 10:00 is taken (מיכל לוי); סניף הצפון: free
      assert.equal(await d.getByRole('button', { name: '10:00', exact: true }).count(), 0, 'the main location\'s 10:00 is taken');
      await d.getByLabel('סניף', { exact: true }).selectOption({ label: 'סניף הצפון' });
      await d.getByRole('button', { name: '10:00', exact: true }).click();
      await d.locator('input[list="crm-names"]').fill('נועה ברק');   // the name (with the contacts' list)
      await d.getByLabel('טלפון').fill('0541112233');
      await d.getByRole('button', { name: 'קביעת התור' }).click();
      await d.waitFor({ state: 'detached' });
      const a = fake.tables.appointments.find((x) => x.name === 'נועה ברק')!;
      assert.equal(a.location_id, north);
      await page.getByText(/טיפול פנים · סניף הצפון/).first().waitFor();       // the agenda says where
      await page.getByText(/טיפול פנים · ראשי/).first().waitFor();
      await shot('loc7-agenda.png');

      await goto('/finance/expenses');
      await page.getByRole('button', { name: '+ הוצאה' }).click();
      const e = dialog();
      await e.getByRole('heading', { name: 'הוצאה חדשה' }).waitFor();
      await e.getByLabel('ספק', { exact: true }).fill('ספק הצפון');
      await e.getByLabel('סה״כ (כולל מע״מ)').fill('118');
      await e.getByLabel('סניף', { exact: true }).selectOption({ label: 'סניף הצפון' });
      await e.getByRole('button', { name: 'אישור ושמירה' }).click();
      await page.getByText('ההוצאה נשמרה').waitFor();
      assert.equal(fake.tables.expenses.find((x) => x.supplier_name === 'ספק הצפון')!.location_id, north);
      await page.getByText(/· סניף הצפון/).first().waitFor();
    });

    await step('a member limited to סניף הצפון: no switch, only its register and rows, no owner\'s buttons', async () => {
      fake.memberLocations = [loc('סניף הצפון').id];
      await goto('/register');
      await registerReady();
      await page.waitForTimeout(800);
      assert.equal(await theSwitch().count(), 0, 'one location to work in: no switch');
      assert.equal(await picker().count(), 0, 'its location has one register');
      await tab('מכירות ודוחות');
      await page.waitForTimeout(600);
      assert.equal(await page.getByText('דנה כהן · טיפול פנים').count(), 0, 'not the main location\'s sales');
      assert.equal(await page.getByText('ללא שם · קרם לחות').count(), 0, 'not קופה 2\'s sale');
      await goto('/settings/locations');
      await page.getByText('רק בעלי העסק מוסיפים ומשנים סניפים וקופות.').waitFor({ timeout: 60_000 });
      assert.equal(await page.getByRole('button', { name: '+ סניף חדש' }).count(), 0);
      assert.equal(await page.getByText('ראשי', { exact: true }).count(), 0, 'only its own location is listed');
      fake.memberLocations = null;
    });

    await step('closing a register with an open day is refused; closing a location brings the business back to one', async () => {
      await goto('/settings/locations');
      await page.getByText('הנשיא 5, חיפה').first().waitFor({ timeout: 60_000 });
      const main = page.locator('li', { hasText: 'קופה 2' }).first();
      said.length = 0;
      await main.getByRole('button', { name: 'סגירה' }).click();
      await page.waitForTimeout(600);
      assert.ok(said.some((m) => m === 'יש יום פתוח בקופה הזו — סוגרים אותו קודם.'), `refused: ${said.join(' | ')}`);
      assert.equal(reg('קופה 2', BIZ).active, true);
      const card = page.locator('div.p-4', { hasText: 'הנשיא 5, חיפה' }).first();
      await card.getByRole('button', { name: 'סגירת הסניף' }).click();
      await page.getByText('"סניף הצפון" נסגר.').waitFor();
      assert.equal(loc('סניף הצפון').active, false);
      await page.getByText('סגור').first().waitFor();
      await page.waitForTimeout(400);
      assert.equal(await theSwitch().count(), 0, 'one active location: no switch again');
      await shot('loc8-closed.png');
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
