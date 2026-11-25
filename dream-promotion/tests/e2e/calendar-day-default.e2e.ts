/**
 * 2.117.3 (complements calendar.e2e.ts): every entry to the appointments screen opens on "יום" (today) and "הכול", on a phone and a computer
 * (nothing kept on the device any more); the big + of the phone's menu opens "תור חדש" on the day shown there, and goes to /create everywhere
 * else; a "יומן בלבד" member has no such + (another menu) — and nothing breaks.
 * Run: npx -y tsx tests/e2e/calendar-day-default.e2e.ts   (next dev on port 3238)
 * Screenshots: docs/screenshots/2.117.3/ (CAL_DAY_SHOTS=<dir> to change).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';
import { staffPhone, staffPhoneShow } from '../../src/features/crm/lead-routing';
import { addDays, isCalendarColor, isPractitionerColor } from '../../src/features/booking/calendar';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_CALENDAR_DAY_PORT ?? 3238);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.CAL_DAY_SHOTS ?? path.join(ROOT, 'docs/screenshots/2.117.3');
const BIZ = 'b0000000-0000-4000-8000-0000000000a5';
const OWNER = 'a0000000-0000-4000-8000-0000000000a5';      // the owner's account — שגית פרץ on the team
const KARIN_USER = 'a0000000-0000-4000-8000-0000000000a6';
const GAL_USER = 'a0000000-0000-4000-8000-0000000000a7';
const SAGIT = 'c0000000-0000-4000-8000-0000000000a5';
const KARIN = 'c0000000-0000-4000-8000-0000000000a6';
const GAL = 'c0000000-0000-4000-8000-0000000000a7';
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 900 };
const TODAY = '2026-10-18';                                 // a Sunday (summer time until the 25th: +03:00)
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+03:00`).toISOString();
let clock = new Date(at(TODAY, '12:40'));                   // the browser's and the history's

type Row = Record<string, any>;
const SVC = {
  micro: { id: 'e0000000-0000-4000-8000-0000000000a1', name: 'מיקרובליידינג', minutes: 60, price: 1200 },
  face: { id: 'e0000000-0000-4000-8000-0000000000a2', name: 'לייזר פנים', minutes: 30, price: 250 },
  body: { id: 'e0000000-0000-4000-8000-0000000000a3', name: 'לייזר גוף מלא', minutes: 90, price: 700 },
  firm: { id: 'e0000000-0000-4000-8000-0000000000a4', name: 'טיפול מיצוק', minutes: 45, price: 400 },
  carbon: { id: 'e0000000-0000-4000-8000-0000000000a5', name: 'קרבון', minutes: 30, price: 300 },
};
/** [the day from Sunday 18.10, the practitioner, "HH:MM", the treatment, the customer (invented), the status] */
type Appt = [number, string | null, string, keyof typeof SVC, string, string?];
const WEEK: Appt[] = [
  [0, KARIN, '09:00', 'micro', 'דנה ל.', 'done'], [0, KARIN, '10:30', 'micro', 'הדס ב.', 'done'], [0, KARIN, '13:00', 'micro', 'שירה מ.', 'confirmed'], [0, KARIN, '16:00', 'micro', 'מיכל ו.'],
  [0, GAL, '08:30', 'face', 'רוני ש.', 'done'], [0, GAL, '09:00', 'body', 'ליאת ג.', 'done'], [0, GAL, '11:00', 'face', 'מאיה פ.', 'done'], [0, GAL, '12:00', 'face', 'סתיו א.', 'confirmed'],
  [0, GAL, '14:00', 'body', 'יובל ק.', 'confirmed'], [0, GAL, '17:00', 'face', 'אלה ח.'],
  [0, SAGIT, '10:00', 'firm', 'גלית ד.', 'done'], [0, SAGIT, '12:30', 'firm', 'לינוי צ.', 'confirmed'], [0, SAGIT, '15:30', 'carbon', 'אביגיל ר.'], [0, SAGIT, '18:00', 'firm', 'רינת ס.'],
  [0, null, '15:00', 'face', 'עדי ק.'],
  [1, KARIN, '09:00', 'micro', 'מיכל ו.'], [1, KARIN, '11:00', 'micro', 'נגה ת.'], [1, KARIN, '14:30', 'micro', 'ספיר ה.'],
  [1, GAL, '09:30', 'face', 'אורין ב.'], [1, GAL, '10:00', 'body', 'קים ל.'], [1, GAL, '13:00', 'face', 'מעיין ש.'], [1, GAL, '16:00', 'face', 'רוני ש.'],
  [1, SAGIT, '10:00', 'firm', 'הדס ב.'], [1, SAGIT, '12:00', 'carbon', 'שירה מ.'], [1, SAGIT, '15:00', 'firm', 'ליאת ג.'],
  [2, KARIN, '10:00', 'micro', 'מאיה פ.'], [2, KARIN, '12:00', 'micro', 'יובל ק.'],
  [2, GAL, '08:30', 'face', 'אלה ח.'], [2, GAL, '09:00', 'face', 'גלית ד.'], [2, GAL, '11:00', 'body', 'רינת ס.'], [2, GAL, '15:00', 'face', 'סתיו א.'], [2, GAL, '17:30', 'face', 'מיכל ו.'],
  [2, SAGIT, '09:00', 'firm', 'אביגיל ר.'], [2, SAGIT, '13:00', 'firm', 'לינוי צ.'], [2, SAGIT, '16:00', 'carbon', 'עדי ק.'],
  [3, KARIN, '09:30', 'micro', 'נגה ת.'], [3, KARIN, '13:30', 'micro', 'קים ל.'], [3, KARIN, '16:00', 'micro', 'ספיר ה.'],
  [3, GAL, '10:00', 'body', 'מעיין ש.'], [3, GAL, '14:00', 'face', 'אורין ב.'], [3, GAL, '18:00', 'face', 'דנה ל.'],
  [3, SAGIT, '11:00', 'firm', 'הדס ב.'], [3, SAGIT, '14:30', 'firm', 'רוני ש.'],
  [4, KARIN, '09:00', 'micro', 'שירה מ.'], [4, KARIN, '11:30', 'micro', 'ליאת ג.'], [4, KARIN, '15:00', 'micro', 'מאיה פ.'], [4, KARIN, '17:00', 'micro', 'יובל ק.'],
  [4, GAL, '09:00', 'face', 'אלה ח.'], [4, GAL, '12:00', 'body', 'גלית ד.'], [4, GAL, '16:30', 'face', 'רינת ס.'],
  [4, SAGIT, '10:00', 'firm', 'סתיו א.'], [4, SAGIT, '13:00', 'carbon', 'מיכל ו.'], [4, SAGIT, '17:30', 'firm', 'אביגיל ר.'],
  [5, KARIN, '09:00', 'micro', 'לינוי צ.'], [5, GAL, '09:30', 'face', 'עדי ק.'], [5, GAL, '10:00', 'body', 'נגה ת.'], [5, SAGIT, '10:00', 'firm', 'ספיר ה.'], [5, SAGIT, '11:00', 'carbon', 'קים ל.'],
];
const apptId = (i: number) => `90000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
const person = (id: string, name: string, extra: Row = {}) =>
  ({ id, business_id: BIZ, name, phone: null, active: true, member_user_id: null, practitioner: false, color: '', created_at: '2026-10-18T05:00:00Z', ...extra });
/** the team when the calendar is in use: Sagit (on the team since the leads — her WhatsApp), Karin and Gal (no number) */
const TEAM = () => [
  person(SAGIT, 'שגית פרץ', { phone: '972501111111', member_user_id: OWNER, practitioner: true, color: 'yellow', created_at: '2026-10-12T08:00:00Z' }),
  person(KARIN, 'קרין בן ניזרי', { member_user_id: KARIN_USER, practitioner: true, color: 'pink', created_at: '2026-10-18T05:00:00Z' }),
  person(GAL, 'גל שחר', { member_user_id: GAL_USER, practitioner: true, color: 'turquoise', created_at: '2026-10-18T05:01:00Z' }),
];
const MEMBERS = [{ userId: OWNER, name: 'שגית פרץ', role: 'owner' }, { userId: KARIN_USER, name: 'קרין בן ניזרי', role: 'editor' }, { userId: GAL_USER, name: 'גל שחר', role: 'editor' }];

function seed(team: Row[], appts: Appt[], calendar = true): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-10-01T08:00:00Z' };
  return {
    brands: [{ ...base, name: 'קליניקה לייט', onboarded: true, industry: 'קוסמטיקה', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }, { business_id: BIZ, user_id: KARIN_USER, role: 'editor', access: 'full' },
      { business_id: BIZ, user_id: GAL_USER, role: 'editor', access: 'full' }],
    profiles: [{ id: OWNER, full_name: 'שגית פרץ', email: 'owner@clinic.test' }, { id: KARIN_USER, full_name: 'קרין בן ניזרי', email: 'karin@clinic.test' },
      { id: GAL_USER, full_name: 'גל שחר', email: 'gal@clinic.test' }],
    lead_staff: team,
    booking_services: Object.values(SVC).map((s, i) => ({ ...base, ...s, active: true, sort: i })),
    booking_settings: [{ ...base, slug: null, enabled: false, title: 'קליניקה לייט', address: '', phone: '', message: '', slot_minutes: 30, min_notice_minutes: 0, max_days_ahead: 30,
      hours: { 0: [['08:00', '20:00']], 1: [['08:00', '20:00']], 2: [['08:00', '20:00']], 3: [['08:00', '20:00']], 4: [['08:00', '20:00']], 5: [['08:00', '14:00']] }, closed_dates: [] }],
    appointments: appts.map(([d, staff, time, kind, name, status], i) => {
      const s = SVC[kind], start = at(addDays(TODAY, d), time);
      return { ...base, id: apptId(i), service_id: s.id, service_name: s.name, lead_id: null, name, phone: `05${String(20000101 + i)}`, email: '', note: '',
        start_at: start, end_at: new Date(Date.parse(start) + s.minutes * 60_000).toISOString(), status: status ?? 'booked', source: 'manual',
        ...(calendar ? { staff_id: staff } : {}) };
    }),
    appointment_events: [],
    leads: [], lead_activities: [], content: [], media: [], ad_drafts: [], pronunciations: [], push_subscriptions: [], social_messages: [],
    register_settings: [], employees: [], catalog_items: [], sales: [], documents: [], payments: [], quotes: [], document_drafts: [],
    client_packages: [], client_package_uses: [], client_sessions: [], client_treatments: [], treatment_types: [], payment_requests: [],
    business_locations: [], registers: [],
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

const CALENDAR_NOT_READY = 'צריך קודם להריץ את מיגרציה 20261018005700 (יומן התורים והמטפלות).';

/** /api/leads/departments as the real route answers (routingView, staff.save, staff.calendar), on the fake's lead_staff */
function teamRoute(fake: FakeSupabase, owner: boolean, userId: string, posts: Row[]) {
  return async (r: any) => {
    const req = r.request();
    if (!(req.headers().authorization ?? '').startsWith('Bearer ')) return r.fulfill({ status: 401, json: { code: 'no_session' } });
    const team = () => fake.tables.lead_staff as Row[];
    const bad = (message: string, code = 'invalid', status = 400) => r.fulfill({ status, json: { code, message } });
    const view = () => ({
      ready: true, connected: false, owner, me: team().filter((s) => s.active && s.member_user_id === userId).map((s) => s.id),
      staff: [...team()].sort((x, y) => String(x.created_at).localeCompare(String(y.created_at))).map((s) => ({
        id: s.id, name: s.name, active: s.active, memberUserId: s.member_user_id ?? null,
        ...('practitioner' in s ? { practitioner: Boolean(s.practitioner), color: s.color ?? '' } : {}),
        ...(owner ? { phone: s.phone ?? '', phoneShown: staffPhoneShow(s.phone) } : {}),
      })),
      departments: [], defaultStaffId: null,
    });
    if (req.method() === 'GET') {
      const setup = new URL(req.url()).searchParams.get('view') === 'setup';
      return r.fulfill({ json: setup && owner ? { ...view(), members: MEMBERS, health: { connected: false }, recent: [] } : view() });
    }
    if (!owner) return bad('רק בעלי העסק יכולים לשנות את זה.', 'owner_only', 403);
    const b = JSON.parse(req.postData() ?? '{}');
    posts.push(b);
    const ready = fake.calendarTables;
    if (b.action === 'staff.save') {
      const typed = String(b.phone ?? '').trim();
      const phone = typed ? staffPhone(typed) : null;
      if (typed && !phone) return bad('מספר וואטסאפ לא תקין. למשל 050-1234567, או מספר בחו״ל עם קידומת: ‎+1 555 010 0123');
      // before 5700: no such columns, and the number may not be empty
      if (!ready && (!phone || b.practitioner !== undefined || b.color !== undefined)) return bad(CALENDAR_NOT_READY, 'not_ready', 409);
      if (b.color !== undefined && b.color !== '' && !isCalendarColor(b.color)) return bad('צבע לא מוכר.');
      if (b.color !== undefined && b.color !== '' && !isPractitionerColor(b.color)) return bad('הצבע הזה שמור ליומן (כתום — שישי, כחול — שבת, סגול — חגים). בחרו צבע אחר.');
      if (b.memberUserId && team().some((s) => s.member_user_id === b.memberUserId)) return bad('החשבון הזה ב-Dream כבר משויך לאדם אחר בצוות.', 'duplicate', 409);
      team().push({ id: randomUUID(), business_id: BIZ, name: String(b.name).trim(), phone, active: true, member_user_id: b.memberUserId ?? null,
        created_at: clock.toISOString(), ...(ready ? { practitioner: Boolean(b.practitioner), color: b.color ?? '' } : {}) });
    } else if (b.action === 'staff.calendar') {
      if (!ready) return bad(CALENDAR_NOT_READY, 'not_ready', 409);
      const s = team().find((x) => x.id === b.id && x.active);
      if (!s) return bad('האדם הזה לא נמצא ברשימת הצוות.', 'not_found', 404);
      if (b.color !== undefined && b.color !== '' && !isCalendarColor(b.color)) return bad('צבע לא מוכר.');
      if (b.color !== undefined && b.color !== '' && !isPractitionerColor(b.color)) return bad('הצבע הזה שמור ליומן (כתום — שישי, כחול — שבת, סגול — חגים). בחרו צבע אחר.');
      if (b.practitioner !== undefined) s.practitioner = Boolean(b.practitioner);
      if (b.color !== undefined) s.color = b.color;
    } else return bad('פעולה לא מוכרת.');
    return r.fulfill({ json: view() });
  };
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
  // --lang: the date and the hour in a form as on a phone in Hebrew (24 hours), not as an American one
  const browser = await (async () => { await waitForServer(dev); return chromium.launch({ args: ['--lang=he-IL'], env: { ...process.env, LANG: 'he_IL.UTF-8', LANGUAGE: 'he' } }); })();
  for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}/appointments`).then((r) => r.ok, () => false); if (ok) break; }
  const errors: string[] = [];
  const calls: string[] = [];
  const posts: Row[] = [];
  const contexts: any[] = [];

  /** a browser for one person, on a fake that may be shared (the same tables, another account) */
  async function open(viewport: { width: number; height: number }, tables: Tables, who: { userId: string; email: string; owner: boolean; access?: 'full' | 'calendar' | 'agenda' }, calendar = true) {
    const fake = new FakeSupabase(tables, { businessId: BIZ, userId: who.userId, email: who.email, today: TODAY, clock: () => clock.getTime() });
    fake.calendarTables = calendar;
    const phone = viewport.width < 600;
    const ctx = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    contexts.push(ctx);
    await ctx.clock.setFixedTime(clock);
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(who.userId, who.email))]);
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
      businesses: [{ id: BIZ, name: 'קליניקה לייט', state: 'active' }], superAdmin: false, access: who.access ?? 'full' } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/meta/**`, (r: any) => r.fulfill({ json: { pages: [], connected: false } }));
    await ctx.route(`${BASE}/api/client-file/**`, (r: any) => r.fulfill({ status: 403, json: { code: 'no_access', message: 'אין גישה' } }));
    await ctx.route(`${BASE}/api/finance/**`, (r: any) => r.fulfill({ status: 403, json: { code: 'no_access', message: 'אין גישה' } }));
    // a calendar member (2.109): the real route refuses her (leadsCaller) — as here
    await ctx.route(`${BASE}/api/leads/departments**`, who.access === 'calendar' || who.access === 'agenda'
      ? (r: any) => r.fulfill({ status: 403, json: who.access === 'agenda' ? { code: 'agenda_only', message: 'ההרשאה שלך היא ליומן בלבד.' }
        : { code: 'calendar_only', message: 'ההרשאה שלך היא ליומן וללידים בלבד.' } })
      : teamRoute(fake, who.owner, who.userId, posts));
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(e.message));
    page.on('dialog', (d: any) => d.accept());
    return { ctx, page, fake };
  }
  const owner = { userId: OWNER, email: 'owner@clinic.test', owner: true };
  const gal = { userId: GAL_USER, email: 'gal@clinic.test', owner: false };
  /** the clock moves on: the browsers' and the history's */
  const tick = async (hm: string) => { clock = new Date(at(TODAY, hm)); for (const c of contexts) await c.clock.setFixedTime(clock).catch(() => null); };

  const goto = async (p: any, to: string) => {
    try { return await p.goto(`${BASE}${to}`, { waitUntil: 'domcontentloaded' }); }
    catch (e: any) { if (!/ERR_ABORTED/.test(String(e?.message))) throw e; return p.goto(`${BASE}${to}`, { waitUntil: 'domcontentloaded' }); }
  };
  let current: any = null;
  const step = async (name: string, fn: () => Promise<void>) => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('the step did not end in 150s')), 150_000); });
    try { await Promise.race([fn(), late]); results.push({ name, ok: true }); console.log(`ok - ${name}`); }
    catch (e: any) {
      results.push({ name, ok: false, error: e.message });
      console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}\n  last requests:\n    ${calls.join('\n    ')}`);
      if (current) await current.screenshot({ path: path.join(SHOTS, `cal-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null);
    } finally { clearTimeout(timer); }
  };
  const shot = async (p: any, name: string, full = true) => { await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, name), fullPage: full }); };
  /** a phone's screen as it is, from a place on the page (under the bar at the top): the bar at the bottom stays where it is */
  const screen = async (p: any, name: string, css: string) => {
    await p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(css)}); if (e) window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 72); })()`);
    await shot(p, name, false);
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
    assert.deepEqual(bad, [], `${what} fits the phone`);
  };
  /** the day's column titles — "קרין · 4 תורים" — or the week's days */
  const block = (p: any, label: RegExp) => p.getByRole('button', { name: label });
  const dialog = (p: any) => p.getByRole('dialog').last();
  const tables = () => seed(TEAM(), [[0, KARIN, '09:00', 'micro', 'דנה ל.'], [0, GAL, '10:00', 'face', 'רוני ש.'], [0, SAGIT, '11:00', 'firm', 'גלית ד.'],
    [1, KARIN, '09:30', 'micro', 'מיכל ו.'], [1, GAL, '10:30', 'body', 'קים ל.']]);
  /** "יום" selected and "הכול" on — once the screen has loaded its first answer */
  const onDayAll = async (p: any, what: string) => {
    await p.getByRole('tab', { name: 'יום', selected: true }).waitFor({ timeout: 120_000 });
    await p.getByText('יום ראשון, 18 באוקטובר').waitFor();
    const all = p.getByRole('button', { name: 'הכול', exact: true });
    await all.waitFor();
    assert.equal(await all.getAttribute('aria-pressed'), 'true', `${what}: "הכול" is on`);
    assert.equal(await p.getByRole('tab', { name: 'שבוע', selected: true }).count(), 0, `${what}: not the week`);
  };
  /** leave the screen inside the app (a link, no reload) and come back with the back button */
  const leaveAndBack = async (p: any) => {
    await p.locator('a[href="/dashboard"]:visible').first().click();
    await p.waitForURL(/\/dashboard/, { timeout: 120_000 });
    await p.goBack();
    await p.waitForURL(/\/appointments$/, { timeout: 120_000 });
  };

  try {
    const tbl = tables();
    const phone = await open(PHONE, tbl, owner);
    const desk = await open(DESK, tbl, owner);

    for (const [who, label] of [[phone, 'phone 390'], [desk, 'computer 1280']] as const) {
      await step(`(א) ${label}: the entry opens on "יום" and "הכול", also after "שבוע" and leaving and coming back`, async () => {
        current = who.page;
        await goto(who.page, '/appointments');
        await onDayAll(who.page, 'first entry');
        await who.page.getByRole('tab', { name: 'שבוע' }).click();
        await who.page.getByRole('tab', { name: 'שבוע', selected: true }).waitFor();
        await who.page.getByRole('button', { name: 'קרין בן ניזרי', exact: true }).click();   // a filter too: it goes back to "הכול"
        await leaveAndBack(who.page);
        await onDayAll(who.page, 'second entry');
        assert.equal(await who.page.evaluate(() => localStorage.getItem('dp-cal-view')), null, 'nothing kept on the device');
        await goto(who.page, '/appointments');   // a reload as well
        await onDayAll(who.page, 'after a reload');
        await fits(who.page, label);
        await shot(who.page, label.startsWith('phone') ? 'calendar-entry-phone-390.png' : 'calendar-entry-desktop-1280.png', false);
      });
    }

    await step('(ב) phone: the + of the menu opens "תור חדש" on the day shown — today, and the next day after the arrow', async () => {
      current = phone.page;
      const plus = phone.page.getByRole('button', { name: 'תור חדש', exact: true });
      await plus.waitFor();
      await plus.click();
      let d = dialog(phone.page);
      await d.getByRole('heading', { name: 'תור חדש' }).waitFor();
      assert.equal(await d.getByLabel('תאריך').inputValue(), TODAY);
      await fits(phone.page, 'the form');
      await shot(phone.page, 'calendar-plus-new-appointment-phone-390.png', false);
      await phone.page.keyboard.press('Escape');
      await d.waitFor({ state: 'hidden' });
      await phone.page.getByRole('button', { name: 'הבא' }).click();
      await phone.page.getByText('יום שני, 19 באוקטובר').waitFor();
      await plus.click();
      d = dialog(phone.page);
      await d.getByRole('heading', { name: 'תור חדש' }).waitFor();
      assert.equal(await d.getByLabel('תאריך').inputValue(), addDays(TODAY, 1), 'the day shown');
      await phone.page.keyboard.press('Escape');
    });

    await step('(ב2) the computer: the form from "+ תור" on the day shown (a shot), and no bottom menu + there', async () => {
      current = desk.page;
      await desk.page.getByRole('button', { name: '+ תור' }).click();
      const d = dialog(desk.page);
      await d.getByRole('heading', { name: 'תור חדש' }).waitFor();
      assert.equal(await d.getByLabel('תאריך').inputValue(), TODAY);
      await shot(desk.page, 'calendar-new-appointment-desktop-1280.png', false);
      await desk.page.keyboard.press('Escape');
      assert.equal(await desk.page.getByRole('button', { name: 'תור חדש', exact: true }).filter({ visible: true }).count(), 0, 'the + is the phone menu\'s only');
    });

    await step('(ג) phone: on another screen the + still goes to /create', async () => {
      current = phone.page;
      await goto(phone.page, '/dashboard');
      const plus = phone.page.getByRole('link', { name: 'יצירת תוכן חדש' });
      await plus.waitFor({ timeout: 120_000 });
      assert.equal(await phone.page.getByRole('button', { name: 'תור חדש', exact: true }).count(), 0, 'not the appointment button');
      await plus.click();
      await phone.page.waitForURL(/\/create/, { timeout: 120_000 });
    });

    await step('(ד) "יומן בלבד": the calendar opens on the day, and there is no + in her menu — nothing breaks', async () => {
      const a = await open(PHONE, tables(), { userId: KARIN_USER, email: 'karin@clinic.test', owner: false, access: 'agenda' });
      current = a.page;
      await goto(a.page, '/appointments');
      await a.page.getByRole('tab', { name: 'יום', selected: true }).waitFor({ timeout: 120_000 });
      await a.page.getByText('יום ראשון, 18 באוקטובר').waitFor();
      const bar = a.page.getByRole('navigation', { name: 'ניווט' });
      assert.deepEqual((await bar.locator('a').allInnerTexts()).map((x: string) => x.trim()), ['תורים']);
      assert.equal(await a.page.getByRole('button', { name: 'תור חדש', exact: true }).count(), 0, 'no + of the menu');
      assert.equal(await a.page.getByRole('link', { name: 'יצירת תוכן חדש' }).count(), 0, 'no /create +');
      await a.page.getByRole('button', { name: '+ תור' }).click();
      await dialog(a.page).getByRole('heading', { name: 'תור חדש' }).waitFor();
      await a.page.keyboard.press('Escape');
      await fits(a.page, 'agenda-only');
      await a.ctx.close();
    });

    await step('no error in the browser', async () => { assert.deepEqual(errors, []); });
  } finally {
    await browser.close().catch(() => null);
    try { process.kill(-dev.pid!, 'SIGTERM'); } catch { /* gone */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
