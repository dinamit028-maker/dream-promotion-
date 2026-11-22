/**
 * 2.118, round 2 (complements export-scope.e2e.ts, which is left as it was): the message is now in the card "חבילה לרואה החשבון"
 * (ScopeNote), not a toast, and with no switch at the top (one active location left, a location closed since still picked on the
 * profile) it comes with a button "להציג את כל הסניפים".
 *   (1) one active location + a closed one picked: the package without the Tax Authority's part, the message in the card with the button;
 *   (2) the button: the app reloads on "all locations", and the package has INI.TXT / BKMVDATA.zip;
 *   (3) two active locations, one picked: the message in the card, NO button (the switch is there); a member limited: the same, no button.
 * Run: npx -y tsx tests/e2e/export-scope-hidden-switch.e2e.ts   (next dev on port 3229)
 * Screenshots: docs/screenshots/2.117.1/ (EXPORT_SCOPE_SHOTS=<dir> to change).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_EXPORT_SCOPE2_PORT ?? 3229);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.EXPORT_SCOPE_SHOTS ?? path.join(ROOT, 'docs/screenshots/2.117.1');
const BIZ = 'b0000000-0000-4000-8000-0000000000e1';
const OWNER = 'a0000000-0000-4000-8000-0000000000e1';
const NORTH = 'c0000000-0000-4000-8000-0000000000e1';
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 800 };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  return {
    brands: [{ ...base, name: 'קליניקה לייט', onboarded: true, industry: 'קוסמטיקה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'company', vat_rate: 18, pay_link: '', dealer_number: '000000109', legal_name: 'קליניקה לייט בע״מ',
      street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [], business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }],
    catalog_items: [], employees: [], leads: [], sales: [], register_shifts: [], booking_services: [], booking_settings: [], appointments: [],
    // two invoices, one in each location (the main location's id is the business's)
    documents: [
      { ...base, id: '90000000-0000-4000-8000-0000000000e1', doc_type: 305, doc_number: 1, link_no: 1, issued_at: `${today}T08:00:00Z`, doc_date: today,
        customer_name: 'דנה כהן', customer_phone: '', customer_dealer: '', lead_id: null, before_discount: 500, discount: 0, after_discount: 500, vat_amount: 90, total: 590,
        vat_rate: 18, lines: [{ name: 'טיפול', qty: 1, unitPriceExVat: 500, discountExVat: 0, totalExVat: 500, vatRate: 18, kind: 1 }], payments: [], print_count: 1,
        share_token: 'a'.repeat(64), issuer: null, source: 'direct', due_date: today, notes: '', location_id: BIZ },
      { ...base, id: '90000000-0000-4000-8000-0000000000e2', doc_type: 305, doc_number: 2, link_no: 2, issued_at: `${today}T09:00:00Z`, doc_date: today,
        customer_name: 'מיכל לוי', customer_phone: '', customer_dealer: '', lead_id: null, before_discount: 200, discount: 0, after_discount: 200, vat_amount: 36, total: 236,
        vat_rate: 18, lines: [{ name: 'טיפול', qty: 1, unitPriceExVat: 200, discountExVat: 0, totalExVat: 200, vatRate: 18, kind: 1 }], payments: [], print_count: 1,
        share_token: 'b'.repeat(64), issuer: null, source: 'direct', due_date: today, notes: '', location_id: NORTH },
    ],
    payments: [], expenses: [], sale_refunds: [], stock_movements: [], content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [],
    push_subscriptions: [], quotes: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [],
    payment_requests: [], payment_plans: [], payment_plan_items: [], client_packages: [], client_package_uses: [], client_sessions: [], client_treatments: [], treatment_types: [],
    business_locations: [{ id: NORTH, business_id: BIZ, name: 'סניף הצפון', kind: 'branch', address: 'הנשיא 5, חיפה', phone: '', hours: '', active: false, sort: 1, created_at: '2026-02-01T00:00:00Z' }],
    registers: [],
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
  for (const p of ['/finance/accountant', '/finance']) { for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; } }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@clinic.test' });
  const errors: string[] = [];
  const said: string[] = [];
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
    try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false, error: e.message }); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}\n  last requests:\n    ${calls.join('\n    ')}`); }
  };
  const theSwitch = (p: any = page) => p.locator('select[aria-label="הסניף שעובדים בו"]:visible');
  const accountant = async (p: any = page) => { await goto('/finance/accountant', p); await p.getByRole('heading', { name: 'רואה חשבון', exact: true }).waitFor({ timeout: 120_000 }); };
  const download = async (p: any = page) => {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60_000 }), p.getByRole('button', { name: 'הורדת החבילה (ZIP)' }).click()]);
    const zip = await JSZip.loadAsync(readFileSync(await dl.path()));
    return Object.keys(zip.files);
  };
  const OF = ['INI.TXT', 'BKMVDATA.zip', 'סיכום-הפקה-ממשק-פתוח.html', 'דוח-מסמכים-לפי-סוג.html'];
  const REST = ['מסמכים.csv', 'הוצאות.csv', 'יומן-תשלומים.csv', 'חייבים.csv'];
  const has = (names: string[], f: string) => names.some((n) => n.endsWith(f));
  /** nothing sideways; the message is in a Hebrew right-to-left block, not clipped */
  const fits = async (p: any, what: string) => {
    const [sw, iw] = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw + 1, `${what}: the page scrolls sideways (${sw} > ${iw})`);
  };
  const shot = async (p: any, name: string) => { await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, name) }); };
  const pickNorth = async (p: any = page) => {
    await Promise.all([p.waitForEvent('framenavigated', { timeout: 60_000 }), theSwitch(p).selectOption({ label: 'סניף הצפון' })]);
    await p.getByRole('heading', { name: 'רואה חשבון', exact: true }).waitFor({ timeout: 120_000 });
  };
  const MSG_ALL = "הקובץ לרשות המסים הוא של כל העסק — בחרו 'כל הסניפים' במתג";
  const MSG_LIMITED = 'רק מי שרואה את כל הסניפים יכול להפיק את הקובץ לרשות המסים';

  const NOTE = 'החבילה ירדה בלי הקובץ לרשות המסים:';
  const card = (p: any) => p.locator('div', { has: p.getByRole('button', { name: 'הורדת החבילה (ZIP)' }) }).last();
  const note = (p: any) => p.getByRole('alert').filter({ hasText: /הקובץ לרשות המסים|רק מי שרואה/ });
  const SHOWALL = (p: any) => p.getByRole('button', { name: 'להציג את כל הסניפים' });
  const inCard = async (p: any, msg: string) => {
    await p.getByText(NOTE).waitFor();
    const n = note(p); await n.waitFor();
    assert.ok((await n.innerText()).includes(msg), `the note says: ${msg}`);
    assert.equal(await n.evaluate((e: Element) => getComputedStyle(e).direction), 'rtl');
    // the note sits inside the accountant's package card, not in a floating toast
    assert.ok(await p.getByRole('button', { name: 'הורדת החבילה (ZIP)' }).evaluate((b: Element, el: Element) => { let c: Element | null = b; while (c) { if (c.contains(el)) return true; c = c.parentElement; if (c && c.tagName === 'MAIN') break; } return false; }, await n.elementHandle()), 'in the card');
  };

  try {
    await step('(1) one active location, a closed one still picked: no switch, the package without the file, the message in the card with the button', async () => {
      fake.currentLocation = NORTH;
      await accountant();
      assert.equal(await theSwitch().count(), 0, 'no switch: one active location');
      const names = await download();
      for (const f of REST) assert.ok(has(names, f), `${f} is in the package`);
      for (const f of OF) assert.ok(!has(names, f), `${f} is not in the package (${names.join(', ')})`);
      await inCard(page, MSG_ALL);
      await SHOWALL(page).waitFor();
      await fits(page, 'computer');
      await shot(page, 'export-scope-no-switch-desktop-1280.png');
      const m = await context(PHONE);
      await accountant(m.page);
      await download(m.page);
      await inCard(m.page, MSG_ALL);
      await SHOWALL(m.page).waitFor();
      assert.ok((await SHOWALL(m.page).boundingBox()).height >= 36, 'the button is a finger-sized target');
      await fits(m.page, 'phone 390');
      await m.page.getByRole('button', { name: 'הורדת החבילה (ZIP)' }).scrollIntoViewIfNeeded();
      await shot(m.page, 'export-scope-no-switch-phone-390.png');
      await m.ctx.close();
    });

    await step('(2) "להציג את כל הסניפים": the app reloads on all locations, and the package has INI.TXT and BKMVDATA.zip', async () => {
      await Promise.all([page.waitForEvent('framenavigated', { timeout: 60_000 }), SHOWALL(page).click()]);
      await page.getByRole('heading', { name: 'רואה חשבון', exact: true }).waitFor({ timeout: 120_000 });
      assert.equal(fake.currentLocation, null);
      const names = await download();
      for (const f of [...REST, ...OF]) assert.ok(has(names, f), `${f} is in the package (${names.join(', ')})`);
      assert.equal(await note(page).count(), 0, 'no note when the file is made');
    });

    await step('(3) two active locations, one picked: the message in the card without the button; a member limited: the same', async () => {
      fake.tables.business_locations.find((l) => l.id === NORTH)!.active = true;
      fake.currentLocation = NORTH;
      await accountant();
      await theSwitch().waitFor();
      await download();
      await inCard(page, MSG_ALL);
      assert.equal(await SHOWALL(page).count(), 0, 'the switch is there — no button');
      await fits(page, 'computer');
      await shot(page, 'export-scope-all-branches-desktop-1280.png');
      const m = await context(PHONE);
      await accountant(m.page);
      await download(m.page);
      await inCard(m.page, MSG_ALL);
      await fits(m.page, 'phone 390');
      await m.page.getByRole('button', { name: 'הורדת החבילה (ZIP)' }).scrollIntoViewIfNeeded();
      await shot(m.page, 'export-scope-all-branches-phone-390.png');
      await m.ctx.close();
      fake.memberLocations = [NORTH]; fake.currentLocation = null;
      await accountant();
      await download();
      await inCard(page, MSG_LIMITED);
      assert.equal(await SHOWALL(page).count(), 0, 'a limited member cannot show all — no button');
      await fits(page, 'limited, computer');
      await shot(page, 'export-scope-limited-desktop-1280.png');
      const l = await context(PHONE);
      await accountant(l.page);
      await download(l.page);
      await inCard(l.page, MSG_LIMITED);
      await fits(l.page, 'limited, phone 390');
      await l.page.getByRole('button', { name: 'הורדת החבילה (ZIP)' }).scrollIntoViewIfNeeded();
      await shot(l.page, 'export-scope-limited-phone-390.png');
      await l.ctx.close();
      fake.memberLocations = null;
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
