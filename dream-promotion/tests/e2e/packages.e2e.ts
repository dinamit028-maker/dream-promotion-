/**
 * Packages and series of treatments (docs/FINANCE ADDITIONS HE.md, T1; 2.87) in a real browser (Chromium via Playwright), on a
 * phone (390×844, and 375), against the in-memory Supabase of fake-supabase.ts — the rules themselves are proven on Postgres
 * (tests/sql/client-packages.check.sql, concurrency.sh §13).
 * The Definition of Done of T1, clicked through: a package sold from the client card (its tax invoice by the existing engine,
 * with the package's key), paid in two payments (two receipts), two treatments taken from it in the card ("לנכות מהחבילה" is
 * offered), a cancelled session gives its treatment back, the report (what is left, what was paid in advance), and the
 * cancellation with the system's suggestion — a credit invoice for what was not used and the money back — that the owner
 * approves. Also: a package paid at once (320), and a package's terms in the product editor; retries from the same dialog (a
 * refused money back, a session whose answer was lost) do nothing twice; Escape closes the top dialog only.
 *
 * Run: npm run test:e2e   (starts `next dev` on port 3219; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (k* — packages; not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_PACKAGES_PORT ?? 3219);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000000b7';
const OWNER = 'a0000000-0000-4000-8000-0000000000b7';
const NOA = 'd0000000-0000-4000-8000-0000000000b7';
const LASER = 'e0000000-0000-4000-8000-0000000000b7';
const T_NOA = 'e0000000-0000-4000-8000-0000000000b8';
const PKG_ITEM = 'c0000000-0000-4000-8000-0000000000b7';
const PHONE = { width: 390, height: 844 };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  return {
    brands: [{ ...base, name: 'קליניקה לייט', onboarded: true, industry: 'קוסמטיקה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'company', vat_rate: 18, pay_link: '', dealer_number: '515123456', legal_name: 'קליניקה לייט בע״מ', street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [], employees: [],
    catalog_items: [{ ...base, id: PKG_ITEM, name: '6 טיפולי לייזר', price: 1200, kind: 'package', active: true, favorite: false, fav_order: 0, sort: 0, image_url: '',
      track_stock: false, stock_qty: 0, low_stock: 2, description: 'לא ניתן להעברה', package_sessions: 6, package_type_id: LASER, package_valid_months: 6 }],
    leads: [{ ...base, id: NOA, name: 'נועה לוי', phone: '0521112233', source: 'ידני', status: 'נסגר', date: '2026-01-01', tags: [], value: 0, notes: '' }],
    treatment_types: [{ id: LASER, business_id: BIZ, name: 'לייזר', active: true, sort: 0 }],
    client_treatments: [{ id: T_NOA, business_id: BIZ, lead_id: NOA, title: 'הסרת שיער', area: 'רגליים', started_at: today, status: 'active', treatment_type_id: LASER, created_at: '2026-01-01T00:00:00Z' }],
    client_sessions: [], client_packages: [], client_package_uses: [],
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
  if (process.env.E2E_DEV_LOG) { const { createWriteStream } = await import('node:fs'); const log = createWriteStream(process.env.E2E_DEV_LOG); dev.stdout?.pipe(log); dev.stderr?.pipe(log); }
  const results: { name: string; ok: boolean; error?: string }[] = [];
  const browser = await (async () => { await waitForServer(dev); return chromium.launch(); })();
  for (const p of ['/finance/packages', '/finance/documents', '/leads']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@clinic.test' });
  const errors: string[] = [];

  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', isMobile: true, hasTouch: true });
  await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@clinic.test'))]);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
  const calls: string[] = [];   // the last requests to the fake — printed when a step fails
  const failOnce = new Set<string>();   // functions that are refused once (a step that fails, then a retry)
  const lostOnce = new Set<string>();   // functions that are done once, but their answer is lost on the way back
  await ctx.route('http://sb.test/**', async (route: any) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const where = `${req.method()} ${req.url().replace('http://sb.test', '').slice(0, 140)}`;
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(req.url())?.[1];
    if (fn && failOnce.delete(fn)) {
      calls.push(`REFUSED ${where}`);
      return route.fulfill({ status: 500, json: { code: 'XX000', message: 'the server did not answer (test)' }, headers: cors });
    }
    try {
      const r = fake.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
      calls.push(`${r.status} ${where}${r.status >= 400 ? ` ${String(r.body ?? '').slice(0, 160)}` : ''}`); calls.splice(0, calls.length - 14);
      if (fn && lostOnce.delete(fn)) { calls.push(`LOST ${where}`); return route.abort('failed'); }
      return route.fulfill({ status: r.status, body: r.body ?? '', headers: { ...(r.headers ?? {}), ...cors } });
    } catch (e: any) {   // a bug in the fake is not a request that never answers
      calls.push(`THROW ${where}: ${e?.message}`);
      return route.fulfill({ status: 500, json: { message: `fake: ${e?.message}` }, headers: cors });
    }
  });
  await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'קליניקה לייט', state: 'active' }, businesses: [{ id: BIZ, name: 'קליניקה לייט', state: 'active' }], superAdmin: false, access: 'full' } }));
  await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
  await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
  await ctx.route(`${BASE}/api/finance/tax/status`, (r: any) => r.fulfill({ json: { mode: 'unconfigured', configured: false, connection: null, message: 'החיבור לרשות המסים לא הוגדר.' } }));
  // the client file's server routes: a new treatment is kept in the fake (as the route does with the service role); the
  // photos, declarations and timeline are not part of this test (they answer "no access" — the card shows what it can)
  await ctx.route(`${BASE}/api/client-file/**`, (r: any) => {
    const body = JSON.parse(r.request().postData() ?? '{}');
    if (r.request().url().endsWith('/photos') && body.action === 'treatment') {
      const row = { id: crypto.randomUUID(), business_id: BIZ, lead_id: body.leadId, title: body.title, area: '', started_at: today, status: 'active', treatment_type_id: body.treatmentTypeId ?? null, created_at: new Date().toISOString() };
      fake.tables.client_treatments.push(row);
      return r.fulfill({ json: { treatment: row } });
    }
    return r.fulfill({ status: 403, json: { code: 'no_access', message: 'תיק הלקוח פתוח רק לבעלי העסק ולמטפלים שהבעלים סימן.' } });
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
      await page.screenshot({ path: path.join(SHOTS, `k-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
    finally { clearTimeout(timer); }
  };
  const dialog = () => page.getByRole('dialog').last();
  const settle = async () => {
    const still = await page.evaluate(() => Promise.race([
      Promise.all(document.getAnimations().filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime))).map((a) => a.finished.catch(() => null))).then(() => ''),
      new Promise<string>((ok) => setTimeout(() => ok(document.getAnimations().map((a: any) => `${a.animationName ?? a.transitionProperty ?? a.id}:${a.playState}:${Math.round(Number(a.currentTime ?? -1))}/${a.effect?.getComputedTiming().endTime}`).join(', ')), 8000)),
    ]));
    if (still) console.log(`  # animations still running after 8s: ${still}`);
  };
  const shot = async (name: string) => { await settle(); await page.screenshot({ path: path.join(SHOTS, name), ...(name.endsWith('.jpg') ? { quality: 82 } : {}) }); };
  /** nothing sideways, every control on the screen (or in a row that scrolls by design), no text under 10px */
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
  const card = async () => {
    await goto('/leads');
    await page.getByRole('button', { name: /נועה לוי/ }).first().click();
    await dialog().getByRole('heading', { name: 'נועה לוי' }).waitFor();
  };
  const pkg = () => fake.tables.client_packages[0];

  try {
    await goto('/finance/packages');
    await page.getByRole('heading', { name: 'חבילות', exact: true }).waitFor({ timeout: 120_000 });

    await step('the packages screen: the report (nothing yet) and the catalog’s package with its terms', async () => {
      await page.getByText('חבילות פעילות').waitFor();
      await page.getByText('6 טיפולי לייזר').waitFor();
      await page.getByText('6 טיפולים · לייזר · 6 חודשים').waitFor();
      await page.getByText(/עוד לא נמכרו חבילות/).waitFor();
      await fits('the packages screen');
      await shot('k1-packages-empty.png');
    });

    await step('a sale from the client card: the package’s terms copied, its tax invoice by the existing engine with the package’s key', async () => {
      await card();
      await dialog().getByRole('button', { name: /💰 כספים/ }).click();
      await dialog().getByRole('button', { name: '📦 מכירת חבילה' }).click();
      const d = dialog();
      await d.getByRole('heading', { name: 'מכירת חבילה' }).waitFor();
      await d.getByText('נועה לוי', { exact: true }).waitFor();   // the customer of the card, chosen
      await d.getByRole('radio', { name: /6 טיפולי לייזר/ }).click();
      assert.equal(await d.getByLabel('המחיר בפועל ₪ (כולל מע״מ)').inputValue(), '1200', 'the catalog’s price');
      assert.ok((await d.getByLabel('בתוקף עד (ריק = בלי הגבלה)').inputValue()) > today, 'valid for 6 months from today');
      await d.getByRole('radio', { name: /חשבונית — תשלום אחר כך/ }).click();
      await d.getByText(/יופק: חשבונית מס/).waitFor();
      await fits('the sale dialog');
      await shot('k2-sell.png');
      await d.getByRole('button', { name: 'מכירה והפקת המסמך' }).click();
      await d.waitFor({ state: 'detached' }).catch(() => null);
      await page.getByText(/נותרו 6 מתוך 6 · בתוקף עד/).first().waitFor();
      const p = pkg();
      assert.deepEqual([p.lead_id, p.item_id, p.sessions_total, Number(p.price), p.treatment_type_id, p.status], [NOA, PKG_ITEM, 6, 1200, LASER, 'active']);
      const doc = fake.tables.documents.find((x) => x.id === p.document_id)!;
      assert.ok(doc, 'the package’s document is linked to it');
      assert.deepEqual([doc.doc_type, Number(doc.total), doc.lead_id, doc.idempotency_key], [305, 1200, NOA, `package:${p.id}`]);
      assert.match(doc.lines[0].name, /6 טיפולי לייזר — 6 טיפולים/);
      assert.ok(fake.tables.lead_activities.some((a) => a.lead_id === NOA && /נמכרה חבילה: 6 טיפולי לייזר/.test(a.body)), 'the card’s history has it');
      await fits('the card with its package');
      await shot('k3-card-package.png');
    });

    await step('paid in two payments: two receipts on the package’s invoice — paid in full, the income once', async () => {
      await goto(`/finance/packages?open=${pkg().id}`);
      const v = dialog();
      await v.getByRole('heading', { name: '6 טיפולי לייזר' }).waitFor();
      for (const n of [1, 2]) {
        await v.getByRole('button', { name: 'פתיחת המסמך' }).click();
        await dialog().getByRole('heading', { name: 'חשבונית מס 1' }).waitFor();
        await dialog().getByRole('button', { name: 'קבלה על תשלום' }).click();
        const r = dialog();
        await r.getByLabel('סכום תשלום 1').fill('600');
        await r.getByRole('button', { name: 'הפקת קבלה' }).click();
        await page.getByText(`הופקה קבלה מס׳ ${n}`).first().waitFor();
        await page.waitForFunction(() => document.querySelectorAll('[role=dialog]').length === 2);   // the package, its document
        // Escape closes the document only — also after the screen behind them reloaded (2.87: it closed the package with it)
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelectorAll('[role=dialog]').length === 1);
        await v.getByRole('heading', { name: '6 טיפולי לייזר' }).waitFor();
      }
      const p = pkg();
      const paid = fake.tables.payments.filter((x) => x.applies_to === p.document_id).reduce((a, x) => a + (x.direction === 'in' ? 1 : -1) * Number(x.amount), 0);
      assert.equal(paid, 1200, 'two payments of ₪600');
      assert.equal(fake.tables.documents.filter((x) => x.doc_type === 305).length, 1, 'one tax invoice: the income is counted once');
      await goto(`/finance/packages?open=${p.id}`);
      await dialog().getByText(/שולם: ₪1,200/).waitFor();
    });

    await step('two treatments taken in the card: "לנכות מהחבילה" is offered and chosen; the session and its deduction are one step', async () => {
      await card();
      const box = dialog();
      await box.getByText('🩺 טיפולים שבוצעו').waitFor();
      for (const left of [5, 4]) {
        await box.getByRole('button', { name: '+ רישום טיפול שבוצע' }).click();
        const d = dialog();
        await d.getByRole('heading', { name: 'רישום טיפול שבוצע' }).waitFor();
        const offer = d.getByRole('radio', { name: /לנכות מהחבילה "6 טיפולי לייזר"/ });
        assert.ok(await offer.isChecked(), 'the fitting package is offered and chosen');
        if (left === 5) { await fits('the session dialog'); await shot('k4-session-offer.png'); }
        await d.getByLabel('הערות (לא חובה)').fill(left === 5 ? '18 ג׳אול' : '20 ג׳אול');
        await d.getByRole('button', { name: 'רישום וניכוי מהחבילה' }).click();
        await box.getByText(/הטיפול נרשם ונוכה מהחבילה/).waitFor();
        await box.getByText(new RegExp(`נותרו ${left} מתוך 6`)).first().waitFor();
      }
      assert.equal(fake.tables.client_sessions.length, 2);
      assert.equal(fake.tables.client_package_uses.filter((u) => !u.returned_at).length, 2, 'two treatments taken');
      await fits('the card with its sessions');
      await shot('k5-card-sessions.png');
    });

    await step('a session cancelled: it stays in the file, marked — and its treatment goes back to the package', async () => {
      await card();
      const box = dialog();
      await box.getByRole('button', { name: 'ביטול הטיפול' }).first().click();
      const d = dialog();
      await d.getByLabel('סיבה (לא חובה)').fill('לא הגיעה');
      await d.getByRole('button', { name: 'ביטול הטיפול' }).click();
      await box.getByText(/הטיפול בוטל, וחזר לחבילה/).waitFor();
      await box.getByText(/נותרו 5 מתוך 6/).first().waitFor();
      await box.getByText('בוטל: לא הגיעה').waitFor();
      const cancelled = fake.tables.client_sessions.find((s) => s.cancelled_at)!;
      const back = fake.tables.client_package_uses.find((u) => u.session_id === cancelled.id)!;
      assert.equal(back.return_reason, 'הטיפול בוטל: לא הגיעה');
      // the Definition of Done again: two treatments taken
      await box.getByRole('button', { name: '+ רישום טיפול שבוצע' }).click();
      await dialog().getByRole('button', { name: 'רישום וניכוי מהחבילה' }).click();
      await box.getByText(/נותרו 4 מתוך 6/).first().waitFor();
    });

    await step('a new treatment from the card, without taking it from the package', async () => {
      await card();
      const box = dialog();
      await box.getByRole('button', { name: '+ רישום טיפול שבוצע' }).click();
      const d = dialog();
      await d.getByLabel('טיפול', { exact: true }).selectOption('+');
      await d.getByLabel('שם הטיפול').fill('ייעוץ');
      await d.getByRole('radio', { name: 'בלי ניכוי מחבילה' }).click();
      // the session is saved, but its answer is lost on the way back: the retry is the same session (its id is fixed on the device)
      lostOnce.add('client_session_add');
      await d.getByRole('button', { name: 'רישום הטיפול' }).click();
      await d.getByRole('alert').waitFor();
      await d.getByRole('button', { name: 'רישום הטיפול' }).click();
      await box.getByText(/^✓ הטיפול נרשם$/).waitFor();   // not "…ונוכה מהחבילה"
      await box.getByText(/נותרו 4 מתוך 6/).first().waitFor();
      assert.equal(fake.tables.client_treatments.length, 2, 'the new treatment, once');
      const added = fake.tables.client_treatments.find((t) => t.id !== T_NOA)!;
      assert.equal(fake.tables.client_sessions.filter((x) => x.treatment_id === added.id).length, 1, 'one session, after the retry too');
    });

    await step('the report: what is left and what was paid in advance and not used yet — the same numbers as the package', async () => {
      await goto('/finance/packages');
      await page.getByText('נועה לוי · 6 טיפולי לייזר').waitFor();
      const stat = (label: string) => page.getByText(label, { exact: true }).locator('xpath=following-sibling::strong[1]').innerText();
      assert.equal(await stat('חבילות פעילות'), '1');
      assert.equal(await stat('טיפולים שנותרו בהן'), '4');
      assert.equal(await stat('שווי הטיפולים שנותרו'), '₪800');
      assert.equal(await stat('שולם מראש ועוד לא נוצל'), '₪800', '₪1,200 paid − ₪400 used');
      await page.getByText(/מידע לבעלים — לא קביעה חשבונאית/).waitFor();
      await fits('the report');
      await shot('k6-report.png');
    });

    await step('cancelling: the system suggests a credit for what was not used and the money back; the owner approves', async () => {
      await page.getByText('נועה לוי · 6 טיפולי לייזר').click();
      await dialog().getByRole('button', { name: 'ביטול החבילה' }).click();
      const d = dialog();
      await d.getByRole('heading', { name: /ביטול החבילה/ }).waitFor();
      assert.equal(await d.getByLabel(/חשבונית זיכוי על ₪/).inputValue(), '800', 'credit what was not used (4 of 6)');
      assert.equal(await d.getByLabel('החזר ₪').inputValue(), '800', 'and give back what was paid beyond the 2 used');
      await d.getByLabel('סיבה (חובה)').fill('עוברת דירה');
      await fits('the cancel dialog');
      await shot('k7-cancel.png');
      // the money back is refused once: the credit invoice stays issued, and a retry from the same dialog does not issue another
      failOnce.add('record_credit_refund');
      await d.getByRole('button', { name: 'הפקת זיכוי וביטול החבילה' }).click();
      await d.getByText(/חשבונית הזיכוי הופקה, אבל ההחזר לא נרשם/).waitFor();
      assert.equal(pkg().status, 'active', 'not cancelled before the money back is recorded');
      await d.getByRole('button', { name: 'ביטול החבילה', exact: true }).click();
      await page.getByText(/החבילה בוטלה/).first().waitFor();
      assert.equal(fake.tables.documents.filter((x) => x.doc_type === 330).length, 1, 'one credit invoice');
      assert.equal(fake.tables.payments.filter((x) => x.source === 'credit').length, 1, 'the money back, once');
      const credit = fake.tables.documents.find((x) => x.doc_type === 330)!;
      assert.deepEqual([Number(credit.total), credit.base_doc_type, credit.lead_id], [800, 305, NOA]);
      const back = fake.tables.payments.find((x) => x.source === 'credit')!;
      assert.deepEqual([Number(back.amount), back.direction, back.document_id], [800, 'out', credit.id]);
      assert.equal(pkg().status, 'cancelled');
      assert.equal(pkg().cancel_reason, 'עוברת דירה');
    });

    await step('a package paid at once (a tax invoice-receipt), sold from the packages screen', async () => {
      await goto('/finance/packages');
      await page.getByRole('button', { name: '+ מכירת חבילה' }).click();
      const d = dialog();
      await d.getByLabel('חיפוש לקוח/ה').fill('נועה');
      await d.getByRole('button', { name: /נועה לוי/ }).click();
      await d.getByRole('radio', { name: /6 טיפולי לייזר/ }).click();
      assert.ok(await d.getByRole('radio', { name: 'שולם עכשיו' }).getAttribute('aria-checked') === 'true', 'paid now by default');
      await d.getByRole('button', { name: 'מכירה והפקת המסמך' }).click();
      await page.getByText(/נמכרה 6 טיפולי לייזר לנועה לוי/).waitFor();
      const second = fake.tables.client_packages[1];
      const doc = fake.tables.documents.find((x) => x.id === second.document_id)!;
      assert.deepEqual([doc.doc_type, Number(doc.total)], [320, 1200]);
      assert.equal(fake.tables.payments.filter((x) => x.document_id === doc.id).reduce((a, x) => a + Number(x.amount), 0), 1200, 'its payment in the ledger');
    });

    await step('the product editor: a package’s terms (treatments, type, months) — a new package of the catalog', async () => {
      await goto('/finance/packages');
      await page.getByRole('button', { name: '+ חבילה חדשה' }).click();
      const d = dialog();
      await d.getByRole('heading', { name: 'חבילה חדשה' }).waitFor();
      await d.getByRole('heading', { name: 'תנאי החבילה' }).waitFor();
      await d.getByLabel('שם (בקופה, במסמכים ובאתר)').fill('זוג טיפולי מיצוק');
      await d.getByLabel('מחיר בקופה ₪ (כולל מע״מ)').fill('500');
      await d.getByLabel('מספר טיפולים').fill('2');
      await d.getByLabel('תוקף בחודשים (ריק = בלי הגבלה)').fill('3');
      await fits('the product editor with a package');
      await shot('k8-editor-package.png');
      await d.getByRole('button', { name: 'יצירת החבילה' }).click();
      await d.getByText(/נוצר/).first().waitFor();
      const item = fake.tables.catalog_items.find((x) => x.name === 'זוג טיפולי מיצוק')!;
      assert.deepEqual([item.kind, item.package_sessions, item.package_valid_months, item.package_type_id], ['package', 2, 3, null]);
    });

    await step('at 375: the packages screen and the card fit', async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      try {
        await goto('/finance/packages');
        await page.getByText('החבילות בקטלוג').waitFor();
        await fits('packages at 375');
        await card();
        await dialog().getByText('📦 חבילות').waitFor();
        await fits('the card at 375');
      } finally { await page.setViewportSize(PHONE); }
    });

    await step('no errors in the browser', async () => { assert.deepEqual(errors, []); });
  } finally { await ctx.close(); }

  await browser.close();
  try { process.kill(-dev.pid!, 'SIGTERM'); } catch { dev.kill('SIGTERM'); }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n# e2e packages: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
