/**
 * Payment plans, debt reminders and a duplicate expense (docs/FINANCE_ADDITIONS_HE.md, T3 + T5 + T6; 2.89) in a real browser
 * (Chromium via Playwright), on a phone (390×844, and 375), against the in-memory Supabase of fake-supabase.ts. The timer and the
 * reminder's email are tested in tests/plans-reminders.test.ts, the SQL on Postgres (tests/sql/plans-reminders.check.sql,
 * concurrency.sh §15) — here the reminders the timer queued are seeded.
 * Clicked through: "📅 פריסה לתשלומים" from an open invoice (equal parts to the agora, a changed amount moves the ones after it,
 * a sum that misses the balance is not saved); a receipt pays the payments in order; "חייבים" and the overview count a plan's
 * payments by their own dates; the WhatsApp queue ("שליחה" opens WhatsApp with the debt as it is now; a debt paid meanwhile is
 * not sent); the reminders' settings (only the owner turns them on; anyone who may write turns them off); "לא לשלוח" on the
 * customer's card; an expense whose file was recorded before, "זו הוצאה אחרת", and one that repeats a supplier's number.
 *
 * Run: npx tsx tests/e2e/plans-reminders.e2e.ts   (starts `next dev` on port 3223; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (r* — plans and reminders; not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';
import { addMonths } from '../../src/features/finance/plans';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_PLANS_PORT ?? 3223);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000000d7';
const OWNER = 'a0000000-0000-4000-8000-0000000000d7';
const NOA = 'd0000000-0000-4000-8000-0000000000d7';
const DANA = 'd0000000-0000-4000-8000-0000000000d8';
const INV1 = 'f0000000-0000-4000-8000-0000000000d1';
const INV2 = 'f0000000-0000-4000-8000-0000000000d2';
const INV3 = 'f0000000-0000-4000-8000-0000000000d3';
const INV4 = 'f0000000-0000-4000-8000-0000000000d4';
const INV5 = 'f0000000-0000-4000-8000-0000000000d5';
const PLAN2 = 'c0000000-0000-4000-8000-0000000000d2';
const Q1 = 'e0000000-0000-4000-8000-0000000000e1';
const Q2 = 'e0000000-0000-4000-8000-0000000000e2';
const E1 = 'e0000000-0000-4000-8000-0000000000f1';
const PHONE = { width: 390, height: 844 };
const FILE = Buffer.from('%PDF-1.4 a supplier invoice — the same bytes twice');
const SHA = createHash('sha256').update(FILE).digest('hex');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const day = (n: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ddmm = (d: string) => d.split('-').reverse().join('/');

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  const inv = (id: string, n: number, lead: string, name: string, phone: string, email: string, before: number, vat: number, total: number, date: string, due: string) => ({
    ...base, id, doc_type: 305, doc_number: n, link_no: 1, issued_at: `${date}T08:00:00Z`, doc_date: date, due_date: due, customer_name: name, customer_phone: phone,
    customer_email: email, customer_dealer: '', lead_id: lead, lines: [{ name: 'טיפול', qty: 1, unitPriceExVat: before, discountExVat: 0, totalExVat: before, vatRate: 18, kind: 1 }],
    payments: [], before_discount: before, discount: 0, after_discount: before, vat_amount: vat, total, vat_rate: 18, print_count: 0, share_token: `${n}`.padStart(64, 'a'),
    issuer: null, source: 'direct',
  });
  const reminder = (id: string, doc: string, lead: string, step: number, due: string, amount: number, to: string) => ({
    id, business_id: BIZ, document_id: doc, item_id: null, lead_id: lead, step, days: 7, due_date: due, amount, tone: 'firm', channel: 'whatsapp', to_address: to,
    status: 'queued', email_id: null, created_at: `${today}T07:00:00Z`, sent_at: null, sent_by: null, cancelled_at: null, cancel_reason: '', error: '',
  });
  return {
    brands: [{ ...base, name: 'קליניקה לייט', onboarded: true, industry: 'קוסמטיקה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'company', vat_rate: 18, pay_link: '', dealer_number: '515123456', legal_name: 'קליניקה לייט בע״מ', street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [{ business_id: BIZ, user_id: OWNER, trading_name: '', phone: '03-1234567', email: '', payment_terms: 'immediate', quote_valid_days: 30, vat_period: 'bimonthly', paylink_receipt: 'auto' }],
    business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }],
    employees: [], catalog_items: [],
    leads: [
      { ...base, id: NOA, name: 'נועה לוי', phone: '0521112233', email: 'noa@example.com', source: 'ידני', status: 'נסגר', date: '2026-01-01', tags: [], value: 0, notes: '' },
      { ...base, id: DANA, name: 'דנה כהן', phone: '0502222222', email: '', source: 'ידני', status: 'נסגר', date: '2026-01-01', tags: [], value: 0, notes: '' },
    ],
    documents: [
      inv(INV1, 7, NOA, 'נועה לוי', '0521112233', 'noa@example.com', 2500, 450, 2950, today, today),            // a plan is made on it here
      inv(INV2, 8, DANA, 'דנה כהן', '0502222222', '', 1000, 180, 1180, day(-40), day(-30)),                  // late by its own date, its plan ahead
      inv(INV3, 9, DANA, 'דנה כהן', '0502222222', '', 100, 18, 118, day(-12), day(-10)),                     // late: a reminder waits
      inv(INV4, 10, NOA, 'נועה לוי', '0521112233', 'noa@example.com', 500, 90, 590, day(-10), day(-8)),    // late: a reminder waits — paid meanwhile
      inv(INV5, 11, NOA, 'נועה לוי', '0521112233', 'noa@example.com', 500, 90, 590, day(-6), day(-4)),     // late 4 days: the approval screen counts it
    ],
    payment_plans: [{ id: PLAN2, business_id: BIZ, user_id: OWNER, document_id: INV2, lead_id: DANA, total: 1180, payments: 2, status: 'active', note: '', created_at: `${day(-30)}T08:00:00Z`,
      cancelled_at: null, cancelled_by: null, cancel_reason: '' }],
    payment_plan_items: [
      { id: randomUUID(), plan_id: PLAN2, business_id: BIZ, n: 1, due_date: day(5), amount: 590 },
      { id: randomUUID(), plan_id: PLAN2, business_id: BIZ, n: 2, due_date: day(35), amount: 590 },
    ],
    debt_reminder_settings: [], debt_reminder_stops: [],
    debt_reminders: [reminder(Q1, INV3, DANA, 2, day(-10), 118, '0502222222'), reminder(Q2, INV4, NOA, 2, day(-8), 590, '0521112233')],
    expenses: [{ ...base, id: E1, expense_number: 1, status: 'confirmed', supplier_name: 'אור ספקים בע"מ', supplier_dealer: '', supplier_doc_type: 'tax_invoice', supplier_doc_number: 'A-12',
      allocation_number: '', doc_date: day(-3), category: 'materials', description: '', amount_before_vat: 100, vat_amount: 18, total: 118, vat_deductible_pct: 100, paid_on: null,
      payment_method: null, file_path: `${BIZ}/x-inv.pdf`, file_mime: 'application/pdf', ai_model: '', ai_extracted: null, stock_lines: [], void_reason: '', voided_at: null,
      file_sha256: SHA, duplicate_ack: null }],
    sales: [], sale_refunds: [], stock_movements: [], register_shifts: [], content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [], push_subscriptions: [],
    payments: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [], payment_requests: [],
    client_packages: [], client_package_uses: [], client_sessions: [], client_treatments: [], treatment_types: [], quotes: [],
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
  for (const p of ['/finance/documents', '/finance/receivables', '/finance/settings', '/finance/expenses', '/finance', '/leads']) {
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
  const popups: string[] = [];
  await ctx.route(/https:\/\/(wa\.me|api\.whatsapp\.com)\//, (r: any) => { popups.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>wa</body></html>' }); });
  await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'קליניקה לייט', state: 'active' }, businesses: [{ id: BIZ, name: 'קליניקה לייט', state: 'active' }], superAdmin: false, access: 'full' } }));
  await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
  await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
  await ctx.route(`${BASE}/api/finance/tax/status`, (r: any) => r.fulfill({ json: { mode: 'unconfigured', configured: false, connection: null, message: 'החיבור לרשות המסים לא הוגדר.' } }));
  await ctx.route(`${BASE}/api/client-file/**`, (r: any) => r.fulfill({ status: 403, json: { code: 'no_access', message: 'אין גישה' } }));
  await ctx.route(`${BASE}/api/store/payments`, (r: any) => r.fulfill({ json: { connected: false, provider: null, mode: null, hint: '', connectedAt: null, ready: false, liveOpen: false, verifiedAt: null, linksLive: false } }));
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
      await page.screenshot({ path: path.join(SHOTS, `r-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
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
  const openInvoice = async (n: number, name: string) => {
    await goto('/finance/documents');
    await page.getByText(`חשבונית מס ${n} · ${name}`).click();
    await dialog().getByRole('heading', { name: `חשבונית מס ${n}` }).waitFor();
  };
  const pay = (doc: string, amount: number) => fake.tables.payments.push({ id: randomUUID(), business_id: BIZ, direction: 'in', amount, method: 'transfer', paid_on: today, source: 'document',
    document_id: randomUUID(), applies_to: doc, note: '', created_at: new Date().toISOString() });

  try {
    await goto('/finance/documents');
    await page.getByText('חשבונית מס 7 · נועה לוי').waitFor({ timeout: 120_000 });

    await step('"📅 פריסה לתשלומים" from an open invoice: equal parts to the agora; a changed amount moves the ones after it; a sum that misses is not saved', async () => {
      await openInvoice(7, 'נועה לוי');
      await dialog().getByRole('button', { name: '📅 פריסה לתשלומים' }).click();
      const d = dialog();
      await d.getByRole('heading', { name: 'פריסה לתשלומים' }).waitFor();
      await d.getByText('לא תשלומים בכרטיס אשראי', { exact: false }).waitFor();
      assert.deepEqual(await Promise.all([1, 2, 3].map((i) => d.getByLabel(`סכום תשלום ${i}`).inputValue())), ['983.34', '983.33', '983.33'], 'equal parts, the agora on the first');
      assert.equal(await d.getByLabel('תאריך תשלום 1').inputValue(), today);
      await d.getByLabel('סכום תשלום 1').fill('1000');
      assert.deepEqual(await Promise.all([2, 3].map((i) => d.getByLabel(`סכום תשלום ${i}`).inputValue())), ['975', '975'], 'the ones after it share what is left');
      await d.getByText('סה״כ ₪2,950 מתוך יתרה של ₪2,950 ✓').waitFor();
      await d.getByLabel('סכום תשלום 3').fill('900');
      await d.getByText('סה״כ ₪2,875 מתוך יתרה של ₪2,950').waitFor();
      assert.equal(await d.getByRole('button', { name: 'שמירת הפריסה' }).isDisabled(), true, 'a sum that misses the balance is not saved');
      await d.getByLabel('סכום תשלום 3').fill('975');
      await d.getByText('סה״כ ₪2,950 מתוך יתרה של ₪2,950 ✓').waitFor();
      await fits('the plan dialog');
      await shot('r1-plan-dialog.png');
      await d.getByRole('button', { name: 'שמירת הפריסה' }).click();
      await dialog().getByText('📅 פריסה ל-3 תשלומים · ₪2,950').waitFor();
      const plans = fake.tables.payment_plans.filter((p: any) => p.document_id === INV1 && p.status === 'active');
      assert.equal(plans.length, 1);
      assert.deepEqual(fake.tables.payment_plan_items.filter((i: any) => i.plan_id === plans[0].id).map((i: any) => [i.n, i.amount, i.due_date]),
        [[1, 1000, today], [2, 975, addMonths(today, 1)], [3, 975, addMonths(today, 2)]], 'its payments: a month apart');
      assert.equal(await dialog().getByText('פתוח', { exact: true }).count(), 3, 'three open payments');
    });

    await step('a payment pays the plan in order: the first paid, the second in part, the third open', async () => {
      pay(INV1, 1500);
      await openInvoice(7, 'נועה לוי');
      const d = dialog();
      await d.getByText('📅 פריסה ל-3 תשלומים · ₪2,950').waitFor();
      await d.getByText('שולם', { exact: true }).first().waitFor();
      await d.getByText('₪475 מתוך ₪975').waitFor();
      await d.getByText('שולם חלקית', { exact: true }).waitFor();
      await fits('an invoice with its plan');
      await shot('r2-invoice-plan.png');
    });

    await step('"חייבים" and the overview: a plan\'s payments count by their own dates — an invoice late by its own date but with its plan ahead is not late', async () => {
      await goto('/finance/receivables');
      const row = page.locator('div.rounded-2xl', { hasText: 'דנה כהן · חשבונית מס 8' }).first();
      await row.getByText(`📅 תשלום 1 מתוך 2 עד ${ddmm(day(5))} · ₪590`).waitFor();
      await row.getByText('פתוח · פריסה').waitFor();
      assert.equal(await row.getByText('באיחור').count(), 0, 'not late: its plan is ahead');
      await page.locator('div.rounded-2xl', { hasText: 'דנה כהן · חשבונית מס 9' }).first().getByText('באיחור', { exact: true }).waitFor();
      await fits('the receivables with plans');
      await goto('/finance');
      // late: invoices 9 (₪118), 10 (₪590) and 11 (₪590) — not 8 (its plan is ahead), not 7 (its payments are due from today)
      const late = page.locator('div, button', { hasText: /^באיחור/ }).filter({ hasText: '3 מסמכים' }).first();
      await late.getByText('₪1,298').waitFor();
      await page.getByText('📨 2 תזכורות חוב מחכות לשליחה בוואטסאפ.').waitFor();
    });

    await step('the WhatsApp queue: "שליחה" opens WhatsApp with the debt as it is now, and it is kept on the card; a debt paid meanwhile is not sent', async () => {
      await goto('/finance/receivables');
      const q = page.locator('div.rounded-2xl', { hasText: '📨 תזכורות לשליחה בוואטסאפ (2)' }).first();
      await q.waitFor();
      const r1 = q.locator('div.rounded-xl', { hasText: 'דנה כהן · חשבונית מס מס׳ 9' });
      await r1.getByText('10 ימי איחור · תזכורת 2').waitFor();
      await fits('the reminders\' queue');
      await shot('r3-queue.png');
      const [popup] = await Promise.all([page.waitForEvent('popup'), r1.getByRole('button', { name: 'שליחה בוואטסאפ' }).click()]);
      await popup.waitForURL(/wa\.me/, { timeout: 15_000 });
      const text = decodeURIComponent(popup.url());
      assert.match(text, /wa\.me\/972502222222\?text=/);
      // the business as on its documents; the debt as it is now; the invoice's own link
      assert.match(text, /שלום דנה, לפי הרישומים שלנו בקליניקה לייט בע״מ, חשבונית מס מס׳ 9 עדיין לא שולמה במלואה — יתרה של ₪118, שמועד התשלום שלה היה \d\d\/\d\d\/\d{4}/);
      assert.match(text, new RegExp(`${BASE}/d/a+9`));
      await popup.close();
      await page.getByText('התזכורת נרשמה כנשלחה — בכרטיס הלקוח וביומן.').waitFor();
      const s1 = fake.tables.debt_reminders.find((x: any) => x.id === Q1)!;
      assert.deepEqual([s1.status, s1.sent_by], ['sent', OWNER]);
      assert.equal(fake.tables.lead_activities.filter((a: any) => a.lead_id === DANA && a.kind === 'whatsapp').length, 1, 'on Dana\'s card');
      // invoice 10 is paid before its reminder is sent: it says so, and nothing opens
      pay(INV4, 590);
      await goto('/finance/receivables');
      const r2 = page.locator('div.rounded-xl', { hasText: 'נועה לוי · חשבונית מס מס׳ 10' });
      await r2.getByText('שולם בינתיים').waitFor();
      const before = popups.length;
      await r2.getByRole('button', { name: 'הסרה' }).click();
      await page.getByText('החוב שולם בינתיים — התזכורת לא נשלחה.').waitFor();
      assert.equal(popups.length, before, 'no WhatsApp for a debt that was paid');
      const s2 = fake.tables.debt_reminders.find((x: any) => x.id === Q2)!;
      assert.deepEqual([s2.status, s2.cancel_reason], ['cancelled', 'paid']);
      // the queue is read again after the answer: it empties
      await page.getByText('📨 תזכורות לשליחה בוואטסאפ', { exact: false }).waitFor({ state: 'detached', timeout: 15_000 });
    });

    await step('the reminders\' settings: off until the owner approves (what would go now is shown); anyone who may write turns them off', async () => {
      await goto('/finance/settings');
      const card = page.locator('div.grid', { has: page.getByText('תזכורות חוב אוטומטיות', { exact: true }) }).first();
      await card.getByText('כבויות', { exact: true }).waitFor();
      await card.getByText('אם יופעלו עכשיו: 1 לתור הוואטסאפ.').waitFor();
      await card.getByRole('button', { name: 'מייל' }).click();
      await card.getByText('אם יופעלו עכשיו: 1 במייל.').waitFor();
      await card.getByRole('button', { name: 'תור לשליחה בוואטסאפ' }).click();
      const go = card.getByRole('button', { name: 'הפעלת התזכורות' });
      assert.equal(await go.isDisabled(), true, 'not before the approval is ticked');
      await card.getByLabel(/אני מאשר\/ת לשלוח ללקוחות תזכורות חוב לפי הכללים האלה \(3, 7 ו-14 ימים אחרי מועד התשלום\)/).check();
      await fits('the reminders\' settings');
      await shot('r4-settings.png');
      await go.click();
      await card.getByText('פועלות', { exact: true }).waitFor();
      await card.getByText(/הופעלו באישור הבעלים ב-.*: 3, 7 ו-14 ימים אחרי מועד התשלום, בתור לשליחה בוואטסאפ\./).waitFor();
      const s = fake.tables.debt_reminder_settings[0];
      assert.deepEqual([s.enabled, s.days, s.channel, s.approved_by], [true, [3, 7, 14], 'whatsapp', OWNER]);
      // a member who is not the owner: may not turn them on, may turn them off
      fake.owner = false; fake.tables.business_members[0].role = 'editor';
      await goto('/finance/settings');
      await card.getByText('פועלות', { exact: true }).waitFor();
      await card.getByRole('button', { name: 'כיבוי התזכורות' }).click();
      await card.getByText('כבויות', { exact: true }).waitFor();
      await card.getByText('רק הבעלים של העסק מפעילים תזכורות אוטומטיות.').waitFor();
      assert.equal(await card.getByRole('button', { name: 'הפעלת התזכורות' }).count(), 0);
      assert.equal(fake.tables.debt_reminder_settings[0].enabled, false);
      fake.owner = true; fake.tables.business_members[0].role = 'owner';
    });

    await step('the customer\'s card: late by the plan\'s payments; "לא לשלוח" stops the automatic reminders', async () => {
      await goto('/leads');
      await page.getByRole('button', { name: /נועה לוי/ }).first().click();
      await dialog().getByRole('heading', { name: 'נועה לוי' }).waitFor();
      await dialog().getByRole('button', { name: /💰 כספים/ }).click();
      // owed: invoice 7 (₪1,450 left, its payments ahead) + invoice 11 (₪590, 4 days late); invoice 10 was paid
      await dialog().getByText('(באיחור ₪590)').waitFor();
      await dialog().getByText('₪2,040', { exact: true }).waitFor();
      const box = dialog().getByLabel('🔕 לא לשלוח תזכורות חוב אוטומטיות');
      assert.equal(await box.isChecked(), false);
      // the box follows the database: it is ticked once "לא לשלוח" was kept
      await box.click();
      for (let i = 0; i < 50 && !(await box.isChecked()); i++) await page.waitForTimeout(100);
      assert.equal(await box.isChecked(), true);
      assert.ok(fake.tables.debt_reminder_stops.some((x: any) => x.lead_id === NOA && !x.lifted_at), 'kept');
      await fits('the money of a card');
    });

    await step('an expense whose file was recorded before: said at once (with a link); "זו הוצאה אחרת" saves it and is kept; the AI reading is still there', async () => {
      await goto('/finance/expenses');
      await page.getByRole('button', { name: '+ הוצאה' }).click();
      const d = dialog();
      await d.getByRole('heading', { name: 'הוצאה חדשה' }).waitFor();
      await d.getByLabel('קובץ החשבונית').setInputFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: FILE });
      await d.getByText(`הקובץ הזה כבר נקלט בהוצאה #1 מתאריך ${ddmm(day(-3))}.`).first().waitFor();
      await d.getByRole('button', { name: 'פתיחת הוצאה #1' }).first().waitFor();
      await d.getByRole('button', { name: '✨ קריאה אוטומטית' }).waitFor();
      await d.getByLabel('ספק', { exact: true }).fill('ספק חדש');
      await d.getByLabel('סה״כ (כולל מע״מ)').fill('59');
      await fits('a new expense that repeats a file');
      await d.getByRole('button', { name: 'אישור ושמירה' }).click();
      const warn = d.getByRole('alert');
      await warn.getByRole('button', { name: 'זו הוצאה אחרת — לשמור' }).waitFor();
      await shot('r5-duplicate.png');
      await warn.getByRole('button', { name: 'זו הוצאה אחרת — לשמור' }).click();
      await page.getByText('ההוצאה נשמרה').waitFor();
      const e = fake.tables.expenses.find((x: any) => x.supplier_name === 'ספק חדש')!;
      assert.equal(e.file_sha256, SHA, 'its fingerprint');
      assert.deepEqual([e.duplicate_ack.of, e.duplicate_ack.reasons, e.duplicate_ack.by], [[E1], ['file'], OWNER], 'the decision, who made it');
    });

    await step('an expense that repeats a supplier\'s number: a warning; "חזרה לטופס" saves nothing; another number saves at once', async () => {
      await goto('/finance/expenses');
      await page.getByRole('button', { name: '+ הוצאה' }).click();
      const d = dialog();
      await d.getByLabel('ספק', { exact: true }).fill('אור ספקים בע״מ');
      await d.getByLabel('מספר המסמך').fill('a 12');
      await d.getByLabel('סה״כ (כולל מע״מ)').fill('236');
      const n = fake.tables.expenses.length;
      await d.getByRole('button', { name: 'אישור ושמירה' }).click();
      await d.getByRole('alert').getByText(`נראה שההוצאה הזו כבר קיימת: אותו ספק ואותו מספר מסמך — הוצאה #1 מתאריך ${ddmm(day(-3))}.`).waitFor();
      await d.getByRole('button', { name: 'חזרה לטופס' }).click();
      assert.equal(fake.tables.expenses.length, n, 'nothing saved');
      await d.getByLabel('מספר המסמך').fill('A-13');
      await d.getByRole('button', { name: 'אישור ושמירה' }).click();
      await page.getByText('ההוצאה נשמרה').waitFor();
      assert.equal(fake.tables.expenses.length, n + 1);
      assert.equal(fake.tables.expenses[n].duplicate_ack ?? null, null, 'no decision was needed');
    });

    await step('at 375: the plan dialog, the invoice\'s plan, the queue and the settings fit', async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      try {
        await openInvoice(7, 'נועה לוי');
        await dialog().getByText('📅 פריסה ל-3 תשלומים · ₪2,950').waitFor();
        await fits('an invoice with its plan at 375');
        await dialog().getByRole('button', { name: 'פריסה מחדש' }).click();
        await dialog().getByRole('heading', { name: 'פריסה מחדש' }).waitFor();
        await fits('the plan dialog at 375');
        await goto('/finance/settings');
        await page.getByText('תזכורות חוב אוטומטיות', { exact: true }).waitFor();
        await fits('the settings at 375');
      } finally { await page.setViewportSize(PHONE); }
    });

    await step('no errors in the browser', async () => { assert.deepEqual(errors, []); });
  } finally { await ctx.close(); }

  await browser.close();
  try { process.kill(-dev.pid!, 'SIGTERM'); } catch { dev.kill('SIGTERM'); }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n# e2e plans & reminders: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
