/**
 * Stage 4ב — the books' core (2.121.0, migration 20261128007100) in a real browser, against the in-memory Supabase (the rules
 * themselves are proven on Postgres in tests/sql/books-core.check.sql and books-core-concurrency.sh):
 *   before migration 7100: no "ספרים" card in the money settings; a card payment in installments is issued with its count (the old
 *   database ignores the keys);
 *   after it: the card for the owner only — the start date, the opening balances not entered, the entries, what did not post; the
 *   move of the start to another month confirmed in the page (the documents since then post — then the date is fixed); a member who
 *   is not the owner sees nothing; "תשלומים" asks the number (required) and the first charge (optional, from the payment's day to a
 *   year after it) — sent as "installments" / "firstDue"; money back (a refund receipt) asks neither.
 *
 * Run: npx -y tsx tests/e2e/books-core.e2e.ts   (starts `next dev` on port 3247; needs the preinstalled Chromium)
 * Screenshots: BOOKS_SHOTS=<dir> (default tests/e2e/shots/books-core) — phone (iPhone 13) and computer (1280×800). BOOKS_ONLY=<part
 * of a step's name> runs one step. Demo data only: dealer number 000000109 (the fictitious range), example.test e-mails.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_BOOKS_PORT ?? 3247);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.BOOKS_SHOTS ?? path.join(__dirname, 'shots', 'books-core');
const BIZ = 'b0000000-0000-4000-8000-000000000071';
const OWNER = 'a0000000-0000-4000-8000-0000000000b7';
const DESKTOP = { width: 1280, height: 800 };
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const ddmm = (iso: string) => iso.split('-').reverse().join('/');
const monthStart = `${TODAY.slice(0, 7)}-01`;
const nextStart = (() => { const [y, m] = TODAY.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; })();
const addDays = (d: string, n: number) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  const issuer = { name: 'עסק דמו', dealerNumber: '000000109', entityType: 'licensed_dealer' };
  return {
    brands: [{ ...base, name: 'דמו', onboarded: true, industry: 'יופי', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'licensed_dealer', vat_rate: 18, pay_link: '', dealer_number: '000000109', legal_name: 'עסק דמו',
      street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [],
    business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }],
    // one receipt of today (it posts when the start moves to this month)
    documents: [{ ...base, id: 'c0000000-0000-4000-8000-000000000071', doc_type: 320, doc_number: 1, link_no: 1, issued_at: `${TODAY}T08:00:00Z`, doc_date: TODAY,
      customer_name: 'לקוחה דמו', customer_phone: '', customer_dealer: '', lead_id: null, before_discount: 500, discount: 0, after_discount: 500, vat_amount: 90, total: 590, vat_rate: 18,
      lines: [{ name: 'טיפול', qty: 1, unitPriceExVat: 500, discountExVat: 0, totalExVat: 500, vatRate: 18, kind: 1 }], payments: [{ method: 1, amount: 590, date: TODAY, m: 'cash' }],
      print_count: 1, share_token: '7'.repeat(64), issuer, source: 'direct', notes: '', base_doc_type: null, base_doc_number: null }],
    payments: [], catalog_items: [], employees: [], leads: [], sales: [], sale_refunds: [], stock_movements: [], register_shifts: [], appointments: [], booking_services: [],
    content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [], push_subscriptions: [],
    quotes: [], expenses: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [], tax_allocation_rules: [],
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
  const AXE_PATH = [path.join(ROOT, 'node_modules/axe-core/axe.min.js'), path.join(ROOT, '../storefront/node_modules/axe-core/axe.min.js')].find((f) => existsSync(f));
  const AXE = AXE_PATH ? readFileSync(AXE_PATH, 'utf8') : null;
  const axeFindings: string[] = [];
  const dev = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: 'http://sb.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-test-key', NEXT_TELEMETRY_DISABLED: '1' },
  });
  const results: { name: string; ok: boolean }[] = [];
  const browser = await (async () => { await waitForServer(dev); return chromium.launch(); })();
  for (const p of ['/finance', '/finance/documents', '/finance/settings']) for (let i = 0; i < 3; i++) { if (await fetch(`${BASE}${p}`).then((r) => r.ok, () => false)) break; }
  const errors: string[] = [];
  /** a fake of the seed — the seeded receipt is 320 no. 1, so the next one is 2 */
  const fresh = () => { const f = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' }); f.counters.set(320, 1); return f; };
  let fake = fresh();
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
  const card = (page: any) => page.getByRole('region', { name: 'ספרים', exact: true });
  const noSideScroll = async (page: any, what: string) => {
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw + 1, `${what}: the page scrolls sideways (${sw} > ${iw})`);
  };
  const axe = async (page: any, what: string) => {
    if (!AXE) return;
    await settle(page);
    await page.evaluate(AXE);
    const v = await page.evaluate(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }).then(r => r.violations.map(v => v.id + ' (' + v.impact + '): ' + v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')))`);
    for (const x of v as string[]) axeFindings.push(`${what}: ${x}`);
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    if (process.env.BOOKS_ONLY && !name.includes(process.env.BOOKS_ONLY)) return;
    try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false }); await lastPage?.screenshot({ path: path.join(SHOTS, `FAIL-${results.length}.png`) }).catch(() => undefined); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}`); }
  };
  /** a new 320 of 600 by card "תשלומים": the composer, up to the payment */
  const composeCard = async (page: any) => {
    await page.getByRole('button', { name: '+ מסמך חדש' }).click({ timeout: 120_000 });
    const d = dialog(page);
    await d.getByRole('radio', { name: 'חשבונית מס / קבלה' }).click();
    await d.getByLabel('תיאור שורה 1').fill('טיפול דמו');
    await d.getByLabel('מחיר שורה 1').fill('600');
    await d.getByLabel('אמצעי תשלום 1').selectOption('card');
    await d.getByRole('radio', { name: 'תשלומים', exact: true }).click();
    return d;
  };

  // ---- before migration 7100 ---------------------------------------------------------------------------------------------------
  await step('before 7100: no books card; a card payment in installments is issued with its count (the old database ignores it)', async () => {
    fake = fresh();
    fake.booksCore = false;
    const { ctx, page } = await open('/finance/settings', 'desktop');
    try {
      await settingsReady(page);
      await page.waitForTimeout(800);
      assert.equal(await card(page).count(), 0, 'no card before 7100');
      await page.goto(`${BASE}/finance/documents`, { waitUntil: 'domcontentloaded' });
      const d = await composeCard(page);
      await d.getByLabel('מספר תשלומים 1').fill('4');
      await d.getByRole('button', { name: 'הפקת חשבונית מס / קבלה' }).click();
      await page.getByRole('heading', { name: 'חשבונית מס / קבלה 2' }).waitFor();
      const doc = fake.tables.documents.find((x: any) => x.doc_number === 2)!;
      assert.deepEqual(doc.payments.map((p: any) => [p.method, p.cardKind, p.installments]), [[3, 2, 4]]);
    } finally { await ctx.close(); }
  });

  // ---- after it ----------------------------------------------------------------------------------------------------------------
  for (const view of ['phone', 'desktop'] as const) {
    const tag = view === 'phone' ? 'm' : 'd';
    await step(`${view}: the owner's books card — read only, then the start moved to this month (confirmed in the page) and fixed`, async () => {
      fake = fresh();
      const { ctx, page } = await open('/finance/settings', view);
      try {
        await settingsReady(page);
        const c = card(page);
        await c.waitFor({ timeout: 60_000 });
        await c.getByText(ddmm(nextStart)).waitFor();
        await c.getByText('(יתחילו בתאריך הזה)').waitFor();
        await c.getByText('עוד לא נרשמו').waitFor();
        await c.getByText(/פקודות שנרשמו:\s*0/).waitFor();
        await c.getByText(/ממתינים לרישום:\s*0/).waitFor();
        await c.scrollIntoViewIfNeeded();
        await shot(page, `${tag}1-books-card.png`);
        await noSideScroll(page, `${view} books card`);
        await axe(page, `${view} books card`);
        // a month after next — refused in the page (the database would refuse it too: books_start_date)
        const after = (() => { const [y, m] = nextStart.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; })();
        await c.getByLabel('חודש תחילת הספרים').fill(after);
        await c.getByText('תחילת הספרים — לכל המאוחר החודש הבא').waitFor();
        assert.ok(await c.getByRole('button', { name: 'הזזה…' }).isDisabled());
        // this month: confirmed in the page, then the receipt of today posts and the date is fixed
        await c.getByLabel('חודש תחילת הספרים').fill(monthStart.slice(0, 7));
        await c.getByRole('button', { name: 'הזזה…' }).click();
        const confirm = page.getByRole('region', { name: 'אישור הזזת תחילת הספרים' });
        await confirm.getByText(`להזיז את תחילת הספרים ל-${ddmm(monthStart)}?`).waitFor();
        await confirm.getByText('מה שכבר הופק מאז נרשם עכשיו — מיד אחרי האישור.').waitFor();
        await shot(page, `${tag}2-books-move-confirm.png`);
        await axe(page, `${view} books move confirm`);
        await confirm.getByRole('button', { name: `אישור — ${ddmm(monthStart)}` }).click();
        await page.getByText(`תחילת הספרים נשמרה: ${ddmm(monthStart)}. נרשמה פקודה אחת.`).waitFor();
        await c.getByText('כבר נרשמו פקודות בספרים — תאריך ההתחלה קבוע.').waitFor();
        await c.getByText(/פקודות שנרשמו:\s*1/).waitFor();
        await c.getByText('פעילים').waitFor();
        assert.equal(await c.getByLabel('חודש תחילת הספרים').count(), 0, 'no move once something posted');
        assert.ok(fake.tables.finance_audit_log.some((x: any) => x.action === 'books.start'), 'logged');
        await shot(page, `${tag}3-books-fixed.png`);
      } finally { await ctx.close(); }
    });

    await step(`${view}: "תשלומים" — the number required, the first charge optional (from the payment's day to a year after it)`, async () => {
      fake = fresh();
      const { ctx, page } = await open('/finance/documents', view);
      try {
        const d = await composeCard(page);
        await d.getByText(`2 עד 36 תשלומים.`).waitFor();
        await d.getByLabel('מספר תשלומים 1').fill('1');
        await d.getByText('בתשלומים — כמה תשלומים (2 עד 36)').first().waitFor();
        await d.getByLabel('מספר תשלומים 1').fill('6');
        await d.getByLabel('חיוב ראשון בתשלומים 1').fill(addDays(TODAY, 400));
        await d.getByText('מועד החיוב הראשון — מיום התשלום ועד שנה אחריו').first().waitFor();
        await d.getByRole('button', { name: 'הפקת חשבונית מס / קבלה' }).click();
        await d.getByText('מועד החיוב הראשון — מיום התשלום ועד שנה אחריו').first().waitFor();
        assert.equal(fake.tables.documents.length, 1, 'nothing issued');
        const first = addDays(TODAY, 10);
        await d.getByLabel('חיוב ראשון בתשלומים 1').fill(first);
        await d.getByText(`6 תשלומים, חודש אחרי חודש — הראשון ב-${ddmm(first)}.`).waitFor();
        await noSideScroll(page, `${view} installments`);
        await shot(page, `${tag}4-installments.png`);
        await axe(page, `${view} installments`);
        await d.getByRole('button', { name: 'הפקת חשבונית מס / קבלה' }).click();
        await page.getByRole('heading', { name: 'חשבונית מס / קבלה 2' }).waitFor();
        const doc = fake.tables.documents.find((x: any) => x.doc_number === 2)!;
        assert.deepEqual(doc.payments.map((p: any) => [p.method, p.cardKind, p.installments, p.firstDue]), [[3, 2, 6, first]]);
        // the kind changed to "רגיל" — the count is not sent (the database refuses it: installments_card_only)
        await page.goto(`${BASE}/finance/documents`, { waitUntil: 'domcontentloaded' });
        const d2 = await composeCard(page);
        await d2.getByLabel('מספר תשלומים 1').fill('3');
        await d2.getByRole('radio', { name: 'רגיל', exact: true }).click();
        assert.equal(await d2.getByLabel('מספר תשלומים 1').count(), 0);
        await d2.getByRole('button', { name: 'הפקת חשבונית מס / קבלה' }).click();
        await page.getByRole('heading', { name: 'חשבונית מס / קבלה 3' }).waitFor();
        const doc3 = fake.tables.documents.find((x: any) => x.doc_number === 3)!;
        assert.deepEqual(doc3.payments.map((p: any) => [p.cardKind, 'installments' in p, 'firstDue' in p]), [[1, false, false]]);
      } finally { await ctx.close(); }
    });
  }

  await step('a member who is not the owner: no books card', async () => {
    fake = fresh();
    fake.owner = false;
    const { ctx, page } = await open('/finance/settings', 'desktop');
    try {
      await settingsReady(page);
      await page.waitForTimeout(1200);
      assert.equal(await card(page).count(), 0);
    } finally { await ctx.close(); }
  });

  await browser.close();
  try { process.kill(-dev.pid!); } catch { /* gone */ }
  const relevant = errors.filter((e) => !/hydrat|ResizeObserver/i.test(e));
  if (relevant.length) console.log(`page errors:\n  ${relevant.slice(0, 5).join('\n  ')}`);
  console.log(axeFindings.length ? `\naxe: ${axeFindings.length} finding(s)\n${[...new Set(axeFindings)].join('\n')}` : (AXE ? '\naxe: no WCAG A/AA violation on these screens' : '\naxe: not run (axe-core not found)'));
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed`);
  // axe is reported, as in cpa-stage1.e2e.ts (the app's own colours — the primary chips and buttons — are not of this change)
  process.exit(passed === results.length && !relevant.length ? 0 : 1);
}
void main().catch((e) => { console.error(e); process.exit(1); });
