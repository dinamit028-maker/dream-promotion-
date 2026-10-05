/**
 * "כספים" (Dream Finance 2.51; an app of its own since 2.52) in a real browser (Chromium via Playwright), on a phone
 * (390×844, and 375 for sideways scrolling) and on a computer (1440×900), against the in-memory Supabase of
 * fake-supabase.ts (the accounting rules themselves are proven on Postgres in tests/sql).
 * The module's own shell: its header, the menu from the right (groups, one open at a time), the bottom bar, the "+",
 * every one of the 9 screens at its own address, the phone's back button, an old link, "חזרה ל-Dream", the business
 * switch, a locked business, the computer's sidebar and "חדש".
 * The money: a tax invoice from the contacts, the receivables and a reminder, a receipt, a credit invoice with money
 * back, a quote accepted and converted, an expense with its VAT share, the VAT working paper, the audit check, the CRM
 * card, the super admin's explicit opening, and the cashier who never gets here.
 *
 * Run: npm run test:e2e   (starts `next dev` on port 3218; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (f* — the money, m* — the module's shell).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { FakeSupabase, session, type Tables } from './fake-supabase';
import { FINANCE_SECTIONS } from '../../src/features/finance/routes';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_FINANCE_PORT ?? 3218);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-000000000002';
const OTHER_BIZ = 'b0000000-0000-4000-8000-000000000003';
const OWNER = 'a0000000-0000-4000-8000-0000000000a2';
const CASHIER = 'c0000000-0000-4000-8000-0000000000c2';
const ADMIN = 'a0000000-0000-4000-8000-0000000000ad';
const DANA = 'd0000000-0000-4000-8000-0000000000d2';
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
// the module's colour (globals.css --fin): teal in the dark theme, a deeper teal in the light one
const TEAL_DARK = 'rgb(45, 212, 191)';
const TEAL_LIGHT = 'rgb(15, 118, 110)';
// the phone's menu: the links that sit inside a group (the group opens first)
const GROUP_OF: Record<string, string> = {
  'מסמכים': 'הכנסות', 'הכנסות': 'הכנסות', 'חייבים': 'הכנסות', 'הצעות מחיר': 'הכנסות', 'דוחות': 'דוחות ורואה חשבון', 'רואה חשבון': 'דוחות ורואה חשבון',
};
const PATH_OF: Record<string, string> = Object.fromEntries(FINANCE_SECTIONS.map((s) => [s.label, s.path]));
const BAR: Record<string, string> = { 'לובי': '/finance', 'הכנסות': '/finance/income', 'הוצאות': '/finance/expenses', 'חייבים': '/finance/receivables' };
type Biz = { id: string; name: string; state: 'active' | 'locked' | 'expired' };

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
  for (const p of [...FINANCE_SECTIONS.map((s) => s.path), '/leads', '/register', '/dashboard']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@followme.test' });
  const errors: string[] = [];
  const popups: string[] = [];

  async function open(o: { access: 'full' | 'register'; userId: string; superAdmin?: boolean; path: string; desktop?: boolean; businesses?: Biz[] }) {
    const ctx = await browser.newContext(o.desktop
      ? { viewport: DESKTOP, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' }
      : { viewport: PHONE, deviceScaleFactor: 2, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', isMobile: true, hasTouch: true });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(o.userId, 'user@followme.test'))]);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    await ctx.route('http://sb.test/**', async (route: any) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      fake.opts.userId = o.userId;
      const r = fake.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
      return route.fulfill({ status: r.status, body: r.body ?? '', headers: { ...(r.headers ?? {}), ...cors } });
    });
    // the businesses this user may work in; switching (POST) is remembered, like the server does
    const list: Biz[] = o.businesses ?? [{ id: BIZ, name: 'FollowMe', state: 'active' }];
    let currentBiz = list[0].id;
    await ctx.route(`${BASE}/api/business/me`, (r: any) => {
      if (r.request().method() === 'POST') { currentBiz = JSON.parse(r.request().postData() ?? '{}').id; return r.fulfill({ json: { ok: true } }); }
      return r.fulfill({ json: { business: list.find((b) => b.id === currentBiz), businesses: list, superAdmin: Boolean(o.superAdmin), access: o.access } });
    });
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
    try { return await page.goto(`${BASE}${to}`, { waitUntil: 'domcontentloaded' }); }
    catch (e: any) { if (!/ERR_ABORTED/.test(String(e?.message))) throw e; return page.goto(`${BASE}${to}`, { waitUntil: 'domcontentloaded' }); }
  }
  let current: any = null;
  const step = async (name: string, fn: () => Promise<void>) => {
    if (current) for (let i = 0; i < 3 && await current.getByRole('dialog').count(); i++) await current.keyboard.press('Escape');
    try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false, error: e.message }); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 6).join('\n  ')}`); }
  };
  const dialog = (page: any) => page.getByRole('dialog').last();
  const at = (page: any, pathname: string) => page.waitForURL((u: URL) => u.pathname === pathname);
  const heading = (page: any, name: string) => page.getByRole('heading', { name, exact: true }).waitFor();
  /** until nothing on the page moves: a panel opening, a theme fading in (endless ones — a spinner — are not waited for) */
  const settle = (page: any) => page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
    .map((a) => a.finished.catch(() => null))));
  const shot = async (page: any, name: string) => {
    await settle(page);
    await page.screenshot({ path: path.join(SHOTS, name), ...(name.endsWith('.jpg') ? { quality: 82 } : {}) });
  };
  /** the phone's menu: open it, open the link's group when it is in one, tap the link — the screen's own address */
  const menuTo = async (page: any, label: string) => {
    await page.getByRole('button', { name: 'תפריט', exact: true }).click();
    const m = page.getByRole('dialog', { name: 'תפריט כספים' });
    await m.waitFor();
    const group = GROUP_OF[label];
    if (group) {
      const b = m.getByRole('button', { name: group, exact: true });
      if (await b.getAttribute('aria-expanded') !== 'true') await b.click();
    }
    await m.getByRole('link', { name: label, exact: true }).click();
    await at(page, PATH_OF[label]);
    await m.waitFor({ state: 'detached' });
    await heading(page, label);
  };
  /** the phone's bottom bar */
  const barTo = async (page: any, label: string) => {
    await page.getByRole('navigation', { name: 'ניווט כספים' }).getByRole('link', { name: label, exact: true }).click();
    await at(page, BAR[label]);
  };
  const noSideScroll = async (page: any, what: string) => {
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw + 1, `${what}: the page scrolls sideways (${sw} > ${iw})`);
  };
  /** every link and button on screen inside these is at least 44×44 (a finger, not a mouse) — measured once the panels
   *  stopped moving (a sheet opens from 97% of its size) */
  const touchTargets = async (page: any, selector: string, what: string) => {
    await settle(page);
    const small = await page.locator(selector).evaluateAll((roots: Element[]) => roots
      .flatMap((r) => [r, ...Array.from(r.querySelectorAll('a, button'))])
      .filter((e) => /^(A|BUTTON)$/.test(e.tagName) && e.getAttribute('tabindex') !== '-1')
      .map((e) => { const b = e.getBoundingClientRect(); return { t: (e.getAttribute('aria-label') || e.textContent || '').trim(), w: Math.round(b.width), h: Math.round(b.height),
        moving: document.getAnimations().map((a: any) => `${a.animationName}:${a.playState}:${Math.round(a.currentTime ?? -1)}`).join(','),
        transforms: (() => { const out: string[] = []; for (let x: Element | null = e; x; x = x.parentElement) { const t = getComputedStyle(x).transform; if (t !== 'none') out.push(t); } return out.join('|'); })() }; })
      .filter((x) => x.w > 0 && x.h > 0 && (x.w < 44 || x.h < 44)));
    assert.equal(small.length, 0, `${what}: touch targets under 44px: ${JSON.stringify(small)}`);
  };
  const bg = (loc: any) => loc.evaluate((e: Element) => getComputedStyle(e).backgroundColor);
  /** the names the "+" actions are announced by (a hint is their description, not their name) */
  const names = (links: any) => links.evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  const focused = (page: any) => page.evaluate(() => { const e = document.activeElement; return (e?.getAttribute('aria-label') || e?.textContent || '').trim(); });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  /** the screen fits a finger and an eye: nothing sideways, every control on the screen (or in a row that scrolls by
   *  design), and no text under 10px */
  const fits = async (page: any, what: string) => {
    await settle(page);
    await noSideScroll(page, what);
    // plain JavaScript in a string: the test runner's compiler would wrap named helpers in a function the page lacks
    const bad: string[] = await page.evaluate(`(() => {
      const w = window.innerWidth;
      const shown = function (e) { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const inScroller = function (e) {
        for (let p = e.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true; }
        return false;
      };
      const label = function (e) { return (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30); };
      const outside = Array.from(document.querySelectorAll('button, a, input, select, textarea'))
        .filter(function (e) { return shown(e) && !inScroller(e); })
        .filter(function (e) { const b = e.getBoundingClientRect(); return b.left < -1 || b.right > w + 1; })
        .map(function (e) { return 'off screen: "' + label(e) + '"'; });
      const tiny = Array.from(document.querySelectorAll('body *'))
        .filter(function (e) { return shown(e) && Array.from(e.childNodes).some(function (n) { return n.nodeType === 3 && (n.textContent || '').trim(); }); })
        .filter(function (e) { return parseFloat(getComputedStyle(e).fontSize) < 10; })
        .map(function (e) { return 'tiny text: "' + label(e) + '" ' + getComputedStyle(e).fontSize; });
      return outside.concat(tiny).slice(0, 8);
    })()`);
    assert.deepEqual(bad, [], `${what}: ${bad.join(' · ')}`);
  };

  const { page } = await open({ access: 'full', userId: OWNER, path: '/finance' });
  current = page;
  try {
    await page.getByRole('heading', { name: 'לובי כספים', exact: true }).waitFor({ timeout: 120_000 });

    await step('the overview on a phone: real numbers from the database, nothing sideways', async () => {
      await page.getByText('הכנסות (לפני מע״מ)').waitFor();
      await page.getByText('רווח משוער').waitFor();
      await noSideScroll(page, 'overview');
      await shot(page, 'f1-overview.png');
      assert.ok(fake.calls.some((c) => c.path.startsWith('/rest/v1/rpc/finance_summary')), 'the numbers come from finance_summary()');
    });

    await step('the module opens as an app of its own: its header, its bottom bar and "+", none of the app\'s menus', async () => {
      await heading(page, 'כספים · FollowMe');
      await page.getByRole('link', { name: 'חזרה ל-Dream' }).waitFor();
      const bar = page.getByRole('navigation', { name: 'ניווט כספים' });
      assert.deepEqual((await bar.locator('a, button').allInnerTexts()).map((t: string) => t.trim()), ['לובי', 'הכנסות', 'הוצאות', 'חייבים', 'תפריט']);
      assert.equal(await bar.getByRole('link', { name: 'לובי' }).getAttribute('aria-current'), 'page', 'the lobby is marked');
      const plus = page.getByRole('button', { name: 'יצירה חדשה' });
      await plus.waitFor();
      assert.equal(await bg(plus), TEAL_DARK, 'the "+" wears the module\'s colour');
      // the app's own menus are not there: no "עוד" (all the screens), no "+" for content, no sidebar
      assert.equal(await page.getByRole('button', { name: 'עוד', exact: true }).count(), 0);
      assert.equal(await page.getByRole('link', { name: 'יצירת תוכן חדש' }).count(), 0);
      assert.equal(await page.locator('aside[aria-label="ניווט ראשי"]').count(), 0);
      await touchTargets(page, 'header, nav[aria-label="ניווט כספים"], button[aria-label="יצירה חדשה"]', 'header, bottom bar and "+"');
      await noSideScroll(page, 'the module on a phone');
    });

    await step('the menu opens from the right: groups open one at a time, the screen on screen is marked; ✕, Escape and a tap outside close it', async () => {
      const menuButton = page.getByRole('button', { name: 'תפריט', exact: true });
      await menuButton.click();
      const m = page.getByRole('dialog', { name: 'תפריט כספים' });
      await m.waitFor();
      assert.equal(await menuButton.getAttribute('aria-expanded'), 'true');
      const panel = m.locator('.animate-drawer');
      await panel.evaluate((e: Element) => Promise.all(e.getAnimations().map((a) => a.finished)));
      const box = await panel.boundingBox();
      assert.ok(Math.abs(box.x + box.width - PHONE.width) <= 1 && box.width <= 340, `the menu sits on the right edge (${JSON.stringify(box)})`);
      assert.equal(await focused(page), 'סגירת התפריט', 'the focus moves into the menu');
      assert.equal(await m.getByRole('link', { name: 'לובי כספים' }).getAttribute('aria-current'), 'page');
      const income = m.getByRole('button', { name: 'הכנסות', exact: true });
      const reports = m.getByRole('button', { name: 'דוחות ורואה חשבון', exact: true });
      assert.deepEqual([await income.getAttribute('aria-expanded'), await reports.getAttribute('aria-expanded')], ['false', 'false']);
      await income.click();
      for (const l of ['מסמכים', 'הכנסות', 'חייבים', 'הצעות מחיר']) await m.getByRole('link', { name: l, exact: true }).waitFor();
      await reports.click();
      await m.getByRole('link', { name: 'רואה חשבון', exact: true }).waitFor();
      assert.equal(await income.getAttribute('aria-expanded'), 'false', 'opening a group closes the open one');
      assert.equal(await m.getByRole('link', { name: 'חייבים', exact: true }).count(), 0);
      await reports.click();
      assert.equal(await reports.getAttribute('aria-expanded'), 'false', 'tapping the open group closes it');
      // the personal area and the way back
      await m.getByText('user@followme.test').waitFor();
      await m.getByText('FollowMe', { exact: true }).waitFor();
      await m.getByRole('link', { name: 'חזרה ל-Dream' }).waitFor();
      assert.equal(await m.getByRole('button', { name: 'החלפת עסק' }).count(), 0, 'one business: nothing to switch');
      await income.click();
      await touchTargets(page, '[role="dialog"][aria-label="תפריט כספים"]', 'the menu');
      await noSideScroll(page, 'the menu');
      await shot(page, 'm2-phone-menu.jpg');
      // ✕ — and the focus returns to the menu button
      await m.getByRole('button', { name: 'סגירת התפריט' }).last().click();
      await m.waitFor({ state: 'detached' });
      assert.equal(await focused(page), 'תפריט', 'the focus returns to the menu button');
      assert.equal(await menuButton.getAttribute('aria-expanded'), 'false');
      // Escape
      await menuButton.click(); await m.waitFor();
      await page.keyboard.press('Escape'); await m.waitFor({ state: 'detached' });
      // a tap on the dimmed page beside it
      await menuButton.click(); await m.waitFor();
      await page.touchscreen.tap(20, 420); await m.waitFor({ state: 'detached' });
      // tapping the screen already on screen closes the menu too
      await menuButton.click(); await m.waitFor();
      await m.getByRole('link', { name: 'לובי כספים' }).click(); await m.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '', 'the page scrolls again');
    });

    await step('a tax invoice to a customer from the contacts: numbered, issuer kept, logged in the CRM', async () => {
      await menuTo(page, 'מסמכים');
      // until the software is registered with the Tax Authority, the documents say they are for testing
      if (!process.env.NEXT_PUBLIC_SOFTWARE_REG_NUMBER) await page.getByText(/התוכנה עוד לא רשומה ברשות המסים/).waitFor();
      await page.getByRole('button', { name: '+ מסמך חדש' }).click();
      const d = dialog(page);
      await d.getByRole('radio', { name: 'חשבונית מס', exact: true }).click();
      await d.getByLabel('חיפוש לקוח').fill('דנה');
      await d.getByRole('button', { name: /דנה כהן/ }).click();
      await d.getByLabel('תיאור שורה 1').fill('ייעוץ עסקי');
      await d.getByLabel('מחיר שורה 1').fill('1180');
      await d.getByText('₪1,180').first().waitFor();
      await noSideScroll(page, 'composer');
      await shot(page, 'f2-composer.png');
      await d.getByRole('button', { name: 'הפקת חשבונית מס' }).click();
      await page.getByRole('heading', { name: 'חשבונית מס 1' }).waitFor();
      const doc = fake.tables.documents.find((x) => x.doc_type === 305)!;
      assert.deepEqual([doc.doc_number, doc.total, doc.vat_amount, doc.after_discount, doc.lead_id, doc.customer_name, doc.customer_dealer],
        [1, 1180, 180, 1000, DANA, 'סלון דנה בע״מ', '520013954']);
      assert.match(doc.idempotency_key, /^direct:/);
      assert.equal(doc.issuer.name, 'פולו מי אופנה בע״מ');
      await page.getByText(/ח\.פ 515123456/).first().waitFor();
      assert.ok(fake.tables.lead_activities.some((a) => a.lead_id === DANA && /חשבונית מס מס׳ 1/.test(a.body)), 'the customer\'s history has it');
      await shot(page, 'f3-invoice.png');
    });

    await step('receivables: the reminder carries the real amount; a receipt closes the invoice', async () => {
      await page.keyboard.press('Escape');
      await barTo(page, 'חייבים');
      await page.getByText('סלון דנה בע״מ · חשבונית מס 1').waitFor();
      await page.getByRole('button', { name: 'תזכורת' }).click();
      const d = dialog(page);
      await d.getByText(/₪1,180 על חשבונית מס מס׳ 1/).waitFor();
      const href = await d.getByRole('link', { name: 'שליחה בוואטסאפ' }).getAttribute('href');
      assert.match(href ?? '', /wa\.me\/972521234567/);
      await shot(page, 'f4-reminder.png');
      await page.keyboard.press('Escape');
      await page.getByText('סלון דנה בע״מ · חשבונית מס 1').click();
      await dialog(page).getByRole('button', { name: 'קבלה על תשלום' }).click();
      await dialog(page).getByRole('button', { name: 'הפקת קבלה' }).click();
      await page.getByText(/הופקה קבלה מס׳ 1 · ₪1,180/).waitFor();
      const r = fake.tables.documents.find((x) => x.doc_type === 400)!;
      assert.equal(r.paid_document_id, fake.tables.documents.find((x) => x.doc_type === 305)!.id);
      assert.ok(fake.tables.payments.some((p) => p.document_id === r.id && p.direction === 'in' && p.amount === 1180 && p.method === 'transfer'), 'the ledger has the payment');
      for (let i = 0; i < 2 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
      await barTo(page, 'לובי'); await barTo(page, 'חייבים');
      await page.getByText('אין חובות פתוחים', { exact: false }).waitFor();
    });

    await step('a credit invoice on a paid sale, with the money paid back', async () => {
      await menuTo(page, 'מסמכים');
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
      await menuTo(page, 'הצעות מחיר');
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
      await barTo(page, 'הוצאות');
      await page.getByRole('button', { name: /\+ הוצאה/ }).click();
      const d = dialog(page);
      await d.getByLabel('ספק', { exact: true }).fill('תחנת דלק');
      await d.getByLabel('קטגוריה').selectOption('vehicle');
      await d.getByLabel('סה״כ (כולל מע״מ)').fill('354');
      await d.getByLabel(/מע״מ לקיזוז/).waitFor();
      assert.equal(await d.getByLabel(/מע״מ לקיזוז/).inputValue(), '66.67');
      await d.getByLabel('שולם').check();
      await noSideScroll(page, 'expense form');
      await shot(page, 'f5-expense.png');
      await d.getByRole('button', { name: 'אישור ושמירה' }).click();
      await page.getByText('תחנת דלק · רכב ודלק').waitFor();
      const e = fake.tables.expenses[0];
      assert.deepEqual([e.expense_number, e.amount_before_vat, e.vat_amount, e.total, e.vat_deductible_pct, e.paid_on, e.payment_method], [1, 300, 54, 354, 66.67, today, 'transfer']);
      assert.ok(fake.tables.payments.some((p) => p.expense_id === e.id && p.direction === 'out' && p.amount === 354));
      await menuTo(page, 'דוחות');
      // output VAT: 180 (305) + 18 (320) − 9 (330) + 360 (305 from the quote) = 549; deductible: 54 × 66.67% = 36 → 513
      await page.getByText('מע״מ לתשלום (להחזר אם שלילי)').waitFor();
      await page.getByText('₪513').first().waitFor();
      await shot(page, 'f6-reports.png');
    });

    await step('the accountant: the audit log is checked and intact', async () => {
      await menuTo(page, 'רואה חשבון');
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
      await menuTo(page, 'הגדרות כספים');
      await page.getByText('לא אומת מול פרסום רשמי').first().waitFor();
      await page.getByText('החיבור לרשות המסים לא הוגדר.').waitFor();
    });

    await step('every one of the 9 screens from the menu, at its own address; the phone\'s back button; a direct link; nothing sideways at 375', async () => {
      for (const s of FINANCE_SECTIONS) {
        await menuTo(page, s.label);
        await noSideScroll(page, s.label);
      }
      await shot(page, 'm1-phone-settings.jpg');
      // the phone's back button: the screen before, and the one before it; forward again
      await page.goBack(); await at(page, '/finance/accountant'); await heading(page, 'רואה חשבון');
      await page.goBack(); await at(page, '/finance/reports'); await heading(page, 'דוחות');
      await page.goForward(); await at(page, '/finance/accountant'); await heading(page, 'רואה חשבון');
      // a direct link (a refresh, a link in a message) opens that screen, and the bottom bar marks it
      await goto(page, '/finance/receivables');
      await heading(page, 'חייבים');
      assert.equal(await page.getByRole('navigation', { name: 'ניווט כספים' }).getByRole('link', { name: 'חייבים' }).getAttribute('aria-current'), 'page');
      // 375 wide (a small phone): every screen again, nothing sideways — the menu and the "+" too
      await page.setViewportSize({ width: 375, height: 812 });
      try {
        for (const s of FINANCE_SECTIONS) { await menuTo(page, s.label); await noSideScroll(page, `${s.label} at 375`); }
        await page.getByRole('button', { name: 'תפריט', exact: true }).click();
        await noSideScroll(page, 'the menu at 375');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'יצירה חדשה' }).click();
        await noSideScroll(page, '"+" at 375');
        await page.keyboard.press('Escape');
      } finally { await page.setViewportSize(PHONE); }
    });

    await step('an old link (/finance?tab=…) lands on the screen\'s own address and still does what it asked', async () => {
      const res = await goto(page, '/finance?tab=quotes&new=1');
      const from = res.request().redirectedFrom();
      assert.equal(from?.url(), `${BASE}/finance?tab=quotes&new=1`, 'it was redirected');
      assert.equal((await from.response()).status(), 307);
      assert.equal(new URL(res.url()).pathname + new URL(res.url()).search, '/finance/quotes?new=1');
      await dialog(page).getByRole('heading', { name: 'הצעת מחיר חדשה' }).waitFor();
      await page.waitForURL((u: URL) => u.pathname === '/finance/quotes' && !u.search);   // used once: a refresh does not open it again
      await page.keyboard.press('Escape');
    });

    await step('"+": the documents this business may issue, a quote and an expense — each opens its form', async () => {
      await barTo(page, 'לובי');
      const plus = page.getByRole('button', { name: 'יצירה חדשה' });
      const sheet = page.getByRole('dialog', { name: 'יצירה חדשה' });
      await plus.click();
      await sheet.waitFor();
      assert.deepEqual(await names(sheet.getByRole('link')), ['חשבונית מס', 'חשבונית מס / קבלה', 'קבלה', 'הצעת מחיר', 'הוצאה']);
      await touchTargets(page, '[role="dialog"][aria-label="יצירה חדשה"]', '"+"');
      await shot(page, 'm3-phone-new.jpg');
      await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'detached' });
      assert.equal(await focused(page), 'יצירה חדשה', 'the focus returns to "+"');
      // a receipt of a VAT business is issued on the invoice that was paid: "+" → "חייבים", which says how; the invoice
      // from the quote (₪2,360) is open — two taps to the receipt form
      await plus.click();
      await sheet.getByRole('link', { name: 'קבלה', exact: true }).click();
      await at(page, '/finance/receivables');
      await page.getByText('קבלה מופקת על החשבונית ששולמה: בוחרים אותה ברשימה, ואז "קבלה על תשלום".').waitFor();
      await page.waitForURL((u: URL) => u.pathname === '/finance/receivables' && !u.search);
      await page.getByText('סלון דנה בע״מ · חשבונית מס 2').click();
      await dialog(page).getByRole('button', { name: 'קבלה על תשלום' }).waitFor();
      await page.keyboard.press('Escape');
      await dialog(page).getByRole('button', { name: 'קבלה על תשלום' }).waitFor({ state: 'detached' });
      for (const [label, where, title] of [
        ['חשבונית מס', '/finance/documents', 'מסמך חדש'], ['חשבונית מס / קבלה', '/finance/documents', 'מסמך חדש'],
        ['הצעת מחיר', '/finance/quotes', 'הצעת מחיר חדשה'], ['הוצאה', '/finance/expenses', 'הוצאה חדשה'],
      ]) {
        await plus.click();
        await sheet.getByRole('link', { name: label, exact: true }).click();
        await at(page, where);
        const d = dialog(page);
        await d.getByRole('heading', { name: title, exact: true }).waitFor();
        if (where === '/finance/documents') assert.equal(await d.getByRole('radio', { name: label, exact: true }).getAttribute('aria-checked'), 'true', `${label} is the chosen type`);
        await page.waitForURL((u: URL) => u.pathname === where && !u.search);
        await page.keyboard.press('Escape');
        await d.getByRole('heading', { name: title, exact: true }).waitFor({ state: 'detached' });
      }
      assert.deepEqual([fake.tables.document_drafts.length, fake.tables.quotes.length, fake.tables.expenses.length], [0, 1, 1], 'opening a form saves nothing');
    });

    await step('the module\'s colour in the light theme too', async () => {
      await barTo(page, 'לובי');
      await page.getByText('רווח משוער').waitFor();
      await shot(page, 'm1-phone-lobby.jpg');
      await page.getByRole('button', { name: 'מעבר למצב בהיר' }).click();
      assert.equal(await bg(page.getByRole('button', { name: 'יצירה חדשה' })), TEAL_LIGHT);
      await shot(page, 'm4-phone-light.jpg');
      await page.getByRole('button', { name: 'מעבר למצב כהה' }).click();
      assert.equal(await bg(page.getByRole('button', { name: 'יצירה חדשה' })), TEAL_DARK);
    });

    await step('pilot widths — 375, 390, 430, tablet, computer: every finance screen, the forms (document, quote, expense, payment), the CRM card and the register fit, close and read', async () => {
      const saved = () => [fake.tables.documents.length, fake.tables.quotes.length, fake.tables.expenses.length, fake.tables.payments.length];
      const before = saved();
      const widths = [{ width: 375, height: 812 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }];
      try {
        for (const vp of widths) {
          await page.setViewportSize(vp);
          const w = `${vp.width}px`;
          for (const s of FINANCE_SECTIONS) {
            await goto(page, s.path);
            await heading(page, s.label);
            await fits(page, `${s.label} · ${w}`);
          }
          // the forms: each fits the screen with its buttons on it, and closes
          for (const [where, opener, title] of [
            ['/finance/documents', '+ מסמך חדש', 'מסמך חדש'], ['/finance/quotes', '+ הצעת מחיר', 'הצעת מחיר חדשה'], ['/finance/expenses', /\+ הוצאה/, 'הוצאה חדשה'],
          ] as const) {
            await goto(page, where);
            await page.getByRole('button', { name: opener }).first().click();
            const d = dialog(page);
            await d.getByRole('heading', { name: title }).waitFor();
            await fits(page, `${title} · ${w}`);
            await page.keyboard.press('Escape');
            await d.getByRole('heading', { name: title }).waitFor({ state: 'detached' });
          }
          // a payment on the open invoice: the receipt form, then everything closes
          await goto(page, '/finance/receivables');
          await page.getByText('סלון דנה בע״מ · חשבונית מס 2').click();
          await dialog(page).getByRole('button', { name: 'קבלה על תשלום' }).click();
          await dialog(page).getByRole('button', { name: 'הפקת קבלה' }).waitFor();
          await fits(page, `קבלה על תשלום · ${w}`);
          for (let i = 0; i < 3 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
          assert.equal(await page.getByRole('dialog').count(), 0, `${w}: the payment forms close`);
          // the customer's money in the CRM card, and the register
          await goto(page, '/leads');
          await page.getByRole('button', { name: /דנה כהן/ }).first().click();
          await dialog(page).getByRole('button', { name: /💰 כספים/ }).click();
          await dialog(page).getByText(/חשבונית מס 1 ·/).waitFor();
          await fits(page, `כרטיס CRM · ${w}`);
          await page.keyboard.press('Escape');
          await goto(page, '/register');
          await page.getByRole('heading', { name: 'קופה' }).waitFor();
          await fits(page, `קופה · ${w}`);
          if (vp.width === 430 || vp.width === 768) await shot(page, `m9-register-${vp.width}.jpg`);
        }
      } finally { await page.setViewportSize(PHONE); }
      assert.deepEqual(saved(), before, 'looking saved nothing');
    });

    await step('the CRM card: the customer\'s money, and a new document straight from it', async () => {
      await goto(page, '/leads');
      await page.getByRole('button', { name: /דנה כהן/ }).first().click();
      await dialog(page).getByRole('button', { name: /💰 כספים/ }).click();
      await dialog(page).getByText(/חשבונית מס 1 ·/).waitFor();
      await dialog(page).getByText(/אין חוב פתוח|חייב\/ת/).first().waitFor();
      await shot(page, 'f7-crm.png');
      await dialog(page).getByRole('link', { name: '🧾 הפקת מסמך' }).click();
      await at(page, '/finance/documents');
      await dialog(page).getByRole('heading', { name: 'מסמך חדש' }).waitFor();
      assert.equal(await dialog(page).getByLabel('שם הלקוח').inputValue(), 'סלון דנה בע״מ', 'the customer is filled in from the card');
    });

    await step('"חזרה ל-Dream": the app\'s home with its own menus; into the module again and out from its menu', async () => {
      await page.getByRole('link', { name: 'חזרה ל-Dream' }).click();
      await at(page, '/dashboard');
      await page.getByRole('button', { name: 'עוד', exact: true }).waitFor();
      assert.equal(await page.getByRole('navigation', { name: 'ניווט כספים' }).count(), 0, 'the module\'s bottom bar is gone');
      assert.equal(await page.getByRole('button', { name: 'יצירה חדשה' }).count(), 0, 'and its "+"');
      await page.getByRole('button', { name: 'עוד', exact: true }).click();
      await page.getByRole('dialog', { name: 'כל המסכים' }).getByRole('link', { name: 'כספים', exact: true }).click();
      await at(page, '/finance');
      await page.getByRole('navigation', { name: 'ניווט כספים' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'עוד', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'תפריט', exact: true }).click();
      await page.getByRole('dialog', { name: 'תפריט כספים' }).getByRole('link', { name: 'חזרה ל-Dream' }).click();
      await at(page, '/dashboard');
      await page.getByRole('button', { name: 'עוד', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '', 'the page scrolls again');
    });
  } finally { await page.context().close(); current = null; }

  await step('on a computer (1440): the module\'s sidebar with "חזרה ל-Dream" on top and a "חדש" button — no bottom bar, no floating "+"', async () => {
    const { ctx, page: p } = await open({ access: 'full', userId: OWNER, path: '/finance', desktop: true });
    current = p;
    try {
      const side = p.locator('aside[aria-label="ניווט כספים"]');
      await side.waitFor({ timeout: 120_000 });
      await p.getByText('רווח משוער').waitFor();
      assert.deepEqual((await side.getByRole('link').allInnerTexts()).map((t: string) => t.trim()),
        ['חזרה ל-Dream', 'לובי כספים', 'מסמכים', 'הכנסות', 'חייבים', 'הצעות מחיר', 'הוצאות', 'דוחות', 'רואה חשבון', 'הגדרות כספים']);
      for (const g of ['הכנסות', 'דוחות ורואה חשבון']) await side.locator('p', { hasText: new RegExp(`^${g}$`) }).waitFor();
      await heading(p, 'כספים · FollowMe');
      assert.equal(await p.getByRole('button', { name: 'תפריט', exact: true }).count(), 0, 'no bottom bar');
      assert.equal(await p.getByRole('button', { name: 'יצירה חדשה' }).count(), 0, 'no floating "+"');
      assert.equal(await p.locator('aside[aria-label="ניווט ראשי"]').count(), 0, 'not the app\'s sidebar');
      await noSideScroll(p, 'the module on a computer');
      await shot(p, 'm5-desktop.jpg');
      const add = p.getByRole('button', { name: 'חדש', exact: true });
      assert.equal(await bg(add), TEAL_DARK);
      await add.click();
      const list = p.getByRole('group', { name: 'יצירה חדשה' });
      assert.deepEqual(await names(list.getByRole('link')), ['חשבונית מס', 'חשבונית מס / קבלה', 'קבלה', 'הצעת מחיר', 'הוצאה']);
      await shot(p, 'm6-desktop-new.jpg');
      await p.keyboard.press('Escape');
      await list.waitFor({ state: 'detached' });
      await add.click();
      await list.getByRole('link', { name: 'הוצאה' }).click();
      await at(p, '/finance/expenses');
      await dialog(p).getByRole('heading', { name: 'הוצאה חדשה' }).waitFor();
      await p.keyboard.press('Escape');
      for (const s of FINANCE_SECTIONS) {
        const link = side.getByRole('link', { name: s.label, exact: true });
        await link.click();
        await at(p, s.path);
        await heading(p, s.label);
        assert.equal(await link.getAttribute('aria-current'), 'page', `${s.label} is marked`);
        await noSideScroll(p, `${s.label} (computer)`);
      }
      await side.getByRole('link', { name: 'מסמכים', exact: true }).click();
      await at(p, '/finance/documents');
      await p.getByRole('button', { name: 'מעבר למצב בהיר' }).click();
      assert.equal(await bg(add), TEAL_LIGHT);
      await shot(p, 'm7-desktop-light.jpg');
      await side.getByRole('link', { name: 'חזרה ל-Dream' }).click();
      await at(p, '/dashboard');
      await p.locator('aside[aria-label="ניווט ראשי"]').waitFor();
      assert.equal(await side.count(), 0, 'the module\'s sidebar is gone');
    } finally { await ctx.close(); current = null; }
  });

  await step('the business switch from the header and from the menu; a locked business keeps its notice inside the module', async () => {
    const { ctx, page: p } = await open({ access: 'full', userId: OWNER, path: '/finance',
      businesses: [{ id: BIZ, name: 'FollowMe', state: 'active' }, { id: OTHER_BIZ, name: 'סטודיו שני', state: 'locked' }] });
    current = p;
    try {
      const title = p.getByRole('button', { name: 'כספים · FollowMe — החלפת עסק' });
      await title.waitFor({ timeout: 120_000 });
      await title.click();
      const s = p.getByRole('dialog', { name: 'החלפת עסק' });
      await s.waitFor();
      assert.equal(await s.getByRole('button', { name: 'FollowMe', exact: true }).getAttribute('aria-current'), 'true', 'the current business is marked');
      await s.getByRole('button', { name: 'סטודיו שני (נעול)', exact: true }).waitFor();
      await touchTargets(p, '[role="dialog"][aria-label="החלפת עסק"]', 'the business switch');
      await shot(p, 'm8-phone-business.jpg');
      await p.keyboard.press('Escape');
      await s.waitFor({ state: 'detached' });
      // the same list from the menu; a tap switches (the server keeps the choice, the app reloads)
      await p.getByRole('button', { name: 'תפריט', exact: true }).click();
      await p.getByRole('dialog', { name: 'תפריט כספים' }).getByRole('button', { name: 'החלפת עסק' }).click();
      await s.waitFor();
      const [req] = await Promise.all([
        p.waitForRequest((r: any) => r.url() === `${BASE}/api/business/me` && r.method() === 'POST'),
        s.getByRole('button', { name: 'סטודיו שני (נעול)', exact: true }).click(),
      ]);
      assert.deepEqual(JSON.parse(req.postData()), { id: OTHER_BIZ });
      // after the reload: the other business, locked — the same notice as anywhere in the app, inside the module
      await p.getByRole('button', { name: 'כספים · סטודיו שני — החלפת עסק' }).waitFor({ timeout: 120_000 });
      await p.getByRole('alert').filter({ hasText: 'העסק "סטודיו שני" נעול כרגע' }).waitFor();
      await p.getByRole('navigation', { name: 'ניווט כספים' }).waitFor();
    } finally { await ctx.close(); current = null; }
  });

  await step('a super admin: the business\'s money is closed until opened with a reason (and that is logged)', async () => {
    fake.finance = { superAdmin: true, member: false, grantUntil: null, lockedUntil: null };
    const { ctx, page: p } = await open({ access: 'full', userId: ADMIN, superAdmin: true, path: '/finance' });
    try {
      await p.getByText('הנתונים הכספיים של העסק הזה סגורים').waitFor({ timeout: 120_000 }).catch(async (e: Error) => {
        await shot(p, 'f8-debug.png');
        console.log('URL:', p.url(), '\nTEXT:', (await p.locator('body').innerText()).slice(0, 800));
        throw e;
      });
      assert.equal(await p.getByText('הכנסות (לפני מע״מ)').count(), 0, 'nothing behind it');
      await p.getByLabel(/סיבה/).fill('בדיקת תקלה בדוח לבקשת הבעלים');
      await p.getByRole('button', { name: 'פתיחת גישה זמנית' }).click();
      await p.getByText(/גישת מנהל-על פתוחה עד/).waitFor();
      await p.getByText('הכנסות (לפני מע״מ)').waitFor();
      assert.ok(fake.tables.finance_audit_log.some((r) => r.action === 'support.access_opened' && r.actor_kind === 'super_admin'), 'the opening is in the business\'s log');
      await shot(p, 'f8-super-admin.png');
    } finally { await ctx.close(); fake.finance = { superAdmin: false, member: true, grantUntil: null, lockedUntil: null }; }
  });

  await step('a cashier never gets the money screens — nor the module\'s menus', async () => {
    const { ctx, page: p } = await open({ access: 'register', userId: CASHIER, path: '/finance/documents' });
    try {
      await p.waitForURL(/\/register$/, { timeout: 120_000 });
      assert.equal(await p.getByRole('link', { name: 'כספים' }).count(), 0);
      assert.equal(await p.getByRole('navigation', { name: 'ניווט כספים' }).count(), 0);
      assert.equal(await p.locator('aside[aria-label="ניווט כספים"]').count(), 0);
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
