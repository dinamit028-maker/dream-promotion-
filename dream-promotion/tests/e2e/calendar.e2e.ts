/**
 * The appointments calendar (2.105, migration 5700) in a real browser (Chromium via Playwright), on a phone (390×844) and a
 * computer (1280×900), against the in-memory Supabase of fake-supabase.ts, with the browser's clock fixed (Sunday 18.10.2026,
 * 12:40 — the history's moments follow the same clock). The team's route (/api/leads/departments) is a stand-in here with the
 * real one's answers, on the fake's lead_staff — the route itself is tested in tests/lead-routing.test.ts, the database's rules
 * on Postgres (tests/sql/appointment-staff.check.sql), the calendar's arithmetic in tests/booking-calendar.test.ts.
 * Clicked through:
 *   the setup — "מטפלות": a person of the team marked as a practitioner and her colour; two new ones without a WhatsApp number
 *   (a wrong number refused), each with her account; then the day has a column for each, and the appointments with none wait
 *   above it ("לשיבוץ");
 *   a day on the phone: a column per practitioner in her colour; an appointment given a practitioner, moved, moved to another
 *   practitioner — one practitioner twice at once is refused (the message says so, nothing changes); its history (who, what,
 *   when); a tap on an empty hour books there, with that column's practitioner and her free hours;
 *   a week and a month on the computer: the title, the days, Saturday open (2.106), the next / previous / "היום", one practitioner
 *   or "רק שלי"; the list as before, with the practitioner;
 *   a member who is not the owner (Gal): sees everyone, moves Karin's appointment — the history says Gal; "מטפלות" read only;
 *   2.109 — Karin, "יומן ולידים": any other screen opens the calendar, two tabs, everyone's appointments, no settings or money;
 *   a new customer only with a phone (in the calendar and in the leads); the card without money, AI or deleting;
 *   2.110 — her treatments (a new one, a name and a length changed, never a price), and "סיום": an appointment from hour to hour —
 *   typed, or a tap on "שעה וחצי" / "שעתיים"; 2.110.2 — "+ שירות חדש" from the appointment itself;
 *   after the migration, a business with no practitioners: one column, as before, and the history; before the migration: the
 *   same views, no practitioner, no history, and "מטפלות" says what is missing;
 *   2.106 — the holidays of Israel: the week of Sukkot (Chol HaMoed, Hoshana Raba — closed to customers by the business —
 *   Simchat Torah), the month of September (Rosh Hashana, Yom Kippur, the eves, the fast of Gedaliah), a day of Chol HaMoed and
 *   Hoshana Raba on the phone, the list (Hanukkah); Friday, Saturday and a holiday in a colour each in every view — open for
 *   appointments like any day (one booked on a Saturday with no hours, in the usual hours); the three colours are not offered to
 *   a practitioner (and refused); "סגירה בחגים" adds the coming year's festival days to the closed days (the ones there stay),
 *   saved with the hours — the calendar still books them.
 * The names of the customers are invented; the practitioners are the business's own (docs/STATUS.md, "4תה").
 *
 * Run: npx -y tsx tests/e2e/calendar.e2e.ts   (starts `next dev` on port 3237; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (cal-* — not committed).
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
const PORT = Number(process.env.E2E_CALENDAR_PORT ?? 3237);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
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
  async function open(viewport: { width: number; height: number }, tables: Tables, who: { userId: string; email: string; owner: boolean; access?: 'full' | 'calendar' }, calendar = true) {
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
    await ctx.route(`${BASE}/api/leads/departments**`, who.access === 'calendar'
      ? (r: any) => r.fulfill({ status: 403, json: { code: 'calendar_only', message: 'ההרשאה שלך היא ליומן וללידים בלבד.' } })
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
  const heads = (p: any): Promise<string[]> => p.evaluate(`Array.from(document.querySelectorAll('main .flex.border-b > div.flex-1')).map(function (e) { return e.innerText.replace(/\\s+/g, ' ').trim(); })`);
  /** the titles, once the screen has them (a view loads its days after it is drawn with the days it had) */
  const expectHeads = async (p: any, want: string[], what = 'the titles') => {
    let got: string[] = [];
    for (let i = 0; i < 50; i++) { got = await heads(p); if (JSON.stringify(got) === JSON.stringify(want)) return; await p.waitForTimeout(200); }
    assert.deepEqual(got, want, what);
  };
  /** a column of the day (its practitioner's place), a tap at an hour — the quarter it falls in */
  const tapHour = async (p: any, col: number, hm: string, from = 8 * 60) => {
    const [h, m] = hm.split(':').map(Number);
    const y = (h * 60 + m - from) * (64 / 60) + 6;
    const c = p.locator('main div.cursor-copy').nth(col);
    const box = await c.boundingBox();
    await c.click({ position: { x: box.width / 2, y } });
  };
  const block = (p: any, label: RegExp) => p.getByRole('button', { name: label });
  const dialog = (p: any) => p.getByRole('dialog').last();
  const events = (fake: FakeSupabase, id: string) => (fake.tables.appointment_events as Row[]).filter((e) => e.appointment_id === id);
  const appt = (fake: FakeSupabase, name: string, day = TODAY) =>
    (fake.tables.appointments as Row[]).find((a) => a.name === name && new Date(a.start_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) === day)!;
  const israelTime = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });

  try {
    // ------------------------------------------------------------------------------------------------- the setup (phone) --
    const setupTables = seed([person(SAGIT, 'שגית פרץ', { phone: '972501111111', member_user_id: OWNER, created_at: '2026-10-12T08:00:00Z' })],
      [[0, null, '10:00', 'firm', 'גלית ד.'], [0, null, '12:30', 'micro', 'שירה מ.'], [0, null, '15:00', 'face', 'עדי ק.']]);
    const s = await open(PHONE, setupTables, owner);
    current = s.page;

    await step('before anyone is a practitioner: the day as one column, no filter, nothing waiting', async () => {
      await goto(s.page, '/appointments');
      await block(s.page, /^10:00–10:45 גלית ד\./).waitFor({ timeout: 120_000 });
      await s.page.getByRole('tab', { name: 'יום', selected: true }).waitFor();
      await s.page.getByText('יום ראשון, 18 באוקטובר').waitFor();
      await s.page.getByText('3 תורים ביום הזה').waitFor();
      assert.equal(await s.page.getByRole('button', { name: 'הכול', exact: true }).count(), 0, 'no practitioner: no filter');
      assert.equal(await s.page.getByText(/בלי מטפל\/ת:/).count(), 0, 'no practitioner: nothing waits for one');
      await expectHeads(s.page, [], 'one column, no titles');
    });

    await step('"מטפלות": Sagit marked, her colour; Karin and Gal added without a number (a wrong one refused)', async () => {
      await s.page.getByRole('button', { name: 'מטפלות', exact: true }).click();
      const sagit = s.page.locator('li').filter({ hasText: 'שגית פרץ' });
      await sagit.getByText('050-1111111').waitFor();
      const mark = sagit.getByLabel('מטפל/ת ביומן');
      assert.equal(await mark.isChecked(), false);
      await mark.check();                                       // at once on the screen; the server's answer after
      await sagit.getByText('(בינתיים צבע אוטומטי)').waitFor();
      // 2.106: orange, blue and violet are Friday's, Saturday's and the holidays' — never offered to a practitioner
      const offered: string[] = [];
      for (const r of await sagit.getByRole('radio').all()) offered.push(String(await r.getAttribute('aria-label')));
      assert.deepEqual(offered, ['ורוד', 'טורקיז', 'צהוב', 'ירוק', 'אדום', 'אפור']);
      await s.page.getByText('כתום, כחול וסגול שמורים ליומן — לשישי, לשבת ולחגים.', { exact: false }).waitFor();
      await sagit.getByRole('radio', { name: 'צהוב' }).click();
      await s.page.waitForFunction(() => document.querySelector('[aria-label="צהוב"][aria-checked="true"]'));
      assert.deepEqual(setupTables.lead_staff.map((x) => [x.name, x.practitioner, x.color]), [['שגית פרץ', true, 'yellow']]);
      assert.deepEqual(posts.slice(-2), [{ action: 'staff.calendar', id: SAGIT, practitioner: true }, { action: 'staff.calendar', id: SAGIT, color: 'yellow' }]);
      // a new practitioner: a number that is typed must be one
      await s.page.getByLabel('שם', { exact: true }).fill('קרין בן ניזרי');
      await s.page.getByRole('radiogroup', { name: 'צבע ביומן' }).getByRole('radio', { name: 'ורוד' }).click();
      await s.page.getByLabel(/מספר וואטסאפ/).fill('123');
      await s.page.getByRole('button', { name: 'הוספה ליומן' }).click();
      await s.page.getByText(/מספר וואטסאפ לא תקין/).waitFor();
      await s.page.waitForTimeout(1500);
      assert.equal(await s.page.getByText(/מספר וואטסאפ לא תקין/).count(), 1, 'the message stays — the list is not read again over it');
      await s.page.getByLabel(/מספר וואטסאפ/).fill('');
      await s.page.getByLabel(/החשבון שלה\/ו ב-Dream/).selectOption({ label: 'קרין בן ניזרי' });
      await s.page.getByRole('button', { name: 'הוספה ליומן' }).click();
      await s.page.locator('li').filter({ hasText: 'קרין בן ניזרי' }).getByText('בלי וואטסאפ').waitFor();
      await tick('12:41');                                      // one after the other: the team's order
      await s.page.getByLabel('שם', { exact: true }).fill('גל שחר');
      await s.page.getByRole('radiogroup', { name: 'צבע ביומן' }).getByRole('radio', { name: 'טורקיז' }).click();
      await s.page.getByLabel(/החשבון שלה\/ו ב-Dream/).selectOption({ label: 'גל שחר' });
      await s.page.getByRole('button', { name: 'הוספה ליומן' }).click();
      await s.page.locator('li').filter({ hasText: 'גל שחר' }).getByText('בלי וואטסאפ').waitFor();
      assert.deepEqual(setupTables.lead_staff.map((x) => [x.name, x.phone, x.practitioner, x.color, x.member_user_id]), [
        ['שגית פרץ', '972501111111', true, 'yellow', OWNER], ['קרין בן ניזרי', null, true, 'pink', KARIN_USER], ['גל שחר', null, true, 'turquoise', GAL_USER]]);
      await fits(s.page, '"מטפלות"');
      await screen(s.page, 'cal-1-staff-phone.png', 'main h3');
      // a refusal — here the person was taken off the team on another screen meanwhile: the mark is taken back, the message stays
      const ghost = person(randomUUID(), 'אורחת', { created_at: clock.toISOString() });
      setupTables.lead_staff.push(ghost);
      await s.page.getByRole('button', { name: 'יומן תורים', exact: true }).click();
      await s.page.getByRole('button', { name: 'מטפלות', exact: true }).click();
      const row = s.page.locator('li').filter({ hasText: 'אורחת' });
      await row.waitFor();
      ghost.active = false;
      await row.getByLabel('מטפל/ת ביומן').click();
      await s.page.getByText('האדם הזה לא נמצא ברשימת הצוות.').waitFor();
      await row.waitFor({ state: 'detached' });
      await s.page.waitForTimeout(1000);
      assert.equal(await s.page.getByText('האדם הזה לא נמצא ברשימת הצוות.').count(), 1, 'the message stays after the list is read again');
      assert.equal(ghost.practitioner, false, 'nothing saved');
    });

    await step('the day: a column for each, the three appointments wait above it; one given a practitioner', async () => {
      await s.page.getByRole('button', { name: 'יומן תורים', exact: true }).click();
      await s.page.getByText('3 תורים בלי מטפל/ת:').waitFor();
      await expectHeads(s.page, ['שגית אין תורים', 'קרין אין תורים', 'גל אין תורים']);
      for (const n of ['הכול', 'שגית פרץ', 'קרין בן ניזרי', 'גל שחר', 'רק שלי']) await s.page.getByRole('button', { name: n, exact: true }).waitFor();
      await s.page.getByRole('button', { name: /12:30 · שירה מ\. · לשיבוץ/ }).click();
      const d = dialog(s.page);
      await d.getByLabel('מטפל/ת').selectOption({ label: 'קרין בן ניזרי' });
      await d.getByRole('button', { name: 'שמירת השינוי' }).click();
      await s.page.getByText('2 תורים בלי מטפל/ת:').waitFor();
      await d.getByText('שובץ אצל קרין בן ניזרי').waitFor();
      const a = appt(s.fake, 'שירה מ.');
      assert.equal(a.staff_id, setupTables.lead_staff.find((x) => x.name === 'קרין בן ניזרי')!.id);
      assert.deepEqual(events(s.fake, a.id).map((e) => [e.kind, e.actor_name, e.after.staff]), [['staff', 'שגית פרץ', 'קרין בן ניזרי']]);
      await s.page.keyboard.press('Escape');
      await expectHeads(s.page, ['שגית אין תורים', 'קרין תור אחד', 'גל אין תורים']);
      await fits(s.page, 'the day with the appointments that wait');
    });
    await s.ctx.close();

    // ------------------------------------------------------------------------------------------- the calendar in use --
    const tables = seed(TEAM(), WEEK);
    const p = await open(PHONE, tables, owner);
    current = p.page;
    const mic = () => appt(p.fake, 'מיכל ו.');

    await step('a day on the phone: a column for each practitioner in her colour, the one with none above', async () => {
      await goto(p.page, '/appointments');
      await block(p.page, /^16:00–17:00 מיכל ו\./).waitFor({ timeout: 120_000 });
      await p.page.getByText('15 תורים ביום הזה').waitFor();
      await expectHeads(p.page, ['שגית 4 תורים', 'קרין 4 תורים', 'גל 6 תורים']);
      await p.page.getByText('תור אחד בלי מטפל/ת:').waitFor();
      // her colour: the block of Karin's appointment is pink, Gal's turquoise, Sagit's yellow
      const colour = async (re: RegExp) => String(await block(p.page, re).getAttribute('class')).split(' ').find((c) => /^cal-(?!appt)/.test(c));
      assert.deepEqual([await colour(/^16:00–17:00 מיכל ו\./), await colour(/^17:00–17:30 אלה ח\./), await colour(/^18:00–18:45 רינת ס\./)], ['cal-pink', 'cal-turquoise', 'cal-yellow']);
      await fits(p.page, 'the day');
      await screen(p.page, 'cal-2-day-phone.png', '[role=tablist]');
      await shot(p.page, 'cal-2-day-phone-full.png');
    });

    await step('the one with none is given Sagit; an appointment moved — the same length — and its history', async () => {
      await tick('12:41');
      await p.page.getByRole('button', { name: /15:00 · עדי ק\. · לשיבוץ/ }).click();
      let d = dialog(p.page);
      await d.getByRole('heading', { name: 'היסטוריה' }).waitFor();
      await d.getByText('אין עדיין שינויים רשומים.').waitFor();
      await d.getByLabel('מטפל/ת').selectOption({ label: 'שגית פרץ' });
      await d.getByRole('button', { name: 'שמירת השינוי' }).click();
      await d.getByText('שובץ אצל שגית פרץ').waitFor();
      await p.page.keyboard.press('Escape');
      assert.equal(await p.page.getByText(/בלי מטפל\/ת:/).count(), 0, 'nothing waits');
      await expectHeads(p.page, ['שגית 5 תורים', 'קרין 4 תורים', 'גל 6 תורים']);
      await tick('12:44');
      await block(p.page, /^16:00–17:00 מיכל ו\./).click();
      d = dialog(p.page);
      await d.getByLabel('שעה').fill('16:30');
      await d.getByText('א׳ 18.10 · 16:30–17:30').waitFor();
      await d.getByRole('button', { name: 'שמירת השינוי' }).click();
      await d.getByText('הוזז מ-16:00 ל-16:30').waitFor();
      assert.deepEqual([israelTime(mic().start_at), israelTime(mic().end_at)], ['16:30', '17:30'], 'the same length');
      await block(p.page, /^16:30–17:30 מיכל ו\./).waitFor();
    });

    await step('one practitioner twice at once is refused — the message says so, nothing changes; to another practitioner it goes', async () => {
      await tick('12:46');
      const d = dialog(p.page);
      await d.getByLabel('שעה').fill('13:00');                  // Karin is with שירה מ. 13:00–14:00
      await d.getByRole('button', { name: 'שמירת השינוי' }).click();
      await d.getByText('כבר יש תור אצל המטפל/ת הזה/זו בשעה הזו. בחרו שעה אחרת או מטפל/ת אחר/ת.').waitFor();
      assert.equal(israelTime(mic().start_at), '16:30', 'not moved');
      assert.equal(events(p.fake, mic().id).length, 1, 'nothing written');
      await d.getByLabel('מטפל/ת').selectOption({ label: 'גל שחר' });   // Gal is free 13:00–14:00
      await d.getByRole('button', { name: 'שמירת השינוי' }).click();
      await d.getByText('הועבר מקרין בן ניזרי לגל שחר').waitFor();
      await d.getByText('הוזז מ-16:30 ל-13:00').waitFor();
      assert.deepEqual([mic().staff_id, israelTime(mic().start_at)], [GAL, '13:00']);
      assert.deepEqual(events(p.fake, mic().id).map((e) => [e.kind, e.actor_name]), [['moved', 'שגית פרץ'], ['moved', 'שגית פרץ'], ['staff', 'שגית פרץ']]);
      assert.equal(await d.getByText(/^18\.10, 12:46$/).count(), 2, 'when — Israel time');
      await fits(p.page, 'the appointment');
      await shot(p.page, 'cal-3-appointment-phone.png', false);
      await p.page.keyboard.press('Escape');
      await expectHeads(p.page, ['שגית 5 תורים', 'קרין 3 תורים', 'גל 7 תורים']);
    });

    await step('a tap on an empty hour of a column books there — that practitioner, her free hours', async () => {
      await tick('12:50');
      await tapHour(p.page, 1, '17:00');                        // Karin's column — free from 14:00
      const d = dialog(p.page);
      await d.getByRole('heading', { name: 'תור חדש' }).waitFor();
      assert.equal(await d.getByLabel('מטפל/ת').inputValue(), KARIN);
      assert.equal(await d.getByLabel('תאריך').inputValue(), TODAY);
      assert.equal(await d.getByLabel('או שעה אחרת').inputValue(), '17:00');
      assert.equal(await d.getByRole('button', { name: '13:00', exact: true }).count(), 0, 'Karin\'s 13:00 is taken');
      await d.getByRole('button', { name: '17:00', exact: true }).waitFor();
      await d.locator('input[list="crm-names"]').fill('נגה ת.');
      await d.getByLabel('טלפון').fill('0541112233');
      await d.getByRole('button', { name: 'קביעת התור' }).click();
      await d.waitFor({ state: 'detached' });
      const a = appt(p.fake, 'נגה ת.');
      assert.deepEqual([a.staff_id, israelTime(a.start_at), israelTime(a.end_at), a.status], [KARIN, '17:00', '18:00', 'booked']);
      assert.deepEqual(events(p.fake, a.id).map((e) => [e.kind, e.actor_name, e.after.staff]), [['created', 'שגית פרץ', 'קרין בן ניזרי']]);
      await block(p.page, /^17:00–18:00 נגה ת\./).click();
      await dialog(p.page).getByText('נקבע התור אצל קרין בן ניזרי').waitFor();
      await p.page.keyboard.press('Escape');
    });

    await step('"רק שלי" and one practitioner on the phone; the month, a day picked; the list with the practitioner', async () => {
      await p.page.getByRole('button', { name: 'רק שלי', exact: true }).click();
      await expectHeads(p.page, ['שגית 5 תורים'], 'the owner\'s account is Sagit');
      await p.page.getByRole('button', { name: 'גל שחר', exact: true }).click();
      await expectHeads(p.page, ['גל 7 תורים']);
      await p.page.getByRole('button', { name: 'הכול', exact: true }).click();
      await p.page.getByRole('tab', { name: 'חודש' }).click();
      await p.page.getByText('אוקטובר 2026').waitFor();
      await p.page.getByRole('button', { name: /^יום שלישי, 20 באוקטובר: 10 תורים$/ }).click();
      await p.page.getByText('יום שלישי, 20 באוקטובר · 10 תורים').waitFor();
      await fits(p.page, 'the month');
      await screen(p.page, 'cal-4-month-phone.png', '[role=tablist]');
      await p.page.getByRole('tab', { name: 'רשימה' }).click();
      await p.page.getByText('מטפל/ת: קרין בן ניזרי · שינוי והיסטוריה ›').first().waitFor();
      await p.page.getByText(/^היום · /).waitFor();
      await fits(p.page, 'the list');
      // the device remembers the view
      await goto(p.page, '/appointments');
      await p.page.getByRole('tab', { name: 'רשימה', selected: true }).waitFor({ timeout: 60_000 });
      await p.page.getByRole('tab', { name: 'יום' }).click();
    });

    // ------------------------------------------------------------------------------------------------- a computer --
    const w = await open(DESK, tables, owner);
    current = w.page;
    await step('a week on the computer: Sunday to Saturday (Saturday open, in its colour); the next week and back', async () => {
      await goto(w.page, '/appointments');
      await w.page.getByRole('tab', { name: 'שבוע', selected: true }).waitFor({ timeout: 120_000 });
      await w.page.getByText('18–24 באוקטובר 2026').waitFor();
      await block(w.page, /^17:00–18:00 נגה ת\./).waitFor();
      await expectHeads(w.page, ['א׳ 18.10 16 תורים', 'ב׳ 19.10 10 תורים', 'ג׳ 20.10 10 תורים', 'ד׳ 21.10 8 תורים', 'ה׳ 22.10 10 תורים', 'ו׳ 23.10 5 תורים', 'ש׳ 24.10 אין תורים']);
      const days = await heads(w.page);
      assert.deepEqual(days.map((x) => x.split(' ').slice(0, 2).join(' ')), ['א׳ 18.10', 'ב׳ 19.10', 'ג׳ 20.10', 'ד׳ 21.10', 'ה׳ 22.10', 'ו׳ 23.10', 'ש׳ 24.10']);
      assert.equal(days[6], 'ש׳ 24.10 אין תורים', 'a Saturday with no hours: open for appointments (2.106)');
      assert.equal(days[0], 'א׳ 18.10 16 תורים');
      await w.page.getByText('59 תורים בשבוע הזה').waitFor();
      // Sunday 09:00: Karin with דנה ל., Gal with ליאת ג. — side by side in the day's column
      const [x, y] = await Promise.all([block(w.page, /^09:00–10:00 דנה ל\./).boundingBox(), block(w.page, /^09:00–10:30 ליאת ג\./).boundingBox()]);
      assert.ok(x.x + x.width <= y.x + 1 || y.x + y.width <= x.x + 1, 'side by side, not one over the other');
      await shot(w.page, 'cal-5-week-desktop.png');
      await w.page.getByRole('group', { name: 'סינון לפי מטפל/ת' }).getByRole('button', { name: 'קרין בן ניזרי', exact: true }).click();
      await w.page.getByText('17 תורים בשבוע הזה').waitFor();
      assert.equal(await block(w.page, /אלה ח\./).count(), 0, 'Gal\'s are not shown');
      await w.page.getByRole('button', { name: 'הכול', exact: true }).click();
      await w.page.getByRole('button', { name: 'הבא' }).click();
      await w.page.getByText('25–31 באוקטובר 2026').waitFor();
      await w.page.getByText('אין תורים בשבוע הזה').waitFor();
      await w.page.getByRole('button', { name: 'היום', exact: true }).click();
      await w.page.getByText('18–24 באוקטובר 2026').waitFor();
      await w.page.getByRole('tab', { name: 'יום' }).click();
      await expectHeads(w.page, ['שגית 5 תורים', 'קרין 4 תורים', 'גל 7 תורים']);
      await shot(w.page, 'cal-6-day-desktop.png');
      await w.page.getByRole('tab', { name: 'חודש' }).click();
      await w.page.getByRole('button', { name: /^יום ראשון, 18 באוקטובר: 16 תורים$/ }).getByText('+13').waitFor();
      await shot(w.page, 'cal-7-month-desktop.png');
      // the light look: the same colours, readable on white
      await w.page.evaluate("localStorage.setItem('dp-theme', 'light')");
      await goto(w.page, '/appointments');
      await w.page.getByRole('tab', { name: 'שבוע' }).click({ timeout: 60_000 });
      await block(w.page, /^17:00–18:00 נגה ת\./).waitFor();
      await shot(w.page, 'cal-9-week-light-desktop.png');
    });
    await w.ctx.close();

    // ------------------------------------------------------------------------ the holidays, Friday and Saturday (2.106) --
    /** the week of Sukkot (27.9–3.10.2026, three weeks back): appointments on Chol HaMoed; the business closes Hoshana Raba; one at Hanukkah */
    const SUKKOT: Appt[] = [
      [-21, KARIN, '10:00', 'micro', 'דנה ל.', 'done'], [-21, GAL, '12:00', 'face', 'רוני ש.', 'done'], [-20, SAGIT, '11:00', 'firm', 'גלית ד.', 'done'],
      [-19, GAL, '09:30', 'body', 'ליאת ג.', 'done'], [-18, KARIN, '13:00', 'micro', 'שירה מ.', 'done'], [-17, SAGIT, '10:00', 'carbon', 'מאיה פ.', 'done'],
      [49, KARIN, '10:00', 'micro', 'נגה ת.'],
    ];
    const holidayTables = seed(TEAM(), [...WEEK, ...SUKKOT]);
    const settingsOf = (fake: FakeSupabase) => (fake.tables.booking_settings as Row[])[0];
    (holidayTables.booking_settings as Row[])[0].closed_dates = ['2026-10-02'];
    /** the colour of each title of the week (or the day's practitioners) and of each column — Friday, Saturday, closed */
    const tones = (p: any): Promise<string[]> => p.evaluate(`Array.from(document.querySelectorAll('main .flex.border-b > div.flex-1')).map(function (e) { return (e.className.match(/cal-(fri|sat|chag)/) || [''])[0]; })`);
    const cols = (p: any): Promise<string[]> => p.evaluate(`Array.from(document.querySelectorAll('main div.cursor-copy')).map(function (e) { return (e.className.match(/cal-(fri|sat|chag|closed)/g) || []).join(' '); })`);
    const looks = async (l: any) => String(await l.getAttribute('class'));
    const hw = await open(DESK, holidayTables, owner);
    current = hw.page;
    await step('the holidays on the computer: Friday, Saturday and a holiday in their colours; one booked on Saturday; the week of Sukkot; September', async () => {
      await goto(hw.page, '/appointments');
      await hw.page.getByRole('tab', { name: 'שבוע', selected: true }).waitFor({ timeout: 120_000 });
      await block(hw.page, /^18:00–18:45 רינת ס\./).waitFor();
      // a week with no holiday: no line for one — the titles as before; Friday and Saturday in their colours, Saturday open
      await expectHeads(hw.page, ['א׳ 18.10 15 תורים', 'ב׳ 19.10 10 תורים', 'ג׳ 20.10 10 תורים', 'ד׳ 21.10 8 תורים', 'ה׳ 22.10 10 תורים', 'ו׳ 23.10 5 תורים', 'ש׳ 24.10 אין תורים']);
      assert.deepEqual(await tones(hw.page), ['', '', '', '', '', 'cal-fri', 'cal-sat']);
      assert.deepEqual(await cols(hw.page), ['', '', '', '', '', 'cal-fri', 'cal-sat']);
      // Saturday has no hours (the booking page's): the calendar books it in the business's usual hours (08:00–20:00 here)
      const sat = hw.page.locator('main div.cursor-copy').nth(6);
      const satBox = await sat.boundingBox();
      await sat.click({ position: { x: satBox.width / 2, y: (10 * 60 - 8 * 60) * (48 / 60) + 6 } });
      const nd = dialog(hw.page);
      await nd.getByRole('button', { name: '10:00', exact: true, pressed: true }).waitFor();
      assert.equal(await nd.getByRole('button', { name: '08:00', exact: true }).count(), 1, 'the usual hours, from the earliest opening');
      assert.equal(await nd.getByText('אין שעות פנויות לפי שעות הפעילות.').count(), 0);
      await nd.locator('input[list="crm-names"]').fill('טל א.');   // the name (with the contacts' list)
      await nd.getByLabel('טלפון').fill('0521230011');
      await nd.getByRole('button', { name: 'קביעת התור' }).click();
      await block(hw.page, /^10:00–11:00 טל א\./).waitFor();
      assert.equal(israelTime(appt(hw.fake, 'טל א.', '2026-10-24').start_at), '10:00');
      await expectHeads(hw.page, ['א׳ 18.10 15 תורים', 'ב׳ 19.10 10 תורים', 'ג׳ 20.10 10 תורים', 'ד׳ 21.10 8 תורים', 'ה׳ 22.10 10 תורים', 'ו׳ 23.10 5 תורים', 'ש׳ 24.10 תור אחד']);
      for (let i = 0; i < 3; i++) await hw.page.getByRole('button', { name: 'הקודם' }).click();
      await hw.page.getByText('27 בספטמבר – 3 באוקטובר 2026').waitFor();
      await expectHeads(hw.page, ['א׳ 27.9 חול המועד סוכות 2 תורים', 'ב׳ 28.9 חול המועד סוכות תור אחד', 'ג׳ 29.9 חול המועד סוכות תור אחד',
        'ד׳ 30.9 חול המועד סוכות תור אחד', 'ה׳ 1.10 חול המועד סוכות תור אחד', 'ו׳ 2.10 הושענא רבה אין תורים', 'ש׳ 3.10 שמחת תורה אין תורים']);
      // every day of it a holiday: the holiday's colour over Friday's and Saturday's; Hoshana Raba, closed to customers, open here
      assert.deepEqual(await tones(hw.page), Array(7).fill('cal-chag'));
      assert.deepEqual(await cols(hw.page), Array(7).fill('cal-chag'), 'never striped: open for appointments');
      assert.match(await looks(hw.page.getByText('שמחת תורה', { exact: true })), /\bcal-hol\b/, 'a festival stands out');
      await block(hw.page, /^10:00–11:00 דנה ל\./).waitFor();
      await shot(hw.page, 'cal-10-sukkot-week-desktop.png', false);
      // the month of September: the holidays in their days, a day picked says its holiday
      await hw.page.getByRole('tab', { name: 'חודש' }).click();
      await hw.page.getByText('ספטמבר 2026').waitFor();
      for (const [day, name] of [['יום שישי, 11 בספטמבר', 'ערב ראש השנה'], ['יום שבת, 12 בספטמבר', 'ראש השנה'], ['יום ראשון, 13 בספטמבר', 'ראש השנה'],
        ['יום שני, 14 בספטמבר', 'צום גדליה'], ['יום ראשון, 20 בספטמבר', 'ערב יום כיפור'], ['יום שני, 21 בספטמבר', 'יום כיפור'], ['יום שישי, 25 בספטמבר', 'ערב סוכות'],
        ['יום שבת, 26 בספטמבר', 'סוכות'], ['יום ראשון, 27 בספטמבר', 'חול המועד סוכות'], ['יום שבת, 3 באוקטובר', 'שמחת תורה']]) {
        assert.equal(await hw.page.getByRole('button', { name: new RegExp(`^${day} · ${name}: `) }).count(), 1, `${day} · ${name}`);
      }
      assert.equal(await hw.page.getByRole('button', { name: /^יום רביעי, 16 בספטמבר: אין תורים$/ }).count(), 1, 'a day with none: as before');
      const letters: string[] = await hw.page.evaluate(`Array.from(document.querySelectorAll('main .grid-cols-7.border-b > span')).map(function (e) { return (e.className.match(/cal-(fri|sat)/) || [''])[0]; })`);
      assert.deepEqual(letters, ['', '', '', '', '', 'cal-fri', 'cal-sat'], 'the letters of Friday and Saturday');
      assert.match(await looks(hw.page.getByRole('button', { name: /^יום שישי, 18 בספטמבר: / })), /\bcal-fri\b/);
      assert.match(await looks(hw.page.getByRole('button', { name: /^יום שבת, 19 בספטמבר: / })), /\bcal-sat\b/);
      assert.match(await looks(hw.page.getByRole('button', { name: /^יום שבת, 12 בספטמבר · ראש השנה: / })), /\bcal-chag\b/, 'a holiday on a Saturday: the holiday\'s colour');
      assert.match(await looks(hw.page.getByRole('button', { name: /^יום שני, 21 בספטמבר · יום כיפור: / })), /\bcal-chag\b/);
      assert.doesNotMatch(await looks(hw.page.getByRole('button', { name: /^יום שני, 14 בספטמבר · צום גדליה: / })), /\bcal-(chag|fri|sat|closed)\b/, 'a fast: its name only');
      assert.doesNotMatch(await looks(hw.page.getByRole('button', { name: /^יום שישי, 25 בספטמבר · ערב סוכות: / })), /\bcal-chag\b/, 'an eve: Friday\'s colour');
      await hw.page.getByRole('button', { name: /^יום שבת, 12 בספטמבר · ראש השנה: / }).click();
      await hw.page.getByText('יום שבת, 12 בספטמבר · ראש השנה · אין תורים').waitFor();
      await shot(hw.page, 'cal-11-september-month-desktop.png', false);
      // the list: Friday's day in its colour, Hanukkah by its day
      await hw.page.getByRole('tab', { name: 'רשימה' }).click();
      await hw.page.locator('main h3', { hasText: 'יום ראשון, 6 בדצמבר · חנוכה' }).waitFor();
      assert.match(await looks(hw.page.locator('main h3', { hasText: 'יום שישי, 23 באוקטובר' })), /\bcal-fri\b/);
      assert.doesNotMatch(await looks(hw.page.locator('main h3', { hasText: 'יום חמישי, 22 באוקטובר' })), /\bcal-(fri|sat)\b/);
      // the light look: the same colours, readable on white
      await hw.page.evaluate("localStorage.setItem('dp-theme', 'light')");
      await goto(hw.page, '/appointments');
      await hw.page.getByRole('tab', { name: 'שבוע' }).click({ timeout: 120_000 });
      await block(hw.page, /^18:00–18:45 רינת ס\./).waitFor();
      for (let i = 0; i < 3; i++) await hw.page.getByRole('button', { name: 'הקודם' }).click();
      await block(hw.page, /^10:00–11:00 דנה ל\./).waitFor();
      await shot(hw.page, 'cal-12-sukkot-week-light-desktop.png', false);
      await hw.page.evaluate("localStorage.setItem('dp-theme', 'dark')");
    });
    await hw.ctx.close();

    const hp = await open(PHONE, holidayTables, owner);
    current = hp.page;
    await step('the holidays on the phone: September; a day of Chol HaMoed; Hoshana Raba open; "סגירה בחגים" in the opening hours', async () => {
      await goto(hp.page, '/appointments');
      await block(hp.page, /^18:00–18:45 רינת ס\./).waitFor({ timeout: 120_000 });
      await hp.page.getByRole('tab', { name: 'חודש' }).click();
      await hp.page.getByText('אוקטובר 2026').waitFor();
      await hp.page.getByRole('button', { name: 'הקודם' }).click();
      await hp.page.getByText('ספטמבר 2026').waitFor();
      await fits(hp.page, 'the month with its holidays');
      await screen(hp.page, 'cal-13-september-month-phone.png', '[role=tablist]');
      await hp.page.getByRole('button', { name: /^יום שני, 28 בספטמבר · חול המועד סוכות: תור אחד$/ }).click();
      await hp.page.getByText('יום שני, 28 בספטמבר · חול המועד סוכות · תור אחד').waitFor();
      await hp.page.getByRole('tab', { name: 'יום' }).click();
      await hp.page.locator('main p', { hasText: /^חול המועד סוכות$/ }).waitFor();
      await expectHeads(hp.page, ['שגית תור אחד', 'קרין אין תורים', 'גל אין תורים']);
      assert.deepEqual(await cols(hp.page), ['', '', ''], 'the colour on the day\'s grid, not on each column; open');
      assert.equal(await hp.page.locator('main div.relative.flex.cal-chag').count(), 1, 'Chol HaMoed: the holiday\'s colour');
      await fits(hp.page, 'a day of Chol HaMoed');
      await screen(hp.page, 'cal-14-chol-hamoed-day-phone.png', '[role=tablist]');
      for (let i = 0; i < 4; i++) await hp.page.getByRole('button', { name: 'הבא' }).click();
      await hp.page.getByText('יום שישי, 2 באוקטובר', { exact: true }).waitFor();
      await hp.page.locator('main p', { hasText: /^הושענא רבה$/ }).waitFor();
      assert.equal(await hp.page.locator('main .flex.border-b.cal-chag').count(), 1, 'a holiday on a Friday: the holiday\'s colour on the titles');
      assert.deepEqual(await cols(hp.page), ['', '', ''], 'closed to customers (one of the closed days), open on the calendar: not striped');
      assert.equal(await hp.page.locator('main div.relative.flex.cal-chag').count(), 1);
      // the opening hours: "סגירה בחגים" — the coming year's festival days join the closed days; saved only with "שמירת שעות"
      await hp.page.getByRole('button', { name: 'שעות פעילות', exact: true }).click();
      const chips = (): Promise<string[]> => hp.page.evaluate(`Array.from(document.querySelectorAll('main button[aria-label$="— הסרה"]')).map(function (e) { return e.getAttribute('aria-label'); })`);
      await hp.page.getByRole('button', { name: '2.10.2026 הושענא רבה — הסרה' }).waitFor();
      await hp.page.getByRole('button', { name: 'סגירה בחגים', exact: true }).click();
      await hp.page.getByText('נוספו 7 ימי חג — כדי שיישמרו, לחצו "שמירת שעות".').waitFor();
      assert.deepEqual(await chips(), ['2.10.2026 הושענא רבה — הסרה', '22.4.2027 פסח — הסרה', '28.4.2027 שביעי של פסח — הסרה', '11.6.2027 שבועות — הסרה',
        '2.10.2027 ראש השנה — הסרה', '3.10.2027 ראש השנה — הסרה', '11.10.2027 יום כיפור — הסרה', '16.10.2027 סוכות — הסרה']);
      assert.deepEqual(settingsOf(hp.fake).closed_dates, ['2026-10-02'], 'nothing saved before "שמירת שעות"');
      await fits(hp.page, 'the opening hours');
      await hp.page.evaluate(`(() => { const e = Array.from(document.querySelectorAll('main label')).find(function (l) { return l.textContent.trim() === 'ימים סגורים (חג, חופשה)'; }); if (e) window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 160); })()`);
      await shot(hp.page, 'cal-15-close-holidays-phone.png', false);
      await hp.page.getByRole('button', { name: 'שמירת שעות' }).click();
      await hp.page.getByText('✓ נשמר').waitFor();
      assert.deepEqual(settingsOf(hp.fake).closed_dates, ['2026-10-02', '2027-04-22', '2027-04-28', '2027-06-11', '2027-10-02', '2027-10-03', '2027-10-11', '2027-10-16']);
      await hp.page.getByRole('button', { name: 'סגירה בחגים', exact: true }).click();
      await hp.page.getByText('כל ימי החג של השנה הקרובה כבר בימים הסגורים.').waitFor();
      // the calendar shows them closed: Pesach striped, its eve open
      await hp.page.getByRole('button', { name: 'יומן תורים', exact: true }).click();
      await hp.page.getByRole('tab', { name: 'חודש' }).click();
      await hp.page.getByText('אוקטובר 2026').waitFor();
      for (let i = 0; i < 6; i++) await hp.page.getByRole('button', { name: 'הבא' }).click();
      await hp.page.getByText('אפריל 2027').waitFor();
      // closed to customers only: on the calendar Pesach is open, in the holiday's colour; its eve as any Wednesday
      const pesach = await looks(hp.page.getByRole('button', { name: /^יום חמישי, 22 באפריל · פסח: אין תורים$/ }));
      assert.match(pesach, /\bcal-chag\b/);
      assert.doesNotMatch(pesach, /\bcal-closed\b/);
      assert.doesNotMatch(await looks(hp.page.getByRole('button', { name: /^יום רביעי, 21 באפריל · ערב פסח: אין תורים$/ })), /\bcal-(closed|chag)\b/);
      await hp.page.getByRole('tab', { name: 'יום' }).click();
    });
    await hp.ctx.close();

    // ---------------------------------------------------------------------------------- Gal: not the owner, sees everyone --
    const g = await open(PHONE, tables, gal);
    current = g.page;
    await step('Gal (not the owner) sees everyone, moves Karin\'s appointment — the history says Gal; "מטפלות" read only', async () => {
      await tick('13:05');
      await goto(g.page, '/appointments');
      await block(g.page, /^17:00–18:00 נגה ת\./).waitFor({ timeout: 120_000 });
      await expectHeads(g.page, ['שגית 5 תורים', 'קרין 4 תורים', 'גל 7 תורים']);
      await g.page.getByRole('button', { name: 'רק שלי', exact: true }).click();
      await expectHeads(g.page, ['גל 7 תורים'], 'her account is Gal');
      await g.page.getByRole('button', { name: 'הכול', exact: true }).click();
      await block(g.page, /^17:00–18:00 נגה ת\./).click();
      const d = dialog(g.page);
      await d.getByLabel('שעה').fill('18:30');
      await d.getByRole('button', { name: 'שמירת השינוי' }).click();
      await d.getByText('הוזז מ-17:00 ל-18:30').waitFor();
      const a = appt(g.fake, 'נגה ת.');
      assert.deepEqual(events(g.fake, a.id).map((e) => [e.kind, e.actor, e.actor_name]), [['created', OWNER, 'שגית פרץ'], ['moved', GAL_USER, 'גל שחר']]);
      const lines: string[] = await d.locator('li').allInnerTexts();
      assert.deepEqual(lines.map((x) => x.replace(/\s+/g, ' ').trim()), ['18.10, 13:05 גל שחר · הוזז מ-17:00 ל-18:30', '18.10, 12:50 שגית פרץ · נקבע התור אצל קרין בן ניזרי']);
      await d.getByRole('heading', { name: 'היסטוריה' }).scrollIntoViewIfNeeded();
      await shot(g.page, 'cal-8-gal-history-phone.png', false);
      await g.page.keyboard.press('Escape');
      await g.page.getByRole('button', { name: 'מטפלות', exact: true }).click();
      await g.page.getByText('רק בעלי העסק משנים את רשימת המטפלות.').waitFor();
      const marks = g.page.getByLabel('מטפל/ת ביומן');
      assert.equal(await marks.count(), 3);
      for (let i = 0; i < 3; i++) assert.equal(await marks.nth(i).isDisabled(), true);
      assert.equal(await g.page.getByRole('button', { name: 'הוספה ליומן' }).count(), 0);
      assert.equal(await g.page.getByText('050-1111111').count(), 0, 'no numbers for a member');
    });
    await g.ctx.close();

    // --------------------------------------------------- 2.109: Karin — "יומן ולידים": the calendar and the leads only --
    const k = await open(PHONE, tables, { userId: KARIN_USER, email: 'karin@clinic.test', owner: false, access: 'calendar' });
    current = k.page;
    await step('Karin ("יומן ולידים"): any other screen opens the calendar; two tabs; everyone\'s appointments; no settings', async () => {
      await tick('13:10');
      await goto(k.page, '/dashboard');
      await k.page.waitForURL(/\/appointments$/, { timeout: 120_000 });
      await block(k.page, /^18:30–19:30 נגה ת\./).waitFor({ timeout: 120_000 });
      await expectHeads(k.page, ['שגית 5 תורים', 'קרין 4 תורים', 'גל 7 תורים'], 'she sees everyone');
      const bar = k.page.getByRole('navigation', { name: 'ניווט' });
      assert.deepEqual((await bar.locator('a').allInnerTexts()).map((x: string) => x.trim()), ['לקוחות', 'תורים'], 'the phone\'s tabs: hers only');
      assert.equal(await k.page.getByRole('button', { name: 'עוד' }).count(), 0, 'no "עוד"');
      assert.equal(await k.page.getByRole('link', { name: 'יצירת תוכן חדש' }).count(), 0, 'no "יצירה"');
      for (const t of ['מטפלות', 'שעות פעילות', 'דף הזמנה']) assert.equal(await k.page.getByRole('button', { name: t, exact: true }).count(), 0, `no "${t}"`);
      assert.equal(await k.page.getByText(/AI פעיל|AI לא מוגדר/).count(), 0, 'no AI');
      await fits(k.page, 'her calendar');
      await shot(k.page, 'cal-9-calendar-member-phone.png', false);
      for (const to of ['/finance', '/register', '/settings', '/attendance', '/media']) {
        await goto(k.page, to);
        await k.page.waitForURL(/\/appointments$/, { timeout: 120_000 });
      }
    });

    await step('Karin books — a new customer only with a phone', async () => {
      await block(k.page, /^18:30–19:30 נגה ת\./).waitFor({ timeout: 120_000 });
      await k.page.getByRole('button', { name: '+ תור' }).click();
      const d = dialog(k.page);
      await d.getByRole('heading', { name: 'תור חדש' }).waitFor();
      await d.getByLabel('או שעה אחרת').fill('19:30');
      await d.locator('input[list="crm-names"]').fill('רוני ח.');
      const book = d.getByRole('button', { name: 'קביעת התור' });
      await d.getByText('טלפון (חובה ללקוח/ה חדש/ה)').waitFor();
      assert.equal(await book.isDisabled(), true, 'no phone — not opened');
      await d.getByLabel('טלפון').fill('052');
      assert.equal(await book.isDisabled(), true, 'a phone that is not whole');
      await d.getByLabel('טלפון').fill('052-7654321');
      assert.equal(await book.isDisabled(), false);
      await shot(k.page, 'cal-10-new-customer-phone.png', false);
      await book.click();
      await d.waitFor({ state: 'detached' });
      const lead = (k.fake.tables.leads as Row[]).find((l) => l.name === 'רוני ח.')!;
      assert.equal(lead.phone, '052-7654321', 'the customer has her phone');
      assert.equal(appt(k.fake, 'רוני ח.').lead_id, lead.id);
      assert.deepEqual(events(k.fake, appt(k.fake, 'רוני ח.').id).map((e) => [e.kind, e.actor]), [['created', KARIN_USER]], 'the history says Karin');
      // no charge, no deposit, no money in the appointment
      await block(k.page, /רוני ח\./).click();
      assert.equal(await dialog(k.page).getByText('💳 חיוב').count(), 0, 'no "חיוב"');
      await k.page.keyboard.press('Escape');
    });

    await step('2.110 — Karin\'s treatments: a new one ("לייזר — ידיים", 40 minutes), a name and a length changed; never a price', async () => {
      await k.page.getByRole('button', { name: 'שירותים', exact: true }).click();
      await k.page.getByText('המשך הוא ברירת המחדל של תור חדש').waitFor();
      assert.equal(await k.page.getByText(/₪/).count(), 0, 'no prices or deposits');
      assert.equal(await k.page.getByRole('button', { name: 'מחיקה' }).count(), 0, 'no deleting — hiding');
      assert.equal(await k.page.getByPlaceholder(/מחיר/).count(), 0, 'no price field');
      await k.page.getByLabel('שם הטיפול').fill('לייזר — ידיים');
      await k.page.getByLabel('משך (דקות)').fill('40');
      await k.page.getByRole('button', { name: 'הוספה', exact: true }).click();
      await k.page.getByText('לייזר — ידיים').waitFor();
      const hands = (k.fake.tables.booking_services as Row[]).find((x) => x.name === 'לייזר — ידיים')!;
      assert.deepEqual([hands.minutes, hands.price ?? null, hands.deposit ?? null], [40, null, null], 'her treatment: 40 minutes, no money');
      // "לייזר פנים" → "לייזר — פנים", 30 → 20 minutes; its price stays the owner's
      await k.page.locator('div', { has: k.page.getByText('לייזר פנים', { exact: true }) })
        .filter({ has: k.page.getByRole('button', { name: 'עריכה' }) }).last().getByRole('button', { name: 'עריכה' }).click();
      const form = k.page.locator('form').filter({ has: k.page.getByRole('button', { name: 'שמירה' }) }).first();
      await form.getByLabel('שם הטיפול').fill('לייזר — פנים');
      await form.getByLabel('משך (דקות)').fill('20');
      await form.getByRole('button', { name: 'שמירה' }).click();
      await k.page.getByText('לייזר — פנים').waitFor();
      const face = (k.fake.tables.booking_services as Row[]).find((x) => x.id === SVC.face.id)!;
      assert.deepEqual([face.name, face.minutes, face.price], ['לייזר — פנים', 20, 250], 'renamed, 20 minutes — the price as it was');
      await fits(k.page, 'her treatments');
      await shot(k.page, 'cal-12-treatments-phone.png', false);
      await k.page.getByRole('button', { name: 'יומן תורים', exact: true }).click();
    });

    await step('2.110 — "סיום": a new appointment ends by its treatment, or at an hour set by hand; the sheet changes the end', async () => {
      await block(k.page, /^18:30–19:30 נגה ת\./).waitFor({ timeout: 120_000 });
      await k.page.getByRole('button', { name: '+ תור' }).click();
      const d = dialog(k.page);
      await d.getByRole('heading', { name: 'תור חדש' }).waitFor();
      // 2.110.2: "+ שירות חדש" from the appointment itself — saved, chosen, no price
      await d.getByRole('button', { name: '+ שירות חדש' }).click();
      const ns = d.getByRole('group', { name: 'שירות חדש' });
      await ns.getByLabel('שם השירות').fill('לייזר — גב');
      await ns.getByLabel('משך (דקות)').fill('50');
      await ns.getByRole('button', { name: 'שמירת השירות' }).click();
      await ns.waitFor({ state: 'detached' });
      const back = (k.fake.tables.booking_services as Row[]).find((x) => x.name === 'לייזר — גב')!;
      assert.deepEqual([back.minutes, back.price ?? null], [50, null], 'a new service: 50 minutes, no price');
      assert.equal(await d.getByLabel('שירות').inputValue(), back.id, 'and chosen for this appointment');
      await shot(k.page, 'cal-14-quick-service-phone.png', false);
      await d.getByLabel('שירות').selectOption({ label: 'לייזר — ידיים · 40 דק׳' });
      await d.getByLabel('או שעה אחרת').fill('21:00');
      assert.equal(await d.getByLabel('סיום').inputValue(), '21:40', 'by the treatment: 40 minutes');
      // "שעה וחצי" — a tap, and the end follows: 21:00 → 22:30
      await d.getByRole('group', { name: 'משך התור' }).getByRole('button', { name: 'שעה וחצי', exact: true }).click();
      assert.equal(await d.getByLabel('סיום').inputValue(), '22:30', '21:00 and an hour and a half');
      await d.getByText('משך: שעה וחצי').waitFor();
      await d.getByLabel('סיום').fill('20:50');
      await d.getByText('שעת הסיום חייבת להיות אחרי שעת ההתחלה.').waitFor();
      assert.equal(await d.getByRole('button', { name: 'קביעת התור' }).isDisabled(), true);
      await d.getByLabel('סיום').fill('22:15');
      await d.locator('input[list="crm-names"]').fill('רוני ח.');
      await d.getByRole('button', { name: 'קביעת התור' }).click();
      await d.waitFor({ state: 'detached' });
      const a = (k.fake.tables.appointments as Row[]).find((x) => x.name === 'רוני ח.' && israelTime(x.start_at) === '21:00')!;
      assert.deepEqual([israelTime(a.start_at), israelTime(a.end_at)], ['21:00', '22:15'], 'from hour to hour, as set');
      // the sheet: the end alone
      await k.page.getByRole('button', { name: /21:00 · רוני ח\./ }).click();   // no practitioner: in the strip above the day
      const sh = dialog(k.page);
      assert.equal(await sh.getByLabel('סיום').inputValue(), '22:15');
      await sh.getByLabel('סיום').fill('22:30');
      await sh.getByRole('button', { name: 'שמירת השינוי' }).click();
      await sh.getByText('שעת הסיום שונתה מ-22:15 ל-22:30').waitFor();
      const b = (k.fake.tables.appointments as Row[]).find((x) => x.id === a.id)!;
      assert.equal(israelTime(b.end_at), '22:30');
      await sh.getByRole('group', { name: 'משך התור' }).getByRole('button', { name: 'שעתיים', exact: true }).click();
      assert.equal(await sh.getByLabel('סיום').inputValue(), '23:00', 'two hours from 21:00');
      await sh.getByRole('button', { name: 'שמירת השינוי' }).click();
      await sh.getByText('שעת הסיום שונתה מ-22:30 ל-23:00').waitFor();
      assert.equal(israelTime((k.fake.tables.appointments as Row[]).find((x) => x.id === a.id)!.end_at), '23:00');
      await shot(k.page, 'cal-13-end-time-phone.png', false);
      await k.page.keyboard.press('Escape');
    });

    await step('Karin\'s leads: the contacts, a new one only with a phone; the card without money, AI or deleting', async () => {
      await k.page.getByRole('navigation', { name: 'ניווט' }).getByRole('link', { name: 'לקוחות' }).click();
      await k.page.getByRole('heading', { name: 'לקוחות' }).waitFor({ timeout: 120_000 });
      assert.equal(await k.page.getByRole('button', { name: 'הגדרות לקוחות' }).count(), 0, 'no settings');
      assert.equal(await k.page.getByRole('link', { name: /מחלקות/ }).count(), 0, 'no departments');
      await k.page.getByRole('button', { name: '+ איש קשר' }).click();
      const d = dialog(k.page);
      await d.getByLabel('שם').fill('מאיה ש.');
      const add = d.getByRole('button', { name: 'הוספה' });
      assert.equal(await add.isDisabled(), true, 'no phone — not opened');
      await d.getByLabel('טלפון (חובה)').fill('0541239876');
      await add.click();
      const card = dialog(k.page);
      await card.getByText('מאיה ש.').first().waitFor();
      assert.ok((k.fake.tables.leads as Row[]).some((l) => l.name === 'מאיה ש.' && l.phone === '0541239876'));
      assert.equal(await card.getByRole('button', { name: /הצעת הודעת המשך/ }).count(), 0, 'no AI');
      assert.equal(await card.getByText('מחיקת איש הקשר').count(), 0, 'no deleting');
      assert.equal(await card.getByLabel('ערך לקוח ₪').count(), 0, 'no money');
      await shot(k.page, 'cal-11-calendar-member-lead-phone.png', false);
      await k.page.keyboard.press('Escape');
    });
    await k.ctx.close();
    await p.ctx.close();

    // ------------------------------------------------------------------------- no practitioners / before the migration --
    const plain = (calendar: boolean) => seed(calendar ? [] : [{ id: SAGIT, business_id: BIZ, name: 'שגית פרץ', phone: '972501111111', active: true, member_user_id: OWNER,
      created_at: '2026-10-12T08:00:00Z' }], [[0, null, '10:00', 'firm', 'גלית ד.'], [0, null, '11:00', 'micro', 'שירה מ.'], [0, null, '15:00', 'face', 'עדי ק.']], calendar);
    const n = await open(PHONE, plain(true), owner);
    current = n.page;
    await step('after the migration, a business with no practitioners: one column, as before — and the history', async () => {
      await goto(n.page, '/appointments');
      await block(n.page, /^11:00–12:00 שירה מ\./).waitFor({ timeout: 120_000 });
      await expectHeads(n.page, []);
      assert.equal(await n.page.getByRole('button', { name: 'הכול', exact: true }).count(), 0);
      assert.equal(await n.page.getByText(/בלי מטפל\/ת:/).count(), 0);
      const look = String(await block(n.page, /^11:00–12:00 שירה מ\./).getAttribute('class'));
      assert.ok(/\bcal-plain\b/.test(look) && !/\bcal-none\b/.test(look), `the app's own colour — not "waiting for a practitioner": ${look}`);
      await block(n.page, /^15:00–15:30 עדי ק\./).click();
      const d = dialog(n.page);
      assert.equal(await d.getByLabel('מטפל/ת').count(), 0, 'no practitioner to choose');
      await d.getByLabel('שעה').fill('10:15');                  // the same location, no practitioners: one at a time
      await d.getByRole('button', { name: 'שמירת השינוי' }).click();
      await d.getByText('כבר יש תור בשעה הזו. בחרו שעה אחרת.').waitFor();
      await d.getByLabel('שעה').fill('16:00');
      await d.getByRole('button', { name: 'שמירת השינוי' }).click();
      await d.getByText('הוזז מ-15:00 ל-16:00').waitFor();
      await n.page.keyboard.press('Escape');
      await n.page.getByRole('tab', { name: 'רשימה' }).click();
      await n.page.getByRole('button', { name: 'הזזה והיסטוריה ›' }).first().waitFor();
      await n.page.getByRole('button', { name: '+ תור' }).click();
      assert.equal(await dialog(n.page).getByLabel('מטפל/ת').count(), 0);
      await n.page.keyboard.press('Escape');
    });
    await n.ctx.close();

    const b = await open(PHONE, plain(false), owner, false);
    current = b.page;
    await step('before the migration: the same views, no practitioner, no history; "מטפלות" says what is missing', async () => {
      await goto(b.page, '/appointments');
      await block(b.page, /^15:00–15:30 עדי ק\./).waitFor({ timeout: 120_000 });
      await block(b.page, /^15:00–15:30 עדי ק\./).click();
      const d = dialog(b.page);
      await d.getByLabel('שעה').waitFor();
      assert.equal(await d.getByLabel('מטפל/ת').count(), 0);
      assert.equal(await d.getByRole('heading', { name: 'היסטוריה' }).count(), 0, 'no history before the migration');
      await d.getByLabel('שעה').fill('17:00');
      await d.getByRole('button', { name: 'שמירת השינוי' }).click();
      await b.page.getByText('✓ נשמר').waitFor();
      assert.equal(israelTime(appt(b.fake, 'עדי ק.').start_at), '17:00');
      const sent = b.fake.calls.filter((c) => c.method === 'PATCH' && c.path.startsWith('/rest/v1/appointments'));
      assert.deepEqual(Object.keys(sent.at(-1)!.body).sort(), ['end_at', 'start_at'], 'no staff_id before the migration');
      await b.page.keyboard.press('Escape');
      await b.page.getByRole('tab', { name: 'רשימה' }).click();
      await b.page.getByRole('button', { name: 'הזזה ›' }).first().waitFor();
      await b.page.getByRole('button', { name: 'מטפלות', exact: true }).click();
      await b.page.getByText(/כדי לשבץ מטפלות ביומן צריך קודם להריץ את מיגרציה 20261018005700/).waitFor();
      assert.equal(await b.page.getByLabel('מטפל/ת ביומן').first().isDisabled(), true);
      assert.equal(await b.page.getByRole('button', { name: 'הוספה ליומן' }).count(), 0);
    });
    await b.ctx.close();

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
