/**
 * "כספים" (Dream Finance 2.51) in a real browser (Chromium via Playwright), on a phone (390×844), against the in-memory
 * Supabase of fake-supabase.ts (the accounting rules themselves are proven on Postgres in tests/sql).
 * A tax invoice from the contacts, the receivables and a reminder, a receipt, a credit invoice with money back, a quote
 * accepted and converted, an expense with its VAT share, the VAT working paper, the audit check, the CRM card, the super
 * admin's explicit opening, and the cashier who never gets here.
 *
 * Run: npm run test:e2e   (starts `next dev` on port 3218; needs the preinstalled Chromium)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_FINANCE_PORT ?? 3218);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-000000000002';
const OWNER = 'a0000000-0000-4000-8000-0000000000a2';
const CASHIER = 'c0000000-0000-4000-8000-0000000000c2';
const ADMIN = 'a0000000-0000-4000-8000-0000000000ad';
const DANA = 'd0000000-0000-4000-8000-0000000000d2';
const PHONE = { width: 390, height: 844 };

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  return {
    brands: [{ ...base, name: 'FollowMe', onboarded: true, industry: 'אופנה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'company', vat_rate: 18, pay_link: '', dealer_number: '515123456', legal_name: 'פולו מי אופנה בע״מ', street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [], catalog_items: [], employees: [],
    leads: [{ ...base, id: DANA, name: 'דנה כהן', phone: '0521234567', source: 'ידני', status: 'חדש', date: '2026-01-01', tags: [], value: 0, notes: '',
      billing_name: 'סלון דנה בע״מ', billing_dealer: '520013954', billing_street: 'הרצל 5', billing_city: 'חולון' }],
    sales: [], documents: [], sale_refunds: [], stock_movements: [], register_shifts: [], appointments: [], booking_services: [],
    content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [], push_subscriptions: [],
    payments: [], quotes: [], expenses: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [],
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
  const results: { name: string; ok: boolean; error?: string }[] = [];
  const browser = await (async () => { await waitForServer(dev); return chromium.launch(); })();
  // `next dev` compiles a page on its first visit and may reload the open tab while doing so (a navigation that starts
  // then is aborted). Compile every page this run visits up front, so no step races the compiler.
  for (const p of ['/finance', '/leads', '/register']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@followme.test' });
  const errors: string[] = [];
  const popups: string[] = [];

  async function open(o: { access: 'full' | 'register'; userId: string; superAdmin?: boolean; path: string }) {
    const ctx = await browser.newContext({ viewport: PHONE, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', isMobile: true, hasTouch: true });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(o.userId, 'user@followme.test'))]);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    await ctx.route('http://sb.test/**', async (route: any) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      fake.opts.userId = o.userId;
      const r = fake.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
      return route.fulfill({ status: r.status, body: r.body ?? '', headers: { ...(r.headers ?? {}), ...cors } });
    });
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'FollowMe', state: 'active' }, businesses: [{ id: BIZ, name: 'FollowMe', state: 'active' }], superAdmin: Boolean(o.superAdmin), access: o.access } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: Boolean(o.superAdmin) } }));
    await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
    await ctx.route(`${BASE}/api/finance/tax/status`, (r: any) => r.fulfill({ json: { mode: 'unconfigured', configured: false, connection: null, message: 'החיבור לרשות המסים לא הוגדר.' } }));
    await ctx.route(/https:\/\/(wa\.me|api\.whatsapp\.com)\//, (r: any) => { popups.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>wa</body></html>' }); });
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(`${o.access}: ${e.message}`));
    page.on('dialog', (d: any) => d.accept());
    await goto(page, o.path);
    return { ctx, page };
  }
  /** A full navigation; once more if `next dev` aborted it with a reload of its own (only ERR_ABORTED, nothing else). */
  async function goto(page: any, to: string) {
    try { await page.goto(`${BASE}${to}`, { waitUntil: 'domcontentloaded' }); }
    catch (e: any) { if (!/ERR_ABORTED/.test(String(e?.message))) throw e; await page.goto(`${BASE}${to}`, { waitUntil: 'domcontentloaded' }); }
  }
  let current: any = null;
  const step = async (name: string, fn: () => Promise<void>) => {
    if (current) for (let i = 0; i < 3 && await current.getByRole('dialog').count(); i++) await current.keyboard.press('Escape');
    try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false, error: e.message }); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 6).join('\n  ')}`); }
  };
  const dialog = (page: any) => page.getByRole('dialog').last();
  const tab = async (page: any, name: string) => { await page.getByRole('tab', { name, exact: true }).click(); };
  const noSideScroll = async (page: any, what: string) => {
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw + 1, `${what}: the page scrolls sideways (${sw} > ${iw})`);
  };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

  const { page } = await open({ access: 'full', userId: OWNER, path: '/finance' });
  current = page;
  try {
    await page.getByRole('heading', { name: 'כספים' }).waitFor({ timeout: 120_000 });

    await step('the overview on a phone: real numbers from the database, nothing sideways', async () => {
      await page.getByText('הכנסות (לפני מע״מ)').waitFor();
      await page.getByText('רווח משוער').waitFor();
      await noSideScroll(page, 'overview');
      await page.screenshot({ path: path.join(SHOTS, 'f1-overview.png') });
      assert.ok(fake.calls.some((c) => c.path.startsWith('/rest/v1/rpc/finance_summary')), 'the numbers come from finance_summary()');
    });

    await step('a tax invoice to a customer from the contacts: numbered, issuer kept, logged in the CRM', async () => {
      await tab(page, 'מסמכים');
      await page.getByRole('button', { name: '+ מסמך חדש' }).click();
      const d = dialog(page);
      await d.getByRole('radio', { name: 'חשבונית מס', exact: true }).click();
      await d.getByLabel('חיפוש לקוח').fill('דנה');
      await d.getByRole('button', { name: /דנה כהן/ }).click();
      await d.getByLabel('תיאור שורה 1').fill('ייעוץ עסקי');
      await d.getByLabel('מחיר שורה 1').fill('1180');
      await d.getByText('₪1,180').first().waitFor();
      await noSideScroll(page, 'composer');
      await page.screenshot({ path: path.join(SHOTS, 'f2-composer.png') });
      await d.getByRole('button', { name: 'הפקת חשבונית מס' }).click();
      await page.getByRole('heading', { name: 'חשבונית מס 1' }).waitFor();
      const doc = fake.tables.documents.find((x) => x.doc_type === 305)!;
      assert.deepEqual([doc.doc_number, doc.total, doc.vat_amount, doc.after_discount, doc.lead_id, doc.customer_name, doc.customer_dealer],
        [1, 1180, 180, 1000, DANA, 'סלון דנה בע״מ', '520013954']);
      assert.match(doc.idempotency_key, /^direct:/);
      assert.equal(doc.issuer.name, 'פולו מי אופנה בע״מ');
      await page.getByText(/ח\.פ 515123456/).first().waitFor();
      assert.ok(fake.tables.lead_activities.some((a) => a.lead_id === DANA && /חשבונית מס מס׳ 1/.test(a.body)), 'the customer\'s history has it');
      await page.screenshot({ path: path.join(SHOTS, 'f3-invoice.png') });
    });

    await step('receivables: the reminder carries the real amount; a receipt closes the invoice', async () => {
      await page.keyboard.press('Escape');
      await tab(page, 'חייבים');
      await page.getByText('סלון דנה בע״מ · חשבונית מס 1').waitFor();
      await page.getByRole('button', { name: 'תזכורת' }).click();
      const d = dialog(page);
      await d.getByText(/₪1,180 על חשבונית מס מס׳ 1/).waitFor();
      const href = await d.getByRole('link', { name: 'שליחה בוואטסאפ' }).getAttribute('href');
      assert.match(href ?? '', /wa\.me\/972521234567/);
      await page.screenshot({ path: path.join(SHOTS, 'f4-reminder.png') });
      await page.keyboard.press('Escape');
      await page.getByText('סלון דנה בע״מ · חשבונית מס 1').click();
      await dialog(page).getByRole('button', { name: 'קבלה על תשלום' }).click();
      await dialog(page).getByRole('button', { name: 'הפקת קבלה' }).click();
      await page.getByText(/הופקה קבלה מס׳ 1 · ₪1,180/).waitFor();
      const r = fake.tables.documents.find((x) => x.doc_type === 400)!;
      assert.equal(r.paid_document_id, fake.tables.documents.find((x) => x.doc_type === 305)!.id);
      assert.ok(fake.tables.payments.some((p) => p.document_id === r.id && p.direction === 'in' && p.amount === 1180 && p.method === 'transfer'), 'the ledger has the payment');
      for (let i = 0; i < 2 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
      await tab(page, 'סקירה'); await tab(page, 'חייבים');
      await page.getByText('אין חובות פתוחים', { exact: false }).waitFor();
    });

    await step('a credit invoice on a paid sale, with the money paid back', async () => {
      await tab(page, 'מסמכים');
      await page.getByRole('button', { name: '+ מסמך חדש' }).click();
      const d = dialog(page);
      await d.getByRole('radio', { name: 'חשבונית מס / קבלה' }).click();
      await d.getByLabel('תיאור שורה 1').fill('חולצה');
      await d.getByLabel('כמות שורה 1').fill('2');
      await d.getByLabel('מחיר שורה 1').fill('59');
      await d.getByLabel('סכום תשלום 1').waitFor();
      await d.getByRole('button', { name: 'הפקת חשבונית מס / קבלה' }).click();
      await page.getByRole('heading', { name: 'חשבונית מס / קבלה 1' }).waitFor();
      await dialog(page).getByRole('button', { name: 'חשבונית זיכוי' }).click();
      const c = dialog(page);
      await c.getByRole('button', { name: 'סכום', exact: true }).click();
      await c.getByLabel('סכום הזיכוי (כולל מע״מ)').fill('59');
      await c.getByText('חשבונית הזיכוי:').waitFor();
      await c.getByRole('button', { name: 'הפקת חשבונית זיכוי' }).click();
      await page.getByText(/הופקה חשבונית מס זיכוי מס׳ 1 · ₪59/).waitFor();
      const cr = fake.tables.documents.find((x) => x.doc_type === 330)!;
      assert.deepEqual([cr.base_doc_type, cr.base_doc_number, cr.total, cr.vat_amount], [320, 1, 59, 9]);
      assert.ok(fake.tables.payments.some((p) => p.document_id === cr.id && p.direction === 'out' && p.source === 'credit' && p.amount === 59), 'money back is in the ledger');
    });

    await step('a quote: sent to the customer, accepted, converted into an invoice', async () => {
      for (let i = 0; i < 2 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
      await tab(page, 'הצעות מחיר');
      await page.getByRole('button', { name: '+ הצעת מחיר' }).click();
      const d = dialog(page);
      await d.getByLabel('חיפוש לקוח').fill('דנה');
      await d.getByRole('button', { name: /דנה כהן/ }).click();
      await d.getByLabel('תיאור שורה 1').fill('חבילת סטיילינג');
      await d.getByLabel('מחיר שורה 1').fill('2360');
      const [popup] = await Promise.all([page.waitForEvent('popup'), d.getByRole('button', { name: 'שמירה ושליחה ללקוח' }).click()]);
      await popup.waitForLoadState().catch(() => {});
      assert.match(decodeURIComponent(popup.url()), /הצעת מחיר מס׳ 1 .*₪2,360/);
      await popup.close();
      const q = fake.tables.quotes[0];
      assert.deepEqual([q.quote_number, q.status, q.total], [1, 'sent', 2360]);
      await page.getByRole('heading', { name: 'הצעת מחיר 1' }).waitFor();
      await dialog(page).getByRole('button', { name: '✓ אושרה' }).click();
      await page.getByText('ההצעה סומנה כמאושרת').waitFor();
      await page.getByText(/הצעה 1 · /).click();
      await dialog(page).getByRole('button', { name: 'הפיכה למסמך' }).click();
      await dialog(page).getByRole('button', { name: 'הפקת חשבונית מס' }).click();
      await page.getByText(/הופקה חשבונית מס מס׳ 2 מההצעה/).waitFor();
      assert.equal(fake.tables.quotes[0].status, 'converted');
      const inv = fake.tables.documents.find((x) => x.doc_type === 305 && x.doc_number === 2)!;
      assert.deepEqual([inv.quote_id, inv.total, inv.source], [q.id, 2360, 'quote']);
    });

    await step('an expense with its VAT share, paid — into the ledger and the VAT working paper', async () => {
      await tab(page, 'הוצאות');
      await page.getByRole('button', { name: /\+ הוצאה/ }).click();
      const d = dialog(page);
      await d.getByLabel('ספק', { exact: true }).fill('תחנת דלק');
      await d.getByLabel('קטגוריה').selectOption('vehicle');
      await d.getByLabel('סה״כ (כולל מע״מ)').fill('354');
      await d.getByLabel(/מע״מ לקיזוז/).waitFor();
      assert.equal(await d.getByLabel(/מע״מ לקיזוז/).inputValue(), '66.67');
      await d.getByLabel('שולם').check();
      await noSideScroll(page, 'expense form');
      await page.screenshot({ path: path.join(SHOTS, 'f5-expense.png') });
      await d.getByRole('button', { name: 'אישור ושמירה' }).click();
      await page.getByText('תחנת דלק · רכב ודלק').waitFor();
      const e = fake.tables.expenses[0];
      assert.deepEqual([e.expense_number, e.amount_before_vat, e.vat_amount, e.total, e.vat_deductible_pct, e.paid_on, e.payment_method], [1, 300, 54, 354, 66.67, today, 'transfer']);
      assert.ok(fake.tables.payments.some((p) => p.expense_id === e.id && p.direction === 'out' && p.amount === 354));
      await tab(page, 'דוחות');
      // output VAT: 180 (305) + 18 (320) − 9 (330) + 360 (305 from the quote) = 549; deductible: 54 × 66.67% = 36 → 513
      await page.getByText('מע״מ לתשלום (להחזר אם שלילי)').waitFor();
      await page.getByText('₪513').first().waitFor();
      await page.screenshot({ path: path.join(SHOTS, 'f6-reports.png') });
    });

    await step('the accountant: the audit log is checked and intact', async () => {
      await tab(page, 'רואה חשבון');
      await page.getByText('מסמך הופק', { exact: false }).first().waitFor();
      await page.getByRole('button', { name: 'בדיקת שלמות היומן' }).click();
      await page.getByText(/היומן שלם/).waitFor();
      await noSideScroll(page, 'accountant');
    });

    await step('the accountant\'s package: the files, the open format, and the seal of the audit log', async () => {
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'הורדת החבילה (ZIP)' }).click()]);
      const zip = await JSZip.loadAsync(readFileSync(await download.path()));
      const names = Object.keys(zip.files);
      for (const want of ['מסמכים.csv', 'הוצאות.csv', 'יומן-תשלומים.csv', 'חייבים.csv', 'חותמת-יומן.txt', 'INI.TXT', 'BKMVDATA.zip']) {
        assert.ok(names.some((n) => n.endsWith(want)), `${want} is in the package (${names.join(', ')})`);
      }
      const seal = await zip.file(names.find((n) => n.endsWith('חותמת-יומן.txt'))!)!.async('string');
      assert.match(seal, /בדיקת שלמות: תקין/);
      assert.match(seal, /Hash של הרשומה האחרונה: h\d+/, 'the last hash of the log');
      const docs = await zip.file(names.find((n) => n.endsWith('מסמכים.csv'))!)!.async('string');
      assert.ok(docs.includes('סלון דנה בע״מ'), 'the documents list has the invoice to the customer');
      await page.getByText(/החבילה ירדה: \d+ מסמכים/).waitFor();
    });

    await step('settings: the allocation thresholds say they are not verified', async () => {
      await tab(page, 'הגדרות');
      await page.getByText('לא אומת מול פרסום רשמי').first().waitFor();
      await page.getByText('החיבור לרשות המסים לא הוגדר.').waitFor();
    });

    await step('the CRM card: the customer\'s money, and a new document straight from it', async () => {
      await goto(page, '/leads');
      await page.getByRole('button', { name: /דנה כהן/ }).first().click();
      await dialog(page).getByRole('button', { name: /💰 כספים/ }).click();
      await dialog(page).getByText(/חשבונית מס 1 ·/).waitFor();
      await dialog(page).getByText(/אין חוב פתוח|חייב\/ת/).first().waitFor();
      await page.screenshot({ path: path.join(SHOTS, 'f7-crm.png') });
      await dialog(page).getByRole('link', { name: '🧾 הפקת מסמך' }).click();
      await page.waitForURL(/\/finance\?tab=documents&new=1&lead=/);
      await dialog(page).getByRole('heading', { name: 'מסמך חדש' }).waitFor();
      assert.equal(await dialog(page).getByLabel('שם הלקוח').inputValue(), 'סלון דנה בע״מ', 'the customer is filled in from the card');
    });
  } finally { await page.context().close(); current = null; }

  await step('a super admin: the business\'s money is closed until opened with a reason (and that is logged)', async () => {
    fake.finance = { superAdmin: true, member: false, grantUntil: null, lockedUntil: null };
    const { ctx, page: p } = await open({ access: 'full', userId: ADMIN, superAdmin: true, path: '/finance' });
    try {
      await p.getByText('הנתונים הכספיים של העסק הזה סגורים').waitFor({ timeout: 120_000 }).catch(async (e: Error) => {
        await p.screenshot({ path: path.join(SHOTS, 'f8-debug.png') });
        console.log('URL:', p.url(), '\nTEXT:', (await p.locator('body').innerText()).slice(0, 800));
        throw e;
      });
      assert.equal(await p.getByRole('tab', { name: 'מסמכים' }).count(), 0, 'nothing behind it');
      await p.getByLabel(/סיבה/).fill('בדיקת תקלה בדוח לבקשת הבעלים');
      await p.getByRole('button', { name: 'פתיחת גישה זמנית' }).click();
      await p.getByText(/גישת מנהל-על פתוחה עד/).waitFor();
      await p.getByRole('tab', { name: 'מסמכים' }).waitFor();
      assert.ok(fake.tables.finance_audit_log.some((r) => r.action === 'support.access_opened' && r.actor_kind === 'super_admin'), 'the opening is in the business\'s log');
      await p.screenshot({ path: path.join(SHOTS, 'f8-super-admin.png') });
    } finally { await ctx.close(); fake.finance = { superAdmin: false, member: true, grantUntil: null, lockedUntil: null }; }
  });

  await step('a cashier never gets the money screens', async () => {
    const { ctx, page: p } = await open({ access: 'register', userId: CASHIER, path: '/finance' });
    try {
      await p.waitForURL(/\/register$/, { timeout: 120_000 });
      assert.equal(await p.getByRole('link', { name: 'כספים' }).count(), 0);
    } finally { await ctx.close(); }
  });

  await step('no errors in the browser', async () => { assert.deepEqual(errors, []); });

  await browser.close();
  try { process.kill(-dev.pid!, 'SIGTERM'); } catch { dev.kill('SIGTERM'); }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n# e2e finance: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
