/**
 * T7 of docs/FINANCE_ADDITIONS_HE.md (2.97) in a real browser (Chromium via Playwright), against the in-memory Supabase of
 * fake-supabase.ts: the overview leads to action, and the customer's card has its money.
 *   every card of the overview opens its list — filtered by the card's own rules, for the same period — and the list shows the
 *   card's number: income (by customer), expenses (their cost, and the manual entries), profit and VAT (the reports' summary),
 *   money in (the income screen), owed, late (what is late of each invoice, by the plan's payments), the register's requests,
 *   the week's recurring charges, the expenses waiting for approval (any date), the paid sales without a document and the
 *   invoices without an allocation number; another period goes with the card;
 *   the customer's card: "💰 כספים" — owed and late, the plan's payments, the payments, the documents; "💳 שליחת לינק לתשלום"
 *   (one invoice: its dialog; an invoice and a quote: which one); the packages in the same box, also while it is closed;
 *   the allocation thresholds read "אושר מול רואה חשבון" (migration 5200); a phone: the overview, a list and the card fit.
 * 2.98: foreign currencies at the top of the overview — the dollar, the euro and the pound at the Bank of Israel's representative
 *   rate, with its date; the converter both ways (the yen whole, the dinar's fils); a bad number says so; the bank does not answer:
 *   "not available" and "load again", never a guessed rate (the server's route is faked here: /api/finance/fx — tests/fx.test.ts).
 * The numbers' rules are tested apart: tests/overview-lists.test.ts and tests/card-money.test.ts (the lists'), the database's
 * functions on Postgres (tests/sql/*.check.sql).
 *
 * Run: npx -y tsx tests/e2e/overview.e2e.ts   (starts `next dev` on port 3235; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (ov* — not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';
import { CONFIRMED_NOTE } from '../../src/features/finance/allocation';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_OVERVIEW_PORT ?? 3235);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000000e7';
const OWNER = 'a0000000-0000-4000-8000-0000000000e7';
const DANA = 'e0000000-0000-4000-8000-0000000000e1';
const NOA = 'e0000000-0000-4000-8000-0000000000e2';
const RON = 'e0000000-0000-4000-8000-0000000000e3';
const INV1 = '90000000-0000-4000-8000-0000000000e1';
const INV2 = '90000000-0000-4000-8000-0000000000e2';
const INV3 = '90000000-0000-4000-8000-0000000000e3';
const Q1 = '70000000-0000-4000-8000-0000000000e1';
const PLAN = '50000000-0000-4000-8000-0000000000e1';
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const day = (n: number) => { const x = new Date(`${TODAY}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dmy = (d: string) => d.split('-').reverse().join('/');
const MONTH = { from: `${TODAY.slice(0, 7)}-01`, to: (() => { const [y, m] = TODAY.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); })() };

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: `${TODAY}T06:00:00Z` };
  const issuer = { name: 'קליניקת שקד בע״מ', dealerNumber: '515123456', entityType: 'company' };
  const doc = (id: string, type: number, n: number, o: Record<string, any>) => ({ ...base, id, doc_type: type, doc_number: n, link_no: n, issued_at: `${TODAY}T08:0${n}:00Z`, doc_date: TODAY,
    customer_phone: '', customer_email: '', customer_dealer: '', lead_id: null, discount: 0, vat_rate: 18, payments: [], print_count: 1, share_token: `${n}${type}`.padEnd(64, 'a'),
    issuer, source: 'direct', notes: '', location_id: BIZ, due_date: null, ...o });
  const line = (name: string, net: number) => [{ name, qty: 1, unitPriceExVat: net, discountExVat: 0, totalExVat: net, vatRate: 18, kind: 1 }];
  const expense = (n: number, o: Record<string, any>) => ({ ...base, id: randomUUID(), expense_number: n, supplier_dealer: '', supplier_doc_type: 'tax_invoice', supplier_doc_number: '',
    allocation_number: '', doc_date: TODAY, category: 'other', description: '', vat_deductible_pct: 100, paid_on: null, payment_method: null, file_path: '', stock_lines: [], void_reason: '',
    location_id: BIZ, ...o });
  const plan = (o: Record<string, any>) => ({ business_id: BIZ, user_id: OWNER, lines: [{ name: 'ליווי', qty: 1, unitPrice: Number(o.amount) }], prices_include_vat: true,
    every_months: 1, day_of_month: 5, start_date: day(-60), end_date: null, mode: 'issue', send_link: false, note: '', paused_at: null, ended_at: null, end_reason: '',
    created_at: `${day(-60)}T08:00:00Z`, ...o });
  return {
    brands: [{ ...base, name: 'קליניקת שקד', onboarded: true, industry: 'קוסמטיקה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'company', vat_rate: 18, pay_link: '', dealer_number: '515123456', legal_name: 'קליניקת שקד בע״מ',
      street: 'הרצל', house_no: '1', city: 'תל אביב', zip: '' }],
    business_finance_profile: [{ business_id: BIZ, user_id: OWNER, trading_name: '', phone: '03-1234567', email: '', payment_terms: 'immediate', quote_valid_days: 30, vat_period: 'bimonthly', paylink_receipt: 'auto' }],
    business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }],
    business_locations: [{ id: BIZ, business_id: BIZ, name: 'ראשי', kind: 'clinic', address: '', phone: '', hours: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' }],
    registers: [{ id: BIZ, business_id: BIZ, location_id: BIZ, name: 'קופה 1', device: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' }],
    leads: [
      { ...base, id: DANA, name: 'דנה כהן', phone: '0521234567', email: 'dana@example.com', source: 'ידני', status: 'נסגר', date: '2026-01-01', tags: [], value: 0, notes: '' },
      { ...base, id: NOA, name: 'נועה לוי', phone: '0521112233', email: 'noa@example.com', source: 'ידני', status: 'נסגר', date: '2026-01-01', tags: [], value: 0, notes: '' },
      { ...base, id: RON, name: 'רון שגיא', phone: '0523334444', email: '', source: 'ידני', status: 'נסגר', date: '2026-01-01', tags: [], value: 0, notes: '' },
    ],
    // Dana: ₪1,180 in three payments (₪200 paid — the first payment is late by ₪200); Noa: ₪590 late by its own date; a company:
    // ₪6,000 before VAT — above the threshold, no allocation number; Yossi paid ₪236 at once
    documents: [
      doc(INV1, 305, 1, { customer_name: 'דנה כהן', customer_phone: '0521234567', customer_email: 'dana@example.com', lead_id: DANA, before_discount: 1000, after_discount: 1000,
        vat_amount: 180, total: 1180, lines: line('טיפול לייזר', 1000), due_date: day(-20) }),
      doc(INV2, 305, 2, { customer_name: 'נועה לוי', customer_phone: '0521112233', customer_email: 'noa@example.com', lead_id: NOA, before_discount: 500, after_discount: 500,
        vat_amount: 90, total: 590, lines: line('טיפול פנים', 500), due_date: day(-5) }),
      doc(INV3, 305, 3, { customer_name: 'שקד בע״מ', customer_dealer: '514000004', before_discount: 6000, after_discount: 6000, vat_amount: 1080, total: 7080,
        lines: line('ליווי שנתי', 6000), due_date: day(30) }),
      doc('90000000-0000-4000-8000-0000000000e4', 320, 1, { customer_name: 'יוסי לוי', before_discount: 200, after_discount: 200, vat_amount: 36, total: 236,
        lines: line('קרם', 200), payments: [{ method: 1, amount: 236, date: TODAY, m: 'cash' }] }),
      doc('90000000-0000-4000-8000-0000000000e5', 400, 1, { customer_name: 'דנה כהן', lead_id: DANA, before_discount: 200, after_discount: 200, vat_amount: 0, total: 200, vat_rate: 0,
        lines: [], payments: [{ method: 1, amount: 200, date: TODAY, m: 'cash' }], paid_document_id: INV1 }),
    ],
    payments: [
      { id: randomUUID(), business_id: BIZ, user_id: OWNER, direction: 'in', amount: 236, method: 'cash', paid_on: TODAY, source: 'document', document_id: '90000000-0000-4000-8000-0000000000e4',
        applies_to: null, sale_id: null, lead_id: null, reference: {}, note: '', created_at: `${TODAY}T08:04:00Z`, location_id: BIZ },
      { id: randomUUID(), business_id: BIZ, user_id: OWNER, direction: 'in', amount: 200, method: 'cash', paid_on: TODAY, source: 'document', document_id: '90000000-0000-4000-8000-0000000000e5',
        applies_to: INV1, sale_id: null, lead_id: DANA, reference: {}, note: '', created_at: `${TODAY}T08:05:00Z`, location_id: BIZ },
    ],
    payment_plans: [{ id: PLAN, business_id: BIZ, user_id: OWNER, document_id: INV1, lead_id: DANA, total: 1180, payments: 3, status: 'active', note: '', created_at: `${TODAY}T08:01:00Z`,
      cancelled_at: null, cancelled_by: null, cancel_reason: '' }],
    payment_plan_items: [
      { id: randomUUID(), plan_id: PLAN, business_id: BIZ, n: 1, due_date: day(-10), amount: 400 },
      { id: randomUUID(), plan_id: PLAN, business_id: BIZ, n: 2, due_date: day(20), amount: 400 },
      { id: randomUUID(), plan_id: PLAN, business_id: BIZ, n: 3, due_date: day(50), amount: 380 },
    ],
    quotes: [{ ...base, id: Q1, quote_number: 1, status: 'accepted', customer_name: 'נועה לוי', customer_phone: '0521112233', customer_email: 'noa@example.com', lead_id: NOA,
      body: { lines: [{ name: 'סדרת פילינג', qty: 1, unitPrice: 354 }], pricesIncludeVat: true, discount: { kind: 'sum', value: 0 }, customer: { name: 'נועה לוי' } },
      before_discount: 300, discount: 0, after_discount: 300, vat_rate: 18, vat_amount: 54, total: 354, valid_until: null, notes: '', share_token: 'q'.repeat(64) }],
    // two confirmed (₪500 + ₪318 — two thirds of a car's VAT is not offset), two drafts (one of last year), a void one
    expenses: [
      expense(1, { status: 'confirmed', supplier_name: 'ספק ציוד', category: 'equipment', amount_before_vat: 500, vat_amount: 90, total: 590 }),
      expense(2, { status: 'confirmed', supplier_name: 'מוסך', category: 'vehicle', amount_before_vat: 300, vat_amount: 54, total: 354, vat_deductible_pct: 66.67 }),
      expense(3, { status: 'draft', supplier_name: 'דפוס', amount_before_vat: 100, vat_amount: 18, total: 118 }),
      expense(4, { status: 'draft', supplier_name: 'ספק ישן', amount_before_vat: 200, vat_amount: 36, total: 236, doc_date: '2025-03-01' }),
      expense(5, { status: 'void', supplier_name: 'טעות', amount_before_vat: 1000, vat_amount: 180, total: 1180, void_reason: 'כפול' }),
    ],
    // a manual expense entry of ₪50 (migration 5100) — the overview's "הוצאות" counts it
    journal_entries: [{ id: randomUUID(), business_id: BIZ, location_id: BIZ, number: 1, entry_date: TODAY, kind: 'expense', amount: 50, vat: 0, vat_side: 'input', category: 'other',
      explanation: 'הפרשה', party_kind: null, lead_id: null, party_name: '', party_dealer: '', reverses: null, user_id: OWNER, created_at: `${TODAY}T09:00:00Z` }],
    // a request from the register waiting, and a sale paid at the register this morning without a document
    sales: [
      { ...base, id: randomUUID(), customer_name: 'רונית', customer_phone: '', items: [], subtotal: 300, discount: 0, total: 300, vat_rate: 18, vat_amount: 45.76, method: 'link',
        payments: [], status: 'pending', note: '', paid_at: null, channel: 'pos', location_id: BIZ },
      { ...base, id: randomUUID(), customer_name: 'מזדמן', customer_phone: '', items: [{ name: 'קרם', price: 118, qty: 1 }], subtotal: 118, discount: 0, total: 118, vat_rate: 18,
        vat_amount: 18, method: 'cash', payments: [], status: 'paid', note: '', paid_at: `${TODAY}T07:00:00Z`, channel: 'pos', location_id: BIZ },
    ],
    // the week: Ron's retainer in two days; a monthly one in ten days, and a paused one tomorrow, are not
    recurring_plans: [
      plan({ id: randomUUID(), lead_id: RON, name: 'ליווי', amount: 450, next_date: day(2), status: 'active' }),
      plan({ id: randomUUID(), lead_id: NOA, name: 'מנוי', amount: 999, next_date: day(10), status: 'active' }),
      plan({ id: randomUUID(), lead_id: DANA, name: 'מושהה', amount: 77, next_date: day(1), status: 'paused', paused_at: `${day(-1)}T08:00:00Z` }),
    ],
    recurring_charges: [],
    // Dana's package — in the money box of her card
    client_packages: [{ id: randomUUID(), business_id: BIZ, user_id: OWNER, lead_id: DANA, item_id: null, name: '6 טיפולי לייזר', treatment_type_id: null, sessions_total: 6, price: 0,
      sold_on: TODAY, valid_until: day(150), notes: '', status: 'active', document_id: null, cancelled_at: null, cancel_reason: '', created_at: `${TODAY}T08:00:00Z` }],
    client_package_uses: [], client_sessions: [], client_treatments: [], treatment_types: [],
    tax_allocations: [],
    // migration 5200: the thresholds confirmed with the accountant
    tax_allocation_rules: [[1, '2024-05-05', 25000], [2, '2025-01-01', 20000], [3, '2026-01-01', 10000], [4, '2026-06-01', 5000]].map(([version, effective_from, threshold_before_vat]) =>
      ({ version, effective_from, threshold_before_vat, doc_types: [305, 320], requires_customer_dealer: true, verified: true, source_note: CONFIRMED_NOTE })),
    catalog_items: [], catalog_variants: [], catalog_options: [], stock_levels: [], stock_transfers: [], stock_counts: [], stock_reservations: [], stock_movements: [],
    catalog_serials: [], catalog_serial_events: [], price_lists: [], price_list_items: [], sku_series: [], catalog_media: [], catalog_field_defs: [], catalog_collections: [],
    stores: [], store_domains: [], store_theme_versions: [], store_pages: [], store_menus: [], orders: [],
    employees: [], register_shifts: [], booking_services: [], appointments: [], sale_refunds: [], content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [],
    push_subscriptions: [], document_drafts: [], document_cancellations: [], finance_audit_log: [], finance_access_grants: [], payment_requests: [],
    debt_reminders: [], debt_reminder_stops: [], debt_reminder_settings: [],
    bank_deposits: [], bank_deposit_cheques: [], bank_statements: [], bank_lines: [], bank_matches: [], cheque_reminders: [],
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
  for (const p of ['/finance', '/finance/receivables', '/finance/expenses', '/finance/income', '/finance/reports', '/finance/recurring', '/finance/documents', '/leads']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@shaked.test' });
  const errors: string[] = [];
  const calls: string[] = [];
  const asked: any[] = [];
  // 2.98: the representative rates the server would answer (/api/finance/fx), or the bank not answering
  let fxDown = false;
  const fxAuth: string[] = [];
  const FX_AT = `${TODAY}T12:30:00.000Z`;
  const FX = { source: 'boi', rates: [{ code: 'USD', rate: 3.717, unit: 1, updated: FX_AT }, { code: 'EUR', rate: 4.051, unit: 1, updated: FX_AT },
    { code: 'GBP', rate: 4.805, unit: 1, updated: FX_AT }, { code: 'JPY', rate: 2.4983, unit: 100, updated: FX_AT }, { code: 'JOD', rate: 5.243, unit: 1, updated: FX_AT }] };

  async function context(viewport: { width: number; height: number }) {
    const phone = viewport.width < 600;
    const ctx = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@shaked.test'))]);
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
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'קליניקת שקד', state: 'active' },
      businesses: [{ id: BIZ, name: 'קליניקת שקד', state: 'active' }], superAdmin: false, access: 'full' } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
    await ctx.route(`${BASE}/api/notify/sale`, (r: any) => r.fulfill({ json: { sent: 0 } }));
    await ctx.route(`${BASE}/api/finance/tax/status`, (r: any) => r.fulfill({ json: { mode: 'unconfigured', configured: false, connection: null, message: 'החיבור לרשות המסים לא הוגדר.' } }));
    await ctx.route(`${BASE}/api/client-file/**`, (r: any) => r.fulfill({ status: 403, json: { code: 'no_access', message: 'אין גישה' } }));
    await ctx.route(`${BASE}/api/store/**`, (r: any) => r.fulfill({ json: { ok: true, domains: [], vercel: 'not_configured', connected: false } }));
    // the terminal: a test one, connected and checked — "שלח לינק לתשלום" is open (test payments only). Routed after the one above:
    // the route registered last is asked first
    await ctx.route(`${BASE}/api/store/payments`, (r: any) => r.fulfill({ json: { connected: true, provider: 'payplus', mode: 'test', hint: 'ab12', connectedAt: '2026-10-01T10:00:00Z',
      ready: true, liveOpen: false, verifiedAt: '2026-10-01T10:05:00Z', linksLive: false } }));
    // "שלח לינק לתשלום": what the server would keep and answer (the server itself: tests/paylinks.test.ts)
    await ctx.route(`${BASE}/api/finance/paylinks`, async (r: any) => {
      const b = JSON.parse(r.request().postData() ?? '{}');
      asked.push(b);
      if (b.action !== 'send') return r.fulfill({ status: 400, json: { message: 'פעולה לא מוכרת.' } });
      const row = { id: randomUUID(), business_id: BIZ, user_id: OWNER, kind: b.kind, document_id: b.kind === 'document' ? b.target : null, quote_id: b.kind === 'quote' ? b.target : null,
        appointment_id: null, package_id: null, lead_id: NOA, label: b.kind === 'quote' ? 'הצעת מחיר מס׳ 1' : 'חשבונית', customer_name: 'נועה לוי', customer_phone: '0521112233',
        customer_email: 'noa@example.com', amount: b.amount, is_test: true, provider: 'payplus', status: 'sent', expires_at: new Date(Date.now() + b.days * 864e5).toISOString(),
        sent_via: b.via, sends: 1, paid_at: null, paid_amount: null, paid_late: false, failed_at: null, fail_reason: '', cancelled_at: null, receipt_status: 'none',
        receipt_document_id: null, receipt_error: '', created_at: new Date().toISOString() };
      fake.tables.payment_requests.push(row);
      return r.fulfill({ json: { link: row, url: `${BASE}/pay/${row.id}.sig`, text: `לתשלום: ${BASE}/pay/${row.id}.sig`, emailed: false } });
    });
    await ctx.route(`${BASE}/api/finance/fx`, (r: any) => {
      fxAuth.push(r.request().headers().authorization ?? '');
      return r.fulfill(fxDown ? { status: 503, json: { code: 'fx_unavailable', message: 'שערי המטבע לא זמינים כרגע. נסו שוב מאוחר יותר.' } } : { json: FX });
    });
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(e.message));
    page.on('dialog', (d: any) => d.accept());
    return { ctx, page };
  }
  const { page } = await context(DESK);
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
      await page.screenshot({ path: path.join(SHOTS, `ov-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
    finally { clearTimeout(timer); }
  };
  const dialog = (p: any = page) => p.getByRole('dialog').last();
  const shot = async (name: string, p: any = page) => { await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, name), fullPage: true }); };
  /** a number of the screens (Stat): its label, value and hint — the overview's card is a button, a list's is not */
  // a Stat: its first child is the label, then the number (strong), then the hint — a row with a pill of the same words is not one
  const stat = (label: string, p: any = page) =>
    p.locator(`xpath=//*[self::button or self::div][*[1][self::span][normalize-space(.)="${label}"]][strong]`).last();
  const read = async (label: string, p: any = page) => {
    const s = stat(label, p);
    await s.waitFor();
    const spans = await s.locator('xpath=./span').allInnerTexts();
    return { value: (await s.locator('xpath=./strong').innerText()).trim(), hint: (spans[1] ?? '').trim() };
  };
  const overview = async (p: any = page) => { await goto('/finance', p); await stat('באיחור', p).waitFor({ timeout: 120_000 }); };
  const at = async (pathname: string, query: Record<string, string>) => {
    await page.waitForURL((u: URL) => u.pathname === pathname && Object.entries(query).every(([k, v]) => u.searchParams.get(k) === v), { timeout: 60_000 });
  };
  /** a card of the overview opens its list: the address, and the list's number — the card's */
  const opens = async (label: string, pathname: string, query: Record<string, string>, listLabel = label, sameHint = true) => {
    await overview();
    const card = await read(label);
    await stat(label).click();
    await at(pathname, query);
    // the list's number appears once its rows are in: wait for the card's value there
    await page.waitForFunction(([l, v]: string[]) => [...document.querySelectorAll('div > span:first-child')].some((s) => s.textContent?.trim() === l
      && s.parentElement?.querySelector(':scope > strong')?.textContent?.trim() === v), [listLabel, card.value], { timeout: 60_000 }).catch(() => null);
    const list = await read(listLabel);
    assert.equal(list.value, card.value, `${label}: the list's number is the card's`);
    if (sameHint) assert.equal(list.hint, card.hint, `${label}: and its count`);
    return card;
  };
  const fits = async (p: any, what: string) => {
    const bad: string[] = await p.evaluate(`(() => {
      const w = window.innerWidth, out = [];
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
  const card = async (name: string, p: any = page) => {
    await goto('/leads', p);
    await p.getByRole('button', { name: new RegExp(name) }).first().click({ timeout: 120_000 });
    await dialog(p).getByRole('heading', { name }).waitFor();
    return dialog(p);
  };

  try {
    await step('the overview: every card with its number — and two new ones, the week\'s charges and the expenses waiting for approval', async () => {
      await overview();
      const want: [string, string, string][] = [
        ['הכנסות (לפני מע״מ)', '₪7,700', 'מע״מ עסקאות ₪1,386'],
        ['הוצאות', '₪868', '2 הוצאות מאושרות · ופקודות ידניות ₪50'],
        ['רווח משוער', '₪6,832', 'הכנסות פחות הוצאות (לפני מס הכנסה)'],
        ['מע״מ לתשלום (משוער)', '₪1,260', 'תשומות לקיזוז ₪126'],
        ['נכנס לקופה ולבנק', '₪436', 'יצא ₪0 · נטו ₪436'],
        ['חייבים פתוחים', '₪8,650', '3 מסמכים'],
        ['באיחור', '₪790', '2 מסמכים'],
        ['בקשות תשלום מהקופה', '₪300', '1 ממתינות'],
        ['חיובים השבוע', '₪450', `1 חיובים חוזרים · עד ${dmy(day(6))}`],
        ['הוצאות לאישור', '₪354', '2 ממתינות לאישור'],
      ];
      for (const [label, value, hint] of want) assert.deepEqual(await read(label), { value, hint }, label);
      assert.equal(await stat('באיחור').evaluate((e: Element) => e.tagName), 'BUTTON', 'every card opens something');
      await page.getByText('1 מכירות ששולמו בקופה בתקופה הזו בלי מסמך (₪118).').waitFor();
      await page.getByText('1 חשבוניות מס מעל הסף לעוסק — בלי מספר הקצאה.').waitFor();
      await shot('ov-1-overview.png');
    });

    await step('"באיחור" opens what is late of each invoice: Noa\'s invoice by its date, Dana\'s first payment — the card\'s ₪790 in 2 documents', async () => {
      await opens('באיחור', '/finance/receivables', { show: 'overdue' });
      assert.equal(await page.getByRole('group', { name: 'איזו רשימה' }).getByRole('button', { name: 'באיחור' }).getAttribute('aria-pressed'), 'true');
      const late = page.getByRole('region', { name: 'באיחור', exact: true });
      const rows = (await late.locator('[data-late]').allInnerTexts()).map((t: string) => t.replace(/\s+/g, ' '));
      assert.equal(rows.length, 2, rows.join(' | '));
      assert.ok(/דנה כהן · חשבונית מס 1/.test(rows[0]) && /תשלום 1 מתוך 3/.test(rows[0]) && /היתרה בחשבונית: ₪980/.test(rows[0]) && /₪200/.test(rows[0]), rows[0]);
      assert.ok(/נועה לוי · חשבונית מס 2/.test(rows[1]) && /₪590/.test(rows[1]) && !/היתרה בחשבונית/.test(rows[1]), rows[1]);
      await shot('ov-2-overdue.png');
      // the chips: back to everything open
      await page.getByRole('group', { name: 'איזו רשימה' }).getByRole('button', { name: 'פתוחים' }).click();
      await page.getByText('שקד בע״מ · חשבונית מס 3').waitFor();
      // the address no longer says "overdue" (a refresh shows what is on the screen)
      await page.waitForURL((u: URL) => u.pathname === '/finance/receivables' && !u.searchParams.has('show'), { timeout: 30_000 });
    });

    await step('"חייבים פתוחים" opens the open invoices — "סה״כ פתוח" is the card\'s; "בקשות תשלום מהקופה" its requests and their sum', async () => {
      await opens('חייבים פתוחים', '/finance/receivables', {}, 'סה״כ פתוח', false);
      await opens('בקשות תשלום מהקופה', '/finance/receivables', { show: 'pending' });
      await page.getByRole('region', { name: 'בקשות תשלום מהקופה', exact: true }).getByText('רונית').waitFor();
      assert.equal(await stat('סה״כ פתוח').count(), 0, 'only the requests');
    });

    await step('"הוצאות" opens the period\'s confirmed expenses — their cost and the manual entry: the card\'s ₪868', async () => {
      await opens('הוצאות', '/finance/expenses', { show: 'confirmed', from: MONTH.from, to: MONTH.to });
      await page.getByText('ספק ציוד · ציוד').waitFor();
      await page.getByText(/מוסך ·/).waitFor();
      assert.equal(await page.getByText(/^טעות ·/).count(), 0, 'not the void one');
      assert.equal(await page.getByText(/^דפוס ·/).count(), 0, 'nor a draft');
      await page.getByText('2 הוצאות מאושרות · סה״כ ₪944').waitFor();   // the full amounts with their VAT, as before
      await shot('ov-3-expenses.png');
    });

    await step('"הוצאות לאישור" opens every draft, whatever its date — last year\'s too: the card\'s ₪354 in 2', async () => {
      await opens('הוצאות לאישור', '/finance/expenses', { show: 'drafts' });
      await page.getByText(/^דפוס ·/).waitFor();
      await page.getByText(/^ספק ישן ·/).waitFor();
      assert.equal(await page.getByRole('button', { name: 'כל התאריכים' }).getAttribute('aria-pressed'), 'true');
      // a period again: this month's drafts only
      await page.getByRole('button', { name: 'החודש', exact: true }).click();
      await page.getByText(/^ספק ישן ·/).waitFor({ state: 'detached' });
      await page.getByText(/^דפוס ·/).waitFor();
    });

    await step('"נכנס לקופה ולבנק" and the sales without a document open the income screen on the period — the same numbers', async () => {
      await opens('נכנס לקופה ולבנק', '/finance/income', { from: MONTH.from, to: MONTH.to }, 'נכנס בפועל', false);
      await page.getByText('מכירות ששולמו בלי מסמך (1)').waitFor();
      await overview();
      await page.getByRole('button', { name: 'להפקת המסמכים החסרים' }).click();
      await at('/finance/income', { from: MONTH.from, to: MONTH.to });
      await page.getByText('מכירות ששולמו בלי מסמך (1)').waitFor();
    });

    await step('"הכנסות" opens income by customer for the period; "רווח משוער" and the VAT open the reports\' summary — the same numbers', async () => {
      await overview();
      assert.equal((await read('הכנסות (לפני מע״מ)')).value, '₪7,700');
      await stat('הכנסות (לפני מע״מ)').click();
      await at('/finance/reports', { view: 'customers', from: MONTH.from, to: MONTH.to });
      // the list here is a table: its total row is the card's number
      const t = page.getByRole('table', { name: 'הכנסות לפי לקוח' });
      await t.waitFor({ timeout: 60_000 });
      const total = (await t.locator('tr').last().innerText()).replace(/\s+/g, ' ');
      assert.ok(/סה״כ/.test(total) && /7,700\.00/.test(total), total);
      await overview();
      await stat('רווח משוער').click();
      await at('/finance/reports', { view: 'summary', from: MONTH.from, to: MONTH.to });
      const pnl = (await page.locator('dl').first().innerText()).replace(/\s+/g, ' ');
      assert.ok(/רווח משוער ₪6,832/.test(pnl), pnl);
      await overview();
      await stat('מע״מ לתשלום (משוער)').click();
      await at('/finance/reports', { view: 'summary', from: MONTH.from, to: MONTH.to });
      await page.locator('div').filter({ has: page.locator('dt', { hasText: 'מע״מ לתשלום (להחזר אם שלילי)' }) }).last().getByText('₪1,260').waitFor();
    });

    await step('"חיובים השבוע" opens the recurring charges due by six days from today — Ron\'s: the card\'s ₪450', async () => {
      await opens('חיובים השבוע', '/finance/recurring', { show: 'week' });
      await page.getByText('רון שגיא · ליווי').waitFor();
      assert.equal(await page.getByText('נועה לוי · מנוי').count(), 0, 'in ten days: not this week');
      assert.equal(await page.getByText('דנה כהן · מושהה').count(), 0, 'paused');
      assert.equal(await page.getByRole('group', { name: 'סינון חיובים חוזרים' }).getByRole('button', { name: 'השבוע' }).getAttribute('aria-pressed'), 'true');
    });

    await step('the invoices without an allocation number: the note\'s list — the one it counted (until 2.97 the address\'s filter was ignored)', async () => {
      await overview();
      await page.getByText('1 חשבוניות מס מעל הסף לעוסק — בלי מספר הקצאה.').getByRole('button', { name: 'לרשימה' }).click();
      await at('/finance/documents', { show: 'allocation', from: MONTH.from, to: MONTH.to });
      const box = page.getByRole('region', { name: 'בלי מספר הקצאה', exact: true });
      await box.getByText('1 חשבוניות', { exact: true }).waitFor();
      await box.getByText('חשבונית מס 3 · שקד בע״מ').waitFor();
      assert.equal(await box.getByText(/חשבונית מס 1 ·/).count(), 0, 'a private customer\'s invoice needs none');
      await box.getByRole('button', { name: '✕ לכל המסמכים' }).click();
      await box.waitFor({ state: 'detached' });
    });

    await step('another period goes with the card: last month — the expenses card and its list both ₪0', async () => {
      await overview();
      await page.getByRole('button', { name: 'חודש קודם', exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('button > span:first-child')].some((s) => s.textContent?.trim() === 'הוצאות'
        && s.parentElement?.querySelector(':scope > strong')?.textContent?.trim() === '₪0'), null, { timeout: 60_000 });
      const [y, m] = MONTH.from.split('-').map(Number);
      const from = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10), to = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
      await stat('הוצאות').click();
      await at('/finance/expenses', { show: 'confirmed', from, to });
      assert.deepEqual(await read('הוצאות'), { value: '₪0', hint: '0 הוצאות מאושרות' });
      assert.equal(await page.getByRole('button', { name: 'חודש קודם', exact: true }).getAttribute('aria-pressed'), 'true', 'the picker says which period');
    });

    await step('Dana\'s card: the money box — owed and late, the plan\'s payments, her payments and documents; her package in the box, also while closed', async () => {
      const d = await card('דנה כהן');
      // the money box: the innermost box that holds "💰 כספים"
      const box = d.locator('div.rounded-2xl').filter({ has: page.getByRole('button', { name: /💰 כספים/ }) }).last();
      await box.getByText('📦 חבילות').waitFor();
      await box.getByText(/נותרו 6 מתוך 6 · בתוקף עד/).waitFor();
      assert.equal(await box.getByRole('button', { name: /💰 כספים/ }).getAttribute('aria-expanded'), 'false', 'closed — the package shows anyway');
      await box.getByRole('button', { name: /💰 כספים/ }).click();
      await box.getByText('(באיחור ₪200)').waitFor();
      await box.getByText('₪980', { exact: true }).waitFor();
      const plan = (await box.getByRole('region', { name: 'פריסה לתשלומים', exact: true }).locator('li').allInnerTexts()).map((t: string) => t.replace(/\s+/g, ' '));
      assert.deepEqual(plan, [
        `חשבונית מס 1 · תשלום 1 מתוך 3 · עד ${dmy(day(-10))} · באיחור ₪200`,
        `חשבונית מס 1 · תשלום 2 מתוך 3 · עד ${dmy(day(20))} ₪400`,
        `חשבונית מס 1 · תשלום 3 מתוך 3 · עד ${dmy(day(50))} ₪380`,
      ]);
      const pays = (await box.getByRole('region', { name: 'תשלומים', exact: true }).locator('li').allInnerTexts()).map((t: string) => t.replace(/\s+/g, ' '));
      assert.deepEqual(pays, [`${dmy(TODAY)} · קבלה · מזומן +₪200`]);
      const docs = box.getByRole('region', { name: 'מסמכים', exact: true });
      await docs.getByText('🧾 מסמכים').waitFor();
      await docs.getByText(/^קבלה 1 ·/).waitFor();
      await docs.getByText(/^חשבונית מס 1 ·/).waitFor();
      await shot('ov-4-card.png');
      // one thing to pay: "שליחת לינק לתשלום" opens its dialog at once — up to what is left
      await box.getByRole('button', { name: '💳 שליחת לינק לתשלום' }).click();
      const l = dialog();
      await l.getByRole('heading', { name: '💳 לינק לתשלום' }).waitFor();
      await l.getByText('חשבונית מס 1 · דנה כהן').waitFor();
      await l.getByLabel('סכום (עד ₪980)').waitFor();
      await page.keyboard.press('Escape');
    });

    await step('Noa\'s card: an invoice and an accepted quote — "על מה?" first; the quote\'s link for its total', async () => {
      const d = await card('נועה לוי');
      await d.getByRole('button', { name: /💰 כספים/ }).click();
      await d.getByRole('button', { name: '💳 שליחת לינק לתשלום' }).click();
      const pick = dialog();
      await pick.getByRole('heading', { name: '💳 לינק לתשלום — על מה?' }).waitFor();
      const options = (await pick.getByRole('listitem').allInnerTexts()).map((t: string) => t.replace(/\s+/g, ' '));
      assert.deepEqual(options, ['חשבונית מס 2 נשאר ₪590', 'הצעת מחיר 1 ₪354']);
      await shot('ov-5-pick.png');
      await pick.getByRole('listitem').filter({ hasText: 'הצעת מחיר 1' }).click();
      const l = dialog();
      await l.getByText('הצעת מחיר 1 · נועה לוי').waitFor();
      await l.getByLabel('סכום (עד ₪354)').waitFor();
      await l.getByRole('radio', { name: '🔗 העתקת לינק' }).click();
      await l.getByRole('button', { name: 'שליחת הלינק' }).click();
      await l.getByLabel('הלינק ללקוח/ה').waitFor();
      assert.deepEqual([asked.at(-1).kind, asked.at(-1).target, asked.at(-1).amount], ['quote', Q1, 354]);
      await l.getByRole('button', { name: 'סיום' }).click();
    });

    await step('settings: the allocation thresholds — "אושר מול רואה חשבון" (migration 5200), and who confirmed them, when', async () => {
      await goto('/finance/settings');
      await page.getByText('כללי מספר הקצאה (לפי תאריך המסמך)').waitFor({ timeout: 120_000 });
      await page.getByText('אושר מול רואה חשבון', { exact: true }).first().waitFor();
      assert.equal(await page.getByText('אושר מול רואה חשבון', { exact: true }).count(), 4);
      assert.equal(await page.getByText('לא אומת מול פרסום רשמי').count(), 0);
      await page.getByText(/אושר מול רואה חשבון \(11\.10\.2026\): הסף ותאריך התחולה\. לא נבדק כאן מול פרסום רשמי של רשות המסים\./).waitFor();
    });

    await step('foreign currencies at the top of the overview: the dollar, the euro and the pound — the representative rate, with its date', async () => {
      await overview();
      const fx = page.getByRole('region', { name: 'מטבעות חוץ', exact: true });
      await fx.getByText('₪3.717').waitFor();
      const line = (await fx.innerText()).replace(/\s+/g, ' ');
      for (const t of ['דולר ₪3.717', 'אירו ₪4.051', 'ליש״ט ₪4.805', `שער יציג, ${dmy(TODAY)}`]) assert.ok(line.includes(t), `"${t}" in: ${line}`);
      assert.match(fxAuth.at(-1) ?? '', /^Bearer /, 'the screen asks the server with the session');
      assert.equal(await fx.locator('output').count(), 0, 'the converter opens on a tap');
    });

    await step('the converter both ways: 100 dollars = ₪371.70 and back; 100 shekels = 4,003 yen (whole) and 19.073 dinars; "1,5" says it is not a number', async () => {
      const fx = page.getByRole('region', { name: 'מטבעות חוץ', exact: true });
      await fx.getByRole('button', { name: 'ממיר מטבעות' }).click();
      const out = fx.locator('output');
      await fx.getByLabel('סכום בדולר ארה״ב').fill('100');
      await out.getByText('₪371.70').waitFor();
      await fx.getByText('מדולר ארה״ב לשקלים').waitFor();
      await fx.getByText('1 USD = ₪3.717').first().waitFor();
      await fx.getByText('₪1 = 0.2690 USD').first().waitFor();
      await fx.getByText(`השער היציג של בנק ישראל, מ-${dmy(TODAY)}.`).waitFor();
      await fx.getByRole('button', { name: '⇄ החלפת כיוון' }).click();
      await fx.getByText('משקלים לדולר ארה״ב').waitFor();
      await fx.getByLabel('סכום בשקלים').fill('371.70');
      await out.getByText('100.00 USD').waitFor();
      await fx.getByLabel('מטבע', { exact: true }).selectOption('JPY');
      await fx.getByLabel('סכום בשקלים').fill('100');
      await out.getByText('4,003 JPY').waitFor();
      await fx.getByText('100 JPY = ₪2.4983').first().waitFor();
      await fx.getByLabel('מטבע', { exact: true }).selectOption('JOD');
      await out.getByText('19.073 JOD').waitFor();
      await fx.getByLabel('סכום בשקלים').fill('1,5');
      await out.getByText('מספר לא תקין — ספרות ונקודה עשרונית בלבד').waitFor();
      await shot('ov-8-fx.png');
      await fx.getByRole('button', { name: 'סגירת הממיר' }).click();
      assert.equal(await fx.locator('output').count(), 0);
    });

    await step('the bank does not answer: "not available" and "load again" — never a guessed rate; then it answers', async () => {
      fxDown = true;
      await overview();
      const fx = page.getByRole('region', { name: 'מטבעות חוץ', exact: true });
      await fx.getByText('שערי המטבע לא זמינים כרגע. נסו שוב מאוחר יותר.').waitFor();
      assert.equal(await fx.getByText('₪3.717').count(), 0);
      assert.equal(await fx.getByRole('button', { name: 'ממיר מטבעות' }).count(), 0);
      fxDown = false;
      await fx.getByRole('button', { name: 'לטעון שוב את השערים' }).click();
      await fx.getByText('₪3.717').waitFor();
      await fx.getByRole('button', { name: 'ממיר מטבעות' }).waitFor();
    });

    await step('a phone: the overview, a list and the card\'s money fit', async () => {
      const { page: phone } = await context(PHONE);
      await overview(phone);
      await fits(phone, 'the overview');
      const pfx = phone.getByRole('region', { name: 'מטבעות חוץ', exact: true });
      await pfx.getByRole('button', { name: 'ממיר מטבעות' }).click();
      await pfx.getByLabel('סכום בדולר ארה״ב').fill('250');
      await pfx.locator('output').getByText('₪929.25').waitFor();
      await fits(phone, 'the currency converter');
      await shot('ov-9-phone-fx.png', phone);
      await shot('ov-6-phone.png', phone);
      await stat('באיחור', phone).click();
      await phone.getByRole('region', { name: 'באיחור', exact: true }).waitFor();
      await fits(phone, 'the late list');
      const d = await card('דנה כהן', phone);
      await d.getByRole('button', { name: /💰 כספים/ }).click();
      await d.getByRole('region', { name: 'פריסה לתשלומים', exact: true }).waitFor();
      await fits(phone, 'the card\'s money');
      await shot('ov-7-phone-card.png', phone);
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
