/**
 * 2.117.4: a cheque in the payments editor (PaymentsEditor, the receipt on an invoice) needs its number, bank, branch and account
 * (chequeErrors) — the screen says what is missing, marks the fields with a star, and refuses to issue; once they are filled the receipt
 * is issued with the cheque's details. A phone (390) and a computer (1280), Hebrew / RTL, nothing sideways.
 * Run: npx -y tsx tests/e2e/payments-cheque.e2e.ts   (next dev on port 3239)
 * Screenshots: docs/screenshots/2.117.4/ (CHEQUE_SHOTS=<dir> to change).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { FakeSupabase, session, type Tables } from './fake-supabase';
import { FINANCE_SECTIONS } from '../../src/features/finance/routes';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_CHEQUE_PORT ?? 3239);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.CHEQUE_SHOTS ?? path.join(ROOT, 'docs/screenshots/2.117.4');
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
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
  'מסמכים': 'הכנסות', 'הכנסות': 'הכנסות', 'חייבים': 'הכנסות', 'הצעות מחיר': 'הכנסות', 'חבילות': 'הכנסות', 'דוחות': 'דוחות ורואה חשבון', 'רואה חשבון': 'דוחות ורואה חשבון',
  'פקודות יומן': 'דוחות ורואה חשבון',
};
const PATH_OF: Record<string, string> = Object.fromEntries(FINANCE_SECTIONS.map((s) => [s.label, s.path]));
// the menu of a business that did not turn the desks on: "קופות ובנק" is in it only once they are (2.95, cash-bank.e2e.ts)
const MENU = FINANCE_SECTIONS.filter((s) => s.id !== 'cash' && s.id !== 'bank');
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
    sales: [], documents: [{ ...base, id: '90000000-0000-4000-8000-0000000000c1', doc_type: 305, doc_number: 1, link_no: 1, issued_at: `${TODAY}T08:00:00Z`, doc_date: TODAY,
      customer_name: 'סלון דנה בע״מ', customer_phone: '0521234567', customer_dealer: '520013954', lead_id: DANA, before_discount: 1000, discount: 0, after_discount: 1000, vat_amount: 180, total: 1180,
      vat_rate: 18, lines: [{ name: 'טיפול', qty: 1, unitPriceExVat: 1000, discountExVat: 0, totalExVat: 1000, vatRate: 18, kind: 1 }], payments: [], print_count: 1,
      share_token: 'c'.repeat(64), issuer: null, source: 'direct', due_date: TODAY, notes: '' }], sale_refunds: [], stock_movements: [], register_shifts: [], appointments: [], booking_services: [],
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

  current = null;
  const MISSING = ['מספר הצ׳ק — ספרות בלבד', 'מספר הבנק — חובה בצ׳ק', 'מספר הסניף — חובה בצ׳ק', 'מספר החשבון — חובה בצ׳ק'];
  /** the receipt dialog of the open invoice, a cheque chosen and its number typed — nothing else */
  async function startCheque(p: any) {
    await p.getByText('סלון דנה בע״מ · חשבונית מס 1').waitFor({ timeout: 120_000 });
    await p.getByText('סלון דנה בע״מ · חשבונית מס 1').click();
    await dialog(p).getByRole('button', { name: 'קבלה על תשלום' }).click();
    const d = dialog(p);
    await d.getByRole('heading', { name: /תשלום על חשבונית מס 1/ }).waitFor();
    await d.getByLabel('אמצעי תשלום 1').selectOption('cheque');
    return d;
  }
  /** what the dialog says is missing, a star on each required field; a refusal on "הפקת קבלה" */
  async function missing(p: any, d: any, what: string, shotName: string) {
    for (const ph of ['מס׳ צ׳ק *', 'בנק *', 'סניף *', 'חשבון *']) await d.getByPlaceholder(ph).waitFor();
    await d.getByLabel('מספר צ׳ק').fill('1234');
    const alert = d.locator('[aria-live="polite"]').filter({ hasText: 'חובה בצ׳ק' });
    await alert.waitFor();
    const text = await alert.innerText();
    for (const m of MISSING.slice(1)) assert.ok(text.includes(m), `${what}: says "${m}" (${text})`);
    assert.ok(!text.includes(MISSING[0]), `${what}: the number was typed — not missing`);
    assert.equal(await alert.evaluate((e: Element) => getComputedStyle(e).direction), 'rtl');
    assert.equal(await alert.getAttribute('aria-live'), 'polite');
    await d.getByRole('button', { name: 'הפקת קבלה' }).click();
    await p.waitForTimeout(600);
    assert.equal(fake.tables.documents.filter((x: any) => x.doc_type === 400).length, 0, `${what}: a cheque without bank / branch / account is refused`);
    await d.getByText('מספר הבנק — חובה בצ׳ק').first().waitFor();
    const [sw, iw] = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw + 1, `${what}: nothing sideways (${sw} > ${iw})`);
    await shot(p, shotName);
  }

  await step('(א) phone 390: a cheque with only its number — the stars, what is missing, and the receipt refused', async () => {
    const m = await open({ access: 'full', userId: OWNER, path: '/finance/receivables' });
    current = m.page;
    const d = await startCheque(m.page);
    await missing(m.page, d, 'phone', 'cheque-missing-phone-390.png');
    await m.ctx.close();
    current = null;
  });

  await step('(ב) computer 1280: the same, and then with every field filled the receipt is issued with the cheque\'s details', async () => {
    const m = await open({ access: 'full', userId: OWNER, path: '/finance/receivables', desktop: true });
    await m.page.setViewportSize({ width: 1280, height: 800 });
    current = m.page;
    const d = await startCheque(m.page);
    await missing(m.page, d, 'computer', 'cheque-missing-desktop-1280.png');
    await d.getByLabel('מספר בנק').fill('12');
    await d.getByLabel('מספר סניף').fill('345');
    await d.getByLabel('מספר חשבון').fill('678901');
    await d.locator('[aria-live="polite"]').filter({ hasText: 'חובה בצ׳ק' }).waitFor({ state: 'detached' });   // the inline note goes; the refusal of the first try stays until the next try
    await d.getByRole('button', { name: 'הפקת קבלה' }).click();
    await m.page.getByText(/הופקה קבלה מס׳ 1/).waitFor();
    const r = fake.tables.documents.find((x: any) => x.doc_type === 400)!;
    const pay = (r.payments as any[])[0];
    assert.deepEqual([pay.cheque?.bank, pay.cheque?.branch, pay.cheque?.account, pay.cheque?.number], ['12', '345', '678901', '1234'], JSON.stringify(pay));
    await m.ctx.close();
    current = null;
  });

  await step('no errors in the browser', async () => { assert.deepEqual(errors, []); });

  await browser.close();
  try { process.kill(-dev.pid!, 'SIGTERM'); } catch { dev.kill('SIGTERM'); }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
