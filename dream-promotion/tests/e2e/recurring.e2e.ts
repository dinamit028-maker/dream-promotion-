/**
 * Recurring charges (docs/FINANCE_ADDITIONS_HE.md T4; 2.90) in a real browser (Chromium via Playwright), on a phone (390×844, and
 * 375), against the in-memory Supabase of fake-supabase.ts. The timer and the server's documents are tested in
 * tests/recurring.test.ts, the SQL on Postgres (tests/sql/recurring.check.sql, concurrency.sh §16) — here the charges the timer
 * made are seeded.
 * Clicked through: before migration 4500 the screen says so; "+ חיוב חוזר" (a customer of the contacts, the lines, every month on
 * a day, the first charges shown, the checks before saving); from the customer's card ("🔁 חיוב חוזר", and the card lists it);
 * a held charge's "נסו שוב", the draft waiting in "מסמכים", the invoice of a charge; pause (DoD: a paused plan charges nothing —
 * nothing is made), resume, end; editing a plan that charged (its schedule stays, the amount changes from the next charge).
 *
 * Run: npx tsx tests/e2e/recurring.e2e.ts   (starts `next dev` on port 3224; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (rc* — not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';
import { firstCharge, upcoming } from '../../src/features/finance/recurring';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_RECURRING_PORT ?? 3224);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000000e7';
const OWNER = 'a0000000-0000-4000-8000-0000000000e7';
const NOA = 'd0000000-0000-4000-8000-0000000000e7';
const DANA = 'd0000000-0000-4000-8000-0000000000e8';
const RON = 'd0000000-0000-4000-8000-0000000000e9';
const SEEDED = 'c0000000-0000-4000-8000-0000000000e1';            // דנה's monthly plan: it charged (an invoice, a held one, a draft)
const INV = 'f0000000-0000-4000-8000-0000000000e1';
const C_ISSUED = 'e0000000-0000-4000-8000-0000000000c1';
const C_HELD = 'e0000000-0000-4000-8000-0000000000c2';
const C_DRAFT = 'e0000000-0000-4000-8000-0000000000c3';
const PHONE = { width: 390, height: 844 };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const day = (n: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const month = (n: number) => { const [y, m] = today.split('-').map(Number); const i = y * 12 + (m - 1) + n; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-05`; };
const ddmm = (d: string) => d.split('-').reverse().join('/');
const D1 = Math.min(28, Number(today.slice(8, 10)));

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  return {
    brands: [{ ...base, name: 'סטודיו לייט', onboarded: true, industry: 'שיווק', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'company', vat_rate: 18, pay_link: '', dealer_number: '515123456', legal_name: 'סטודיו לייט בע״מ', street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [{ business_id: BIZ, user_id: OWNER, trading_name: '', phone: '03-1234567', email: '', payment_terms: 'net_30', quote_valid_days: 30, vat_period: 'bimonthly', paylink_receipt: 'auto' }],
    business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }],
    employees: [], catalog_items: [],
    leads: [
      { ...base, id: NOA, name: 'נועה לוי', phone: '0521112233', email: 'noa@example.com', source: 'ידני', status: 'נסגר', date: '2026-01-01', tags: [], value: 0, notes: '' },
      { ...base, id: DANA, name: 'דנה כהן', phone: '0502222222', email: '', source: 'ידני', status: 'נסגר', date: '2026-01-01', tags: [], value: 0, notes: '' },
      { ...base, id: RON, name: 'רון שגיא', phone: '0503333333', email: '', source: 'ידני', status: 'נסגר', date: '2026-01-01', tags: [], value: 0, notes: '' },
    ],
    documents: [{ ...base, id: INV, doc_type: 305, doc_number: 21, link_no: 1, issued_at: `${month(-1)}T08:00:00Z`, doc_date: month(-1), due_date: day(20), customer_name: 'דנה כהן',
      customer_phone: '0502222222', customer_email: '', customer_dealer: '', lead_id: DANA, idempotency_key: `recurring:${SEEDED}:${month(-1)}`,
      lines: [{ name: 'מנוי חודשי', qty: 1, unitPriceExVat: 500, discountExVat: 0, totalExVat: 500, vatRate: 18, kind: 1 }], payments: [], before_discount: 500, discount: 0,
      after_discount: 500, vat_amount: 90, total: 590, vat_rate: 18, print_count: 0, share_token: 'r'.repeat(64), issuer: null, source: 'direct', notes: 'חיוב חוזר: מנוי חודשי' }],
    recurring_plans: [{ id: SEEDED, business_id: BIZ, user_id: OWNER, lead_id: DANA, name: 'מנוי חודשי', lines: [{ name: 'מנוי חודשי', qty: 1, unitPrice: 590 }],
      prices_include_vat: true, amount: 590, every_months: 1, day_of_month: 5, start_date: month(-3), end_date: null, next_date: month(1), mode: 'issue', send_link: true,
      status: 'active', note: '', paused_at: null, ended_at: null, end_reason: '', created_at: `${month(-3)}T08:00:00Z`, updated_at: `${month(-3)}T08:00:00Z` }],
    recurring_charges: [
      { id: C_ISSUED, business_id: BIZ, plan_id: SEEDED, period_date: month(-1), status: 'issued', document_id: INV, draft_id: null, paylink_id: null,
        note: 'לינק בדיקה — לא נשלח ללקוח/ה (תשלום אמיתי בלינק עוד לא הופעל).', error: '', attempts: 1, claimed_at: null, created_at: `${month(-1)}T08:00:00Z`, updated_at: `${month(-1)}T08:00:00Z` },
      { id: C_HELD, business_id: BIZ, plan_id: SEEDED, period_date: month(-2), status: 'blocked', document_id: null, draft_id: null, paylink_id: null, note: '',
        error: 'לא הופק: מספר העוסק / ח.פ של הלקוח לא תקין (9 ספרות עם ספרת ביקורת)', attempts: 1, claimed_at: null, created_at: `${month(-2)}T08:00:00Z`, updated_at: `${month(-2)}T08:00:00Z` },
      { id: C_DRAFT, business_id: BIZ, plan_id: SEEDED, period_date: month(0), status: 'draft', document_id: null, draft_id: C_DRAFT, paylink_id: null, note: '', error: '',
        attempts: 1, claimed_at: null, created_at: `${month(0)}T08:00:00Z`, updated_at: `${month(0)}T08:00:00Z` },
    ],
    document_drafts: [{ id: C_DRAFT, user_id: OWNER, business_id: BIZ, doc_type: 305, status: 'open', customer_name: 'דנה כהן', lead_id: DANA, quote_id: null, total: 590,
      body: { lines: [{ name: 'מנוי חודשי', qty: 1, unitPrice: 590 }], pricesIncludeVat: true, discount: { kind: 'sum', value: 0 }, customer: { name: 'דנה כהן' }, notes: 'חיוב חוזר: מנוי חודשי', terms: 'net_30', payments: [] },
      document_id: null, created_at: `${month(0)}T08:00:00Z`, updated_at: `${month(0)}T08:00:00Z` }],
    sales: [], sale_refunds: [], stock_movements: [], register_shifts: [], content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [], push_subscriptions: [],
    payments: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [], payment_requests: [], quotes: [],
    client_packages: [], client_package_uses: [], client_sessions: [], client_treatments: [], treatment_types: [], payment_plans: [], payment_plan_items: [],
    debt_reminder_settings: [], debt_reminder_stops: [], debt_reminders: [], expenses: [],
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
  for (const p of ['/finance/recurring', '/finance/documents', '/leads']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@studio.test' });
  const errors: string[] = [];

  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', isMobile: true, hasTouch: true });
  await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@studio.test'))]);
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
  await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'סטודיו לייט', state: 'active' }, businesses: [{ id: BIZ, name: 'סטודיו לייט', state: 'active' }], superAdmin: false, access: 'full' } }));
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
      await page.screenshot({ path: path.join(SHOTS, `rc-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
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
  const openPlan = async (name: RegExp) => {
    await goto('/finance/recurring');
    await page.getByRole('button', { name: 'הכל', exact: true }).click();           // an ended plan too
    await page.getByRole('button', { name }).first().click();
    await dialog().getByRole('heading', { level: 3 }).first().waitFor();
  };

  try {
    await goto('/finance/recurring');
    await page.getByText('חיובים חוזרים פעילים').waitFor({ timeout: 120_000 });

    await step('before migration 4500 the screen says so — nothing else changes', async () => {
      fake.recurringTables = false;
      try {
        await goto('/finance/recurring');
        await page.getByText('החיובים החוזרים עוד לא הופעלו במסד הנתונים', { exact: false }).waitFor();
        assert.equal(await page.getByRole('button', { name: '+ חיוב חוזר' }).count(), 0);
      } finally { fake.recurringTables = true; }
    });

    await step('the screen: what is active, a held charge and why, the draft waiting in "מסמכים"', async () => {
      await goto('/finance/recurring');
      await page.getByRole('button', { name: /דנה כהן · מנוי חודשי/ }).waitFor();
      await page.getByText('לא הופקו — צריך לבדוק').waitFor();
      await page.getByText('לא הופק: מספר העוסק / ח.פ של הלקוח לא תקין', { exact: false }).first().waitFor();
      await page.getByText('טיוטה אחת של חיוב חוזר מחכה לאישור', { exact: false }).waitFor();
      await page.getByText('שום כרטיס אשראי ושום חשבון בנק לא מחויבים כאן', { exact: false }).waitFor();
      await shot('rc1-screen.png');
      await fits('the recurring screen');
    });

    await step('"+ חיוב חוזר": a customer of the contacts, the lines, every month on a day — the first charges shown; saved once', async () => {
      await goto('/finance/recurring');
      await page.getByRole('button', { name: '+ חיוב חוזר' }).click();
      const d = dialog();
      await d.getByRole('heading', { name: 'חיוב חוזר חדש' }).waitFor();
      await d.getByText('שום כרטיס לא מחויב', { exact: false }).waitFor();
      // the checks before saving: a customer first
      await d.getByRole('button', { name: 'שמירת החיוב החוזר' }).click();
      await d.getByText('בחרו לקוח/ה מאנשי הקשר.').waitFor();
      await d.getByLabel('חיפוש לקוח/ה').fill('נועה');
      await d.getByRole('button', { name: /נועה לוי · 0521112233/ }).click();
      await d.getByText('נועה לוי', { exact: true }).waitFor();
      await d.getByRole('button', { name: 'שמירת החיוב החוזר' }).click();
      await d.getByText('תנו שם לחיוב (למשל "ריטיינר חודשי").').waitFor();
      await d.getByLabel('שם החיוב (מופיע בחשבונית)').fill('ריטיינר שיווק');
      await d.getByRole('button', { name: 'שמירת החיוב החוזר' }).click();
      await d.getByText('צריך לפחות שורה אחת (תיאור ומחיר).').waitFor();
      await d.getByLabel('תיאור שורה 1').fill('ריטיינר חודשי');
      await d.getByLabel('מחיר שורה 1').fill('1180');
      await d.getByText('סה״כ לתקופה: ₪1,180 (כולל מע״מ)').waitFor();
      assert.equal(await d.getByLabel('ביום בחודש (1–28)').inputValue(), String(D1), 'today\'s day of the month');
      const first = firstCharge(today, 1, D1, today)!;
      const dates = upcoming({ startDate: today, every: 1, day: D1, nextDate: first, endDate: null }, 3);
      await d.getByText(`החיובים הראשונים: ${dates.map(ddmm).join(', ')}`).waitFor();
      // an end before the first charge: said, nothing saved
      await d.getByLabel('ביום בחודש (1–28)').fill(String(D1 % 28 + 1));
      await d.getByLabel('מסתיים ב- (לא חובה)').fill(today);
      await d.getByRole('button', { name: 'שמירת החיוב החוזר' }).click();
      await d.getByText('אחרי תאריך הסיום', { exact: false }).first().waitFor();
      assert.equal(fake.tables.recurring_plans.length, 1, 'nothing saved');
      await d.getByLabel('ביום בחודש (1–28)').fill(String(D1));
      await d.getByLabel('מסתיים ב- (לא חובה)').fill('');
      await d.getByRole('radio', { name: 'כל חודש', exact: true }).waitFor();
      await fits('the editor');
      await shot('rc2-editor.png');
      await d.getByRole('button', { name: 'שמירת החיוב החוזר' }).click();
      await page.getByText(`החיוב החוזר נשמר — הראשון ב-${ddmm(first)}`).waitFor();
      assert.equal(fake.tables.recurring_plans.length, 2, 'one plan');
      const p = fake.tables.recurring_plans[1];
      assert.deepEqual([p.lead_id, p.name, Number(p.amount), p.every_months, p.day_of_month, p.mode, p.send_link, p.next_date],
        [NOA, 'ריטיינר שיווק', 1180, 1, D1, 'issue', true, first]);
      assert.deepEqual(p.lines, [{ name: 'ריטיינר חודשי', qty: 1, unitPrice: 1180 }]);
      // the plan opens: its next date, no charge yet
      await dialog().getByRole('heading', { name: 'ריטיינר שיווק' }).waitFor();
      await dialog().getByText(`עוד לא חויב — החיוב הראשון ב-${ddmm(first)}.`).waitFor();
      assert.ok(fake.tables.lead_activities.some((a: any) => a.lead_id === NOA && String(a.body).startsWith('חיוב חוזר: ריטיינר שיווק · ₪1180 כל חודש')), 'on the card');
    });

    await step('from the customer\'s card: "🔁 חיוב חוזר" opens the editor with the customer; the card lists the plan', async () => {
      await goto('/leads');
      await page.getByRole('button', { name: /רון שגיא/ }).first().click();
      await dialog().getByRole('heading', { name: 'רון שגיא' }).waitFor();
      await dialog().getByRole('button', { name: /💰 כספים/ }).click();
      await dialog().getByRole('link', { name: '🔁 חיוב חוזר' }).click();
      const d = dialog();
      await d.getByRole('heading', { name: 'חיוב חוזר חדש' }).waitFor();
      await d.getByText('רון שגיא', { exact: true }).waitFor();
      await d.getByLabel('שם החיוב (מופיע בחשבונית)').fill('ליווי רבעוני');
      await d.getByRole('radio', { name: 'כל 3 חודשים' }).click();
      await d.getByLabel('תיאור שורה 1').fill('ליווי');
      await d.getByLabel('מחיר שורה 1').fill('3000');
      await d.getByRole('radio', { name: 'טיוטה — אני מאשר/ת ומפיק/ה' }).click();
      await d.getByText('הטיוטה מחכה ב"מסמכים"', { exact: false }).waitFor();
      await d.getByRole('button', { name: 'שמירת החיוב החוזר' }).click();
      await page.getByText('החיוב החוזר נשמר', { exact: false }).first().waitFor();
      const p = fake.tables.recurring_plans.find((x: any) => x.lead_id === RON)!;
      assert.deepEqual([p.every_months, p.mode, Number(p.amount)], [3, 'draft', 3000]);
      await goto('/leads');
      await page.getByRole('button', { name: /רון שגיא/ }).first().click();
      await dialog().getByRole('button', { name: /💰 כספים/ }).click();
      await dialog().getByRole('link', { name: /🔁 ליווי רבעוני · כל 3 חודשים/ }).waitFor();
      await fits('the money of a card with its plan');
    });

    await step('a held charge: "נסו שוב" sends it back to the timer; the invoice of a charge opens', async () => {
      await goto('/finance/recurring');
      await page.getByRole('button', { name: 'נסו שוב' }).first().click();
      await page.getByText('החיוב יופק בדקות הקרובות').waitFor();
      const c = fake.tables.recurring_charges.find((x: any) => x.id === C_HELD)!;
      assert.deepEqual([c.status, c.error], ['pending', '']);
      await openPlan(/דנה כהן · מנוי חודשי/);
      const d = dialog();
      await d.getByText('ממתין להפקה').waitFor();
      await d.getByText('הטיוטה מחכה במסמכים — בודקים ומפיקים ←').waitFor();
      await d.getByText('לינק בדיקה — לא נשלח ללקוח/ה', { exact: false }).waitFor();
      await d.getByRole('button', { name: /חשבונית מס מס׳ 21 · ₪590/ }).click();
      await dialog().getByRole('heading', { name: /חשבונית מס 21/ }).waitFor();
    });

    await step('pause (DoD: a paused plan charges nothing — nothing is made here), resume, end — what was issued stays', async () => {
      const charges = fake.tables.recurring_charges.length;
      await openPlan(/דנה כהן · מנוי חודשי/);
      await dialog().getByRole('button', { name: 'השהיה' }).click();
      await page.getByText('החיוב החוזר הושהה — לא יחייב עד שממשיכים').waitFor();
      const p = fake.tables.recurring_plans.find((x: any) => x.id === SEEDED)!;
      assert.equal(p.status, 'paused');
      assert.equal(fake.tables.recurring_charges.find((x: any) => x.id === C_HELD)!.status, 'blocked', 'the charge that waited is held');
      await dialog().getByText('מושהה — לא מחייב עד שממשיכים').waitFor();
      await dialog().getByRole('button', { name: 'המשך' }).click();
      await page.getByText(`החיוב החוזר ממשיך — הבא ב-${ddmm(month(1))}`).waitFor();
      assert.equal(p.status, 'active');
      await dialog().getByRole('button', { name: 'סיום' }).click();
      await dialog().getByText('לא יופקו עוד חיובים. חשבוניות שכבר הופקו נשארות כמו שהן.', { exact: false }).waitFor();
      await dialog().getByLabel('סיבת הסיום').fill('הלקוחה עברה לספק אחר');
      await dialog().getByRole('button', { name: 'סיום החיוב החוזר' }).click();
      await page.getByText('החיוב החוזר הסתיים. מה שכבר הופק נשאר כמו שהוא.').waitFor();
      assert.deepEqual([p.status, p.end_reason], ['ended', 'הלקוחה עברה לספק אחר']);
      assert.equal(await dialog().getByRole('button', { name: 'עריכה' }).count(), 0, 'an ended plan does not change');
      assert.equal(fake.tables.recurring_charges.length, charges, 'nothing was charged or removed');
      assert.ok(fake.tables.documents.some((x: any) => x.id === INV), 'the invoice stays');
    });

    await step('editing a plan that charged: its schedule stays; a new amount from the next charge', async () => {
      // the plan made above (נועה) charged once meanwhile (as the timer would)
      const p = fake.tables.recurring_plans.find((x: any) => x.lead_id === NOA)!;
      fake.tables.recurring_charges.push({ id: randomUUID(), business_id: BIZ, plan_id: p.id, period_date: p.next_date, status: 'pending', document_id: null, draft_id: null,
        paylink_id: null, note: '', error: '', attempts: 1, claimed_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      await openPlan(/נועה לוי · ריטיינר שיווק/);
      await dialog().getByRole('button', { name: 'עריכה' }).click();
      const d = dialog();
      await d.getByRole('heading', { name: 'עריכת חיוב חוזר' }).waitFor();
      await d.getByText('אחרי החיוב הראשון התדירות, היום וההתחלה לא משתנים', { exact: false }).waitFor();
      assert.ok(await d.getByLabel('ביום בחודש (1–28)').isDisabled(), 'the day is locked');
      assert.ok(await d.getByRole('radio', { name: 'כל חודש', exact: true }).isDisabled(), 'how often is locked');
      await d.getByLabel('מחיר שורה 1').fill('1416');
      await d.getByText('סה״כ לתקופה: ₪1,416 (כולל מע״מ)').waitFor();
      await d.getByRole('button', { name: 'שמירת השינויים' }).click();
      await page.getByText('השינויים נשמרו — מהחיוב הבא').waitFor();
      assert.equal(Number(p.amount), 1416);
      assert.equal(p.day_of_month, D1, 'the schedule stayed');
    });

    await step('at 375: the screen, a plan and the editor fit', async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      try {
        await goto('/finance/recurring');
        await page.getByText('חיובים חוזרים פעילים').waitFor();
        await page.getByRole('button', { name: 'הכל' }).click();
        await fits('the screen at 375');
        await openPlan(/דנה כהן · מנוי חודשי/);
        await fits('an ended plan at 375');
        await goto('/finance/recurring');
        await page.getByRole('button', { name: '+ חיוב חוזר' }).click();
        await dialog().getByRole('heading', { name: 'חיוב חוזר חדש' }).waitFor();
        await fits('the editor at 375');
      } finally { await page.setViewportSize(PHONE); }
    });

    await step('no errors in the browser', async () => { assert.deepEqual(errors, []); });
  } finally { await ctx.close(); }

  await browser.close();
  try { process.kill(-dev.pid!, 'SIGTERM'); } catch { dev.kill('SIGTERM'); }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n# e2e recurring charges: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
