/**
 * Stage 3 of the accountant's answers (2.120.0) in a real browser, against the in-memory Supabase (the rules themselves are proven on
 * Postgres in tests/sql/cpa-rules-stage3.check.sql and cpa-stage3-concurrency.sh):
 *   before migration 7000: no numbering card in the settings, a deposit with no document — as 2.119;
 *   after it: the card only for the owner with more than one active location; the one-way switch confirmed in the page ("פעם אחת,
 *   אין דרך חזרה"); branch codes; a document after the switch numbered in its location's series (01000001); a code fixed once its
 *   location numbered a document; a deposit issues its document 420 "הפקדת בנק" (its number in the deposits list and the toast),
 *   opened from there with no print / PDF / link, out of the overview's documents, and cancelled with its deposit.
 *
 * Run: npx -y tsx tests/e2e/cpa-stage3.e2e.ts   (starts `next dev` on port 3245; needs the preinstalled Chromium)
 * Screenshots: CPA_SHOTS=<dir> (default tests/e2e/shots/cpa-stage3) — phone (iPhone 13) and computer (1280×800).
 * Demo data only: dealer number 000000109 (the fictitious range), example.test e-mails.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_CPA3_PORT ?? 3245);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.CPA_SHOTS ?? path.join(__dirname, 'shots', 'cpa-stage3');
const BIZ = 'b0000000-0000-4000-8000-000000000007';
const LOC2 = 'b0000000-0000-4000-8000-000000000017';
const OWNER = 'a0000000-0000-4000-8000-0000000000a7';
const DESKTOP = { width: 1280, height: 800 };
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

function seed(o: { locations: number }): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  const loc = (id: string, name: string, sort: number) => ({ id, business_id: BIZ, name, kind: 'branch', address: '', phone: '', hours: '', active: true, sort, created_at: '2026-01-01T00:00:00Z' });
  const issuer = { name: 'עסק דמו', dealerNumber: '000000109', entityType: 'licensed_dealer' };
  return {
    brands: [{ ...base, name: 'דמו', onboarded: true, industry: 'יופי', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'licensed_dealer', vat_rate: 18, pay_link: '', dealer_number: '000000109', legal_name: 'עסק דמו',
      street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [{ ...base, cash_drawers: true, sells_products: false, cheque_remind_days: 3 }],
    business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }],
    business_locations: [loc(BIZ, 'ראשי', 0), ...(o.locations > 1 ? [loc(LOC2, 'סניף דמו', 1)] : [])],
    registers: [{ id: BIZ, business_id: BIZ, location_id: BIZ, name: 'קופה 1', device: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' }],
    // one paid receipt of the main location: 590 cash in its desk (the deposit's money)
    documents: [{ ...base, id: 'c0000000-0000-4000-8000-000000000001', doc_type: 320, doc_number: 1, link_no: 1, issued_at: `${TODAY}T08:00:00Z`, doc_date: TODAY,
      customer_name: 'לקוחה דמו', customer_phone: '', customer_dealer: '', lead_id: null, before_discount: 500, discount: 0, after_discount: 500, vat_amount: 90, total: 590, vat_rate: 18,
      lines: [{ name: 'טיפול', qty: 1, unitPriceExVat: 500, discountExVat: 0, totalExVat: 500, vatRate: 18, kind: 1 }], payments: [{ method: 1, amount: 590, date: TODAY, m: 'cash' }],
      print_count: 1, share_token: '1'.repeat(64), issuer, source: 'direct', notes: '', location_id: BIZ, base_doc_type: null, base_doc_number: null }],
    payments: [{ id: 'd0000000-0000-4000-8000-000000000001', business_id: BIZ, user_id: OWNER, direction: 'in', amount: 590, method: 'cash', paid_on: TODAY, source: 'document',
      document_id: 'c0000000-0000-4000-8000-000000000001', applies_to: null, sale_id: null, lead_id: null, reference: {}, note: '', created_at: `${TODAY}T08:00:00Z`, location_id: BIZ }],
    catalog_items: [], employees: [], leads: [], sales: [], sale_refunds: [], stock_movements: [], register_shifts: [], appointments: [], booking_services: [],
    content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [], push_subscriptions: [],
    quotes: [], expenses: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [], tax_allocation_rules: [],
    bank_deposits: [], bank_deposit_cheques: [], bank_statements: [], bank_lines: [], bank_matches: [], cheque_reminders: [],
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
  const { chromium, devices } = pw.default ?? pw;
  const { defaultBrowserType: _d, ...IPHONE } = devices['iPhone 13'];
  const dev = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: 'http://sb.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-test-key', NEXT_TELEMETRY_DISABLED: '1' },
  });
  const results: { name: string; ok: boolean }[] = [];
  const browser = await (async () => { await waitForServer(dev); return chromium.launch(); })();
  for (const p of ['/finance', '/finance/documents', '/finance/settings', '/finance/cash']) for (let i = 0; i < 3; i++) { if (await fetch(`${BASE}${p}`).then((r) => r.ok, () => false)) break; }
  const errors: string[] = [];
  let fake = new FakeSupabase(seed({ locations: 2 }), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' });
  let lastPage: any = null;

  async function open(p: string, view: 'phone' | 'desktop') {
    const ctx = await browser.newContext(view === 'desktop'
      ? { viewport: DESKTOP, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' }
      : { ...IPHONE, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@example.test'))]);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    await ctx.route('http://sb.test/**', async (route: any) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const r = fake.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
      return route.fulfill({ status: r.status, body: r.body ?? '', headers: { ...(r.headers ?? {}), ...cors } });
    });
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'דמו', state: 'active' }, businesses: [{ id: BIZ, name: 'דמו', state: 'active' }], superAdmin: false, access: 'full' } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
    await ctx.route(`${BASE}/api/finance/tax/status`, (r: any) => r.fulfill({ json: { mode: 'unconfigured', configured: false, connection: null, message: '' } }));
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    lastPage = page;
    page.on('pageerror', (e: Error) => errors.push(e.message));
    page.on('dialog', (d: any) => d.accept());
    try { await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' }); }
    catch (e: any) { if (!/ERR_ABORTED/.test(String(e?.message))) throw e; await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' }); }
    return { ctx, page };
  }
  const settle = (page: any) => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime))).map((a) => a.finished.catch(() => null))));
  const shot = async (page: any, name: string) => { await settle(page); await page.screenshot({ path: path.join(SHOTS, name) }); };
  const dialog = (page: any) => page.getByRole('dialog').last();
  const settingsReady = (page: any) => page.getByText('פרטי העסק על המסמכים').waitFor({ timeout: 120_000 });
  const card = (page: any) => page.getByRole('region', { name: 'מספור מסמכים', exact: true });
  const step = async (name: string, fn: () => Promise<void>) => {
    if (process.env.CPA_ONLY && !name.includes(process.env.CPA_ONLY)) return;
    try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false }); await lastPage?.screenshot({ path: path.join(SHOTS, `FAIL-${results.length}.png`) }).catch(() => undefined); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}`); }
  };

  // ---- before migration 7000 ---------------------------------------------------------------------------------------------------
  await step('before 7000: no numbering card; a deposit is recorded with no document (as 2.119)', async () => {
    fake = new FakeSupabase(seed({ locations: 2 }), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' });
    fake.cpaStage3 = false;
    const { ctx, page } = await open('/finance/settings', 'desktop');
    try {
      await settingsReady(page);
      await page.waitForTimeout(800);
      assert.equal(await card(page).count(), 0, 'no card before 7000');
      await page.goto(`${BASE}/finance/cash`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '+ הפקדה לבנק' }).click({ timeout: 120_000 });
      const d = dialog(page);
      await d.getByLabel('מזומן להפקדה').fill('100');
      await d.getByRole('button', { name: 'רישום ההפקדה' }).click();
      await page.getByText('הפקדה 1 נרשמה').waitFor();
      assert.equal(await page.getByText(/הופקה הפקדת בנק/).count(), 0);
      assert.equal(fake.tables.documents.filter((x: any) => x.doc_type === 420).length, 0, 'no 420 before 7000');
    } finally { await ctx.close(); }
  });

  // ---- after it: who sees the card ---------------------------------------------------------------------------------------------
  await step('after 7000: one active location — no card; not the owner — no card', async () => {
    fake = new FakeSupabase(seed({ locations: 1 }), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' });
    let { ctx, page } = await open('/finance/settings', 'desktop');
    try { await settingsReady(page); await page.waitForTimeout(800); assert.equal(await card(page).count(), 0, 'one location: nothing'); } finally { await ctx.close(); }
    fake = new FakeSupabase(seed({ locations: 2 }), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' });
    fake.owner = false;
    ({ ctx, page } = await open('/finance/settings', 'desktop'));
    try { await settingsReady(page); await page.waitForTimeout(800); assert.equal(await card(page).count(), 0, 'not the owner: nothing'); } finally { await ctx.close(); }
  });

  for (const view of ['desktop', 'phone'] as const) {
    const tag = view === 'phone' ? 'm' : 'd';
    await step(`${view}: the owner switches once (confirmed in the page), the codes are given, a document after it is 01000001`, async () => {
      fake = new FakeSupabase(seed({ locations: 2 }), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' });
      const { ctx, page } = await open('/finance/settings', view);
      try {
        await settingsReady(page);
        await card(page).getByText('סדרה אחת לעסק').waitFor({ timeout: 60_000 });
        await card(page).scrollIntoViewIfNeeded();
        await shot(page, `${tag}1-numbering-before.png`);
        await card(page).getByRole('button', { name: 'מעבר למספור לפי סניף…' }).click();
        const confirm = card(page).getByRole('region', { name: 'אישור מעבר למספור לפי סניף' });
        await confirm.getByText('פעם אחת, אין דרך חזרה').first().waitFor();
        const go = confirm.getByRole('button', { name: 'מעבר למספור לפי סניף' });
        assert.ok(await go.isDisabled(), 'disabled until the words are typed');
        await confirm.getByLabel('אישור המעבר').fill('כן');
        assert.ok(await go.isDisabled());
        await confirm.scrollIntoViewIfNeeded();
        await shot(page, `${tag}2-numbering-confirm.png`);
        await confirm.getByLabel('אישור המעבר').fill('פעם אחת, אין דרך חזרה');
        await go.click();
        await card(page).getByText('לפי סניף', { exact: true }).waitFor();
        assert.ok(fake.numberingSince, 'switched');
        assert.deepEqual(fake.tables.business_locations.map((l: any) => [l.id, l.branch_code]), [[BIZ, '01'], [LOC2, '02']]);
        assert.equal(await card(page).getByRole('button', { name: /מעבר למספור לפי סניף/ }).count(), 0, 'one-way: no switch back');
        // the second location's code → 15
        await card(page).getByLabel('קוד סניף — סניף דמו').fill('15');
        await card(page).getByRole('button', { name: 'שמירת הקוד' }).last().click();
        await page.getByText('קוד הסניף נשמר: 15').waitFor();
        assert.equal(fake.tables.business_locations.find((l: any) => l.id === LOC2)?.branch_code, '15');
        // a code another location has — said in the page, nothing sent
        await card(page).getByLabel('קוד סניף — ראשי').fill('15');
        await card(page).getByText('הקוד הזה כבר של סניף אחר.').first().waitFor();
        await card(page).scrollIntoViewIfNeeded();
        await shot(page, `${tag}3-numbering-after.png`);
      } finally { await ctx.close(); }
      // a document now: the main location's series
      const { ctx: c2, page: p2 } = await open('/finance/documents', view);
      try {
        await p2.getByRole('button', { name: '+ מסמך חדש' }).click({ timeout: 120_000 });
        const d = dialog(p2);
        await d.getByRole('radio', { name: 'חשבונית מס / קבלה' }).click();
        await d.getByLabel('תיאור שורה 1').fill('טיפול פנים');
        await d.getByLabel('מחיר שורה 1').fill('118');
        await d.getByRole('button', { name: 'הפקת חשבונית מס / קבלה' }).click();
        await p2.getByRole('heading', { name: 'חשבונית מס / קבלה 01000001' }).waitFor();
        const doc = fake.tables.documents.find((x: any) => x.doc_number === 1_000_001)!;
        assert.equal(doc.series_location_id, BIZ);
        await shot(p2, `${tag}4-doc-01000001.png`);
      } finally { await c2.close(); }
      // its code is fixed now
      const { ctx: c3, page: p3 } = await open('/finance/settings', view);
      try {
        await settingsReady(p3);
        await card(p3).getByText('לפי סניף', { exact: true }).waitFor({ timeout: 60_000 });
        await card(p3).getByText('נקבע', { exact: true }).waitFor();
        assert.equal(await card(p3).getByLabel('קוד סניף — ראשי').count(), 0, 'no field for a fixed code');
        await card(p3).getByText('01000002').waitFor();   // "הבא" of the main location's 320
      } finally { await c3.close(); }
    });

    await step(`${view}: a deposit issues its 420 — the number in the toast and the list, opened with no print / link, cancelled with it`, async () => {
      // the business switched in the step before; a fresh fake that did not, and one that did — the deposit's number follows
      fake = new FakeSupabase(seed({ locations: 2 }), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' });
      const { ctx, page } = await open('/finance/cash', view);
      try {
        await page.getByRole('button', { name: '+ הפקדה לבנק' }).click({ timeout: 120_000 });
        const d = dialog(page);
        await d.getByLabel('מזומן להפקדה').fill('300');
        await d.getByRole('button', { name: 'רישום ההפקדה' }).click();
        await page.getByText('הפקדה 1 נרשמה · הופקה הפקדת בנק מס׳ 1').waitFor();
        const doc = fake.tables.documents.find((x: any) => x.doc_type === 420)!;
        assert.ok(doc, 'a 420');
        assert.equal(Number(doc.total), 300); assert.equal(doc.customer_name, ''); assert.deepEqual(doc.lines, []);
        assert.deepEqual(doc.payments.map((p: any) => [p.method, p.amount]), [[1, 300]]);
        assert.equal(fake.tables.payments.filter((p: any) => p.document_id === doc.id).length, 0, 'it moves no money');
        await page.getByRole('tab', { name: 'הפקדות' }).click();
        const link = page.getByRole('link', { name: 'הפקדת בנק 1' });
        await link.waitFor();
        await shot(page, `${tag}5-deposit-doc.png`);
        await link.click();
        await page.getByRole('heading', { name: 'הפקדת בנק 1' }).waitFor({ timeout: 120_000 });
        const v = dialog(page);
        await v.getByText(/מסמך הפקדה \(הפקדת בנק\) הופק יחד עם ההפקדה/).waitFor();
        for (const name of ['הדפסת מקור', 'הדפסת העתק', '📄 PDF', '💬 שליחה ללקוח', 'ביטול מסמך', 'חשבונית זיכוי']) assert.equal(await v.getByRole('button', { name }).count(), 0, `no "${name}"`);
        await v.getByText('הפקדה לבנק — המזומן והצ׳קים שהופקדו').waitFor();
        await shot(page, `${tag}6-deposit-docview.png`);
      } finally { await ctx.close(); }
      // the overview's documents: the deposit is not one of them
      const { ctx: c2, page: p2 } = await open('/finance', view);
      try {
        await p2.getByText('מסמכים בתקופה').waitFor({ timeout: 120_000 });
        await p2.getByText(/חשבונית מס \/ קבלה · 1/).first().waitFor();
        assert.equal(await p2.getByText(/הפקדת בנק ·/).count(), 0, 'no 420 in the documents of the period');
      } finally { await c2.close(); }
      // cancelled with its deposit — never by itself
      const { ctx: c3, page: p3 } = await open('/finance/cash', view);
      try {
        await p3.getByRole('tab', { name: 'הפקדות' }).click({ timeout: 120_000 });
        await p3.getByRole('button', { name: 'ביטול ההפקדה' }).click();
        const d = dialog(p3);
        await d.getByText(/גם מסמך ההפקדה \(הפקדת בנק 1\) מסומן "בוטל"/).waitFor();
        await d.getByLabel('סיבה').fill('נרשמה בטעות');
        await d.getByRole('button', { name: 'ביטול ההפקדה' }).click();
        await p3.getByText('ההפקדה בוטלה — הכסף והצ׳קים חזרו לקופה').waitFor();
        const doc = fake.tables.documents.find((x: any) => x.doc_type === 420)!;
        assert.ok(fake.tables.document_cancellations.some((c: any) => c.document_id === doc.id), 'the 420 is cancelled with it');
        assert.ok(fake.tables.documents.some((x: any) => x.id === doc.id), 'and stays');
      } finally { await c3.close(); }
    });
  }

  await step('after the switch, a deposit of the second location is numbered in its series', async () => {
    fake = new FakeSupabase(seed({ locations: 2 }), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' });
    for (const l of fake.tables.business_locations) l.branch_code = l.id === BIZ ? '01' : '02';
    fake.numberingSince = new Date().toISOString();
    // cash at the second location
    fake.tables.payments.push({ id: 'd0000000-0000-4000-8000-000000000002', business_id: BIZ, user_id: OWNER, direction: 'in', amount: 200, method: 'cash', paid_on: TODAY, source: 'document',
      document_id: 'c0000000-0000-4000-8000-000000000001', applies_to: null, sale_id: null, lead_id: null, reference: {}, note: '', created_at: `${TODAY}T09:00:00Z`, location_id: LOC2 });
    const { ctx, page } = await open('/finance/cash', 'desktop');
    try {
      await page.getByRole('button', { name: '+ הפקדה לבנק' }).click({ timeout: 120_000 });
      const d = dialog(page);
      await d.getByLabel('סניף', { exact: true }).selectOption(LOC2);
      await d.getByLabel('מזומן להפקדה').fill('200');
      await d.getByRole('button', { name: 'רישום ההפקדה' }).click();
      await page.getByText('הופקה הפקדת בנק מס׳ 02000001').waitFor();
      assert.equal(fake.tables.documents.find((x: any) => x.doc_type === 420)?.series_location_id, LOC2);
    } finally { await ctx.close(); }
  });

  await browser.close();
  try { process.kill(-dev.pid!); } catch { /* gone */ }
  const relevant = errors.filter((e) => !/hydrat|ResizeObserver/i.test(e));
  if (relevant.length) console.log(`page errors:\n  ${relevant.slice(0, 5).join('\n  ')}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed`);
  process.exit(passed === results.length && !relevant.length ? 0 : 1);
}
void main().catch((e) => { console.error(e); process.exit(1); });
