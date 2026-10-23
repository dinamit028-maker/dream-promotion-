/**
 * "נוכחות ועובדים", stage 1 (2.107) in a real browser (Chromium via Playwright), against the in-memory Supabase of fake-supabase.ts
 * (the attendance functions: fake-attendance.ts). The rules themselves are tested on Postgres (tests/sql/attendance-core.check.sql:
 * the whole month, who may, the closed month, nothing deleted; attendance-compare.sh: the clock before and after 5800). Here the
 * full path is clicked through, as the task asks:
 *   before migration 5800 — the clock's screen as it was; then:
 *   a track and a department → an employee is added (with the private part) → invited on WhatsApp with the personal link →
 *   clocks in and out on the phone (the real clock page) → the monthly report (every day, the Hebrew day kinds, red where missing)
 *   → a manager completes a day, a night shift, corrects one (the old entry stays — the history), voids a duplicate (a reason, always)
 *   → an employee's request is approved → an absence → the month approved, closed (locked), reopened with a reason, closed again
 *   → Excel and PDF of the month, the summary, the payroll file held back (the overtime rules wait) → the dashboard;
 *   an approver sees no "add"; a business with attendance only sees the module only; a phone: the report fits.
 *
 * Run: npx -y tsx tests/e2e/attendance.e2e.ts   (starts `next dev` on port 3243; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (att-* — not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';
import { clockApi } from './fake-attendance';
import { parseXlsx } from '../../src/features/finance/bank';
import { reportPdfInput } from '../../src/lib/server/report-pdf';
import { israelToIso } from '../../src/lib/il-time';
import { holidaysIn } from '../../src/features/booking/holidays';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_ATT_PORT ?? 3243);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000000a7';
const OWNER = 'a0000000-0000-4000-8000-0000000000a7';
const APPROVER = 'a0000000-0000-4000-8000-0000000000a8';
const PHONE_VIEW = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };
const MONTH = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
const day = (n: number) => `${MONTH}-${String(n).padStart(2, '0')}`;
const dm = (n: number) => `${String(n).padStart(2, '0')}/${MONTH.slice(5, 7)}`;
/** the first five weekdays (Sun–Thu) of last month that are not a festival — the days the test works on */
const weekdays = (() => {
  const out: number[] = [];
  const hol = holidaysIn(day(1), day(28));
  for (let n = 1; n <= 28 && out.length < 6; n++) {
    const w = new Date(`${day(n)}T12:00:00Z`).getUTCDay();
    if (w <= 4 && !(hol.get(day(n)) ?? []).some((h) => ['chag', 'chol', 'erev', 'national'].includes(h.kind))) out.push(n);
  }
  return out;
})();

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-01-01T00:00:00Z' };
  return {
    businesses: [{ id: BIZ, name: 'מסעדת הים', slug: 'yam', status: 'active', paid_until: null, grace_days: 0, modules: ['dream', 'attendance'] }],
    brands: [{ ...base, name: 'מסעדת הים', onboarded: true, industry: 'מסעדה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full', attendance_role: null }],
    profiles: [{ id: OWNER, full_name: 'רונית הבעלים', email: 'owner@yam.test', current_business_id: BIZ }],
    business_locations: [{ id: BIZ, business_id: BIZ, name: 'ראשי', kind: 'clinic', address: '', phone: '', hours: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' }],
    registers: [{ id: BIZ, business_id: BIZ, location_id: BIZ, name: 'קופה 1', device: '', active: true, sort: 0, created_at: '2026-01-01T00:00:00Z' }],
    employees: [], time_entries: [], timeclock_settings: [], departments: [], work_tracks: [], employee_private: [], attendance_approvers: [],
    time_requests: [], absences: [], attendance_months: [], attendance_month_events: [], time_entry_events: [],
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
  for (const p of ['/attendance', '/attendance/employees', '/attendance/settings', '/attendance/approvals', '/clock/x']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const fake = new FakeSupabase(seed(), { businessId: BIZ, userId: OWNER, email: 'owner@yam.test' });
  const errors: string[] = [];
  const said: string[] = [];
  const calls: string[] = [];
  let modules = ['dream', 'attendance'];
  const pdfBodies: any[] = [];

  async function context(viewport: { width: number; height: number }) {
    const phone = viewport.width < 600;
    const ctx = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', acceptDownloads: true,
      ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(OWNER, 'owner@yam.test'))]);
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
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'מסעדת הים', state: 'active' },
      businesses: [{ id: BIZ, name: 'מסעדת הים', state: 'active' }], superAdmin: false, access: 'full', modules } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/attendance/members`, (r: any) => r.fulfill({ json: { members: [
      { userId: OWNER, role: 'owner', attendanceRole: null, name: 'רונית הבעלים', email: 'owner@yam.test' },
      { userId: APPROVER, role: 'editor', attendanceRole: 'approver', name: 'יוסי המאשר', email: 'yossi@yam.test' }] } }));
    await ctx.route(`${BASE}/api/attendance/report-pdf`, async (r: any) => {
      const body = JSON.parse(r.request().postData() || '{}'); pdfBodies.push(body);
      const v = reportPdfInput(body);
      return v.ok ? r.fulfill({ status: 200, body: '%PDF-1.4\n%test\n', headers: { 'content-type': 'application/pdf' } }) : r.fulfill({ status: 400, json: { message: v.error } });
    });
    // the employee's clock: the server's answers (its own rules: tests/clock-api.test.ts), on the same in-memory database
    await ctx.route(`${BASE}/api/clock/**`, async (r: any) => {
      const u = new URL(r.request().url());
      const token = u.pathname.split('/')[3];
      if (u.pathname.endsWith('/manifest')) return r.continue();
      const a = clockApi(fake as any, token, r.request().method(), JSON.parse(r.request().postData() || '{}'));
      return r.fulfill({ status: a.status, json: a.json });
    });
    await ctx.route('https://wa.me/**', (r: any) => r.fulfill({ status: 200, body: 'wa', headers: { 'content-type': 'text/plain' } }));
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(e.message));
    page.on('dialog', (d: any) => { said.push(d.message()); return d.accept(); });
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
      await page.screenshot({ path: path.join(SHOTS, `att-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
    finally { clearTimeout(timer); }
  };
  const dialog = (p: any = page) => p.getByRole('dialog').last();
  const shot = async (name: string, p: any = page) => { await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, name), fullPage: true }); };
  const fits = async (p: any, what: string) => {
    const w = await p.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
    assert.ok(w.doc <= w.view + 1, `${what}: no sideways scroll (${w.doc} > ${w.view})`);
  };
  const dana = () => fake.tables.employees.find((e) => e.name === 'דנה כהן')!;
  const report = async (p: any = page) => { await goto(`/attendance/employees/${dana().id}?month=${MONTH}`, p); await p.getByText('כל העובדים').first().waitFor({ timeout: 120_000 }); };
  const row = (n: number) => page.locator('tbody tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${dm(n)}$`) }) });
  const live = () => fake.tables.time_entries.filter((e) => e.employee_id === dana().id && !e.voided_at);

  try {
    await step('before migration 5800: the clock screen as it was, the new screens say what is missing', async () => {
      fake.attendanceTables = false;
      await goto('/attendance');
      await page.getByRole('heading', { name: 'שעון נוכחות' }).waitFor({ timeout: 120_000 });
      await goto('/attendance/employees');
      await page.getByText('המסך הזה עוד לא פעיל').waitFor({ timeout: 120_000 });
      fake.attendanceTables = true;
    });

    await step('settings: a six-day contract (8 hours, then 125% / 150%), confirmed by the employer; a changed rule takes the confirmation away; a department', async () => {
      await goto('/attendance/settings');
      await page.getByRole('button', { name: 'מסלול חדש' }).click({ timeout: 120_000 });
      let d = dialog();
      await d.getByLabel('שם המסלול').fill('6 ימים, 8 שעות');
      await d.getByLabel('שעת התחלה (לסימון איחור, לא חובה)').fill('08:00');
      await d.getByText('6 ימים (א׳–ו׳)').waitFor();
      await shot('att-0-track-editor.png');
      await d.getByRole('button', { name: 'שמירה' }).click();
      await page.getByText('א׳–ו׳ 8 ש׳').waitFor();
      const t0 = fake.tables.work_tracks[0];
      assert.deepEqual(t0.day_minutes, [480, 480, 480, 480, 480, 480, 0]);
      assert.deepEqual([t0.ot_mode, t0.tier1_minutes, t0.tier1_pct, t0.tier2_pct, t0.rest_weekday, t0.rest_pct, t0.independence_pct, t0.auto_break_min], ['daily', 120, 125, 150, 6, 150, 200, 0]);
      await page.getByText('ממתין לאישור המעסיק').waitFor();
      await page.getByRole('button', { name: 'אישור ההגדרות' }).click();
      await page.getByText(/אושר ע״י המעסיק/).waitFor();
      assert.ok(fake.tables.work_tracks[0].rules_confirmed_at);
      // a rule changed: not confirmed any more; back as it was, confirmed again
      for (const v of ['130', '125']) {
        await page.getByRole('button', { name: 'עריכה' }).first().click();
        d = dialog();
        await d.getByLabel('דרגה ראשונה (%)').fill(v);
        if (v === '130') await d.getByText('שינוי של כלל מבטל את האישור').waitFor();
        await d.getByRole('button', { name: 'שמירה' }).click();
        await page.getByText('ממתין לאישור המעסיק').waitFor();
      }
      assert.equal(fake.tables.work_tracks[0].rules_confirmed_at, null);
      await page.getByRole('button', { name: 'אישור ההגדרות' }).click();
      await page.getByText(/אושר ע״י המעסיק/).waitFor();
      await page.getByLabel('ייצוא שעות ב-PDF בלבד').waitFor();
      assert.ok(await page.getByLabel('ייצוא שעות ב-PDF בלבד').isChecked(), 'PDF only — the default');
      await shot('att-1-settings.png');
      await goto('/attendance/departments');
      await page.getByLabel('שם מחלקה').fill('מטבח', { timeout: 120_000 });
      await page.getByRole('button', { name: 'הוספה', exact: true }).first().click();
      await page.locator('li').filter({ hasText: 'מטבח' }).filter({ hasText: '0 עובדים' }).waitFor();
      await page.locator('option', { hasText: 'יוסי המאשר' }).waitFor({ state: 'attached' });
    });

    await step('an employee: the reference\'s fields, the ID and the pay apart (manager only), no delete — archive', async () => {
      await goto('/attendance/employees?new=1');
      const d = dialog();
      await d.getByLabel('שם מלא').fill('דנה כהן', { timeout: 120_000 });
      await d.getByLabel('טלפון (לזימון בוואטסאפ)').fill('050-1234567');
      await d.getByLabel('מספר עובד').fill('101');
      await d.getByLabel('תואר / תפקיד').fill('טבחית');
      await d.getByLabel('מחלקה').selectOption({ label: 'מטבח' });
      await d.getByLabel('מסלול שעות תקן').selectOption({ index: 1 });
      await d.getByLabel('תאריך תחילת עבודה').fill(`${MONTH.slice(0, 4)}-01-01`);
      await d.getByLabel('תעודת זהות (לא חובה)').fill('123456789');
      await d.getByText('מספר תעודת הזהות לא תקין').waitFor();
      assert.ok(await d.getByRole('button', { name: 'שמירה' }).isDisabled(), 'a wrong ID is not saved');
      await d.getByLabel('תעודת זהות (לא חובה)').fill('123456782');
      await d.getByLabel('סוג שכר').selectOption('hourly');
      await d.getByLabel('שכר לשעה (₪)').fill('45.5');
      await shot('att-2-employee-form.png');
      await d.getByRole('button', { name: 'שמירה' }).click();
      await page.locator('tbody').getByText('דנה כהן').waitFor();
      const e = dana();
      assert.equal(e.employee_code, '101'); assert.equal(e.title, 'טבחית'); assert.ok(e.token.length >= 30);
      assert.equal(e.department_id, fake.tables.departments[0].id); assert.equal(e.track_id, fake.tables.work_tracks[0].id);
      assert.deepEqual([fake.tables.employee_private[0].id_number, fake.tables.employee_private[0].hourly_agorot], ['123456782', 4550]);
      assert.ok(!('hourly_agorot' in e) && !('id_number' in e), 'the pay and the ID are not in the employees table');
      await shot('att-3-employees.png');
    });

    await step('invited on WhatsApp — the personal link, from the tap itself', async () => {
      const [pop] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'זימון דנה כהן בוואטסאפ' }).click()]);
      const url = decodeURIComponent(pop.url());
      assert.ok(url.startsWith('https://wa.me/972501234567?text='), url);
      assert.ok(url.includes(`/clock/${dana().token}`), 'the personal link');
      await pop.close();
      for (let i = 0; i < 20 && !dana().invited_at; i++) await page.waitForTimeout(200);
      assert.ok(dana().invited_at, 'זומן');
    });

    await step('the employee clocks in and out on the phone (the clock page as it is)', async () => {
      const { ctx, page: phone } = await context(PHONE_VIEW);
      await goto(`/clock/${dana().token}`, phone);
      await phone.getByRole('button', { name: /כניסה/ }).click({ timeout: 120_000 });
      await phone.getByRole('button', { name: /יציאה/ }).waitFor();
      await shot('att-4-clock-in-phone.png', phone);
      await phone.getByRole('button', { name: /יציאה/ }).click();
      await phone.getByRole('button', { name: /כניסה/ }).waitFor();
      await shot('att-5-clock-out-phone.png', phone);
      await ctx.close();
      const mine = fake.tables.time_entries.filter((e) => e.employee_id === dana().id);
      assert.equal(mine.length, 1); assert.ok(mine[0].clock_out); assert.equal(mine[0].method, 'link');
      assert.deepEqual(fake.tables.time_entry_events.filter((e) => e.entry_id === mine[0].id).map((e) => `${e.kind}:${e.channel}`), ['created:clock', 'clock_out:clock']);
    });

    const [d1, d2, d3, d4, d5] = weekdays;
    await step('the monthly report: every day of the month, the day kinds, red where a work day has no report', async () => {
      await report();
      const n = new Date(Date.UTC(+MONTH.slice(0, 4), +MONTH.slice(5, 7), 0)).getUTCDate();
      assert.equal(await page.locator('tbody tr').count(), n, 'a row for every day');
      await row(d1).getByText('חסר').first().waitFor();
      assert.ok(await page.locator('tbody tr').filter({ hasText: 'שבת' }).count() >= 4);
      assert.equal(await page.getByText('טיוטה').count(), 0, 'the employer confirmed the track: no draft');
    });

    await step('a manager completes a day (07:00–18:00 — overtime) and a night shift (22:00–06:00); a reason always', async () => {
      await row(d1).getByRole('button', { name: 'השלמה' }).click();
      let d = dialog();
      await d.getByLabel('כניסה').fill('07:00'); await d.getByLabel('יציאה').fill('18:00');
      assert.ok(await d.getByRole('button', { name: 'שמירה' }).isDisabled(), 'no reason, no save');
      await d.getByLabel('סיבה (חובה — נשמרת בהיסטוריה)').fill('שכחה להחתים');
      await d.getByRole('button', { name: 'שמירה' }).click();
      await row(d1).getByText('11:00').first().waitFor();
      await row(d1).getByText('125%: 2:00 · 150%: 1:00').waitFor();
      await row(d2).getByRole('button', { name: 'השלמה' }).click();
      d = dialog();
      await d.getByLabel('כניסה').fill('22:00'); await d.getByLabel('יציאה').fill('06:00');
      await d.getByText('היציאה למחרת בבוקר').waitFor();
      await d.getByLabel('סיבה (חובה — נשמרת בהיסטוריה)').fill('משמרת לילה');
      await d.getByRole('button', { name: 'שמירה' }).click();
      await row(d2).getByText('(למחרת)').waitFor();
      await row(d2).getByText('8:00').first().waitFor();
      const night = live().find((e) => e.note === 'משמרת לילה')!;
      assert.equal(night.clock_in, israelToIso(day(d2), '22:00'));
    });

    await step('a correction: the old entry is voided and stays, a new one replaces it; the history says who, when and why', async () => {
      await row(d1).getByRole('button', { name: 'עריכה' }).click();
      await page.getByRole('button', { name: 'תיקון שעות' }).click();
      const d = dialog();
      await d.getByLabel('כניסה').fill('08:00');
      await d.getByLabel('סיבת התיקון (חובה)').fill('תקלה בשעון');
      await d.getByRole('button', { name: 'שמירת התיקון' }).click();
      await row(d1).getByText('10:00').first().waitFor();
      const old = fake.tables.time_entries.find((e) => e.note === 'שכחה להחתים')!;
      const now = live().find((e) => e.replaces === old.id)!;
      assert.ok(old.voided_at && old.void_reason === 'תקלה בשעון', 'the old one: voided, kept');
      assert.equal(now.clock_in, israelToIso(day(d1), '08:00'));
      await row(d1).getByRole('button', { name: `היסטוריה של ${day(d1)}` }).click();
      const h = dialog();
      await h.getByText('בוטל', { exact: true }).first().waitFor(); await h.getByText('רישום מתקן').first().waitFor(); await h.getByText('סיבה: תקלה בשעון').first().waitFor();
      await h.getByText('רונית הבעלים').first().waitFor();
      await shot('att-6-history.png');
      await page.keyboard.press('Escape');
    });

    await step('a duplicate is voided (with a reason) — out of the sums, never deleted', async () => {
      await row(d3).getByRole('button', { name: 'השלמה' }).click();
      let d = dialog();
      await d.getByLabel('כניסה').fill('08:00'); await d.getByLabel('יציאה').fill('09:00');
      await d.getByLabel('סיבה (חובה — נשמרת בהיסטוריה)').fill('בדיקה');
      await d.getByRole('button', { name: 'שמירה' }).click();
      await row(d3).getByText('1:00').first().waitFor();
      await row(d3).getByRole('button', { name: 'עריכה' }).click();
      await page.getByRole('button', { name: 'ביטול הרישום' }).click();
      d = dialog();
      assert.ok(await d.getByRole('button', { name: 'ביטול הרישום' }).isDisabled());
      await d.getByLabel('סיבה (חובה — נשמרת בהיסטוריה)').fill('נרשם בטעות');
      await d.getByRole('button', { name: 'ביטול הרישום' }).click();
      await row(d3).getByText('חסר').first().waitFor();
      assert.ok(fake.tables.time_entries.some((e) => e.note === 'בדיקה' && e.voided_at), 'kept, voided');
    });

    await step('an employee\'s request (from the personal link) is approved — and becomes an entry', async () => {
      fake.tables.time_requests.push({ id: '10000000-0000-4000-8000-000000000001', business_id: BIZ, employee_id: dana().id, kind: 'shift', entry_id: null,
        clock_in: israelToIso(day(d4), '09:00'), clock_out: israelToIso(day(d4), '15:00'), note: 'שכחתי את הטלפון', status: 'pending', created_at: new Date().toISOString() });
      await goto('/attendance/approvals');
      await page.getByText('״שכחתי את הטלפון״').waitFor({ timeout: 120_000 });
      await shot('att-7-approvals.png');
      await page.getByRole('button', { name: 'אישור', exact: true }).first().click();
      await page.getByText('אין בקשות שממתינות.').waitFor();
      const e = live().find((x) => x.method === 'request')!;
      assert.equal(e.clock_in, israelToIso(day(d4), '09:00'));
    });

    await step('an absence: vacation on two days — in the report', async () => {
      await goto('/attendance/absences?new=1');
      const d = dialog();
      await d.getByLabel('עובד/ת').selectOption({ label: 'דנה כהן' }, { timeout: 120_000 });
      await d.getByLabel('מתאריך').fill(day(d5)); await d.getByLabel('עד תאריך').fill(day(d5));
      await d.getByRole('button', { name: 'שמירה' }).click();
      await page.getByRole('button', { name: 'חודש קודם' }).click();
      await page.getByText('מאושרת').waitFor();
      await page.getByText('נרשם ע״י מנהל/ת').waitFor();
      await report();
      await row(d5).getByText('חופשה').first().waitFor();
    });

    await step('the month: approved, closed (locked), reopened with a reason, closed again', async () => {
      await page.getByRole('button', { name: 'אישור החודש' }).click();
      await page.getByText('חודש אושר', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'סגירת חודש' }).click();
      await page.getByText('חודש נסגר', { exact: true }).waitFor();
      await page.getByText('החודש סגור — הדוח נעול').waitFor();
      assert.equal(await page.getByRole('button', { name: 'השלמה' }).count(), 0, 'nothing to add in a closed month');
      assert.equal(await page.getByRole('button', { name: 'השלמת דיווח' }).count(), 0);
      assert.ok(said.some((s) => s.includes('לסגור את')), 'asked before closing');
      await shot('att-8-month-closed.png');
      await page.getByRole('button', { name: 'פתיחה מחדש' }).click();
      const d = dialog();
      await d.getByLabel('סיבה (חובה — נשמרת בהיסטוריה)').fill('תיקון אחרי בדיקת רו״ח');
      await d.getByRole('button', { name: 'פתיחה מחדש' }).click();
      await page.getByText('חודש פתוח', { exact: true }).waitFor();
      await page.getByText(/נפתח מחדש · רונית הבעלים · תיקון אחרי בדיקת רו״ח/).waitFor();
      await page.getByRole('button', { name: 'סגירת חודש' }).click();
      await page.getByText('חודש נסגר', { exact: true }).waitFor();
      assert.deepEqual(fake.tables.attendance_month_events.map((e) => e.kind), ['approved', 'closed', 'reopened', 'closed']);
    });

    await step('exports: PDF only by default (no Excel) — the month as PDF; the payroll report as PDF; Excel once the employer allows it', async () => {
      assert.equal(await page.getByRole('button', { name: 'אקסל' }).count(), 0, 'PDF only: no Excel of hours');
      const [p0] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDF' }).click()]);
      assert.equal(readFileSync(await p0.path(), 'utf8').slice(0, 5), '%PDF-');
      assert.equal(pdfBodies.at(-1).total[6], '24:00');
      await goto('/attendance/reports');
      await page.getByText('השעות יוצאות מהמערכת ב-PDF בלבד').waitFor({ timeout: 120_000 });
      assert.equal(await page.getByRole('button', { name: 'ייצוא לאקסל' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'קובץ לתוכנת שכר (CSV)' }).count(), 0);
      const [pay] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'דוח שכר (PDF)' }).click()]);
      assert.equal(readFileSync(await pay.path(), 'utf8').slice(0, 5), '%PDF-');
      const b = pdfBodies.at(-1);
      assert.equal(reportPdfInput(b).ok, true);
      assert.match(b.title, /^דוח שכר/);
      assert.deepEqual(b.columns.map((c: any) => c.label).slice(0, 6), ['מספר', 'שם', 'ימים', 'רגילות', '125%', '150%']);
      const dRow = b.rows.find((r: string[]) => r[1] === 'דנה כהן');
      assert.deepEqual(dRow.slice(0, 6), ['101', 'דנה כהן', '3', '22:00', '2:00', '0:00'], 'regular 8 + 8 + 6; the long day (10 h): 2 at 125%');
      await shot('att-9-reports.png');
      await goto('/attendance/settings');
      await page.getByLabel('ייצוא שעות ב-PDF בלבד').click({ timeout: 120_000 });
      await page.getByText('מותר גם אקסל וקובץ שכר').waitFor();
      await report();
      const [x] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'אקסל' }).click()]);
      const grid = await parseXlsx(new Uint8Array(readFileSync(await x.path())));
      const head = grid.find((r) => r[0] === 'תאריך')!;
      const total = grid.find((r) => r[0] === 'סה״כ')!;
      assert.equal(total[head.indexOf('סה״כ יומי')], String(10 + 8 + 6), 'the month: 10 + 8 + 6 hours');
      await goto('/attendance/reports');
      await page.getByRole('link', { name: 'דנה כהן' }).first().waitFor({ timeout: 120_000 });
      const [s] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'ייצוא לאקסל' }).click()]);
      const sum = await parseXlsx(new Uint8Array(readFileSync(await s.path())));
      assert.equal(sum.find((r) => r[1] === 'דנה כהן')![4], '24');
      const [c] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'קובץ לתוכנת שכר (CSV)' }).click()]);
      assert.match(readFileSync(await c.path(), 'utf8'), /^\uFEFFמספר עובד,שם/);
    });

    await step('the dashboard: today and the month — from the same reports', async () => {
      await goto('/attendance');
      await page.getByText('סטטוס יומי').waitFor({ timeout: 120_000 });
      await page.getByRole('button', { name: /דיווח מלא/ }).click();
      await page.getByRole('link', { name: /דנה כהן/ }).first().waitFor();
      await page.getByText('עובדים פעילים').first().waitFor();
      await shot('att-10-dashboard.png');
    });

    await step('an approver: no "add an employee", no closing', async () => {
      fake.attendanceRole = 'approver';
      await goto('/attendance/employees');
      await page.locator('tbody').getByText('דנה כהן').waitFor({ timeout: 120_000 });
      assert.equal(await page.getByRole('button', { name: 'הוספת עובד/ת' }).count(), 0);
      await report();
      assert.equal(await page.getByRole('button', { name: 'פתיחה מחדש' }).count(), 0, 'reopening is the admin\'s');
      fake.attendanceRole = 'admin';
    });

    await step('a phone: the monthly report and the employees fit, a card per day', async () => {
      const { ctx, page: phone } = await context(PHONE_VIEW);
      await report(phone);
      await phone.locator('text=חופשה >> visible=true').first().waitFor();
      await fits(phone, 'monthly report');
      await shot('att-11-report-phone.png', phone);
      await goto('/attendance/employees', phone);
      await phone.getByRole('link', { name: 'דנה כהן' }).first().waitFor({ timeout: 120_000 });
      await fits(phone, 'employees');
      await shot('att-12-employees-phone.png', phone);
      await ctx.close();
    });

    await step('a business with attendance only: the module only — every other address leads to it, no way to Dream, a sign-out', async () => {
      modules = ['attendance'];
      const { ctx, page: p } = await context(DESK);
      await goto('/dashboard', p);
      await p.waitForURL(`${BASE}/attendance`, { timeout: 120_000 });
      await p.getByText('סטטוס יומי').waitFor({ timeout: 120_000 });
      assert.equal(await p.getByText('חזרה ל-Dream').count(), 0);
      await p.getByRole('button', { name: 'יציאה מהחשבון' }).first().waitFor();
      await goto('/finance/documents', p);
      await p.waitForURL(`${BASE}/attendance`, { timeout: 120_000 });
      await shot('att-13-attendance-only.png', p);
      await ctx.close();
      modules = ['dream', 'attendance'];
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
