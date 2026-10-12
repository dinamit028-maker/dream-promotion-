/**
 * The search in the menu and the favorites (docs/FINANCE_ADDITIONS_HE.md T11; 2.96) in a real browser (Chromium via Playwright),
 * against the in-memory Supabase of fake-supabase.ts — for all of Dream, not only the money screens. The ranking and the rules of
 * the favorites are unit-tested (tests/menu-search.test.ts). Here the menus are clicked through:
 *   a computer: the search field at the top of the menu → "גבייה" → Enter → חייבים (the document's own example); Ctrl+K anywhere —
 *   arrows choose, Escape clears and then closes, nothing like it says so; inside כספים the same (its own sidebar and Ctrl+K —
 *   the window stays open while the screen adds its own links to the menu);
 *   a star next to a screen → "מועדפים" at the top of the menu and on the home screen, in the module's menu too, in the order
 *   starred; kept with the person (after a reload, and on another device); off again; twelve at most; a save that fails puts
 *   the star back and says so;
 *   a phone: "עוד" → the search and the favorites, a star on a tile; inside כספים the drawer has both; 375 wide — all of it fits.
 *
 * Run: npx -y tsx tests/e2e/nav.e2e.ts   (starts `next dev` on port 3234; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (nav* — not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_NAV_PORT ?? 3234);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000000c6';
const OWNER = 'a0000000-0000-4000-8000-0000000000c6';
const DANA = 'e0000000-0000-4000-8000-0000000000c1';
const PHONE_VIEW = { width: 390, height: 844 };
const NARROW = { width: 375, height: 740 };
const DESK = { width: 1440, height: 900 };
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  const issuer = { name: 'סטודיו נועה', dealerNumber: '034567891', entityType: 'licensed_dealer' };
  return {
    brands: [{ ...base, name: 'סטודיו נועה', onboarded: true, industry: 'קוסמטיקה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'licensed_dealer', vat_rate: 18, pay_link: '', dealer_number: '034567891', legal_name: 'סטודיו נועה',
      street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [], business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }],
    business_locations: [{ id: BIZ, business_id: BIZ, name: 'ראשי', kind: 'clinic', address: '', phone: '', hours: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' }],
    registers: [{ id: BIZ, business_id: BIZ, location_id: BIZ, name: 'קופה 1', device: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' }],
    leads: [{ ...base, id: DANA, name: 'דנה כהן', phone: '0521234567', source: 'ידני', status: 'חדש', date: '2026-01-01', tags: [], value: 0, notes: '' }],
    // Dana's invoice, open — something on the receivables' screen
    documents: [{ ...base, id: '90000000-0000-4000-8000-0000000000c1', doc_type: 305, doc_number: 1, link_no: 1, issued_at: `${TODAY}T08:00:00Z`, doc_date: TODAY,
      customer_name: 'דנה כהן', customer_phone: '0521234567', customer_dealer: '', lead_id: DANA, before_discount: 500, discount: 0, after_discount: 500, vat_amount: 90, total: 590,
      vat_rate: 18, lines: [{ name: 'טיפול', qty: 1, unitPriceExVat: 500, discountExVat: 0, totalExVat: 500, vatRate: 18, kind: 1 }], payments: [], print_count: 1,
      share_token: 'c'.repeat(64), issuer, source: 'direct', due_date: TODAY, notes: '', location_id: BIZ }],
    payments: [], expenses: [], journal_entries: [],
    catalog_items: [], catalog_variants: [], catalog_options: [], stock_levels: [], stock_transfers: [], stock_counts: [], stock_reservations: [], stock_movements: [],
    catalog_serials: [], catalog_serial_events: [], price_lists: [], price_list_items: [], sku_series: [], treatment_types: [],
    stores: [], store_domains: [], store_theme_versions: [], store_pages: [], store_menus: [],
    employees: [], sales: [], register_shifts: [], booking_services: [], appointments: [],
    sale_refunds: [], content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [],
    push_subscriptions: [], quotes: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [],
    payment_requests: [], payment_plans: [], payment_plan_items: [], client_packages: [], client_package_uses: [], client_sessions: [], client_treatments: [],
    catalog_media: [], catalog_field_defs: [], catalog_collections: [], debt_reminders: [], debt_reminder_stops: [], recurring_plans: [], recurring_charges: [],
    bank_deposits: [], bank_deposit_cheques: [], bank_statements: [], bank_lines: [], bank_matches: [], cheque_reminders: [],
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
  for (const p of ['/dashboard', '/leads', '/finance/receivables', '/finance', '/finance/reports', '/appointments']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@studio.test' });
  const errors: string[] = [];
  const calls: string[] = [];
  /** a save of the person's data that fails (the network is down) — the star goes back */
  let saveFails = false;

  async function context(viewport: { width: number; height: number }) {
    const phone = viewport.width < 600;
    const ctx = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem',
      ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@studio.test'))]);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    await ctx.route('http://sb.test/**', async (route: any) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const where = `${req.method()} ${req.url().replace('http://sb.test', '').slice(0, 140)}`;
      if (saveFails && req.method() === 'PUT' && req.url().endsWith('/auth/v1/user')) {
        calls.push(`500 ${where} (made to fail)`);
        return route.fulfill({ status: 500, json: { code: 500, msg: 'down' }, headers: cors });
      }
      try {
        const r = fake.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
        calls.push(`${r.status} ${where}${r.status >= 400 ? ` ${String(r.body ?? '').slice(0, 160)}` : ''}`); calls.splice(0, calls.length - 14);
        return route.fulfill({ status: r.status, body: r.body ?? '', headers: { ...(r.headers ?? {}), ...cors } });
      } catch (e: any) {
        calls.push(`THROW ${where}: ${e?.message}`);
        return route.fulfill({ status: 500, json: { message: `fake: ${e?.message}` }, headers: cors });
      }
    });
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'סטודיו נועה', state: 'active' },
      businesses: [{ id: BIZ, name: 'סטודיו נועה', state: 'active' }], superAdmin: false, access: 'full' } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
    await ctx.route(`${BASE}/api/notify/sale`, (r: any) => r.fulfill({ json: { sent: 0 } }));
    await ctx.route(`${BASE}/api/finance/tax/status`, (r: any) => r.fulfill({ json: { mode: 'unconfigured', configured: false, connection: null, message: 'החיבור לרשות המסים לא הוגדר.' } }));
    await ctx.route(`${BASE}/api/client-file/**`, (r: any) => r.fulfill({ status: 403, json: { code: 'no_access', message: 'אין גישה' } }));
    await ctx.route(`${BASE}/api/store/**`, (r: any) => r.fulfill({ json: { ok: true, domains: [], vercel: 'not_configured', connected: false } }));
    await ctx.route(`${BASE}/api/ai/**`, (r: any) => r.fulfill({ json: { configured: false } }));
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(e.message));
    page.on('dialog', (d: any) => d.accept());
    return { ctx, page };
  }
  let { ctx, page } = await context(DESK);
  const goto = async (to: string, p: any = page) => {
    try { return await p.goto(`${BASE}${to}`, { waitUntil: 'domcontentloaded' }); }
    catch (e: any) { if (!/ERR_ABORTED/.test(String(e?.message))) throw e; return p.goto(`${BASE}${to}`, { waitUntil: 'domcontentloaded' }); }
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    for (let i = 0; i < 4 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('the step did not end in 150s')), 150_000); });
    try { await Promise.race([fn(), late]); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false, error: e.message }); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}\n  last requests:\n    ${calls.join('\n    ')}`);
      await page.screenshot({ path: path.join(SHOTS, `nav-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
    finally { clearTimeout(timer); }
  };
  const shot = async (name: string, p: any = page) => { await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, name), fullPage: true }); };
  const side = (p: any = page) => p.getByRole('complementary', { name: 'ניווט ראשי' });
  const finSide = (p: any = page) => p.getByRole('complementary', { name: 'ניווט כספים' });
  const home = async (p: any = page) => { await goto('/dashboard', p); await p.getByText('מה ניצור היום?').waitFor({ timeout: 120_000 }); };
  const search = (p: any = page) => p.getByRole('dialog', { name: 'חיפוש בתפריט' });
  const box = (where: any) => where.getByRole('combobox', { name: 'חיפוש בתפריט' });
  const options = async (where: any): Promise<string[]> => (await where.getByRole('option').allInnerTexts()).map((x: string) => x.replace(/\s+/g, ' ').trim());
  const favs = (where: any) => where.getByRole('group', { name: 'מועדפים' });
  /** Ctrl+K — the shortcut is on once the page is ready (the business checked): pressed again until the window opens */
  const ctrlK = async (p: any = page) => {
    for (let i = 0; i < 8; i++) {
      await p.keyboard.press('Control+k');
      if (await search(p).waitFor({ timeout: 1500 }).then(() => true, () => false)) return;
    }
    throw new Error('Ctrl+K did not open the search');
  };
  const saved = () => fake.userMeta.dp_favorites as string[] | undefined;
  // the width of the screen itself (clientWidth): on a phone (isMobile) innerWidth grows with a page that is too wide; measured
  // once a drawer has slid in (the animations that end — not a spinner's)
  const fits = async (p: any, what: string) => {
    await p.evaluate(`Promise.all(document.getAnimations().filter(function (a) { var t = a.effect && a.effect.getTiming(); return t && t.iterations !== Infinity; })
      .map(function (a) { return a.finished.catch(function () { return null; }); }))`);
    const bad: string[] = await p.evaluate(`(() => {
      const w = document.documentElement.clientWidth, out = [];
      if (document.documentElement.scrollWidth > w + 1) out.push('the page scrolls sideways: ' + document.documentElement.scrollWidth);
      const shown = function (e) { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const inScroller = function (e) { for (let p = e.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
      Array.from(document.querySelectorAll('button, a, input, select, textarea')).filter(function (e) { return shown(e) && !inScroller(e); })
        .filter(function (e) { const b = e.getBoundingClientRect(); return b.left < -1 || b.right > w + 1; })
        .forEach(function (e) { out.push('off screen: "' + (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30) + '"'); });
      return out.slice(0, 8);
    })()`);
    assert.deepEqual(bad, [], `${what}: ${bad.join(' · ')}`);
  };

  try {
    await step('a computer: the search field at the top of the menu → "גבייה" → Enter → חייבים', async () => {
      await home();
      await side().getByRole('button', { name: 'חיפוש בתפריט' }).click();
      const d = search();
      await d.waitFor();
      assert.equal(await box(d).evaluate((e: Element) => e === document.activeElement), true, 'the box is ready to type in');
      await box(d).fill('גבייה');
      const found = await options(d);
      assert.match(found[0], /^חייבים כספים$/, found.join(' | '));
      assert.equal(await d.getByRole('option').first().getAttribute('aria-selected'), 'true');
      await shot('nav-1-search.png');
      await box(d).press('Enter');
      await page.waitForURL('**/finance/receivables', { timeout: 120_000 });
      await finSide().getByRole('link', { name: 'חייבים' }).waitFor({ timeout: 120_000 });
      assert.equal(await search().count(), 0, 'the window closed');
    });

    await step('Ctrl+K anywhere: nothing like it says so, Escape clears and then closes, arrows choose', async () => {
      await goto('/leads');
      await page.getByText('דנה כהן').first().waitFor({ timeout: 120_000 });
      await ctrlK();
      const d = search();
      await box(d).fill('שוקולד');
      await d.getByText('אין מסך כזה בתפריט.').waitFor();
      await box(d).press('Escape');
      assert.equal(await box(d).inputValue(), '', 'the first Escape clears');
      assert.equal(await search().count(), 1, 'still open');
      await box(d).fill('כרטסת');
      const found = await options(d);
      assert.ok(found.length >= 2 && found.every((x) => /כרטסת/.test(x)), found.join(' | '));
      await box(d).press('ArrowDown');
      assert.equal(await d.getByRole('option').nth(1).getAttribute('aria-selected'), 'true');
      const second = found[1];
      await box(d).press('Enter');
      await page.waitForURL(/\/finance\/reports\?view=(cledger|sledger)/, { timeout: 120_000 });
      assert.equal(page.url().includes('view=cledger'), /לקוח/.test(second), `${second} → ${page.url()}`);
      // Escape on an empty box closes the window
      await page.getByText(/כרטסת/).first().waitFor({ timeout: 120_000 });
      await ctrlK();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      assert.equal(await search().count(), 0, 'closed');
    });

    await step('inside כספים: its own search field and Ctrl+K — "פקודה ידנית" → the journal', async () => {
      await goto('/finance');
      await page.getByRole('heading', { name: 'לובי כספים' }).waitFor({ timeout: 120_000 });
      await finSide().getByRole('button', { name: 'חיפוש בתפריט' }).click();
      const d = search();
      await box(d).fill('פקודה ידנית');
      assert.match((await options(d))[0], /^פקודות יומן כספים$/);
      await box(d).press('Enter');
      await page.waitForURL('**/finance/journal', { timeout: 120_000 });
      // the screen loads its own links into the menu ("פקודות יומן") — the search window opened now stays open
      await ctrlK();
      await page.waitForTimeout(1500);
      assert.equal(await search().count(), 1, 'still open');
      await box(search()).fill('קוד הנחה');
      assert.match((await options(search()))[0], /^קופונים חנות$/);
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    });

    await step('a star next to a screen → "מועדפים" at the top of the menu and on the home screen, in the order starred', async () => {
      await home();
      await page.getByText('☆ ליד מסך בתפריט — והוא יופיע כאן, במועדפים, ובראש התפריט.').waitFor();
      assert.equal(await favs(side()).count(), 0, 'no favorites yet: nothing at the top of the menu');
      await side().getByRole('link', { name: 'לקוחות' }).hover();
      const star = side().getByRole('button', { name: 'הוספה למועדפים: לקוחות' });
      await star.click();
      await favs(side()).getByRole('link', { name: 'לקוחות' }).waitFor();
      assert.equal(await side().getByRole('button', { name: 'הסרה מהמועדפים: לקוחות' }).first().getAttribute('aria-pressed'), 'true');
      assert.deepEqual(saved(), ['/leads'], 'kept with the person');
      // a screen inside כספים, from its own menu
      await goto('/finance/receivables');
      await finSide().getByRole('link', { name: 'חייבים' }).hover();
      await finSide().getByRole('button', { name: 'הוספה למועדפים: חייבים' }).click();
      await favs(finSide()).getByRole('link', { name: 'חייבים' }).waitFor();
      await favs(finSide()).getByRole('link', { name: 'לקוחות' }).waitFor();
      assert.deepEqual(saved(), ['/leads', '/finance/receivables']);
      // from a module's favorites back to the app's screen
      await favs(finSide()).getByRole('link', { name: 'לקוחות' }).click();
      await page.waitForURL('**/leads');
      await home();
      const h = page.getByRole('region', { name: 'מועדפים' });
      assert.deepEqual((await h.getByRole('link').allInnerTexts()).map((x: string) => x.replace(/\s+/g, ' ').trim()), ['לקוחות', 'חייבים · כספים']);
      assert.equal(await page.getByText('☆ ליד מסך בתפריט').count(), 0, 'no hint once there are favorites');
      await shot('nav-2-home.png');
      await h.getByRole('link', { name: /חייבים/ }).click();
      await page.waitForURL('**/finance/receivables');
    });

    await step('kept with the person: after a reload, and on another device', async () => {
      await home();
      await favs(side()).getByRole('link', { name: 'חייבים' }).waitFor();
      await ctx.close();
      ({ ctx, page } = await context(DESK));
      await home();
      await favs(side()).getByRole('link', { name: 'לקוחות' }).waitFor({ timeout: 60_000 });
      await favs(side()).getByRole('link', { name: 'חייבים' }).waitFor();
    });

    await step('off again: the star in the favorites; twelve at most; a save that fails puts the star back', async () => {
      await home();
      await favs(side()).getByRole('button', { name: 'הסרה מהמועדפים: לקוחות' }).click();
      await page.waitForTimeout(300);
      assert.deepEqual(saved(), ['/finance/receivables']);
      assert.equal(await favs(side()).getByRole('link', { name: 'לקוחות' }).count(), 0);
      // twelve: another one is refused, and says so
      fake.userMeta.dp_favorites = ['/finance/receivables', '/dashboard', '/create', '/reels', '/content', '/calendar', '/media', '/strategy', '/ads', '/appointments', '/register', '/finance'];
      await home();
      await favs(side()).getByRole('link', { name: 'חייבים' }).waitFor();
      await side().getByRole('link', { name: 'לקוחות' }).hover();
      await side().getByRole('button', { name: 'הוספה למועדפים: לקוחות' }).click();
      await side().getByRole('status').filter({ hasText: 'אפשר עד 12 מועדפים — מסירים אחד קודם' }).waitFor();
      assert.equal(saved()!.length, 12);
      // the network down: the star goes back, and says so
      fake.userMeta.dp_favorites = ['/finance/receivables'];
      await home();
      await favs(side()).getByRole('link', { name: 'חייבים' }).waitFor();
      saveFails = true;
      try {
        await side().getByRole('link', { name: 'תורים' }).hover();
        await side().getByRole('button', { name: 'הוספה למועדפים: תורים' }).click();
        await side().getByRole('status').filter({ hasText: 'המועדפים לא נשמרו — בדקו את החיבור ונסו שוב' }).waitFor();
        assert.equal(await favs(side()).getByRole('link', { name: 'תורים' }).count(), 0, 'not in the favorites');
        assert.equal(await side().getByRole('button', { name: 'הוספה למועדפים: תורים' }).getAttribute('aria-pressed'), 'false');
        assert.deepEqual(saved(), ['/finance/receivables']);
      } finally { saveFails = false; }
    });

    await step('a phone: "עוד" → the search ("גבייה") and the favorites; a star on a tile', async () => {
      const { page: phone } = await context(PHONE_VIEW);
      await home(phone);
      await phone.getByRole('navigation', { name: 'ניווט' }).getByRole('button', { name: 'עוד' }).click();
      const sheet = phone.getByRole('dialog', { name: 'כל המסכים' });
      await favs(sheet).getByRole('link', { name: 'חייבים' }).waitFor();
      await sheet.getByRole('button', { name: 'הוספה למועדפים: תורים' }).click();
      await favs(sheet).getByRole('link', { name: 'תורים' }).waitFor();
      assert.deepEqual(saved(), ['/finance/receivables', '/appointments']);
      await fits(phone, 'the sheet of every screen');
      await box(sheet).fill('גבייה');
      assert.match((await options(sheet))[0], /^חייבים כספים$/);
      await fits(phone, 'the sheet · the search');
      await shot('nav-3-phone-sheet.png', phone);
      await sheet.getByRole('option').first().click();
      await phone.waitForURL('**/finance/receivables', { timeout: 120_000 });
      // inside כספים: the drawer of the menu has both
      await phone.getByRole('navigation', { name: 'ניווט כספים' }).getByRole('button', { name: 'תפריט' }).click();
      const drawer = phone.getByRole('dialog', { name: 'תפריט כספים' });
      await favs(drawer).getByRole('link', { name: 'תורים' }).waitFor();
      await drawer.getByRole('button', { name: 'הוספה למועדפים: הוצאות' }).waitFor();
      await box(drawer).fill('מעמ');
      assert.match((await options(drawer))[0], /^דוחות כספים$/);
      await fits(phone, 'the drawer of כספים · the search');
      await shot('nav-4-phone-drawer.png', phone);
      await drawer.getByRole('option').first().click();
      await phone.waitForURL('**/finance/reports', { timeout: 120_000 });
    });

    await step('375 wide: the sheet, the search and the favorites fit', async () => {
      const { page: narrow } = await context(NARROW);
      await home(narrow);
      await narrow.getByRole('region', { name: 'מועדפים' }).waitFor();
      await fits(narrow, 'the home screen with favorites');
      await narrow.getByRole('navigation', { name: 'ניווט' }).getByRole('button', { name: 'עוד' }).click();
      const sheet = narrow.getByRole('dialog', { name: 'כל המסכים' });
      await favs(sheet).getByRole('link', { name: 'תורים' }).waitFor();
      await box(sheet).fill('ח');
      await fits(narrow, 'the sheet at 375 · the search');
      await shot('nav-5-375.png', narrow);
    });

    assert.deepEqual(errors, [], `page errors: ${errors.join(' · ')}`);
  } finally {
    await browser.close().catch(() => null);
    try { process.kill(-dev.pid!, 'SIGTERM'); } catch { /* gone */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (errors.length) console.log(`page errors: ${errors.join(' · ')}`);
  process.exit(failed.length || errors.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
