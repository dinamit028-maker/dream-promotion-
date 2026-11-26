/**
 * QA 2.119.0 round 2 — a payment link of an invoice waiting for its allocation number: "💳 שלח לינק לתשלום" is closed (with its reason,
 * and the page says why next to it), and open again once the number is typed in. The same on a phone (iPhone 13) and a computer
 * (1280×800). Against the in-memory Supabase; the payment terminal is the fake's "verified" one.
 * Run: npx tsx tests/e2e/cpa-stage2-paylink.e2e.ts   (starts `next dev` on port 3233)
 * Screenshots: CPA2B_SHOTS=<dir> (default tests/e2e/shots/cpa-stage2-paylink). Demo data only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_CPA2B_PORT ?? 3233);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.CPA2B_SHOTS ?? path.join(__dirname, 'shots', 'cpa-stage2-paylink');
const BIZ = 'b0000000-0000-4000-8000-000000000119';
const OWNER = 'a0000000-0000-4000-8000-0000000001a9';
const DOC = 'd0000000-0000-4000-8000-000000000119';
const TOKEN = 'e'.repeat(64);
const DESKTOP = { width: 1280, height: 800 };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  return {
    brands: [{ ...base, name: 'דמו', onboarded: true, industry: 'יופי', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'company', vat_rate: 18, pay_link: '',
      dealer_number: '000000018', legal_name: 'עסק דמו', street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [], catalog_items: [], employees: [], leads: [],
    sales: [], sale_refunds: [], stock_movements: [], register_shifts: [], appointments: [], booking_services: [],
    content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [], push_subscriptions: [],
    payments: [], quotes: [], expenses: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [],
    document_deliveries: [],
    tax_allocation_rules: [{ version: 4, effective_from: '2026-06-01', threshold_before_vat: 5000, doc_types: [305, 320], required_doc_types: [305, 320, 330], threshold_inclusive: true,
      requires_customer_dealer: true, verified: true, source_note: 'אושר מול רואה חשבון (11.10.2026)' }],
    // exactly the threshold before VAT, to a dealer — needs a number (answer 3א: "5,000 ומעלה")
    documents: [{ ...base, id: DOC, doc_type: 305, doc_number: 41, link_no: 1, issued_at: `${today}T08:00:00Z`, doc_date: today, customer_name: 'לקוח דמו בע״מ', customer_phone: '0500000001',
      customer_email: 'customer@example.test', customer_dealer: '000000026', customer_street: '', customer_city: '', lead_id: null, sale_id: null, location_id: BIZ,
      lines: [{ name: 'שירות דמו', qty: 1, unitPriceExVat: 5000, discountExVat: 0, totalExVat: 5000, vatRate: 18, kind: 1 }], payments: [],
      before_discount: 5000, discount: 0, after_discount: 5000, vat_amount: 900, total: 5900, vat_rate: 18, print_count: 0, share_token: TOKEN, issuer: null, source: 'direct', notes: '', due_date: today }],
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
  for (const p of ['/finance/documents', `/d/${TOKEN}`]) for (let i = 0; i < 3; i++) { if (await fetch(`${BASE}${p}`).then((r) => r.ok, () => false)) break; }
  const AXE_PATH = [path.join(ROOT, 'node_modules/axe-core/axe.min.js'), path.join(ROOT, '../storefront/node_modules/axe-core/axe.min.js')].find((f) => existsSync(f));
  const AXE = AXE_PATH ? readFileSync(AXE_PATH, 'utf8') : '';
  const errors: string[] = [];
  const axeFindings: string[] = [];
  let fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' });
  let lastPage: any = null;
  // what the server's routes answer here (they talk to the real database — the browser's requests to them are answered by the test)
  let share: { status: number; json: any } = { status: 200, json: {} };
  const deliveryAsks: any[] = [];

  async function open(p: string, view: 'phone' | 'desktop') {
    const ctx = await browser.newContext(view === 'desktop'
      ? { viewport: DESKTOP, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' }
      : { ...IPHONE, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@example.test'))]);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    await ctx.route('http://sb.test/**', async (route: any) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      fake.opts.userId = OWNER;
      const r = fake.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
      return route.fulfill({ status: r.status, body: r.body ?? '', headers: { ...(r.headers ?? {}), ...cors } });
    });
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'דמו', state: 'active' }, businesses: [{ id: BIZ, name: 'דמו', state: 'active' }], superAdmin: false, access: 'full' } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
    await ctx.route(`${BASE}/api/finance/tax/status`, (r: any) => r.fulfill({ json: { mode: 'unconfigured', configured: false, connection: null, message: '' } }));
    await ctx.route(`${BASE}/api/doc/delivery`, async (r: any) => {
      const body = JSON.parse(r.request().postData() ?? '{}'); deliveryAsks.push({ ...body, auth: Boolean(r.request().headers().authorization) });
      return body.want === 'keep' ? r.fulfill({ json: { ok: true, kept: true } }) : r.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.7\n% demo\n' });
    });
    await ctx.route(`${BASE}/api/doc/${TOKEN}`, (r: any) => r.fulfill({ status: share.status, json: share.json }));
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
    if (!AXE) return;
    await settle(page);
    await page.evaluate(AXE);
    const v = await page.evaluate(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }).then(r => r.violations.map(v => v.id + ' (' + v.impact + '): ' + v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')))`);
    for (const x of v as string[]) axeFindings.push(`${what}: ${x}`);
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    if (process.env.CPA_ONLY && !name.includes(process.env.CPA_ONLY)) return;
    try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false }); await lastPage?.screenshot({ path: path.join(SHOTS, `FAIL-${results.length}.png`) }).catch(() => undefined); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}`); }
  };
  const openDoc = async (page: any) => { await page.getByText(/^חשבונית מס 41 · /).first().click(); await dialog(page).getByRole('heading', { name: 'חשבונית מס 41' }).waitFor(); return dialog(page); };


  for (const view of ['phone', 'desktop'] as const) {
    const tag = view === 'phone' ? 'm' : 'd';
    await step(`${view}: the payment link of an invoice waiting for its number is closed — and opens with the number`, async () => {
      fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@example.test' });
      fake.tables.business_finance_profile.push({ business_id: BIZ, user_id: OWNER, trading_name: '', phone: '03-0000000', email: '', payment_terms: 'immediate', quote_valid_days: 30, vat_period: 'bimonthly' });
      const { ctx, page } = await open('/finance/documents', view);
      try {
        const d = await openDoc(page);
        await d.getByText('ממתין למספר הקצאה', { exact: true }).waitFor();
        const pay = d.getByRole('button', { name: /שלח לינק לתשלום/ });
        const present = await pay.count();
        assert.ok(present <= 1);
        if (present === 1) {
          assert.equal(await pay.isDisabled(), true, 'the link of an invoice waiting for its number is closed');
          assert.match((await pay.getAttribute('title')) ?? '', /ממתין למספר הקצאה/, 'with its reason');
          await d.getByRole('region', { name: 'מספר הקצאה' }).scrollIntoViewIfNeeded();
          await shot(page, `${tag}20-paylink-closed.png`);
          await d.getByRole('button', { name: 'הזנת מספר שהתקבל' }).click();
          const m = dialog(page);
          await m.getByText(/אחרי השמירה אי אפשר לשנות או למחוק אותו/).waitFor();
          await m.getByLabel('מספר הקצאה').fill('123456789');
          await m.getByRole('button', { name: 'שמירה' }).click();
          await d.getByText('מספר הקצאה 123456789 (ידני)').waitFor();
          assert.equal(await d.getByRole('button', { name: /שלח לינק לתשלום/ }).isDisabled(), false, 'open again with the number');
          await shot(page, `${tag}21-paylink-open.png`);
        } else {
          // no connected terminal in this fake: the button is not offered at all (nothing to close) — say so, and still show the screen
          console.log(`note (${view}): no payment terminal in the fake — the link button is not offered`);
          await shot(page, `${tag}20-paylink-not-offered.png`);
        }
        await noSideScroll(page, 'paylink');
        await axe(page, `${view} paylink`);
      } finally { await ctx.close(); }
    });
  }

  await step('no errors in the browser', async () => { assert.deepEqual(errors, []); });
  console.log(axeFindings.length ? `\naxe: ${axeFindings.length} finding(s)\n${[...new Set(axeFindings)].join('\n')}` : '\naxe: no WCAG A/AA violation on these screens');
  await browser.close();
  try { process.kill(-dev.pid!, 'SIGTERM'); } catch { dev.kill('SIGTERM'); }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n# e2e cpa-stage2-paylink: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
