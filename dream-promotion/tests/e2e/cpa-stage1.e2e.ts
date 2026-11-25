/**
 * Stage 1 of the accountant's answers (2.118.0) in a real browser, against the in-memory Supabase (the rules themselves are proven on
 * Postgres in tests/sql/cpa-rules-stage1.check.sql): the document date read-only, a card payment's required kind (field 1315),
 * a receipt that is never cancelled, an exempt dealer's refund receipt (never beyond the receipt), the deductions-file field of the
 * settings (shown only when the column exists — an "old database" answers 400 for it), and axe on the same screens.
 *
 * Run: npx tsx tests/e2e/cpa-stage1.e2e.ts   (starts `next dev` on port 3231; needs the preinstalled Chromium)
 * Screenshots: CPA_SHOTS=<dir> (default tests/e2e/shots/cpa-stage1) — phone (iPhone 13) and computer (1280×800).
 * Demo data only: dealer number 000000018 (a valid check digit, the fictitious range), example.test e-mails.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_CPA_PORT ?? 3231);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.CPA_SHOTS ?? path.join(__dirname, 'shots', 'cpa-stage1');
const BIZ = 'b0000000-0000-4000-8000-000000000002';
const OWNER = 'a0000000-0000-4000-8000-0000000000a2';
const DESKTOP = { width: 1280, height: 800 };

function seed(entity: string): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  return {
    brands: [{ ...base, name: 'דמו', onboarded: true, industry: 'יופי', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: entity === 'exempt_dealer' ? 'exempt' : 'licensed', entity_type: entity, vat_rate: entity === 'exempt_dealer' ? 0 : 18, pay_link: '',
      dealer_number: '000000018', legal_name: 'עסק דמו', street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [], catalog_items: [], employees: [], leads: [],
    sales: [], documents: [], sale_refunds: [], stock_movements: [], register_shifts: [], appointments: [], booking_services: [],
    content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [], push_subscriptions: [],
    payments: [], quotes: [], expenses: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [],
    tax_allocation_rules: [],
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
  for (const p of ['/finance', '/finance/documents', '/finance/settings']) for (let i = 0; i < 3; i++) { if (await fetch(`${BASE}${p}`).then((r) => r.ok, () => false)) break; }
  // axe-core lives in the storefront's node_modules (the dashboard has none): a missing file fails with how to get it
  const AXE_PATH = [path.join(ROOT, 'node_modules/axe-core/axe.min.js'), path.join(ROOT, '../storefront/node_modules/axe-core/axe.min.js')].find((f) => existsSync(f));
  if (!AXE_PATH) throw new Error('axe-core not found — run `npm ci` in storefront/ (the dashboard borrows its axe.min.js)');
  const AXE = readFileSync(AXE_PATH, 'utf8');
  const errors: string[] = [];
  const axeFindings: string[] = [];
  let fake = new FakeSupabase(seed('company'), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' });
  let lastPage: any = null;   // a failing step leaves a screenshot of it
  let oldDb = false;   // the database before migration 6800: the deductions column does not exist

  async function open(p: string, view: 'phone' | 'desktop') {
    const ctx = await browser.newContext(view === 'desktop'
      ? { viewport: DESKTOP, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' }
      : { ...IPHONE, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@example.test'))]);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    await ctx.route('http://sb.test/**', async (route: any) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (oldDb && /deductions_file/.test(req.url() + (req.postData() ?? ''))) {
        return route.fulfill({ status: 400, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ code: '42703', message: 'column register_settings.deductions_file does not exist' }) });
      }
      fake.opts.userId = OWNER;
      const r = fake.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
      return route.fulfill({ status: r.status, body: r.body ?? '', headers: { ...(r.headers ?? {}), ...cors } });
    });
    const entity = fake.tables.register_settings[0].entity_type;
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'דמו', state: 'active' }, businesses: [{ id: BIZ, name: 'דמו', state: 'active' }], superAdmin: false, access: 'full' } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
    await ctx.route(`${BASE}/api/finance/tax/status`, (r: any) => r.fulfill({ json: { mode: 'unconfigured', configured: false, connection: null, message: '' } }));
    void entity;
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
  const noSideScroll = async (page: any, what: string) => {
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw + 1, `${what}: the page scrolls sideways (${sw} > ${iw})`);
  };
  const axe = async (page: any, what: string) => {
    await settle(page);
    await page.evaluate(AXE);
    const v = await page.evaluate(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }).then(r => r.violations.map(v => v.id + ' (' + v.impact + '): ' + v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')))`);
    for (const x of v as string[]) axeFindings.push(`${what}: ${x}`);
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    if (process.env.CPA_ONLY && !name.includes(process.env.CPA_ONLY)) return;   // debugging: one step by a part of its name
    try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false }); await lastPage?.screenshot({ path: path.join(SHOTS, `FAIL-${results.length}.png`) }).catch(() => undefined); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}`); }
  };
  const ddmm = (iso: string) => iso.split('-').reverse().join('/');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

  for (const view of ['phone', 'desktop'] as const) {
    const tag = view === 'phone' ? 'm' : 'd';
    fake = new FakeSupabase(seed('company'), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' });
    oldDb = false;

    await step(`${view}: the composer — the date is read-only (today), a card payment must name its kind`, async () => {
      const { ctx, page } = await open('/finance/documents', view);
      try {
        await page.getByRole('button', { name: '+ מסמך חדש' }).click();
        const d = dialog(page);
        await d.getByRole('radio', { name: 'חשבונית מס / קבלה' }).click();
        await d.getByLabel('תיאור שורה 1').fill('טיפול פנים');
        await d.getByLabel('מחיר שורה 1').fill('118');
        // the date: text, not an input — and it is today's
        await d.getByText(ddmm(today)).first().waitFor();
        assert.equal(await d.getByLabel('תאריך המסמך').count(), 0, 'no date input for the document');
        assert.equal(await d.locator('input[type=date]').evaluateAll((els: HTMLInputElement[]) => els.filter((e) => !/תשלום|פירעון/.test(e.getAttribute('aria-label') ?? '')).length), 0, 'the only dates left are payments\'');
        await d.getByText('(יום ההפקה — תמיד היום)').scrollIntoViewIfNeeded();
        await shot(page, `${tag}1-composer-date.png`);
        await axe(page, `${view} composer`);
        // a card payment without a kind
        await d.getByLabel('אמצעי תשלום 1').selectOption('card');
        await d.getByRole('radiogroup', { name: /סוג עסקת האשראי/ }).waitFor();
        await d.getByText('בוחרים לפני ההפקה').waitFor();
        await d.getByRole('button', { name: 'הפקת חשבונית מס / קבלה' }).click();
        await d.getByText(/בתשלום בכרטיס אשראי בוחרים את סוג העסקה/).waitFor();
        assert.equal(fake.tables.documents.length, 0, 'nothing issued without the kind');
        await noSideScroll(page, 'composer card');
        await shot(page, `${tag}2-payments-card-kind-missing.png`);
        await axe(page, `${view} composer card kind missing`);
        // choose "תשלומים" → issued with cardKind 2
        await d.getByRole('radio', { name: 'תשלומים', exact: true }).click();
        await shot(page, `${tag}3-payments-card-kind-chosen.png`);
        await d.getByRole('button', { name: 'הפקת חשבונית מס / קבלה' }).click();
        await page.getByRole('heading', { name: 'חשבונית מס / קבלה 1' }).waitFor();
        const doc = fake.tables.documents[0];
        assert.equal(doc.doc_date, today);
        assert.deepEqual(doc.payments.map((p: any) => [p.method, p.cardKind]), [[3, 2]]);
        // a payment that is not a card carries no kind (switch card → cash after choosing)
      } finally { await ctx.close(); }
    });

    await step(`${view}: a payment switched from card to cash drops its kind — the database would refuse a kind on cash`, async () => {
      const { ctx, page } = await open('/finance/documents', view);
      try {
        await page.getByRole('button', { name: '+ מסמך חדש' }).click();
        const d = dialog(page);
        await d.getByRole('radio', { name: 'חשבונית מס / קבלה' }).click();
        await d.getByLabel('תיאור שורה 1').fill('טיפול');
        await d.getByLabel('מחיר שורה 1').fill('59');
        await d.getByLabel('אמצעי תשלום 1').selectOption('card');
        await d.getByRole('radio', { name: 'קרדיט', exact: true }).click();
        await d.getByLabel('אמצעי תשלום 1').selectOption('bit');
        await d.getByRole('button', { name: 'הפקת חשבונית מס / קבלה' }).click();
        await page.getByRole('heading', { name: 'חשבונית מס / קבלה 2' }).waitFor();
        const doc = fake.tables.documents.find((x) => x.doc_number === 2)!;
        assert.deepEqual(doc.payments.map((p: any) => [p.method, p.m, p.cardKind ?? null]), [[4, 'bit', null]], 'Bit is code 4, no kind');
      } finally { await ctx.close(); }
    });

    await step(`${view}: a receipt of a VAT business — no cancel, no money-back button`, async () => {
      // a 305 invoice, then a receipt on it, through the screens
      const { ctx, page } = await open('/finance/documents', view);
      try {
        await page.getByRole('button', { name: '+ מסמך חדש' }).click();
        let d = dialog(page);
        await d.getByRole('radio', { name: 'חשבונית מס', exact: true }).click();
        await d.getByLabel('שם הלקוח').fill('לקוחה לדוגמה').catch(() => undefined);
        await d.getByLabel('תיאור שורה 1').fill('ייעוץ');
        await d.getByLabel('מחיר שורה 1').fill('118');
        await d.getByRole('button', { name: 'הפקת חשבונית מס' }).click();
        await page.getByRole('heading', { name: /חשבונית מס \d+/ }).waitFor();
        await dialog(page).getByRole('button', { name: 'קבלה על תשלום' }).click();
        await dialog(page).getByRole('button', { name: 'הפקת קבלה' }).click();
        await page.getByText(/הופקה קבלה מס׳ 1/).waitFor();
        const rec = fake.tables.documents.find((x) => x.doc_type === 400)!;
        assert.ok(rec, 'a receipt exists');
        // open it from the list
        for (let i = 0; i < 2 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
        await page.getByText(/^קבלה 1 · /).first().click();
        d = dialog(page);
        await d.getByRole('heading', { name: /קבלה 1/ }).waitFor();
        assert.equal(await d.getByRole('button', { name: 'ביטול מסמך' }).count(), 0, 'no cancel on a receipt');
        assert.equal(await d.getByRole('button', { name: 'החזר כספי' }).count(), 0, 'a VAT business credits (330), no refund receipt');
        await d.getByText(/לא מאפשרת לשנות, למחוק או לבטל קבלה/).waitFor();
        await noSideScroll(page, 'receipt doc view');
        await shot(page, `${tag}4-docview-receipt-no-cancel.png`);
        await axe(page, `${view} receipt docview`);
      } finally { await ctx.close(); }
    });

    // ---- an exempt dealer -------------------------------------------------------------------------------------------------
    fake = new FakeSupabase(seed('exempt_dealer'), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' });
    // the fake's goodsCheck (fake-supabase.ts) still refuses every non-credit document with a base ("only a credit invoice points to a base
    // document") — migration 6800 lets a refund receipt (a 400 below zero on a 400) through; mirrored here, reported to the brain
    { const f: any = fake; const orig = f.goodsCheck.bind(f); f.goodsCheck = (r: any) => (r.doc_type === 400 && Number(r.total) < 0 && r.base_doc_type === 400 ? null : orig(r)); }
    await step(`${view}: an exempt dealer — a receipt, "החזר כספי", never beyond the receipt, a negative receipt that can not be refunded again`, async () => {
      const { ctx, page } = await open('/finance/documents', view);
      try {
        await page.getByRole('button', { name: '+ מסמך חדש' }).click();
        let d = dialog(page);
        await d.getByRole('radio', { name: 'קבלה', exact: true }).click();
        await d.getByLabel('תיאור שורה 1').fill('טיפול');
        await d.getByLabel('מחיר שורה 1').fill('200');
        await d.getByRole('button', { name: 'הפקת קבלה' }).click();
        await page.getByRole('heading', { name: 'קבלה 1' }).waitFor();
        d = dialog(page);
        assert.equal(await d.getByRole('button', { name: 'ביטול מסמך' }).count(), 0, 'no cancel');
        await d.getByRole('button', { name: 'החזר כספי' }).waitFor();
        await shot(page, `${tag}5-docview-exempt-receipt.png`);
        await axe(page, `${view} exempt receipt docview`);
        await d.getByRole('button', { name: 'החזר כספי' }).click();
        const r = dialog(page);
        await r.getByRole('heading', { name: /החזר כספי על קבלה 1/ }).waitFor();
        await noSideScroll(page, 'refund dialog');
        await shot(page, `${tag}6-refund-dialog.png`);
        await axe(page, `${view} refund dialog`);
        // more than the receipt → refused, nothing written
        await r.getByLabel('סכום תשלום 1').fill('250');
        await r.getByRole('button', { name: 'הפקת קבלה במינוס' }).click();
        await r.getByText(/ההחזר גדול ממה שנשאר להחזיר/).waitFor();
        assert.equal(fake.tables.documents.filter((x) => Number(x.total) < 0).length, 0);
        await shot(page, `${tag}7-refund-over-refused.png`);
        // a card refund without its kind → refused
        await r.getByLabel('סכום תשלום 1').fill('80');
        await r.getByLabel('אמצעי תשלום 1').selectOption('card');
        await r.getByRole('button', { name: 'הפקת קבלה במינוס' }).click();
        await r.getByText(/בוחרים את סוג העסקה/).waitFor();
        await r.getByRole('radio', { name: 'רגיל', exact: true }).click();
        await r.getByRole('button', { name: 'הפקת קבלה במינוס' }).click();
        await page.getByText(/הופקה קבלה במינוס/).waitFor({ timeout: 8000 }).catch(async (e: Error) => { console.log('DIALOG:', (await r.innerText()).slice(0, 700)); throw e; });
        let neg = fake.tables.documents.filter((x) => Number(x.total) < 0);
        assert.equal(neg.length, 1);
        assert.deepEqual([neg[0].doc_type, neg[0].total, neg[0].base_doc_type, neg[0].base_doc_number, neg[0].vat_amount, neg[0].discount], [400, -80, 400, 1, 0, 0]);
        assert.deepEqual(neg[0].payments.map((p: any) => [p.method, p.amount, p.cardKind]), [[3, -80, 1]]);
        // the second refund: only 120 left
        for (let i = 0; i < 2 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
        await page.getByText(/^קבלה 1 · /).first().click();
        d = dialog(page);
        await d.getByRole('heading', { name: /קבלה 1/ }).waitFor();
        await d.getByRole('button', { name: 'החזר כספי' }).click();
        const r2 = dialog(page);
        await r2.getByText(/אפשר להחזיר עד ₪120/).waitFor();
        await r2.getByLabel('סכום תשלום 1').fill('120.01');
        await r2.getByRole('button', { name: 'הפקת קבלה במינוס' }).click();
        await r2.getByText(/ההחזר גדול ממה שנשאר להחזיר/).waitFor();
        await r2.getByLabel('סכום תשלום 1').fill('120');
        await r2.getByRole('button', { name: 'הפקת קבלה במינוס' }).click();
        await page.getByText(/הופקה קבלה במינוס/).waitFor();
        neg = fake.tables.documents.filter((x) => Number(x.total) < 0);
        assert.equal(neg.reduce((a, x) => a - Number(x.total), 0), 200, 'refunds add up to exactly the receipt, never more');
        // all given back: the button is gone, and a negative receipt itself has no refund / cancel
        for (let i = 0; i < 2 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
        await page.getByText(/^קבלה 1 · /).first().click();
        d = dialog(page);
        await d.getByRole('heading', { name: /קבלה 1/ }).waitFor();
        assert.equal(await d.getByRole('button', { name: 'החזר כספי' }).count(), 0, 'nothing left to refund');
        assert.equal(await d.getByRole('button', { name: 'ביטול מסמך' }).count(), 0);
        for (let i = 0; i < 2 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
        await shot(page, `${tag}8-documents-list-after-refunds.png`);
        await page.getByText(/^קבלה 2 · /).first().click();
        d = dialog(page);
        await d.getByRole('heading', { name: /קבלה 2/ }).waitFor();
        assert.equal(await d.getByRole('button', { name: 'החזר כספי' }).count(), 0, 'a refund receipt is not refunded');
        assert.equal(await d.getByRole('button', { name: 'ביטול מסמך' }).count(), 0, 'a refund receipt is not cancelled');
        await d.getByText(/החזר כספי על קבלה 1/).first().waitFor();
        await noSideScroll(page, 'refund receipt doc view');
        await shot(page, `${tag}9-docview-refund-receipt.png`);
      } finally { await ctx.close(); }
    });

    for (const old of [false, true]) {
      await step(`${view}: settings — the deductions-file field ${old ? 'is hidden on an old database and saving still works' : 'shown, 9 digits, saved'}`, async () => {
        fake = new FakeSupabase(seed('company'), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' });
        oldDb = old;
        const { ctx, page } = await open('/finance/settings', view);
        try {
          await page.getByLabel('מספר עוסק / ח.פ (9 ספרות)').or(page.getByLabel('ח.פ / מספר עוסק (9 ספרות)')).first().waitFor();
          // not getByLabel: Field can not tie its <label> to an input that has a hint beside it (reported — the input has no accessible name)
          const f = page.locator('div.mb-4:has(> label:text-is("מספר תיק ניכויים (9 ספרות, אם יש)")) input');
          if (old) {
            await page.waitForTimeout(1500);
            assert.equal(await f.count(), 0, 'hidden before the migration');
          } else {
            await f.waitFor({ timeout: 8000 }).catch(async (e: Error) => { await page.screenshot({ path: path.join(SHOTS, 'FAIL-settings.png'), fullPage: true }); console.log((await page.locator('body').innerText()).slice(0, 600)); throw e; });
            await f.scrollIntoViewIfNeeded();
            await f.fill('12345');
            await page.getByRole('button', { name: /^שמירה|שמירת/ }).first().click();
            await page.getByText('מספר תיק ניכויים — 9 ספרות (או ריק)').first().waitFor();
            await f.fill('000000026');
            await noSideScroll(page, 'settings');
            await shot(page, `${tag}10-settings-deductions.png`);
            await f.locator('xpath=ancestor::div[contains(@class,"grid")][1]').screenshot({ path: path.join(SHOTS, `${tag}10b-settings-deductions-field.png`) });
            await axe(page, `${view} settings`);
          }
          await page.getByRole('button', { name: /^שמירה|שמירת/ }).first().click();
          await page.getByText(/נשמר/).first().waitFor();
          const row = fake.tables.register_settings[0];
          if (old) assert.ok(!('deductions_file' in row), 'the old database never receives the column');
          else assert.equal(row.deductions_file, '000000026');
        } finally { await ctx.close(); }
      });
    }
  }

  await step('no errors in the browser', async () => { assert.deepEqual(errors, []); });
  console.log(axeFindings.length ? `\naxe: ${axeFindings.length} finding(s)\n${[...new Set(axeFindings)].join('\n')}` : '\naxe: no WCAG A/AA violation on these screens');
  await browser.close();
  try { process.kill(-dev.pid!, 'SIGTERM'); } catch { dev.kill('SIGTERM'); }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n# e2e cpa-stage1: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
