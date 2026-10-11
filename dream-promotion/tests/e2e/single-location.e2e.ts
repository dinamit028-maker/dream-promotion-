/**
 * A business with one location looks exactly as it did before locations (docs/FINANCE_ADDITIONS_HE.md T12א — "בדיקת השוואה"):
 * the register (selling, sales, close of day, documents), the money's lobby, documents (and one open), income and expenses,
 * appointments and settings — on a computer and a phone — against the in-memory Supabase of fake-supabase.ts, with the browser's
 * clock and the fake's day fixed, so two runs a day apart draw the same pictures.
 *   LOC_SHOTS=<dir>    saves every screen there (run it on the code before the change: E2E_APP_DIR=<a checkout of main>)
 *   LOC_COMPARE=<dir>  holds every screen against that folder, pixel by pixel — any change fails
 * The version tag and the software line of a document are covered (they change with every version, by design); a covered pixel
 * is not compared (the cover's edge moves by a pixel when the version is wider or narrower).
 *
 * Run: npx -y tsx tests/e2e/single-location.e2e.ts   (starts `next dev` on port 3225; needs the preinstalled Chromium)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(process.env.E2E_APP_DIR ?? path.resolve(__dirname, '../..'));
const PORT = Number(process.env.E2E_SINGLE_PORT ?? 3225);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-000000000061';
const OWNER = 'a0000000-0000-4000-8000-0000000000a6';
const DANA = 'd0000000-0000-4000-8000-0000000000d6';
const SALON = 'd0000000-0000-4000-8000-0000000000d7';
const CREAM = 'f0000000-0000-4000-8000-0000000000f6';
const LASER = 'f0000000-0000-4000-8000-0000000000f7';
const EMP = 'e0000000-0000-4000-8000-0000000000e6';
const SVC = 'e0000000-0000-4000-8000-0000000000e7';
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };
const DAY = '2026-10-08';                                  // a Thursday
const FIXED = new Date(`${DAY}T10:00:00+03:00`);
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+03:00`).toISOString();
const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  const issuer = { name: 'סלון שגב בע״מ', dealerNumber: '515123456', entityType: 'company', street: 'דיזנגוף', houseNo: '10', city: 'תל אביב', phone: '03-5550000' };
  const line = (name: string, net: number, qty = 1) => ({ name, qty, unitPriceExVat: net / qty, discountExVat: 0, totalExVat: net, vatRate: 18, kind: 1 });
  const doc = (n: number, o: Record<string, unknown>) => ({ ...base, id: id(n), doc_number: 1, print_count: 1, share_token: `t${n}`.padEnd(32, 'x'), issuer,
    customer_phone: '', customer_dealer: '', customer_street: '', customer_city: '', customer_email: '', discount: 0, notes: '', source: 'direct',
    base_doc_type: null, base_doc_number: null, sale_id: null, lead_id: null, refund_id: null, paid_document_id: null, due_date: null, draft_id: null, quote_id: null, ...o });
  return {
    brands: [{ ...base, name: 'סלון שגב', onboarded: true, industry: 'קוסמטיקה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    register_settings: [{ ...base, business_type: 'licensed', entity_type: 'company', vat_rate: 18, pay_link: '', dealer_number: '515123456', legal_name: 'סלון שגב בע״מ',
      street: 'דיזנגוף', house_no: '10', city: 'תל אביב', zip: '' }],
    business_finance_profile: [],
    catalog_items: [
      { ...base, id: CREAM, name: 'קרם לחות', price: 120, kind: 'product', active: true, sort: 0, favorite: true, fav_order: 0, image_url: '', track_stock: true, stock_qty: 7, low_stock: 2 },
      { ...base, id: LASER, name: 'לייזר רגליים', price: 300, kind: 'service', active: true, sort: 1, favorite: true, fav_order: 1, image_url: '', track_stock: false, stock_qty: 0, low_stock: 2 },
    ],
    employees: [{ ...base, id: EMP, name: 'שגית', active: true, token: 't'.repeat(32), commission_service_pct: 10, commission_product_pct: 5 }],
    leads: [
      { ...base, id: DANA, name: 'דנה כהן', phone: '0521234567', source: 'ידני', status: 'נסגר', date: '2026-09-01', tags: [], value: 300, notes: '' },
      { ...base, id: SALON, name: 'סלון רונית', phone: '0547654321', source: 'ידני', status: 'חדש', date: '2026-09-15', tags: [], value: 0, notes: '',
        billing_name: 'סלון רונית בע״מ', billing_dealer: '520013954', billing_street: 'הרצל 5', billing_city: 'חולון' },
    ],
    sales: [
      { ...base, id: id(1), lead_id: DANA, appointment_id: null, customer_name: 'דנה כהן', customer_phone: '0521234567', channel: 'pos',
        items: [{ name: 'לייזר רגליים', price: 300, qty: 1, itemId: LASER, kind: 'service' }], subtotal: 300, discount: 0, total: 300, vat_rate: 18, vat_amount: 45.76,
        method: 'card', payments: [], status: 'paid', note: '', paid_at: at(DAY, '09:15'), created_at: at(DAY, '09:15'), employee_id: EMP, employee_name: 'שגית' },
      { ...base, id: id(2), lead_id: null, appointment_id: null, customer_name: '', customer_phone: '', channel: 'pos',
        items: [{ name: 'קרם לחות', price: 120, qty: 1, itemId: CREAM, kind: 'product' }], subtotal: 120, discount: 0, total: 120, vat_rate: 18, vat_amount: 18.31,
        method: 'cash', payments: [], status: 'paid', note: '', paid_at: at(DAY, '09:40'), created_at: at(DAY, '09:40'), employee_id: EMP, employee_name: 'שגית',
        cash_received: 200, change_given: 80 },
      { ...base, id: id(3), lead_id: SALON, appointment_id: null, customer_name: 'סלון רונית', customer_phone: '0547654321', channel: 'pos',
        items: [{ name: 'לייזר רגליים', price: 300, qty: 1, itemId: LASER, kind: 'service' }, { name: 'קרם לחות', price: 120, qty: 1, itemId: CREAM, kind: 'product' }],
        subtotal: 420, discount: 0, total: 420, vat_rate: 18, vat_amount: 64.07, method: 'link', payments: [], status: 'pending', note: '', paid_at: null,
        created_at: at(DAY, '09:50'), employee_id: null, employee_name: '' },
      { ...base, id: id(4), lead_id: DANA, appointment_id: null, customer_name: 'דנה כהן', customer_phone: '0521234567', channel: 'pos',
        items: [{ name: 'קרם לחות', price: 120, qty: 2, itemId: CREAM, kind: 'product' }], subtotal: 240, discount: 0, total: 240, vat_rate: 18, vat_amount: 36.61,
        method: 'cash', payments: [], status: 'paid', note: '', paid_at: at('2026-10-05', '12:00'), created_at: at('2026-10-05', '12:00'), employee_id: EMP, employee_name: 'שגית' },
    ],
    documents: [
      doc(11, { doc_type: 320, doc_date: DAY, issued_at: at(DAY, '09:16'), customer_name: 'דנה כהן', lead_id: DANA, sale_id: id(1), source: 'pos',
        lines: [line('לייזר רגליים', 254.24)], payments: [{ method: 3, amount: 300, date: DAY }], before_discount: 254.24, after_discount: 254.24, vat_amount: 45.76,
        total: 300, vat_rate: 18, idempotency_key: `sale:${id(1)}` }),
      doc(12, { doc_type: 305, doc_date: '2026-10-01', issued_at: at('2026-10-01', '11:00'), customer_name: 'סלון רונית בע״מ', customer_dealer: '520013954',
        customer_street: 'הרצל 5', customer_city: 'חולון', lead_id: SALON, due_date: '2026-10-31', lines: [line('ייעוץ מקצועי', 1000)], payments: [],
        before_discount: 1000, after_discount: 1000, vat_amount: 180, total: 1180, vat_rate: 18, idempotency_key: 'direct:single-305' }),
      doc(13, { doc_type: 400, doc_date: '2026-10-05', issued_at: at('2026-10-05', '13:00'), customer_name: 'סלון רונית בע״מ', lead_id: SALON, paid_document_id: id(12),
        lines: [], payments: [{ method: 4, amount: 1180, date: '2026-10-05' }], before_discount: 1180, after_discount: 1180, vat_amount: 0, total: 1180, vat_rate: 0,
        idempotency_key: `receipt:${id(12)}:1` }),
    ],
    payments: [
      { id: id(21), business_id: BIZ, user_id: OWNER, direction: 'in', amount: 300, method: 'card', paid_on: DAY, source: 'document', document_id: id(11), applies_to: null,
        sale_id: id(1), refund_id: null, expense_id: null, lead_id: DANA, reference: {}, note: '', created_at: at(DAY, '09:16') },
      { id: id(22), business_id: BIZ, user_id: OWNER, direction: 'in', amount: 1180, method: 'transfer', paid_on: '2026-10-05', source: 'document', document_id: id(13),
        applies_to: id(12), sale_id: null, refund_id: null, expense_id: null, lead_id: SALON, reference: {}, note: '', created_at: at('2026-10-05', '13:00') },
    ],
    expenses: [
      { ...base, id: id(31), expense_number: 1, status: 'confirmed', supplier_name: 'חברת החשמל', supplier_dealer: '520000472', supplier_doc_type: 'tax_invoice',
        supplier_doc_number: '88812', allocation_number: '', doc_date: '2026-10-03', category: 'utilities', description: 'חשמל ספטמבר', amount_before_vat: 500, vat_amount: 90,
        total: 590, vat_deductible_pct: 100, paid_on: '2026-10-04', payment_method: 'transfer', file_path: '', file_mime: '', ai_extracted: null, ai_model: '', stock_lines: [],
        void_reason: '', voided_at: null, created_at: at('2026-10-04', '09:00'), updated_at: at('2026-10-04', '09:00') },
      { ...base, id: id(32), expense_number: 2, status: 'confirmed', supplier_name: 'קוסמטיקה בע״מ', supplier_dealer: '514000012', supplier_doc_type: 'tax_invoice',
        supplier_doc_number: '4410', allocation_number: '', doc_date: '2026-10-06', category: 'inventory', description: 'קרמים', amount_before_vat: 1000, vat_amount: 180,
        total: 1180, vat_deductible_pct: 100, paid_on: null, payment_method: null, file_path: '', file_mime: '', ai_extracted: null, ai_model: '', stock_lines: [],
        void_reason: '', voided_at: null, created_at: at('2026-10-06', '09:00'), updated_at: at('2026-10-06', '09:00') },
    ],
    booking_services: [{ ...base, id: SVC, name: 'לייזר רגליים', minutes: 60, price: 300, active: true, sort: 0 }],
    booking_settings: [],
    appointments: [
      { ...base, id: id(41), service_id: SVC, lead_id: DANA, service_name: 'לייזר רגליים', name: 'דנה כהן', phone: '0521234567', email: '', note: '',
        start_at: at(DAY, '11:00'), end_at: at(DAY, '12:00'), status: 'booked', source: 'manual', created_at: at('2026-10-01', '10:00') },
      { ...base, id: id(42), service_id: SVC, lead_id: null, service_name: 'לייזר רגליים', name: 'מיכל לוי', phone: '0509998877', email: '', note: 'פעם ראשונה',
        start_at: at(DAY, '14:00'), end_at: at(DAY, '15:00'), status: 'confirmed', source: 'public', created_at: at('2026-10-02', '10:00') },
      { ...base, id: id(43), service_id: SVC, lead_id: SALON, service_name: 'לייזר רגליים', name: 'סלון רונית', phone: '0547654321', email: '', note: '',
        start_at: at('2026-10-09', '10:00'), end_at: at('2026-10-09', '11:00'), status: 'booked', source: 'manual', created_at: at('2026-10-02', '10:00') },
    ],
    register_shifts: [
      { ...base, id: id(51), opened_at: at('2026-10-07', '08:00'), opening_cash: 200, closed_at: at('2026-10-07', '19:00'), counted_cash: 560, expected_cash: 560,
        difference: 0, note: '', employee_name: 'שגית' },
      { ...base, id: id(52), opened_at: at(DAY, '08:00'), opening_cash: 200, closed_at: null, counted_cash: null, expected_cash: null, difference: null, note: '',
        employee_name: 'שגית' },
    ],
    sale_refunds: [], stock_movements: [], content: [], media: [], ad_drafts: [], pronunciations: [], lead_activities: [], push_subscriptions: [],
    quotes: [], document_drafts: [], document_cancellations: [], tax_allocations: [], finance_audit_log: [], finance_access_grants: [],
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
  const saveTo = process.env.LOC_SHOTS, compareTo = process.env.LOC_COMPARE;
  if (saveTo) mkdirSync(saveTo, { recursive: true });
  const pw: any = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.js' as string));
  const { chromium } = pw.default ?? pw;
  const dev = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: 'http://sb.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-test-key', NEXT_TELEMETRY_DISABLED: '1' },
  });
  const results: { name: string; ok: boolean; error?: string }[] = [];
  const browser = await (async () => { await waitForServer(dev); return chromium.launch(); })();
  for (const p of ['/register', '/finance', '/finance/documents', '/finance/income', '/finance/expenses', '/appointments', '/settings']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@segev.test', today: DAY });
  const errors: string[] = [];

  async function open(viewport: { width: number; height: number }, p: string) {
    const phone = viewport.width < 600;
    const ctx = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    await ctx.clock.setFixedTime(FIXED);
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@segev.test'))]);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    await ctx.route('http://sb.test/**', async (route: any) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const r = fake.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
      return route.fulfill({ status: r.status, body: r.body ?? '', headers: { ...(r.headers ?? {}), ...cors } });
    });
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'סלון שגב', state: 'active' },
      businesses: [{ id: BIZ, name: 'סלון שגב', state: 'active' }], superAdmin: false, access: 'full' } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/doc/sign-status`, (r: any) => r.fulfill({ json: { configured: false } }));
    await ctx.route(`${BASE}/api/ai`, (r: any) => r.fulfill(r.request().method() === 'GET' ? { json: { available: true, model: 'test' } } : { status: 400, json: { code: 'unknown_task' } }));
    await ctx.route(`${BASE}/api/video`, (r: any) => r.fulfill(r.request().method() === 'GET' ? { json: { available: true } } : { status: 400, json: { error: 'no' } }));
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page };
  }
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) { results.push({ name, ok: false, error: e.message }); console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 6).join('\n  ')}`); }
  };

  // a screen: saved (LOC_SHOTS), held against the earlier one (LOC_COMPARE)
  const cmpPage = await (await browser.newContext()).newPage();
  await cmpPage.evaluate('window.__name = (f) => f');   // tsx names the functions it passes to the browser
  const diffs: string[] = [];
  const shot = async (page: any, name: string) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete));
    await page.waitForTimeout(600);
    // the version tag and a document's software line change with every version, by design: covered
    const mask = [page.getByText(/^v\d+\.\d+\.\d+/), page.locator('p.muted', { hasText: 'Dream Promotion' })];
    const buf: Buffer = await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled', caret: 'hide', mask });
    writeFileSync(path.join(SHOTS, `single-${name}.png`), buf);
    if (saveTo) writeFileSync(path.join(saveTo, `${name}.png`), buf);
    if (!compareTo) return;
    const before = path.join(compareTo, `${name}.png`);
    if (!existsSync(before)) { diffs.push(`${name}: no earlier picture`); return; }
    const r = await cmpPage.evaluate(async ([a, b]: string[]) => {
      const load = (src: string) => new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.width !== y.width || x.height !== y.height) return { size: `${x.width}x${x.height} ≠ ${y.width}x${y.height}`, n: 0 };
      const px = (img: HTMLImageElement) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d')!; g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
      const [p, q] = [px(x), px(y)];
      // a covered pixel (the mask's #FF00FF) in either picture is not compared: the version tag is wider or narrower by a pixel
      const covered = (d: Uint8ClampedArray, i: number) => d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255;
      let n = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (covered(p, i) || covered(q, i)) continue;
        if (Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2])) > 40) n++;
      }
      return { size: '', n };
    }, [`data:image/png;base64,${readFileSync(before).toString('base64')}`, `data:image/png;base64,${buf.toString('base64')}`]);
    if (r.size || r.n > 0) { diffs.push(`${name}: ${r.size || `${r.n} pixels changed`}`); writeFileSync(path.join(SHOTS, `single-${name}.after.png`), buf); }
  };
  // a tab of the register (its label may carry a count: "מכירות ודוחות (1)")
  const tab = async (page: any, label: string) => { await page.getByRole('button', { name: new RegExp(`^${label}`) }).first().click(); await page.waitForTimeout(400); };

  try {
    await step('the register on a computer: selling, sales, close of day, documents', async () => {
      const { ctx, page } = await open(DESK, '/register');
      await page.getByRole('heading', { name: 'קופה' }).waitFor({ timeout: 120_000 });
      await page.locator('section button', { hasText: 'קרם לחות' }).first().waitFor({ timeout: 60_000 });
      await shot(page, 'register-sell-desktop');
      await tab(page, 'מכירות ודוחות');
      await page.getByText('דנה כהן').first().waitFor();
      await shot(page, 'register-sales-desktop');
      await tab(page, 'סגירת יום');
      await page.getByText('🌙 סגירת יום').waitFor();
      await shot(page, 'register-shift-desktop');
      await tab(page, 'מסמכים');
      await page.getByText('סלון רונית בע״מ').first().waitFor();
      await shot(page, 'register-docs-desktop');
      await ctx.close();
    });
    await step('the register on a phone', async () => {
      const { ctx, page } = await open(PHONE, '/register');
      await page.locator('section button', { hasText: 'קרם לחות' }).first().waitFor({ timeout: 120_000 });
      await shot(page, 'register-sell-phone');
      await ctx.close();
    });
    await step('the money: lobby, documents (and one open), income, expenses — computer', async () => {
      const { ctx, page } = await open(DESK, '/finance');
      await page.getByRole('heading', { name: 'לובי כספים' }).waitFor({ timeout: 120_000 });
      await page.waitForTimeout(800);
      await shot(page, 'finance-lobby-desktop');
      await page.goto(`${BASE}/finance/documents`, { waitUntil: 'domcontentloaded' });
      await page.getByText('סלון רונית בע״מ').first().waitFor({ timeout: 60_000 });
      await shot(page, 'finance-documents-desktop');
      await page.getByText('סלון רונית בע״מ').first().click();
      await page.getByText('לכבוד:').first().waitFor();
      await shot(page, 'finance-document-open-desktop');
      await page.goto(`${BASE}/finance/income`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'הכנסות' }).first().waitFor({ timeout: 60_000 });
      await page.waitForTimeout(800);
      await shot(page, 'finance-income-desktop');
      await page.goto(`${BASE}/finance/expenses`, { waitUntil: 'domcontentloaded' });
      await page.getByText('חברת החשמל').first().waitFor({ timeout: 60_000 });
      await shot(page, 'finance-expenses-desktop');
      await ctx.close();
    });
    await step('the money\'s lobby on a phone', async () => {
      const { ctx, page } = await open(PHONE, '/finance');
      await page.getByRole('heading', { name: 'לובי כספים' }).waitFor({ timeout: 120_000 });
      await page.waitForTimeout(800);
      await shot(page, 'finance-lobby-phone');
      await ctx.close();
    });
    await step('appointments and settings', async () => {
      const { ctx, page } = await open(DESK, '/appointments');
      await page.getByText('מיכל לוי').first().waitFor({ timeout: 120_000 });
      await shot(page, 'appointments-desktop');
      await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'הגדרות' }).waitFor({ timeout: 60_000 });
      await shot(page, 'settings-desktop');
      await ctx.close();
    });
    await step('no error in the browser', async () => { if (errors.length) throw new Error(errors.join('\n')); });
    if (compareTo) await step('every screen as before (pixel by pixel)', async () => { if (diffs.length) throw new Error(diffs.join('\n')); });
  } finally {
    await browser.close();
    try { process.kill(-dev.pid!, 'SIGTERM'); } catch { /* already gone */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${saveTo ? ` · pictures saved to ${saveTo}` : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
