/**
 * Stage 4ד — "הנהלת חשבונות" (2.123.0, the screens over migration 20261129007200) in a real browser, against the in-memory Supabase
 * (fake-books.ts mirrors the reports and the owner's functions; the rules themselves are proven on Postgres in
 * tests/sql/books-more.check.sql):
 *   before 7200: no menu item, the route says what is missing;
 *   the owner, phone and computer: מאזן בוחן (by code, balanced) → a ledger (running balance, a document opens its screen), יומן (lines,
 *   a manual entry reversed once), רווח והפסד, מאזן (as of a day, balanced), לוח חשבונות (add / rename / deactivate, Hebrew refusals),
 *   פקודה ידנית (the live balance, D / C lines), יתרות פתיחה (once — a customer by its card, an existing supplier), התאמה (differences
 *   marked); CSV of a report; no page scrolls sideways at 390px; axe on every view;
 *   a member who is not the owner: the reports only (no owner forms); with empty books — not in the menu.
 *
 * Run: npx -y tsx tests/e2e/books-screens.e2e.ts   (starts `next dev` on port 3248; needs the preinstalled Chromium)
 * Screenshots: BOOKS4_SHOTS=<dir> (default tests/e2e/shots/books-screens). BOOKS4_ONLY=<part of a step's name> runs one step.
 * Demo data only: dealer number 000000109 (the fictitious range), example.test e-mails.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';
import { glSeed } from './fake-books';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_BOOKS4_PORT ?? 3248);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.BOOKS4_SHOTS ?? path.join(__dirname, 'shots', 'books-screens');
const BIZ = 'b0000000-0000-4000-8000-000000000072';
const OWNER = 'a0000000-0000-4000-8000-0000000000b8';
const DOC = 'c0000000-0000-4000-8000-000000000072';
const LEAD = 'f0000000-0000-4000-8000-000000000072';
const DESKTOP = { width: 1280, height: 800 };
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const MONTH_START = `${TODAY.slice(0, 7)}-01`;

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  const issuer = { name: 'עסק דמו', dealerNumber: '000000109', entityType: 'licensed_dealer' };
  return {
    brands: [{ ...base, name: 'דמו', onboarded: true, industry: 'יופי', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'licensed_dealer', vat_rate: 18, pay_link: '', dealer_number: '000000109', legal_name: 'עסק דמו',
      street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [],
    business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }],
    documents: [{ ...base, id: DOC, doc_type: 320, doc_number: 1, link_no: 1, issued_at: `${TODAY}T08:00:00Z`, doc_date: TODAY,
      customer_name: 'לקוחה דמו', customer_phone: '0501234567', customer_dealer: '', lead_id: null, before_discount: 500, discount: 0, after_discount: 500, vat_amount: 90, total: 590,
      vat_rate: 18, lines: [{ name: 'טיפול', qty: 1, unitPriceExVat: 500, discountExVat: 0, totalExVat: 500, vatRate: 18, kind: 1 }],
      payments: [{ method: 1, amount: 590, date: TODAY, m: 'cash' }], print_count: 1, share_token: '8'.repeat(64), issuer, source: 'direct', notes: '',
      base_doc_type: null, base_doc_number: null }],
    leads: [{ ...base, id: LEAD, name: 'לקוח פתיחה דמו', phone: '0529999999', source: 'ידני', status: 'חדש', date: '2026-01-01', tags: [], value: 0, notes: '' }],
    payments: [], catalog_items: [], employees: [], sales: [], sale_refunds: [], stock_movements: [], register_shifts: [], appointments: [], booking_services: [],
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
  for (const p of ['/finance', '/finance/books', '/finance/documents', '/finance/journal']) for (let i = 0; i < 3; i++) { if (await fetch(`${BASE}${p}`).then((r) => r.ok, () => false)) break; }
  const errors: string[] = [];
  /** the books started this month, with three entries (a receipt-invoice of today, an expense, a manual one) */
  const fresh = (o: { books?: boolean } = {}) => {
    const f = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' });
    f.counters.set(320, 1);
    f.booksStart = MONTH_START;
    f.booksShowScreens = true;                         // 7300: the owner turned the screens on
    if (o.books !== false) glSeed(f as any, { date: TODAY, docId: DOC });
    return f;
  };
  let fake = fresh();
  let lastPage: any = null;

  async function open(p: string, view: 'phone' | 'desktop') {
    const ctx = await browser.newContext(view === 'desktop'
      ? { viewport: DESKTOP, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', acceptDownloads: true }
      : { ...IPHONE, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', acceptDownloads: true });
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
  const shot = async (page: any, name: string, full = true) => { await settle(page); await page.screenshot({ path: path.join(SHOTS, name), fullPage: full }); };
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
    if (process.env.BOOKS4_ONLY && !name.includes(process.env.BOOKS4_ONLY)) return;
    try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false }); await lastPage?.screenshot({ path: path.join(SHOTS, `FAIL-${results.length}.png`) }).catch(() => undefined); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}`); }
  };
  const views = (page: any) => page.getByRole('group', { name: 'הנהלת חשבונות — מה להציג' });
  const view = (page: any, label: string) => views(page).getByRole('button', { name: label, exact: true }).click();
  const ready = (page: any) => views(page).waitFor({ timeout: 120_000 });
  const entry = (page: any, n: number) => page.locator(`li[data-entry="${n}"]`).first();

  await step('before 7200: the route says what is missing; no menu item', async () => {
    fake = fresh({ books: false });
    fake.booksMore = false;
    const { ctx, page } = await open('/finance/books', 'desktop');
    try {
      await page.getByText('הנהלת החשבונות תופיע כאן אחרי עדכון המסד (מיגרציה 20261129007200).').waitFor({ timeout: 120_000 });
      await page.waitForTimeout(800);
      assert.equal(await page.locator('a[href="/finance/books"]').count(), 0, 'no menu link');
    } finally { await ctx.close(); fake.booksMore = true; }
  });

  for (const v of ['desktop', 'phone'] as const) {
    await step(`${v}: מאזן בוחן by code → כרטסת with a running balance → the document opens`, async () => {
      fake = fresh();
      const { ctx, page } = await open('/finance/books', v);
      try {
        await ready(page);
        if (v === 'desktop') assert.ok(await page.locator('a[href="/finance/books"]').count() > 0, 'the menu link (the owner)');
        const tb = page.getByRole('list', { name: 'מאזן בוחן לפי קוד' });
        await tb.waitFor();
        await page.getByText('מאוזן', { exact: true }).first().waitFor();
        await tb.locator('li[data-tb="CUSTOMERS"]').getByText('לקוחות', { exact: false }).first().waitFor();
        await tb.locator('li[data-tb="1100"]').waitFor();
        await noSideScroll(page, `${v} trial balance`);
        await shot(page, `${v}-1-trial-balance.png`);
        await axe(page, `${v} trial balance`);
        // the receivables' group → a customer's ledger
        await tb.locator('li[data-tb="1100"]').getByRole('button', { name: /1100 · קופת מזומן/ }).click();
        await page.getByText('1100 · קופת מזומן — ראשי', { exact: false }).first().waitFor();
        await page.getByRole('list', { name: 'תנועות הכרטסת' }).waitFor();
        await page.getByText(/יתרה\s*₪590/).first().waitFor();
        // the ledger of 1300 — every customer; its line's document opens the document's screen
        const acc = page.getByLabel('חשבון לכרטסת');
        await acc.fill('1300');
        await page.getByRole('button', { name: 'הצגה' }).click();
        await page.getByText('1300 · לקוחות', { exact: false }).first().waitFor();
        await page.getByText('0501234567 · לקוחה דמו').first().waitFor();
        await noSideScroll(page, `${v} ledger`);
        await shot(page, `${v}-2-ledger.png`);
        await axe(page, `${v} ledger`);
        await page.getByRole('button', { name: 'חשבונית מס / קבלה 1' }).first().click();
        await page.waitForURL(new RegExp(`/finance/documents\\?open=${DOC}`), { timeout: 60_000 });
      } finally { await ctx.close(); }
    });

    await step(`${v}: יומן with lines; a manual entry reversed once`, async () => {
      fake = fresh();
      const { ctx, page } = await open('/finance/books', v);
      try {
        await ready(page);
        await view(page, 'יומן');
        await entry(page, 1).waitFor();
        await entry(page, 1).getByRole('table', { name: 'שורות פקודה 1' }).waitFor();
        await entry(page, 2).getByText('S-000000109 · ספק דמו').waitFor();
        await entry(page, 2).getByText('INV-7').waitFor();
        assert.equal(await entry(page, 1).getByRole('button', { name: 'פקודה הפוכה' }).count(), 0, 'a document\'s entry is corrected at its source');
        await noSideScroll(page, `${v} journal`);
        await shot(page, `${v}-3-journal.png`);
        await axe(page, `${v} journal`);
        await entry(page, 3).getByRole('button', { name: 'פקודה הפוכה' }).click();
        const d = page.getByRole('dialog').last();
        await d.getByText('פקודה הפוכה לפקודה 3').waitFor();
        if (v === 'phone') { await noSideScroll(page, 'phone reverse'); await shot(page, 'phone-4-reverse.png', false); }
        await d.getByRole('button', { name: 'רישום הפקודה ההפוכה' }).click();
        await page.getByText('פקודה 4 הופכת את פקודה 3').first().waitFor();
        await entry(page, 4).getByText('הופכת את פקודה 3').waitFor();
        await entry(page, 3).getByText('בוטלה בפקודה 4').waitFor();
        assert.equal(await entry(page, 3).getByRole('button', { name: 'פקודה הפוכה' }).count(), 0, 'once');
        assert.equal(await entry(page, 4).getByRole('button', { name: 'פקודה הפוכה' }).count(), 0, 'a reversal is not reversed');
        const rev = fake.tables.gl_transactions.find((x: any) => x.number === 4)!;
        assert.equal(rev.details, 'ביטול פקודה 3');
      } finally { await ctx.close(); }
    });

    await step(`${v}: רווח והפסד and מאזן (as of a day, balanced, the earnings line)`, async () => {
      fake = fresh();
      const { ctx, page } = await open('/finance/books', v);
      try {
        await ready(page);
        await view(page, 'רווח והפסד');
        await page.getByText('4100 · הכנסות משירותים').first().waitFor();
        await page.getByText(/סה״כ הוצאות/).first().waitFor();
        await page.getByText('₪350', { exact: true }).first().waitFor();          // 500 − 100 − 50
        await noSideScroll(page, `${v} profit and loss`);
        await shot(page, `${v}-5-profit-loss.png`);
        await axe(page, `${v} profit and loss`);
        await view(page, 'מאזן');
        await page.getByLabel('מאזן נכון ליום').waitFor();
        await page.getByText('רווח (הפסד) שטרם נסגר').first().waitFor();
        await page.getByText('מאוזן', { exact: true }).first().waitFor();
        await noSideScroll(page, `${v} balance sheet`);
        await shot(page, `${v}-6-balance-sheet.png`);
        await axe(page, `${v} balance sheet`);
      } finally { await ctx.close(); }
    });

    await step(`${v}: לוח חשבונות — add, a refusal in Hebrew, rename, deactivate; system accounts stay`, async () => {
      fake = fresh();
      const { ctx, page } = await open('/finance/books', v);
      try {
        await ready(page);
        await view(page, 'לוח חשבונות');
        const list = page.getByRole('list', { name: 'לוח החשבונות' });
        await list.locator('li[data-account="6112"]').waitFor();
        assert.equal(await list.locator('li[data-account="0501234567"]').count(), 0, 'customers only when asked');
        assert.equal(await list.locator('li[data-account="6112"]').getByRole('button', { name: /הסרה מהשימוש/ }).count(), 0, 'a system account is never removed');
        await noSideScroll(page, `${v} chart`);
        await shot(page, `${v}-7-chart.png`);
        await axe(page, `${v} chart`);
        await page.getByRole('button', { name: '+ חשבון חדש' }).click();
        const d = page.getByRole('dialog').last();
        await d.getByLabel('מפתח').fill('6112');
        await d.getByLabel('שם החשבון').fill('הדרכות צוות');
        await d.getByLabel('סוג').selectOption('expense');
        await d.getByRole('button', { name: 'הוספת החשבון' }).click();
        await d.getByText('המפתח 6112 שמור לחשבון של המערכת — בוחרים מפתח אחר.').waitFor();
        await d.getByLabel('מפתח').fill('6130');
        if (v === 'phone') await shot(page, 'phone-8-account-new.png', false);
        await d.getByRole('button', { name: 'הוספת החשבון' }).click();
        await page.getByText('החשבון 6130 נוסף').first().waitFor();
        await list.locator('li[data-account="6130"]').getByRole('button', { name: '6130 · הדרכות צוות', exact: true }).waitFor();
        await list.locator('li[data-account="6130"]').getByRole('button', { name: 'עריכת 6130' }).click();
        const e = page.getByRole('dialog').last();
        await e.getByLabel('שם החשבון').fill('הדרכות');
        await e.getByRole('button', { name: 'שמירה' }).click();
        await list.locator('li[data-account="6130"]').getByRole('button', { name: '6130 · הדרכות', exact: true }).waitFor();
        await list.locator('li[data-account="6130"]').getByRole('button', { name: 'הסרה מהשימוש 6130' }).click();
        await list.locator('li[data-account="6130"]').getByText('לא פעיל').waitFor();
        assert.equal(fake.tables.gl_accounts.find((a: any) => a.key === '6130')!.active, false);
        // an account with a balance is refused, in Hebrew, without its amount
        await page.getByLabel('חיפוש חשבון').fill('דמו');
        await list.locator('li[data-account="S-000000109"]').getByRole('button', { name: 'הסרה מהשימוש S-000000109' }).click();
        await page.getByText('בחשבון יש יתרה — מאפסים אותה בפקודה לפני שמסירים אותו.').waitFor();
      } finally { await ctx.close(); }
    });

    await step(`${v}: פקודה ידנית — D / C lines, the live balance, then in the journal`, async () => {
      fake = fresh();
      const { ctx, page } = await open('/finance/books', v);
      try {
        await ready(page);
        await view(page, 'פקודה ידנית');
        await page.getByLabel('פרטים (2–50 תווים)').fill('הפרשה לפי רו״ח');
        await page.getByLabel('חשבון שורה 1').fill('6117');
        await page.getByLabel('סכום שורה 1').fill('120.50');
        await page.getByLabel('חשבון שורה 2').fill('BANK');
        await page.getByLabel('סכום שורה 2').fill('100');
        await page.getByText(/הפרש\s*₪20\.5/).first().waitFor();
        await page.getByRole('button', { name: 'רישום הפקודה' }).click();
        await page.getByText('הפקודה לא מאוזנת — סך החובה צריך להיות שווה לסך הזכות.').first().waitFor();
        await page.getByRole('button', { name: '+ שורה' }).click();
        await page.getByLabel('חשבון שורה 3').fill('2300');
        await page.getByRole('radiogroup', { name: 'חובה או זכות — שורה 3' }).getByRole('radio', { name: 'זכות' }).click();
        await page.getByLabel('סכום שורה 3').fill('20.50');
        await page.getByText('מאוזן', { exact: true }).first().waitFor();
        await noSideScroll(page, `${v} manual`);
        await shot(page, `${v}-9-manual.png`);
        await axe(page, `${v} manual`);
        await page.getByRole('button', { name: 'רישום הפקודה' }).click();
        await page.getByText('פקודה 4 נרשמה').first().waitFor();
        await entry(page, 4).getByText('הפרשה לפי רו״ח').waitFor();
        const tx = fake.tables.gl_transactions.find((x: any) => x.number === 4)!;
        const ls = fake.tables.gl_lines.filter((l: any) => l.transaction_id === tx.id).map((l: any) => [l.side, l.amount]);
        assert.deepEqual(ls, [['D', 120.5], ['C', 100], ['C', 20.5]]);
      } finally { await ctx.close(); }
    });
  }

  await step('phone: יתרות פתיחה — once; a customer by its card, an existing supplier; the rest to 3100', async () => {
    fake = fresh();
    const { ctx, page } = await open('/finance/books', 'phone');
    try {
      await ready(page);
      await view(page, 'יתרות פתיחה');
      await page.getByLabel('חשבון שורה 1').fill('1100');
      await page.getByLabel('סכום שורה 1').fill('1,000');
      await page.getByRole('radiogroup', { name: 'חשבון או לקוח — שורה 2' }).getByRole('radio', { name: 'לקוח' }).click();
      await page.getByLabel('לקוח שורה 2').fill('פתיחה');
      await page.getByRole('button', { name: /לקוח פתיחה דמו/ }).click();
      await page.getByText('(חשבון 0529999999)').waitFor();
      await page.getByRole('radiogroup', { name: 'חובה או זכות — שורה 2' }).getByRole('radio', { name: 'חובה' }).click();
      await page.getByLabel('סכום שורה 2').fill('250');
      await page.getByRole('button', { name: '+ שורה' }).click();
      await page.getByLabel('חשבון שורה 3').fill('S-000000109');
      await page.getByRole('radiogroup', { name: 'חובה או זכות — שורה 3' }).getByRole('radio', { name: 'זכות' }).click();
      await page.getByLabel('סכום שורה 3').fill('300');
      await page.getByText(/יירשם ב-3100/).waitFor();
      await noSideScroll(page, 'phone opening');
      await shot(page, 'phone-10-opening.png');
      await axe(page, 'phone opening');
      await page.getByRole('button', { name: 'רישום יתרות הפתיחה' }).click();
      try { await page.getByText(/יתרות הפתיחה נרשמו \(פקודה 4\)/).first().waitFor(); }
      catch (e) { await shot(page, 'FAIL-opening.png'); throw e; }
      assert.equal(fake.booksOpening, true);
      const tx = fake.tables.gl_transactions.find((x: any) => x.source_kind === 'opening')!;
      const keyOf = (id: string) => fake.tables.gl_accounts.find((a: any) => a.id === id)!.key;
      assert.deepEqual(fake.tables.gl_lines.filter((l: any) => l.transaction_id === tx.id).map((l: any) => [keyOf(l.account_id), l.side, l.amount]),
        [['1100', 'D', 1000], ['0529999999', 'D', 250], ['S-000000109', 'C', 300], ['3100', 'C', 950]]);
      assert.equal(fake.tables.gl_accounts.find((a: any) => a.key === '0529999999')!.name, 'לקוח פתיחה דמו', 'a new customer by its card');
      await views(page).getByRole('button', { name: 'מאזן בוחן', exact: true }).waitFor();
      assert.equal(await views(page).getByRole('button', { name: 'יתרות פתיחה', exact: true }).count(), 0, 'once — the form is gone');
    } finally { await ctx.close(); }
  });

  await step('7300: a supplier\'s opening line — from the expenses, or a new one; before 7300 — "not possible yet"', async () => {
    fake = fresh();
    fake.booksOpeningSuppliers = false;                // before 7300: the old function refuses a supplier's line
    const { ctx, page } = await open('/finance/books?view=opening', 'desktop');
    try {
      await ready(page);
      await page.getByLabel('חשבון שורה 1').fill('1100');
      await page.getByLabel('סכום שורה 1').fill('100');
      await page.getByRole('radiogroup', { name: 'חשבון או לקוח — שורה 2' }).getByRole('radio', { name: 'ספק' }).click();
      await page.getByLabel('ספק שורה 2').fill('ספק חדש דמו');
      await page.getByRole('button', { name: 'ספק חדש: ספק חדש דמו' }).click();
      await page.getByRole('radiogroup', { name: 'חובה או זכות — שורה 2' }).getByRole('radio', { name: 'זכות' }).click();
      await page.getByLabel('סכום שורה 2').fill('100');
      await page.getByRole('button', { name: 'רישום יתרות הפתיחה' }).click();
      await page.getByText(/יתרת פתיחה לספק חדש עוד לא אפשרית/).first().waitFor();
      assert.equal(fake.booksOpening, false, 'nothing was entered');
    } finally { await ctx.close(); }
    fake = fresh();
    fake.tables.expenses.push({ id: 'd0000000-0000-4000-8000-000000000072', business_id: BIZ, user_id: OWNER, supplier_name: 'ספק חשמל דמו', supplier_dealer: '000000117',
      created_at: `${TODAY}T07:00:00Z` });
    const o = await open('/finance/books?view=opening', 'desktop');
    try {
      const page = o.page;
      await ready(page);
      await page.getByLabel('חשבון שורה 1').fill('1100');
      await page.getByLabel('סכום שורה 1').fill('500');
      await page.getByRole('radiogroup', { name: 'חשבון או לקוח — שורה 2' }).getByRole('radio', { name: 'ספק' }).click();
      await page.getByLabel('ספק שורה 2').fill('חשמל');
      await page.getByRole('button', { name: /ספק חשמל דמו · עם ע\.מ 000000117/ }).click();
      await page.getByText('ע.מ 000000117').waitFor();
      await page.getByRole('radiogroup', { name: 'חובה או זכות — שורה 2' }).getByRole('radio', { name: 'זכות' }).click();
      await page.getByLabel('סכום שורה 2').fill('200');
      await shot(page, 'desktop-12-opening-supplier.png');
      await axe(page, 'desktop opening supplier');
      await page.getByRole('button', { name: 'רישום יתרות הפתיחה' }).click();
      await page.getByText(/יתרות הפתיחה נרשמו/).first().waitFor();
      const s = fake.tables.gl_accounts.find((a: any) => a.key === 'S-000000117')!;
      assert.equal(s.role, 'supplier:d:000000117', 'the account an expense of it posts to');
      const tx = fake.tables.gl_transactions.find((x: any) => x.source_kind === 'opening')!;
      assert.ok(fake.tables.gl_lines.some((l: any) => l.transaction_id === tx.id && l.account_id === s.id && l.side === 'C' && l.amount === 200));
    } finally { await o.ctx.close(); }
  });

  for (const v of ['desktop', 'phone'] as const) {
    await step(`${v}: התאמה — a difference marked; CSV of the trial balance`, async () => {
      fake = fresh();
      fake.booksReconDiff = { cash: 0.01 };
      const { ctx, page } = await open('/finance/books', v);
      try {
        await ready(page);
        if (v === 'desktop') {
          const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'מאזן בוחן — הורדת CSV' }).click()]);
          const text = readFileSync(await dl.path(), 'utf8');
          assert.match(text, /^﻿"קוד מאזן","חשבון","יתרת פתיחה","חובה","זכות","יתרת סגירה"/);
          assert.match(text, /"1100","1100 · קופת מזומן — ראשי"/);
        }
        await view(page, 'התאמה');
        const list = page.getByRole('list', { name: 'התאמת הספרים' });
        await list.locator('li[data-area="cash"]').getByText('הפרש', { exact: false }).waitFor();
        await list.locator('li[data-area="income"]').getByText('תואם').waitFor();
        await page.getByText('יש הפרשים בין הספרים לדוחות — מסומנים למטה. לבירור עם רואה החשבון.').waitFor();
        await noSideScroll(page, `${v} reconcile`);
        await shot(page, `${v}-11-reconcile.png`);
        await axe(page, `${v} reconcile`);
      } finally { await ctx.close(); }
    });
  }

  await step('the owner\'s switch (7300): hidden until turned on in the settings — then in the menu and the search; before 7300 — the owner', async () => {
    fake = fresh();
    fake.booksShowScreens = false;
    const { ctx, page } = await open('/finance/books', 'desktop');
    try {
      await page.getByText(/מסכי הנהלת החשבונות כבויים/).waitFor({ timeout: 120_000 });
      assert.equal(await page.locator('a[href="/finance/books"]').count(), 0, 'off — not in the menu');
      await page.goto(`${BASE}/finance/settings`, { waitUntil: 'domcontentloaded' });
      const box = page.getByRole('checkbox', { name: 'להציג הנהלת חשבונות' });
      await box.waitFor({ timeout: 120_000 });
      assert.equal(await box.isChecked(), false);
      await box.click();                               // the switch follows the database's answer (no optimistic state)
      await page.getByText('מסכי הנהלת החשבונות מוצגים').first().waitFor();
      await page.waitForFunction(() => (document.querySelector('input[type=checkbox].h-5') as HTMLInputElement | null)?.checked === true);
      assert.equal(fake.booksShowScreens, true);
      await page.locator('a[href="/finance/books"]').first().waitFor();
      await shot(page, 'desktop-13-switch.png', false);
      const r = fake.rpc('gl_books_screens_set', { p_on: false });
      assert.equal(r.status, 200);
    } finally { await ctx.close(); }
    fake = fresh();
    fake.booksShowScreens = null;                      // a database before 7300: no switch — the owner sees the area
    const o = await open('/finance/settings', 'desktop');
    try {
      await o.page.getByRole('region', { name: 'ספרים', exact: true }).waitFor({ timeout: 120_000 });
      await o.page.locator('a[href="/finance/books"]').first().waitFor();
      assert.equal(await o.page.getByRole('checkbox', { name: 'להציג הנהלת חשבונות' }).count(), 0, 'no switch before 7300');
    } finally { await o.ctx.close(); }
  });

  await step('a member who is not the owner: the reports, no owner forms, no edits; with empty books — not in the menu', async () => {
    fake = fresh();
    fake.owner = false;
    let { ctx, page } = await open('/finance/books', 'desktop');
    try {
      await ready(page);
      for (const label of ['מאזן בוחן', 'כרטסת', 'יומן', 'רווח והפסד', 'מאזן', 'לוח חשבונות', 'התאמה']) await views(page).getByRole('button', { name: label, exact: true }).waitFor();
      for (const label of ['פקודה ידנית', 'יתרות פתיחה']) assert.equal(await views(page).getByRole('button', { name: label, exact: true }).count(), 0, label);
      await view(page, 'יומן');
      await entry(page, 3).waitFor();
      assert.equal(await page.getByRole('button', { name: 'פקודה הפוכה' }).count(), 0);
      await view(page, 'לוח חשבונות');
      await page.getByRole('list', { name: 'לוח החשבונות' }).waitFor();
      assert.equal(await page.getByRole('button', { name: '+ חשבון חדש' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: /^עריכת / }).count(), 0);
      // the database refuses anyway
      const r = fake.rpc('gl_manual_create', { p_id: 'e0000000-0000-4000-8000-0000000000f1', p_date: TODAY, p_details: 'בדיקה', p_lines: [] });
      assert.equal(r.status, 400); assert.match(r.body.message, /^books_not_allowed/);
    } finally { await ctx.close(); }
    fake = fresh();
    fake.owner = false;
    fake.booksShowScreens = false;                     // the owner did not turn the screens on
    ({ ctx, page } = await open('/finance/books', 'desktop'));
    try {
      await page.getByText(/הבעלים מפעילים אותם בהגדרות הכספים/).waitFor({ timeout: 120_000 });
      assert.equal(await page.locator('a[href="/finance/books"]').count(), 0, 'not in the menu');
    } finally { await ctx.close(); }
  });

  await browser.close();
  try { process.kill(-dev.pid!); } catch { /* gone */ }
  const relevant = errors.filter((e) => !/hydrat|ResizeObserver/i.test(e));
  if (relevant.length) console.log(`page errors:\n  ${relevant.slice(0, 5).join('\n  ')}`);
  console.log(axeFindings.length ? `\naxe: ${axeFindings.length} finding(s)\n${[...new Set(axeFindings)].join('\n')}` : (AXE ? '\naxe: no WCAG A/AA violation on these screens' : '\naxe: not run (axe-core not found)'));
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed`);
  process.exit(passed === results.length && !relevant.length ? 0 : 1);
}
void main().catch((e) => { console.error(e); process.exit(1); });
