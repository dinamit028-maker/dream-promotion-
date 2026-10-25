/**
 * טופס 101 (2.108) in a real browser (Chromium via Playwright), against the in-memory Supabase of fake-supabase.ts. The server
 * routes are the real ones — /api/attendance/form101 and /api/f101/<token> run here, in the test's process, on a service-role
 * client whose requests go to the same in-memory database (the dev server of this sandbox cannot reach it). The full path:
 *   before migration 5900 — nothing of the form; then the employer's part (the deductions file) → a new employee, and "send טופס
 *   101" opens WhatsApp with the personal link → the employee fills it on the phone (prefilled: the name, the ID, the start date),
 *   attaches the ID and signs → back in the employee's file (the PDF, the attachment, "awaiting review") → the accountant marks it
 *   reviewed → an update during the year (version 2, the first kept) → the employees list says who signed.
 * Run: npx -y tsx tests/e2e/form101.e2e.ts   (starts `next dev` on port 3244)   Screenshots: tests/e2e/shots/f101-*.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_F101_PORT ?? 3244);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000001a1';
const OWNER = 'a0000000-0000-4000-8000-0000000001a1';
const PHONE_VIEW = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };
const YEAR = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric' }).format(new Date()));

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  return {
    businesses: [{ id: BIZ, name: 'מסעדת הים', slug: 'yam101', status: 'active', paid_until: null, grace_days: 0, modules: ['dream', 'attendance'] }],
    brands: [{ ...base, name: 'מסעדת הים', onboarded: true, industry: 'מסעדה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full', attendance_role: null }],
    profiles: [{ id: OWNER, full_name: 'רונית הבעלים', email: 'owner@yam.test', current_business_id: BIZ, is_super_admin: false }],
    business_locations: [{ id: BIZ, business_id: BIZ, name: 'ראשי', kind: 'clinic', address: '', phone: '', hours: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' }],
    registers: [{ id: BIZ, business_id: BIZ, location_id: BIZ, name: 'קופה 1', device: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' }],
    register_settings: [{ ...base, legal_name: 'הים בע"מ', street: 'הנמל', house_no: '1', city: 'חיפה' }],
    employees: [], time_entries: [], timeclock_settings: [], departments: [], work_tracks: [], employee_private: [], attendance_approvers: [],
    time_requests: [], absences: [], attendance_months: [], attendance_month_events: [], time_entry_events: [],
    form101_requests: [], form101_submissions: [], push_subscriptions: [],
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
  for (const p of ['/attendance/employees', '/attendance/settings', '/f/x']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok || r.status === 404, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@yam.test' });

  // ---- the real server routes, here, on a service-role client of the in-memory database ----
  const bodyText = async (b: any): Promise<string | null> => {
    if (b == null) return null;
    if (typeof b === 'string') return b;
    if (b instanceof Uint8Array || Buffer.isBuffer(b)) return Buffer.from(b).toString('latin1');
    if (b instanceof ArrayBuffer) return Buffer.from(new Uint8Array(b)).toString('latin1');
    if (typeof Blob !== 'undefined' && b instanceof Blob) return Buffer.from(await b.arrayBuffer()).toString('latin1');
    return '';
  };
  const fakeFetch = async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((v, k) => { headers[k] = v; });
    const r = fake.handle(init.method ?? 'GET', url, headers, await bodyText(init.body));
    return new Response(r.status === 204 ? null : r.body ?? '', { status: r.status, headers: r.headers ?? {} });
  };
  (globalThis as any).__DP_TEST_ADMIN_DB__ = createClient('http://sb.test', 'service-role-test', { auth: { persistSession: false }, global: { fetch: fakeFetch as any } });
  const boss = await import('../../src/app/api/attendance/form101/route');
  const pub = await import('../../src/app/api/f101/[token]/route');
  const pubFile = await import('../../src/app/api/f101/[token]/file/route');
  const serve = async (route: any, handler: (req: Request, token: string) => Promise<Response>) => {
    const req = route.request();
    const u = new URL(req.url());
    const r = await handler(new Request(req.url(), { method: req.method(), headers: await req.allHeaders(), body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() }), u.pathname.split('/')[3]);
    return route.fulfill({ status: r.status, body: Buffer.from(await r.arrayBuffer()), headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' } });
  };

  const errors: string[] = [];
  const calls: string[] = [];
  const popups: string[] = [];
  async function context(viewport: { width: number; height: number }, signedIn = true) {
    const phone = viewport.width < 600;
    const ctx = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', acceptDownloads: true,
      ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    if (signedIn) await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@yam.test'))]);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    await ctx.route('http://sb.test/**', async (route: any) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const r = fake.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
      calls.push(`${r.status} ${req.method()} ${req.url().replace('http://sb.test', '').slice(0, 120)}`); calls.splice(0, calls.length - 14);
      return route.fulfill({ status: r.status, body: r.body ?? '', headers: { ...(r.headers ?? {}), ...cors } });
    });
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'מסעדת הים', state: 'active' },
      businesses: [{ id: BIZ, name: 'מסעדת הים', state: 'active' }], superAdmin: false, access: 'full', modules: ['dream', 'attendance'] } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/attendance/form101**`, (r: any) => serve(r, (req) => (req.method === 'GET' ? boss.GET(req) : boss.POST(req))));
    await ctx.route(`${BASE}/api/f101/**`, (r: any) => serve(r, (req, token) => {
      const params = { params: Promise.resolve({ token }) };
      if (req.url.endsWith('/file')) return pubFile.POST(req, params);
      return req.method === 'GET' ? pub.GET(req, params) : pub.POST(req, params);
    }));
    await ctx.route('https://wa.me/**', (r: any) => { popups.push(r.request().url()); return r.fulfill({ status: 200, body: 'wa', headers: { 'content-type': 'text/plain' } }); });
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(e.message));
    page.on('dialog', (d: any) => d.accept());
    return { ctx, page };
  }
  const { ctx: deskCtx, page } = await context(DESK);
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
      await page.screenshot({ path: path.join(SHOTS, `f101-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
    finally { clearTimeout(timer); }
  };
  const dialog = (p: any = page) => p.getByRole('dialog').last();
  const shot = async (name: string, p: any = page) => { await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, name), fullPage: true }); };
  const fits = async (p: any, what: string) => {
    const w = await p.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
    assert.ok(w.doc <= w.view + 1, `${what}: no sideways scroll (${w.doc} > ${w.view})`);
  };
  const dana = () => fake.tables.employees.find((e) => e.name === 'דנה כהן')!;
  const lastLink = () => { const m = /\/f\/([0-9a-f]{64})/.exec(decodeURIComponent(popups[popups.length - 1] ?? '')); assert.ok(m, `a link in the WhatsApp message: ${popups.at(-1)}`); return `/f/${m![1]}`; };
  const idPhoto = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#c8d2e0' } }).jpeg().toBuffer();
  /** the employee's phone: fill what the step asks, "הבא" */
  const next = (p: any) => p.getByRole('button', { name: 'הבא' }).click();
  const sign = async (p: any) => {
    const c = p.getByRole('img', { name: /משטח חתימה/ });
    await c.scrollIntoViewIfNeeded();
    const b = await c.boundingBox();
    await p.mouse.move(b.x + 30, b.y + b.height * 0.7); await p.mouse.down();
    for (let i = 1; i <= 12; i++) await p.mouse.move(b.x + 30 + i * (b.width - 60) / 12, b.y + b.height * (0.7 - 0.4 * Math.sin(i / 2)), { steps: 2 });
    await p.mouse.up();
  };

  try {
    await step('before migration 5900: nothing of טופס 101 — no column, no employer card', async () => {
      fake.form101Tables = false;
      fake.tables.employees.push({ id: 'e0000000-0000-4000-8000-0000000001a0', user_id: OWNER, business_id: BIZ, name: 'אבי לוי', phone: '050-7654321', token: 'tok-avi-AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        active: true, employee_code: '100', title: '', department_id: null, track_id: null, start_date: `${YEAR}-01-01`, end_date: null, last_active_at: null, invited_at: null, created_at: '2026-01-01T00:00:00Z' });
      await goto('/attendance/employees');
      await page.locator('tbody').getByText('אבי לוי').waitFor({ timeout: 120_000 });
      assert.equal(await page.getByText('טופס 101').count(), 0);
      await goto('/attendance/settings');
      await page.getByText('ייצוא שעות').waitFor({ timeout: 120_000 });
      assert.equal(await page.getByText('טופס 101 — פרטי המעסיק').count(), 0);
      fake.form101Tables = true;
    });

    await step('the employer\'s part (חלק א): the deductions file — 9 digits from 9', async () => {
      await goto('/attendance/settings');
      await page.getByText('טופס 101 — פרטי המעסיק').waitFor({ timeout: 120_000 });
      await page.getByText('הים בע"מ, הנמל 1, חיפה').waitFor();
      await page.getByLabel('מספר תיק ניכויים').fill('123');
      await page.getByText('9 ספרות, מתחיל ב-9').waitFor();
      await page.getByLabel('מספר תיק ניכויים').fill('912345678');
      await page.getByLabel('מספר טלפון', { exact: true }).fill('04-1234567');
      await page.getByText('טופס 101 — פרטי המעסיק').locator('..').getByRole('button', { name: 'שמירה' }).click();
      await page.getByText('פרטי המעסיק נשמרו').waitFor();
      assert.equal(fake.tables.timeclock_settings[0].employer_deductions_file, '912345678');
      await shot('f101-0-employer.png');
    });

    await step('a new employee: "send טופס 101" — WhatsApp opens with the personal link to the form', async () => {
      await goto('/attendance/employees?new=1');
      const d = dialog();
      await d.getByLabel('שם מלא').fill('דנה כהן', { timeout: 120_000 });
      await d.getByLabel('טלפון (לזימון בוואטסאפ)').fill('050-1234567');
      await d.getByLabel('תאריך תחילת עבודה').fill(`${YEAR}-02-01`);
      await d.getByLabel('תעודת זהות (לא חובה)').fill('123456782');
      assert.ok(await d.getByLabel('לשלוח טופס 101').isChecked(), 'checked by default');
      await shot('f101-1-new-employee.png');
      const [pop] = await Promise.all([page.waitForEvent('popup'), d.getByRole('button', { name: 'שמירה' }).click()]);
      await pop.waitForLoadState().catch(() => null);
      await page.getByText(/טופס 101 נשלח/).waitFor();
      const url = decodeURIComponent(popups.at(-1)!);
      assert.ok(url.startsWith('https://wa.me/972501234567?text='), url);
      assert.match(url, new RegExp(`טופס 101 לשנת המס ${YEAR} של מסעדת הים`));
      assert.ok(!/dream/i.test(url));
      await pop.close();
      const req = fake.tables.form101_requests.find((r) => r.employee_id === dana().id)!;
      assert.equal(req.status, 'sent'); assert.ok(!url.includes(req.token_hash), 'the message has the token, the database only its hash');
      await page.locator('tbody').getByText('טופס 101: נשלח').waitFor();
    });

    await step('the employee fills it on the phone — prefilled, step by step, the ID attached, signed on the screen', async () => {
      const { ctx, page: phone } = await context(PHONE_VIEW, false);
      await goto(lastLink(), phone);
      await phone.getByRole('heading', { name: new RegExp(`טופס 101 · שנת המס ${YEAR}`) }).waitFor({ timeout: 120_000 });
      assert.equal(await phone.getByLabel('שם פרטי').inputValue(), 'דנה');
      assert.equal(await phone.getByLabel('מספר זהות (9 ספרות)').inputValue(), '123456782');
      await fits(phone, 'the form');
      await shot('f101-2-phone-personal.png', phone);
      await next(phone);
      await phone.getByText('חסר תאריך לידה.').waitFor();
      await phone.getByLabel('תאריך לידה').fill('1990-05-01');
      await phone.getByLabel('רחוב/שכונה').fill('הרצל');
      await phone.getByLabel('מספר', { exact: true }).fill('5');
      await phone.getByLabel('עיר/ישוב').fill('חיפה');
      await phone.getByRole('radio', { name: 'נקבה' }).check();
      await phone.getByRole('radio', { name: 'נשוי/אה' }).check();
      await phone.getByRole('group', { name: 'תושב ישראל' }).getByRole('radio', { name: 'כן' }).check();
      await phone.getByRole('group', { name: 'חבר קיבוץ/מושב שיתופי' }).getByRole('radio', { name: 'לא', exact: true }).check();
      await phone.getByRole('group', { name: 'חבר בקופת חולים' }).getByRole('radio', { name: 'כן' }).check();
      await phone.getByLabel('שם הקופה').fill('כללית');
      await next(phone);
      await phone.getByText('שלב 2 מתוך').waitFor({ timeout: 5_000 }).catch(async (e: Error) => { await shot('f101-fail-phone.png', phone); throw e; });
      // ג: one child
      await phone.getByRole('button', { name: '+ הוספת ילד/ה' }).click();
      await phone.getByLabel('שם', { exact: true }).fill('נועה');
      await phone.getByLabel('תאריך לידה').fill('2020-03-04');
      await phone.getByText('הילד נמצא בחזקתי').click();
      await next(phone);
      // ד
      await phone.getByText('משכורת חודש', { exact: true }).click();
      assert.equal(await phone.getByLabel('תאריך תחילת העבודה בשנת המס (לא חובה)').inputValue(), `${YEAR}-02-01`, 'the start date from the card');
      await next(phone);
      // ה
      await phone.getByText(/^אין לי הכנסות אחרות ממשכורת/).click();
      await next(phone);
      // ו (married)
      await phone.getByLabel('שם משפחה').fill('כהן');
      await phone.getByLabel('שם פרטי').fill('יוסי');
      await phone.getByText('יש לבן/בת הזוג הכנסה', { exact: true }).click();
      await phone.getByText('עבודה/קצבה/עסק').click();
      await next(phone);
      // ח: resident, children in custody
      await phone.getByText('1. אני תושב/ת ישראל.').click();
      await phone.getByText('7. בגין ילדיי שבחזקתי המפורטים בחלק ג.').click();
      await phone.getByLabel('מספר ילדים שימלאו להם 6 שנים עד 17 שנים בשנת המס (לא חובה)').fill('1');
      await shot('f101-3-phone-credits.png', phone);
      await next(phone);
      await next(phone);   // ט: nothing
      // the end: the ID, the declaration, the signature
      await phone.getByText('צילום תעודת זהות כולל ספח').waitFor();
      await phone.locator('li', { hasText: 'צילום תעודת זהות כולל ספח' }).locator('input[type=file]').setInputFiles({ name: 'id.jpg', mimeType: 'image/jpeg', buffer: idPhoto });
      await phone.locator('li', { hasText: 'צילום תעודת זהות כולל ספח' }).getByText('צורף ✓').waitFor();
      await phone.getByText(/^אני מצהיר\/ה כי הפרטים שמסרתי בטופס זה הינם מלאים ונכונים/).waitFor();
      await phone.getByRole('button', { name: 'חתימה ושליחה' }).click();
      await phone.getByText('חסרה חתימה.').waitFor();
      await sign(phone);
      await phone.getByText('אני מאשר/ת את ההצהרה').click();
      await shot('f101-4-phone-sign.png', phone);
      await phone.getByRole('button', { name: 'חתימה ושליחה' }).click();
      await phone.getByText('תודה, הטופס נשלח ✓').waitFor({ timeout: 60_000 });
      const [dl] = await Promise.all([phone.waitForEvent('download'), phone.getByRole('button', { name: 'הורדת עותק של הטופס' }).click()]);
      const pdf = await PDFDocument.load(await (await import('node:fs/promises')).readFile(await dl.path()));
      assert.equal(pdf.getTitle(), `טופס 101 — דנה כהן — ${YEAR}`);
      await shot('f101-5-phone-done.png', phone);
      await ctx.close();
      const s = fake.tables.form101_submissions.find((x) => x.employee_id === dana().id)!;
      assert.deepEqual([s.version, s.data.employee.city, s.data.children.length, s.attachments.map((a: any) => a.kind)], [1, 'חיפה', 1, ['id']]);
      assert.equal(fake.tables.form101_requests.find((r) => r.id === s.request_id)!.status, 'submitted');
    });

    await step('back in the employee\'s file: the form, the attachment, awaiting review; the accountant marks it reviewed', async () => {
      await goto(`/attendance/employees/${dana().id}?tab=form101`);
      await page.getByText('הטופס של השנה').waitFor({ timeout: 120_000 });
      await page.getByText('ממתין לבדיקת רואה החשבון').waitFor();
      await page.getByRole('button', { name: 'צילום תעודת זהות כולל ספח' }).waitFor();
      const [pdf] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'הטופס (PDF)' }).click()]);
      await pdf.waitForURL(/form101-files/, { timeout: 30_000 }).catch(() => null);
      assert.match(pdf.url(), /\/storage\/v1\/object\/sign\/form101-files\/.+\.pdf\?token=/, 'a short-lived link');
      await pdf.close();
      await shot('f101-6-employee-file.png');
      await page.getByRole('button', { name: 'סימון: נבדק' }).click();
      await dialog().getByLabel('הערה (לא חובה)').fill('הוזן לשכר');
      await dialog().getByRole('button', { name: 'שמירה' }).click();
      await page.getByText(/^נבדק ע״י רונית הבעלים/).waitFor();
      await page.getByText('הערת הבדיקה: הוזן לשכר').waitFor();
    });

    await step('an update during the year: a new link, the last form prefilled, version 2 — the first kept', async () => {
      const [pop] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'עדכון פרטים (שינוי במהלך השנה)' }).click()]);
      await page.getByText('קישור לעדכון פרטים נשלח').waitFor();
      await pop.close();
      assert.match(decodeURIComponent(popups.at(-1)!), /עדכון פרטים בטופס 101/);
      const { ctx, page: phone } = await context(PHONE_VIEW, false);
      await goto(lastLink(), phone);
      await phone.getByRole('heading', { name: /עדכון פרטים — טופס 101/ }).waitFor({ timeout: 120_000 });
      assert.equal(await phone.getByLabel('עיר/ישוב').inputValue(), 'חיפה', 'the last form, prefilled');
      await phone.getByLabel('עיר/ישוב').fill('תל אביב');
      for (let i = 0; i < 7; i++) await next(phone);
      await phone.getByLabel('מה השתנה? (ז. שינויים במהלך השנה) (לא חובה)').fill('עברתי דירה');
      await sign(phone);
      await phone.getByText('אני מאשר/ת את ההצהרה').click();
      await phone.getByRole('button', { name: 'חתימה ושליחה' }).click();
      await phone.getByText(/עדכון מס׳ 2/).waitFor({ timeout: 60_000 });
      await ctx.close();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('עדכון מס׳ 2').waitFor({ timeout: 120_000 });
      await page.getByText('מה השתנה: עברתי דירה').waitFor();
      await page.getByText('הטופס של השנה').waitFor();
      assert.deepEqual(fake.tables.form101_submissions.map((s) => s.version).sort(), [1, 2]);
    });

    await step('the employees list: who signed for the year, who has none', async () => {
      await goto('/attendance/employees');
      await page.locator('tbody').getByText('טופס 101: נחתם').waitFor({ timeout: 120_000 });
      await page.locator('tbody').getByText('טופס 101: חסר').waitFor();
      await page.getByText(new RegExp(`טופס 101 לשנת המס ${YEAR}: עובד/ת אחד/ת עוד בלי טופס חתום \\(אבי לוי\\)`)).waitFor();
      await shot('f101-7-employees.png');
    });

    assert.deepEqual(errors, [], `page errors: ${errors.join(' · ')}`);
  } finally {
    await deskCtx.close().catch(() => null);
    await browser.close().catch(() => null);
    try { process.kill(-dev.pid!, 'SIGTERM'); } catch { /* gone */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (errors.length) console.log(`page errors: ${errors.join(' · ')}`);
  process.exit(failed.length || errors.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
