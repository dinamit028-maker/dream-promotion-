/**
 * Payment links and deposits (docs/FINANCE_ADDITIONS_HE.md, T2; 2.88) in a real browser (Chromium via Playwright), on a phone
 * (390×844, and 375), against the in-memory Supabase of fake-supabase.ts. The servers' answers (/api/finance/paylinks,
 * /api/store/payments, /api/pay/<ref>) are stand-ins here — the servers themselves are tested in tests/paylinks.test.ts, the
 * storefront's side in storefront/tests (the provider's page, the notice twice, the cron), the SQL on Postgres
 * (tests/sql/payment-links.check.sql, concurrency.sh §14).
 * Clicked through: the terminal checked ("בדיקת חיבור" → "מאומת") and the receipt setting; "שלח לינק לתשלום" from an open
 * invoice (a part of the balance, never more; what open links hold is not offered again); the gate "חבר ספק תשלום"; the
 * statuses — נשלח / נכשל (red, never paid) / שולם (בדיקה) / בוטל — and "הפקת הקבלה" of a real payment that waits; an accepted
 * quote; the customer's page (pay → back → "התשלום התקבל", a failure → "לנסות שוב"); a service's deposit, its link from the
 * appointment, and "💳 חיוב" less the deposit really paid.
 *
 * Run: npx tsx tests/e2e/paylinks.e2e.ts   (starts `next dev` on port 3222; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (p* — payment links; not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_PAYLINKS_PORT ?? 3222);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000000c7';
const OWNER = 'a0000000-0000-4000-8000-0000000000c7';
const NOA = 'd0000000-0000-4000-8000-0000000000c7';
const INV = 'f0000000-0000-4000-8000-0000000000c7';
const QUOTE = 'f0000000-0000-4000-8000-0000000000c8';
const QUOTE2 = 'f0000000-0000-4000-8000-0000000000c9';
const SVC = 'e0000000-0000-4000-8000-0000000000c7';
const APPT = 'e0000000-0000-4000-8000-0000000000c8';
const PHONE = { width: 390, height: 844 };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const tomorrow = new Date(Date.now() + 864e5);
const at10 = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 7, 0)).toISOString();   // 10:00 in Israel (summer: UTC+3)

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  return {
    brands: [{ ...base, name: 'קליניקה לייט', onboarded: true, industry: 'קוסמטיקה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'company', vat_rate: 18, pay_link: '', dealer_number: '515123456', legal_name: 'קליניקה לייט בע״מ', street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [{ business_id: BIZ, user_id: OWNER, trading_name: '', phone: '03-1234567', email: '', payment_terms: 'immediate', quote_valid_days: 30, vat_period: 'bimonthly', paylink_receipt: 'auto' }],
    employees: [], catalog_items: [],
    leads: [{ ...base, id: NOA, name: 'נועה לוי', phone: '0521112233', email: 'noa@example.com', source: 'ידני', status: 'נסגר', date: '2026-01-01', tags: [], value: 0, notes: '' }],
    documents: [{ ...base, id: INV, doc_type: 305, doc_number: 7, link_no: 1, issued_at: `${today}T08:00:00Z`, doc_date: today, customer_name: 'נועה לוי', customer_phone: '0521112233',
      customer_email: 'noa@example.com', customer_dealer: '', lead_id: NOA, lines: [{ name: 'סדרת לייזר', qty: 1, unitPriceExVat: 1000, discountExVat: 0, totalExVat: 1000, vatRate: 18, kind: 1 }],
      payments: [], before_discount: 1000, discount: 0, after_discount: 1000, vat_amount: 180, total: 1180, vat_rate: 18, print_count: 0, share_token: 'a'.repeat(64), issuer: null, source: 'direct' }],
    quotes: [
      { ...base, id: QUOTE, quote_number: 3, status: 'accepted', customer_name: 'נועה לוי', customer_phone: '0521112233', customer_email: 'noa@example.com', lead_id: NOA,
        body: { lines: [{ name: 'טיפול פנים', qty: 1, unitPrice: 590 }], pricesIncludeVat: true, discount: { kind: 'sum', value: 0 }, customer: { name: 'נועה לוי' } },
        before_discount: 500, discount: 0, after_discount: 500, vat_rate: 18, vat_amount: 90, total: 590, valid_until: null, notes: '', share_token: 'b'.repeat(64), decided_at: `${today}T09:00:00Z`, decision_by: 'נועה' },
      { ...base, id: QUOTE2, quote_number: 4, status: 'sent', customer_name: 'נועה לוי', customer_phone: '0521112233', customer_email: '', lead_id: NOA,
        body: { lines: [{ name: 'ייעוץ', qty: 1, unitPrice: 118 }], pricesIncludeVat: true, discount: { kind: 'sum', value: 0 }, customer: { name: 'נועה לוי' } },
        before_discount: 100, discount: 0, after_discount: 100, vat_rate: 18, vat_amount: 18, total: 118, valid_until: null, notes: '', share_token: 'c'.repeat(64) },
    ],
    booking_settings: [{ ...base, slug: 'clinic-light', enabled: true, title: 'קליניקה לייט', address: '', phone: '', message: '', slot_minutes: 30, min_notice_minutes: 0, max_days_ahead: 30,
      hours: { 0: [['09:00', '19:00']], 1: [['09:00', '19:00']], 2: [['09:00', '19:00']], 3: [['09:00', '19:00']], 4: [['09:00', '19:00']], 5: [['09:00', '19:00']], 6: [['09:00', '19:00']] }, closed_dates: [] }],
    booking_services: [{ ...base, id: SVC, name: 'לייזר רגליים', minutes: 45, price: 400, deposit: 100, active: true, sort: 0 }],
    appointments: [{ ...base, id: APPT, service_id: SVC, service_name: 'לייזר רגליים', lead_id: NOA, name: 'נועה לוי', phone: '0521112233', email: 'noa@example.com', note: '',
      start_at: at10, end_at: new Date(Date.parse(at10) + 45 * 60_000).toISOString(), status: 'booked', source: 'manual' }],
    payment_requests: [],
    sales: [], sale_refunds: [], stock_movements: [], register_shifts: [], content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [], push_subscriptions: [],
    payments: [], expenses: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [],
    client_packages: [], client_package_uses: [], client_sessions: [], client_treatments: [], treatment_types: [],
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
  for (const p of ['/finance/documents', '/finance/settings', '/finance/quotes', '/appointments', '/pay/x.y']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@clinic.test' });
  const errors: string[] = [];

  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', isMobile: true, hasTouch: true });
  await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@clinic.test'))]);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
  const calls: string[] = [];
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
  await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'קליניקה לייט', state: 'active' }, businesses: [{ id: BIZ, name: 'קליניקה לייט', state: 'active' }], superAdmin: false, access: 'full' } }));
  await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
  await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
  await ctx.route(`${BASE}/api/finance/tax/status`, (r: any) => r.fulfill({ json: { mode: 'unconfigured', configured: false, connection: null, message: 'החיבור לרשות המסים לא הוגדר.' } }));
  await ctx.route(`${BASE}/api/client-file/**`, (r: any) => r.fulfill({ status: 403, json: { code: 'no_access', message: 'אין גישה' } }));
  // the terminal (the dashboard's /api/store/payments): connected, not checked yet — "בדיקת חיבור" checks it
  let terminal: any = { connected: true, provider: 'payplus', mode: 'test', hint: 'ab12', connectedAt: '2026-10-01T10:00:00Z', ready: true, liveOpen: false, verifiedAt: null, linksLive: false };
  const checks: string[] = [];
  await ctx.route(`${BASE}/api/store/payments`, async (r: any) => {
    if (r.request().method() === 'GET') return r.fulfill({ json: terminal });
    const b = JSON.parse(r.request().postData() ?? '{}');
    checks.push(b.action);
    if (b.action === 'check') { terminal = { ...terminal, verifiedAt: new Date().toISOString() }; return r.fulfill({ json: terminal }); }
    return r.fulfill({ status: 400, json: { message: 'פעולה לא מוכרת.' } });
  });
  // "שלח לינק לתשלום" (the dashboard's /api/finance/paylinks): what the server would keep and answer
  const asked: any[] = [];
  const url = (row: any) => `${BASE}/pay/${row.id}.sig`;
  await ctx.route(`${BASE}/api/finance/paylinks`, async (r: any) => {
    const b = JSON.parse(r.request().postData() ?? '{}');
    asked.push(b);
    const rows = fake.tables.payment_requests;
    if (b.action === 'send') {
      const doc = fake.tables.documents.find((d: any) => d.id === b.target);
      const ap = fake.tables.appointments.find((a: any) => a.id === b.target);
      const held = rows.filter((x: any) => x.document_id === b.target && ['sent', 'failed'].includes(x.status)).reduce((a: number, x: any) => a + x.amount, 0);
      if (doc && b.amount > 1180 - held) return r.fulfill({ status: 400, json: { code: 'refused', message: `אפשר לבקש עד ₪${1180 - held}.` } });
      const row = { id: randomUUID(), business_id: BIZ, user_id: OWNER, kind: b.kind, document_id: doc ? b.target : null, quote_id: b.kind === 'quote' ? b.target : null,
        appointment_id: ap ? b.target : null, package_id: b.packageId ?? null, lead_id: NOA,
        label: doc ? 'חשבונית מס מס׳ 7' : ap ? 'מקדמה לתור: לייזר רגליים' : 'הצעת מחיר מס׳ 3', customer_name: 'נועה לוי', customer_phone: '0521112233', customer_email: 'noa@example.com',
        amount: ap ? 100 : b.amount, is_test: true, provider: 'payplus', status: 'sent', expires_at: new Date(Date.now() + b.days * 864e5).toISOString(), sent_via: b.via, sends: 1,
        paid_at: null, paid_amount: null, paid_late: false, failed_at: null, fail_reason: '', cancelled_at: null, receipt_status: 'none', receipt_document_id: null, receipt_error: '',
        created_at: new Date().toISOString() };
      rows.push(row);
      return r.fulfill({ json: { link: row, url: url(row), text: `שלום נועה, לתשלום ${row.label}: ${url(row)}`, emailed: b.via === 'email' } });
    }
    const row = rows.find((x: any) => x.id === b.id);
    if (!row) return r.fulfill({ status: 404, json: { message: 'הלינק לא נמצא.' } });
    if (b.action === 'resend') { row.sends += 1; return r.fulfill({ json: { url: url(row), text: `שלום נועה: ${url(row)}`, emailed: false } }); }
    if (b.action === 'cancel') { row.status = 'cancelled'; row.cancelled_at = new Date().toISOString(); return r.fulfill({ json: { result: 'ok' } }); }
    if (b.action === 'receipt') { row.receipt_status = 'issued'; return r.fulfill({ json: { receipt: 'issued' } }); }
    return r.fulfill({ status: 400, json: { message: 'פעולה לא מוכרת.' } });
  });
  // the customer's page (the dashboard's /api/pay/<ref>): the provider's page is "paid" at once, then the check reads it
  let pub: any = { status: 'sent', label: 'חשבונית מס מס׳ 7', amount: 300, currency: 'ILS', business: 'קליניקה לייט', phone: '03-1234567', customer: 'נועה',
    expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(), test: true, paidAt: null, late: false };
  let payOutcome: 'paid' | 'failed' = 'paid';
  await ctx.route(`${BASE}/api/pay/**`, async (r: any) => {
    const ref = new URL(r.request().url()).pathname.split('/').pop();
    if (r.request().method() === 'GET') return r.fulfill({ json: { link: pub } });
    const b = JSON.parse(r.request().postData() ?? '{}');
    if (b.action === 'start') {
      pub = { ...pub, status: payOutcome === 'paid' ? 'paid' : 'failed', paidAt: payOutcome === 'paid' ? new Date().toISOString() : null };
      return r.fulfill({ json: { url: `${BASE}/pay/${ref}?r=${payOutcome === 'paid' ? 'back' : 'failed'}` } });
    }
    return r.fulfill({ json: { link: pub } });
  });
  ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
  const page = await ctx.newPage();
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('dialog', (d: any) => d.accept());

  const goto = async (to: string) => {
    try { return await page.goto(`${BASE}${to}`, { waitUntil: 'domcontentloaded' }); }
    catch (e: any) { if (!/ERR_ABORTED/.test(String(e?.message))) throw e; return page.goto(`${BASE}${to}`, { waitUntil: 'domcontentloaded' }); }
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    for (let i = 0; i < 4 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('the step did not end in 150s')), 150_000); });
    try { await Promise.race([fn(), late]); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false, error: e.message }); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}\n  last requests:\n    ${calls.join('\n    ')}`);
      await page.screenshot({ path: path.join(SHOTS, `p-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
    finally { clearTimeout(timer); }
  };
  const dialog = () => page.getByRole('dialog').last();
  const settle = async () => {
    await page.evaluate(() => Promise.race([
      Promise.all(document.getAnimations().filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime))).map((a) => a.finished.catch(() => null))),
      new Promise((ok) => setTimeout(ok, 8000)),
    ]));
  };
  const shot = async (name: string) => { await settle(); await page.screenshot({ path: path.join(SHOTS, name) }); };
  /** nothing sideways, every control on the screen, no text under 10px */
  const fits = async (what: string) => {
    await settle();
    const bad: string[] = await page.evaluate(`(() => {
      const w = window.innerWidth;
      const out = [];
      if (document.documentElement.scrollWidth > w + 1) out.push('the page scrolls sideways: ' + document.documentElement.scrollWidth);
      const shown = function (e) { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const inScroller = function (e) { for (let p = e.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
      const label = function (e) { return (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30); };
      Array.from(document.querySelectorAll('button, a, input, select, textarea')).filter(function (e) { return shown(e) && !inScroller(e); })
        .filter(function (e) { const b = e.getBoundingClientRect(); return b.left < -1 || b.right > w + 1; }).forEach(function (e) { out.push('off screen: "' + label(e) + '"'); });
      Array.from(document.querySelectorAll('body *')).filter(function (e) { return shown(e) && Array.from(e.childNodes).some(function (n) { return n.nodeType === 3 && (n.textContent || '').trim(); }); })
        .filter(function (e) { return parseFloat(getComputedStyle(e).fontSize) < 10; }).forEach(function (e) { out.push('tiny text: "' + label(e) + '"'); });
      return out.slice(0, 8);
    })()`);
    assert.deepEqual(bad, [], `${what}: ${bad.join(' · ')}`);
  };
  const openInvoice = async () => {
    await goto('/finance/documents');
    await page.getByText('חשבונית מס 7 · נועה לוי').click();
    await dialog().getByRole('heading', { name: 'חשבונית מס 7' }).waitFor();
  };
  const links = () => fake.tables.payment_requests;

  try {
    await goto('/finance/settings');
    await page.getByText('לינק לתשלום', { exact: true }).waitFor({ timeout: 120_000 });

    await step('the money settings: the terminal (the site\'s own) checked — "מאומת"; the receipt of a link: at once or after my approval', async () => {
      const box = page.locator('#paylinks');
      await box.getByText('לא נבדק').waitFor();
      await box.getByRole('button', { name: 'בדיקת חיבור' }).click();
      await box.getByText('מאומת', { exact: true }).waitFor();
      await box.getByText(/PayPlus קיבל את המפתחות/).waitFor();
      assert.deepEqual(checks, ['check']);
      await box.getByRole('radio', { name: 'אחרי אישור שלי' }).click();
      await box.getByText('נשמר.').waitFor();
      assert.equal(fake.tables.business_finance_profile[0].paylink_receipt, 'approve');
      await box.getByRole('radio', { name: 'מופקת מיד' }).click();
      await box.getByText('נשמר.').waitFor();
      assert.equal(fake.tables.business_finance_profile[0].paylink_receipt, 'auto');
      await box.scrollIntoViewIfNeeded();
      await fits('the payment-link settings');
      await shot('p1-settings.png');
    });

    await step('"שלח לינק לתשלום" from an open invoice: a part of the balance, never more; the link is copied and listed as "נשלח"', async () => {
      await openInvoice();
      await dialog().getByRole('button', { name: '💳 שלח לינק לתשלום' }).click();
      const d = dialog();
      await d.getByRole('heading', { name: '💳 לינק לתשלום' }).waitFor();
      await d.getByText(/מסוף בדיקה/).waitFor();
      const amount = d.getByLabel('סכום (עד ₪1,180)');
      assert.equal(await amount.inputValue(), '1180', 'the balance, by default');
      await amount.fill('1181');
      await d.getByText('אפשר לבקש עד ₪1,180.').waitFor();
      assert.equal(await d.getByRole('button', { name: 'שליחת הלינק' }).isDisabled(), true);
      await amount.fill('300');
      await d.getByRole('radio', { name: '3 ימים' }).click();
      await d.getByRole('radio', { name: '🔗 העתקת לינק' }).click();
      await fits('the send dialog');
      await shot('p2-send.png');
      await d.getByRole('button', { name: 'שליחת הלינק' }).click();
      await d.getByLabel('הלינק ללקוח/ה').waitFor();
      assert.match(await d.getByLabel('הלינק ללקוח/ה').inputValue(), /\/pay\/[0-9a-f-]{36}\.sig$/);
      assert.deepEqual([asked[0].action, asked[0].kind, asked[0].target, asked[0].amount, asked[0].days, asked[0].via], ['send', 'document', INV, 300, 3, 'link']);
      await shot('p3-sent.png');
      await d.getByRole('button', { name: 'סיום' }).click();
      const doc = dialog();
      await doc.getByText('לינקים לתשלום').waitFor();
      await doc.locator('[data-paylink]').getByText('נשלח', { exact: true }).waitFor();
      // what the open link holds is not offered again
      await doc.getByRole('button', { name: '💳 שלח לינק לתשלום' }).click();
      assert.equal(await dialog().getByLabel('סכום (עד ₪880)').inputValue(), '880');
      await page.keyboard.press('Escape');
      await doc.getByRole('heading', { name: 'חשבונית מס 7' }).waitFor();
    });

    await step('the gate: a terminal not checked, or none — "חבר ספק תשלום", and no link', async () => {
      terminal = { ...terminal, verifiedAt: null };
      await openInvoice();
      await dialog().getByRole('button', { name: '💳 שלח לינק לתשלום' }).click();
      await dialog().getByText(/עוד לא נבדק/).waitFor();
      assert.equal(await dialog().getByRole('link', { name: 'לבדיקת החיבור' }).getAttribute('href'), '/finance/settings#paylinks');
      assert.equal(await dialog().getByRole('button', { name: 'שליחת הלינק' }).count(), 0);
      await page.keyboard.press('Escape');
      terminal = { ...terminal, connected: false };
      await dialog().getByRole('button', { name: '💳 שלח לינק לתשלום' }).click();
      await dialog().getByRole('link', { name: 'חבר ספק תשלום' }).waitFor();
      await shot('p4-connect.png');
      terminal = { ...terminal, connected: true, verifiedAt: new Date().toISOString() };
    });

    await step('statuses: a failure is red and never paid; a test payment says so; a real one\'s receipt waits for "הפקת הקבלה"; a link is cancelled', async () => {
      const l = links()[0];
      Object.assign(l, { status: 'failed', failed_at: new Date().toISOString(), fail_reason: '003 declined' });
      await openInvoice();
      const row = dialog().locator(`[data-paylink="${l.id}"]`);
      await row.getByText('נכשל', { exact: true }).waitFor();
      await row.getByText(/התשלום נכשל — הלקוח\/ה יכולים לנסות שוב/).waitFor();
      assert.equal(await row.getByText(/שולם/).count(), 0, 'never shown as paid');
      await shot('p5-failed.png');
      Object.assign(l, { status: 'paid', paid_at: new Date().toISOString(), paid_amount: 300, provider_txn: 'txn-1' });
      links().push({ ...l, id: randomUUID(), amount: 200, paid_amount: 200, is_test: false, receipt_status: 'awaiting', created_at: new Date().toISOString() });
      links().push({ ...l, id: randomUUID(), amount: 100, status: 'sent', paid_at: null, paid_amount: null, created_at: new Date().toISOString() });
      await page.keyboard.press('Escape');
      await openInvoice();
      const d = dialog();
      await d.getByText('שולם (בדיקה)').waitFor();
      await d.getByText('תשלום בדיקה — לא כסף אמיתי, בלי קבלה').waitFor();
      await d.getByText('ממתין לאישור הפקת הקבלה').waitFor();
      await d.getByRole('button', { name: 'הפקת הקבלה' }).click();
      await d.getByText('הקבלה הופקה.').waitFor();
      assert.equal(asked.at(-1).action, 'receipt');
      await d.getByRole('button', { name: 'ביטול הלינק' }).click();
      await d.getByText('הלינק בוטל.').waitFor();
      await d.getByText('בוטל', { exact: true }).waitFor();
      await fits('the links of an invoice');
      await shot('p6-statuses.png');
    });

    await step('an accepted quote is paid by link; a quote not accepted yet is not', async () => {
      await goto('/finance/quotes');
      await page.getByText('הצעה 3 · נועה לוי').click();
      await dialog().getByRole('heading', { name: 'הצעת מחיר 3' }).waitFor();
      await dialog().getByRole('button', { name: '💳 שלח לינק לתשלום' }).click();
      assert.equal(await dialog().getByLabel('סכום (עד ₪590)').inputValue(), '590');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.getByText('הצעה 4 · נועה לוי').click();
      await dialog().getByRole('heading', { name: 'הצעת מחיר 4' }).waitFor();
      assert.equal(await dialog().getByRole('button', { name: '💳 שלח לינק לתשלום' }).count(), 0);
    });

    await step('the customer\'s page: who, what, how much — pay, back, "התשלום התקבל"; a failure: "התשלום לא הצליח" and "לנסות שוב"', async () => {
      await goto(`/pay/${links()[0].id}.sig`);
      await page.getByRole('heading', { name: 'קליניקה לייט' }).waitFor();
      await page.getByText('שלום נועה,', { exact: false }).waitFor();
      await page.getByText('₪300').waitFor();
      await page.getByText('תשלום בדיקה — לא יחויב כסף אמיתי').waitFor();
      await fits('the payment page');
      await shot('p7-pay.png');
      await page.getByRole('button', { name: 'לתשלום מאובטח' }).click();
      await page.getByText('התשלום התקבל. תודה!').waitFor();
      assert.ok(!page.url().includes('?r='), 'the address is clean again');
      await shot('p8-paid.png');
      pub = { ...pub, status: 'sent', paidAt: null }; payOutcome = 'failed';
      await goto(`/pay/${links()[0].id}.sig`);
      await page.getByRole('button', { name: 'לתשלום מאובטח' }).click();
      await page.getByText('התשלום לא הצליח').waitFor();
      await page.getByRole('button', { name: 'לנסות שוב' }).waitFor();
      assert.equal(await page.getByText('התשלום התקבל').count(), 0);
      await shot('p9-failed.png');
      pub = { ...pub, status: 'expired' };
      await goto(`/pay/${links()[0].id}.sig`);
      await page.getByText('הלינק כבר לא בתוקף. אפשר לבקש מהעסק לינק חדש.').waitFor();
      assert.equal(await page.getByRole('button', { name: 'לתשלום מאובטח' }).count(), 0);
    });

    await step('a deposit: set on the service, its link from the appointment; "💳 חיוב" is the price less the deposit really paid', async () => {
      await goto('/appointments');
      await page.getByText(/מקדמה ₪100:/).waitFor();
      await page.getByText('לא נשלח לינק').waitFor();
      await page.getByRole('button', { name: '💳 לינק למקדמה' }).click();
      const d = dialog();
      await d.getByText(/מקדמה:\s*₪100/).waitFor();
      assert.equal(await d.getByLabel(/סכום/).count(), 0, 'the service\'s deposit — not typed');
      await d.getByRole('radio', { name: '🔗 העתקת לינק' }).click();
      await d.getByRole('button', { name: 'שליחת הלינק' }).click();
      await d.getByLabel('הלינק ללקוח/ה').waitFor();
      assert.deepEqual([asked.at(-1).kind, asked.at(-1).target], ['deposit', APPT]);
      assert.ok(asked.at(-1).days <= 2, 'until the appointment');
      await d.getByRole('button', { name: 'סיום' }).click();
      await page.getByRole('button', { name: /נשלח/ }).first().waitFor();
      assert.equal(await page.getByRole('button', { name: '💳 לינק למקדמה' }).count(), 0, 'one deposit link per appointment');
      // paid for real: the register's charge is the rest
      Object.assign(links().at(-1)!, { status: 'paid', is_test: false, paid_at: new Date().toISOString(), paid_amount: 100, provider_txn: 'txn-d', receipt_status: 'issued' });
      await goto('/appointments');
      const charge = page.getByRole('link', { name: /💳 חיוב \(אחרי מקדמה ₪100\)/ });
      await charge.waitFor();
      const q = new URL(`${BASE}${await charge.getAttribute('href')}`).searchParams;
      assert.equal(q.get('price'), '300');
      assert.equal(q.get('item'), 'לייזר רגליים (יתרה אחרי מקדמה ₪100)');
      await fits('the agenda with a deposit');
      await shot('p10-deposit.png');
      // the service's deposit is set in "שירותים"
      await page.getByRole('button', { name: 'שירותים' }).click();
      await page.getByText('45 דק׳ · ₪400 · מקדמה ₪100').waitFor();
      await page.getByRole('button', { name: 'מקדמה', exact: true }).click();
      await page.getByLabel('מקדמה ₪ (ריק = בלי מקדמה)').fill('500');
      await page.getByRole('button', { name: 'שמירה', exact: true }).click();
      await page.getByText('המקדמה לא יכולה להיות גדולה ממחיר השירות.').waitFor();
      await page.getByLabel('מקדמה ₪ (ריק = בלי מקדמה)').fill('150');
      await page.getByRole('button', { name: 'שמירה', exact: true }).click();
      await page.getByText('45 דק׳ · ₪400 · מקדמה ₪150').waitFor();
      assert.equal(fake.tables.booking_services[0].deposit, 150);
    });

    await step('at 375: the invoice\'s links, the dialog and the customer\'s page fit', async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      try {
        await openInvoice();
        await dialog().getByText('לינקים לתשלום').waitFor();
        await fits('an invoice with links at 375');
        await dialog().getByRole('button', { name: '💳 שלח לינק לתשלום' }).click();
        await dialog().getByRole('heading', { name: '💳 לינק לתשלום' }).waitFor();
        await fits('the send dialog at 375');
        pub = { ...pub, status: 'sent' }; payOutcome = 'paid';
        await goto(`/pay/${links()[0].id}.sig`);
        await page.getByRole('button', { name: 'לתשלום מאובטח' }).waitFor();
        await fits('the payment page at 375');
      } finally { await page.setViewportSize(PHONE); }
    });

    await step('no errors in the browser', async () => { assert.deepEqual(errors, []); });
  } finally { await ctx.close(); }

  await browser.close();
  try { process.kill(-dev.pid!, 'SIGTERM'); } catch { dev.kill('SIGTERM'); }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n# e2e paylinks: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
