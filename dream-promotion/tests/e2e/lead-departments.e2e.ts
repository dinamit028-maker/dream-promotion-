/**
 * Lead departments and WhatsApp to the team (2.99) in a real browser (Chromium via Playwright), on a computer and a phone (390×844),
 * against the in-memory Supabase of fake-supabase.ts. The server's routes are faked here (/api/leads/departments,
 * /api/leads/assignment) with the answers the real ones give — the routes themselves, the routing, the queue, the retry and Meta's
 * errors are tested in tests/lead-routing.test.ts, the database's rules on Postgres (tests/sql/lead-routing.check.sql).
 * Clicked through:
 *   the contacts: "🏷️ מחלקות", "הלידים שלי" (the person on the team who is me) and "ללא מחלקה" filter the list; a row says who
 *   is responsible; a push's link (/leads?lead=…) opens the card;
 *   the card: the department, the person, why, when the message went out — or Meta's code and what it means; "לשלוח שוב";
 *   the owner moves the lead to another person and sends it to them on WhatsApp;
 *   the departments screen: "וואטסאפ לא מחובר" (no test possible), a person added (a wrong number refused), a department with a
 *   form and a question + answer, the default recipient; connected: the number and the template's state, "שליחת הודעת בדיקה" shows
 *   Meta's answer — and its error code; a member (not the owner) sees, never changes; before the migration: one clear line;
 *   a phone: the screen and the card fit.
 *
 * Run: npx -y tsx tests/e2e/lead-departments.e2e.ts   (starts `next dev` on port 3236; needs the preinstalled Chromium)
 * Screenshots: tests/e2e/shots (ld* — not committed).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FakeSupabase, session, type Tables } from './fake-supabase';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_LEADS_PORT ?? 3236);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BIZ = 'b0000000-0000-4000-8000-0000000000f1';
const OWNER = 'a0000000-0000-4000-8000-0000000000f1';
const EDITOR = 'a0000000-0000-4000-8000-0000000000f2';
const NOA = 'e0000000-0000-4000-8000-0000000000f1';   // לייזר → דנה, the message went out
const ROTEM = 'e0000000-0000-4000-8000-0000000000f2'; // מיקרובליידינג → מיכל, failed (131030)
const SHIRA = 'e0000000-0000-4000-8000-0000000000f3'; // no department
const MANUAL = 'e0000000-0000-4000-8000-0000000000f4'; // a contact typed by hand: never routed
const DESK = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const NOW = new Date().toISOString();

function seed(): Tables {
  const base = { user_id: OWNER, business_id: BIZ, created_at: '2026-10-12T08:00:00Z' };
  const lead = (id: string, name: string, phone: string, source: string, extra: Record<string, unknown> = {}) =>
    ({ ...base, id, name, phone, email: '', source, status: 'חדש', date: '2026-10-12', tags: ['ליד ממומן'], value: 0, notes: '', ...extra });
  return {
    brands: [{ ...base, name: 'סטודיו לייט', onboarded: true, industry: 'יופי', colors: ['#6B3BF5', '#FF7FA8'], goals: [] }],
    business_members: [{ business_id: BIZ, user_id: OWNER, role: 'owner', access: 'full' }, { business_id: BIZ, user_id: EDITOR, role: 'editor', access: 'full' }],
    leads: [
      lead(NOA, 'נועה לוי', '052-1234567', 'Meta · טופס לייזר', { department_id: 'laser', assigned_staff_id: 'dana', routed_at: NOW, routed_by: 'טופס: טופס לייזר' }),
      lead(ROTEM, 'רותם כהן', '053-2222222', 'Meta · טופס כללי', { department_id: 'micro', assigned_staff_id: 'michal', routed_at: NOW, routed_by: 'שאלה בטופס: איזה טיפול? — מיקרובליידינג' }),
      lead(SHIRA, 'שירה אברהם', '054-3333333', 'Meta · טופס כללי', { department_id: null, assigned_staff_id: null, routed_at: NOW, routed_by: '' }),
      lead(MANUAL, 'אורי ידני', '050-7777777', 'ידני', { tags: [] }),
    ],
    lead_activities: [], content: [], media: [], ad_drafts: [], pronunciations: [], push_subscriptions: [], social_messages: [],
    register_settings: [], employees: [], catalog_items: [], sales: [], documents: [], payments: [], quotes: [], document_drafts: [],
    client_packages: [], client_package_uses: [], client_sessions: [], client_treatments: [], treatment_types: [], recurring_plans: [], recurring_charges: [],
    payment_plans: [], payment_plan_items: [], payment_requests: [], expenses: [], appointments: [], booking_services: [],
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

// ---------------------------------------------------------------------- what the real routes would keep and answer --
type Staff = { id: string; name: string; phone: string; active: boolean; memberUserId: string | null };
type Rule = { kind: 'form' | 'campaign' | 'answer'; formId: string; formName: string; campaign: string; question: string; answer: string };
type Dept = { id: string; name: string; staffId: string; position: number; active: boolean; rules: Rule[] };
const rule = (r: Partial<Rule> & Pick<Rule, 'kind'>): Rule => ({ formId: '', formName: '', campaign: '', question: '', answer: '', ...r });
const shown = (d: string) => (d.startsWith('972') ? `0${d.slice(3, 5)}-${d.slice(5)}` : `+${d}`);

class Server {
  staff: Staff[] = [
    { id: 'dana', name: 'דנה', phone: '972501111111', active: true, memberUserId: OWNER },
    { id: 'michal', name: 'מיכל', phone: '15550100123', active: true, memberUserId: EDITOR },
  ];
  depts: Dept[] = [
    { id: 'laser', name: 'לייזר', staffId: 'dana', position: 0, active: true, rules: [rule({ kind: 'form', formId: '111', formName: 'טופס לייזר' })] },
    { id: 'micro', name: 'מיקרובליידינג', staffId: 'michal', position: 1, active: true, rules: [rule({ kind: 'answer', question: 'איזה טיפול?', answer: 'מיקרובליידינג' })] },
  ];
  defaultStaffId: string | null = null;
  connected = false;
  ready = true;
  posts: any[] = [];
  notes: Record<string, any[]> = {
    [NOA]: [{ id: 'n1', leadId: NOA, staffId: 'dana', staffName: 'דנה', kind: 'lead', status: 'sent', reason: '', attempts: 1, errorCode: '', error: null,
      sentAt: '2026-10-12T11:32:00Z', claimedAt: null, createdAt: '2026-10-12T11:31:00Z', hint: '' }],
    [ROTEM]: [{ id: 'n2', leadId: ROTEM, staffId: 'michal', staffName: 'מיכל', kind: 'lead', status: 'failed', reason: '', attempts: 2, errorCode: '131030',
      error: { message: '(#131030) Recipient phone number not in allowed list', details: 'Recipient phone number not in allowed list', fbtrace: 'AbC1', type: 'OAuthException' },
      sentAt: null, claimedAt: null, createdAt: '2026-10-12T11:40:00Z', hint: 'מספר הבדיקה של Meta שולח רק למספרים שברשימה המאושרת שלו (עד 5). מוסיפים את המספר ב-Meta: WhatsApp ← API Setup ← "To".' }],
  };
  view(owner: boolean, userId: string) {
    if (!this.ready) return { ready: false, connected: this.connected, owner, code: 'not_ready', message: 'מחלקות הלידים עוד לא זמינות: חסר עדכון במסד הנתונים (מיגרציה 20261012005300).' };
    return {
      ready: true, connected: this.connected, owner, me: this.staff.filter((s) => s.active && s.memberUserId === userId).map((s) => s.id),
      staff: this.staff.map((s) => ({ id: s.id, name: s.name, active: s.active, memberUserId: s.memberUserId, ...(owner ? { phone: s.phone, phoneShown: shown(s.phone) } : {}) })),
      departments: this.depts.map((d) => ({ id: d.id, name: d.name, staffId: d.staffId, position: d.position, active: d.active, ...(owner ? { rules: d.rules } : {}) })),
      defaultStaffId: this.defaultStaffId,
    };
  }
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
  for (const p of ['/leads', '/leads/departments']) {
    for (let i = 0; i < 3; i++) { const ok = await fetch(`${BASE}${p}`).then((r) => r.ok, () => false); if (ok) break; }
  }
  const server = new Server();
  const errors: string[] = [];
  const calls: string[] = [];

  async function context(viewport: { width: number; height: number }, who: 'owner' | 'editor' = 'owner') {
    const userId = who === 'owner' ? OWNER : EDITOR;
    const fake = new FakeSupabase(seed(), { businessId: BIZ, userId, email: `${who}@studio.test` });
    const phone = viewport.width < 600;
    const ctx = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(([k, v]: string[]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['sb-sb-auth-token', JSON.stringify(session(userId, `${who}@studio.test`))]);
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
    await ctx.route(`${BASE}/api/business/me`, (r: any) => r.fulfill({ json: { business: { id: BIZ, name: 'סטודיו לייט', state: 'active' },
      businesses: [{ id: BIZ, name: 'סטודיו לייט', state: 'active' }], superAdmin: false, access: 'full' } }));
    await ctx.route(`${BASE}/api/admin/me`, (r: any) => r.fulfill({ json: { admin: false } }));
    await ctx.route(`${BASE}/api/meta/**`, (r: any) => r.fulfill({ json: { pages: [], connected: false } }));
    await ctx.route(`${BASE}/api/client-file/**`, (r: any) => r.fulfill({ status: 403, json: { code: 'no_access', message: 'אין גישה' } }));
    await ctx.route(`${BASE}/api/finance/**`, (r: any) => r.fulfill({ status: 403, json: { code: 'no_access', message: 'אין גישה' } }));
    const owner = who === 'owner';
    await ctx.route(`${BASE}/api/leads/departments**`, async (r: any) => {
      const req = r.request();
      const auth = req.headers().authorization ?? '';
      if (!auth.startsWith('Bearer ')) return r.fulfill({ status: 401, json: { code: 'no_session' } });
      const url = new URL(req.url());
      if (req.method() === 'GET') {
        const view = url.searchParams.get('view');
        if (view === 'forms') {
          return r.fulfill({ json: { pages: 1, errors: [], forms: [
            { id: '111', name: 'טופס לייזר', status: 'ACTIVE', page: 'סטודיו לייט', questions: [] },
            { id: '333', name: 'טופס פנים', status: 'ACTIVE', page: 'סטודיו לייט', questions: [{ key: 'which', label: 'איזה טיפול?', options: ['טיפול פנים', 'מיקרובליידינג'] }] },
          ] } });
        }
        const base = server.view(owner, owner ? OWNER : EDITOR);
        if (view === 'setup' && owner && base.ready) {
          return r.fulfill({ json: { ...base, members: [{ userId: OWNER, name: 'בעלת הסטודיו', role: 'owner' }, { userId: EDITOR, name: 'מיכל (חשבון)', role: 'editor' }],
            health: server.connected ? { connected: true, number: { display: '+1 555-010-0123', name: 'Test Number', quality: 'GREEN' }, template: { status: 'PENDING', language: 'he', category: 'UTILITY' } } : { connected: false },
            recent: [{ ...server.notes[ROTEM][0], leadName: 'רותם כהן' }, { ...server.notes[NOA][0], leadName: 'נועה לוי' }] } });
        }
        return r.fulfill({ json: base });
      }
      if (!owner) return r.fulfill({ status: 403, json: { code: 'owner_only', message: 'רק בעלי העסק יכולים לשנות את זה.' } });
      const b = JSON.parse(req.postData() ?? '{}');
      server.posts.push(b);
      if (b.action === 'staff.save') {
        const digits = String(b.phone).replace(/\D/g, '').replace(/^0/, '972');
        if (digits.length < 10) return r.fulfill({ status: 400, json: { code: 'invalid', message: 'מספר וואטסאפ לא תקין. למשל 050-1234567, או מספר בחו״ל עם קידומת: ‎+1 555 010 0123' } });
        server.staff.push({ id: `s${server.staff.length + 1}`, name: b.name.trim(), phone: digits, active: true, memberUserId: b.memberUserId ?? null });
      } else if (b.action === 'department.save') {
        server.depts.push({ id: `d${server.depts.length + 1}`, name: b.name, staffId: b.staffId, position: server.depts.length, active: true, rules: b.rules });
      } else if (b.action === 'default.set') {
        server.defaultStaffId = b.staffId;
      } else if (b.action === 'test') {
        if (!server.connected) return r.fulfill({ status: 409, json: { code: 'not_connected', message: 'וואטסאפ לא מחובר' } });
        if (b.staffId === 'dana') {
          return r.fulfill({ json: { ok: false, http: 400, code: '131030', hint: 'מספר הבדיקה של Meta שולח רק למספרים שברשימה המאושרת שלו (עד 5). מוסיפים את המספר ב-Meta: WhatsApp ← API Setup ← "To".',
            error: { code: '131030', subcode: '', message: '(#131030) Recipient phone number not in allowed list', type: 'OAuthException', details: 'Recipient phone number not in allowed list', fbtrace: 'Zx9', http: 400 },
            response: { error: { message: '(#131030) Recipient phone number not in allowed list', type: 'OAuthException', code: 131030, fbtrace_id: 'Zx9' } } } });
        }
        return r.fulfill({ json: { ok: true, http: 200, messageId: 'wamid.HBgLMTU1NTAxMDAxMjM', waId: '15550100123', status: 'accepted',
          response: { messaging_product: 'whatsapp', contacts: [{ input: '15550100123', wa_id: '15550100123' }], messages: [{ id: 'wamid.HBgLMTU1NTAxMDAxMjM', message_status: 'accepted' }] } } });
      }
      return r.fulfill({ json: server.view(true, OWNER) });
    });
    await ctx.route(`${BASE}/api/leads/assignment**`, async (r: any) => {
      const req = r.request();
      const card = (leadId: string) => {
        const l = fake.tables.leads.find((x) => x.id === leadId)!;
        return { ready: true, lead: { id: l.id, departmentId: l.department_id ?? null, assignedStaffId: l.assigned_staff_id ?? null, routedAt: l.routed_at ?? null, routedBy: l.routed_by ?? '' },
          notifications: server.notes[leadId] ?? [], connected: server.connected, owner };
      };
      if (req.method() === 'GET') return r.fulfill({ json: card(new URL(req.url()).searchParams.get('lead') ?? '') });
      if (!owner) return r.fulfill({ status: 403, json: { code: 'owner_only', message: 'רק בעלי העסק יכולים לשנות את זה.' } });
      const b = JSON.parse(req.postData() ?? '{}');
      server.posts.push(b);
      if (b.action === 'resend') {
        const n = Object.values(server.notes).flat().find((x) => x.id === b.id);
        Object.assign(n, { status: 'sent', attempts: 3, errorCode: '', error: null, hint: '', sentAt: '2026-10-12T12:05:00Z' });
        return r.fulfill({ json: { ok: true, sent: { status: 'sent', messageId: 'wamid.X', attempts: 3 }, ...card(n.leadId) } });
      }
      if (b.action === 'assign') {
        const l = fake.tables.leads.find((x) => x.id === b.leadId)!;
        l.assigned_staff_id = b.staffId;
        const to = server.staff.find((s) => s.id === b.staffId)!;
        if (b.send) (server.notes[b.leadId] ||= []).push({ id: `m-${b.leadId}`, leadId: b.leadId, staffId: to.id, staffName: to.name, kind: 'move', status: 'sent', reason: '', attempts: 1,
          errorCode: '', error: null, sentAt: '2026-10-12T12:10:00Z', claimedAt: null, createdAt: '2026-10-12T12:10:00Z', hint: '' });
        return r.fulfill({ json: { ok: true, sent: b.send ? { status: 'sent', attempts: 1 } : null, ...card(b.leadId) } });
      }
      return r.fulfill({ status: 400, json: { message: 'פעולה לא מוכרת.' } });
    });
    ctx.setDefaultTimeout(30_000); ctx.setDefaultNavigationTimeout(180_000);
    const page = await ctx.newPage();
    page.on('pageerror', (e: Error) => errors.push(e.message));
    page.on('dialog', (d: any) => d.accept());
    return { ctx, page, fake };
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
      await page.screenshot({ path: path.join(SHOTS, `ld-fail-${results.length}.png`), timeout: 10_000 }).catch(() => null); }
    finally { clearTimeout(timer); }
  };
  const shot = async (name: string, p: any = page) => { await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, name), fullPage: true }); };
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
  const row = (name: string, p: any = page) => p.locator('div.rounded-2xl').filter({ has: p.getByRole('button', { name: new RegExp(name) }) }).first();
  const card = async (name: string, p: any = page) => {
    await p.getByRole('button', { name: new RegExp(name) }).first().click();
    const d = p.getByRole('dialog').last();
    await d.getByRole('heading', { name }).waitFor();
    return d;
  };
  const panel = (d: any) => d.getByRole('region', { name: 'מחלקה ואחראי', exact: true });

  try {
    await step('the contacts: "מחלקות", "הלידים שלי" and "ללא מחלקה"; a row says who is responsible', async () => {
      await goto('/leads');
      await page.getByRole('link', { name: '🏷️ מחלקות' }).waitFor({ timeout: 120_000 });
      await row('נועה לוי').getByText(/אחראי: דנה/).waitFor();
      await row('רותם כהן').getByText(/אחראי: מיכל/).waitFor();
      await row('שירה אברהם').getByText('ללא מחלקה', { exact: true }).waitFor();
      assert.equal(await row('אורי ידני').getByText('ללא מחלקה', { exact: true }).count(), 0, 'a contact typed by hand was never routed');
      const filters = page.getByRole('group', { name: 'סינון לפי אחראי' });
      await filters.getByRole('button', { name: 'הלידים שלי 1' }).click();
      await page.getByRole('button', { name: /נועה לוי/ }).waitFor();
      for (const other of ['רותם כהן', 'שירה אברהם', 'אורי ידני']) assert.equal(await page.getByRole('button', { name: new RegExp(other) }).count(), 0, `${other}: not mine`);
      await shot('ld-1-mine.png');
      await filters.getByRole('button', { name: 'ללא מחלקה 1' }).click();
      await page.getByRole('button', { name: /שירה אברהם/ }).waitFor();
      assert.equal(await page.getByRole('button', { name: /נועה לוי/ }).count(), 0);
      await filters.getByRole('button', { name: 'כל הלידים' }).click();
      await page.getByRole('button', { name: /אורי ידני/ }).waitFor();
    });

    await step('the card: the department, the person, why, and when the message went out', async () => {
      const d = await card('נועה לוי');
      const p = panel(d);
      await p.getByText('🏷️ מחלקה: לייזר').waitFor();
      await p.getByText('👤 אחראי: דנה').waitFor();
      await p.getByText('לפי טופס: טופס לייזר').waitFor();
      await p.getByText(/^💬 נשלח בוואטסאפ לדנה · 12\.10\.2026, 14:32$/).waitFor();
      await shot('ld-2-card.png');
      await page.keyboard.press('Escape');
    });

    await step('a message that failed: Meta\'s code and what it means; "לשלוח שוב" once WhatsApp is connected', async () => {
      const d = await card('רותם כהן');
      const p = panel(d);
      await p.getByText('❌ לא נשלח למיכל · קוד 131030').waitFor();
      await p.getByText(/רשימה המאושרת שלו \(עד 5\)/).waitFor();
      await p.getByText('(#131030) Recipient phone number not in allowed list · fbtrace AbC1').waitFor();
      assert.equal(await p.getByRole('button', { name: 'לשלוח שוב' }).isDisabled(), true, 'not connected: nothing can be sent');
      await page.keyboard.press('Escape');
      server.connected = true;
      await goto('/leads');
      const d2 = await card('רותם כהן');
      await panel(d2).getByRole('button', { name: 'לשלוח שוב' }).click();
      await panel(d2).getByText(/^💬 נשלח בוואטסאפ למיכל · /).waitFor();
      await panel(d2).getByText('נשלח בוואטסאפ ✓').waitFor();
      assert.deepEqual(server.posts.at(-1), { action: 'resend', id: 'n2' });
      await page.keyboard.press('Escape');
    });

    await step('the owner moves a lead to another person and sends it to them on WhatsApp', async () => {
      const d = await card('שירה אברהם');
      const p = panel(d);
      await p.getByText('🏷️ ללא מחלקה', { exact: true }).waitFor();
      await p.getByLabel('העברה לאחראי אחר').selectOption({ label: 'דנה' });
      assert.equal(await p.getByLabel('לשלוח את הליד בוואטסאפ').isChecked(), true);
      await p.getByRole('button', { name: 'העברה' }).click();
      await p.getByText('👤 אחראי: דנה').waitFor();
      await p.getByText(/^💬 נשלח בוואטסאפ לדנה \(העברה\) · /).waitFor();
      assert.deepEqual(server.posts.at(-1), { action: 'assign', leadId: SHIRA, staffId: 'dana', send: true });
      await page.keyboard.press('Escape');
      await row('שירה אברהם').getByText(/אחראי: דנה/).waitFor();
      await page.getByRole('group', { name: 'סינון לפי אחראי' }).getByRole('button', { name: 'הלידים שלי 2' }).waitFor();
    });

    await step('a push\'s link opens the card', async () => {
      await goto(`/leads?lead=${ROTEM}`);
      await page.getByRole('dialog').last().getByRole('heading', { name: 'רותם כהן' }).waitFor({ timeout: 60_000 });
      await page.keyboard.press('Escape');
    });

    await step('the departments screen, WhatsApp not connected: no test; a person added (a wrong number refused)', async () => {
      server.connected = false;
      await goto('/leads');
      await page.getByRole('link', { name: '🏷️ מחלקות' }).click();
      await page.waitForURL((u: URL) => u.pathname === '/leads/departments');
      await page.getByText('⏸️ וואטסאפ לא מחובר').waitFor({ timeout: 60_000 });
      const team = page.getByRole('region', { name: 'הצוות שמקבל לידים' });
      await team.getByText('+15550100123').waitFor();
      assert.equal(await team.getByRole('button', { name: 'שליחת הודעת בדיקה' }).first().isDisabled(), true);
      await team.getByRole('button', { name: '+ אדם לצוות' }).click();
      await team.getByLabel('שם', { exact: true }).fill('נוי');
      await team.getByLabel('מספר וואטסאפ').fill('12');
      await team.getByLabel(/החשבון ב-Dream/).selectOption({ label: 'בעלת הסטודיו' });
      await team.getByRole('button', { name: 'שמירה' }).click();
      await page.getByText(/מספר וואטסאפ לא תקין/).waitFor();
      await team.getByLabel('מספר וואטסאפ').fill('052-999-8888');
      await team.getByRole('button', { name: 'שמירה' }).click();
      await team.getByText('052-9998888').waitFor();
      assert.deepEqual(server.posts.at(-1), { action: 'staff.save', name: 'נוי', phone: '052-999-8888', memberUserId: OWNER });
      await shot('ld-3-team.png');
    });

    await step('a department: a form of the Page and a question with its answer; the default recipient', async () => {
      const depts = page.getByRole('region', { name: 'מחלקות', exact: true });
      await depts.getByText('אחראי: דנה').first().waitFor();
      await depts.getByText('טופס: טופס לייזר').waitFor();
      await depts.getByText('שאלה: איזה טיפול? ← מיקרובליידינג').waitFor();
      await depts.getByRole('button', { name: '+ מחלקה' }).click();
      await depts.getByLabel('שם המחלקה').fill('פנים');
      await depts.getByLabel('אחראי על המחלקה').selectOption({ label: 'נוי' });
      await depts.getByLabel('הטופס').selectOption({ label: 'טופס פנים — סטודיו לייט' });
      await depts.getByRole('button', { name: '+ כלל זיהוי' }).click();
      await depts.getByLabel('כלל 2').selectOption({ label: 'שאלה ותשובה בטופס' });
      await depts.getByLabel('השאלה בטופס').fill('איזה טיפול?');
      await depts.getByLabel('התשובה').fill('טיפול פנים');
      await shot('ld-4-dept-editor.png');
      await depts.getByRole('button', { name: 'שמירה' }).click();
      await depts.getByText('טופס: טופס פנים').waitFor();
      await depts.getByText('שאלה: איזה טיפול? ← טיפול פנים').waitFor();
      const saved = server.posts.at(-1);
      assert.deepEqual([saved.action, saved.name, saved.staffId], ['department.save', 'פנים', 's3']);
      assert.deepEqual(saved.rules, [rule({ kind: 'form', formId: '333', formName: 'טופס פנים' }), rule({ kind: 'answer', question: 'איזה טיפול?', answer: 'טיפול פנים' })]);
      const none = page.getByRole('region', { name: 'ליד בלי מחלקה' });
      await none.getByLabel('מי מקבל ליד בלי מחלקה').selectOption({ label: 'דנה' });
      await page.getByText('נשמר ✓').waitFor();
      assert.deepEqual(server.posts.at(-1), { action: 'default.set', staffId: 'dana' });
      await page.getByRole('region', { name: 'הצוות שמקבל לידים' }).getByText('ברירת מחדל').waitFor();
    });

    await step('connected: the number and the template\'s state; the test shows Meta\'s answer, or its error code', async () => {
      server.connected = true;
      await goto('/leads/departments');
      await page.getByText('💬 וואטסאפ מחובר').waitFor({ timeout: 60_000 });
      await page.getByText('שולח מ: +1 555-010-0123 · Test Number').waitFor();
      await page.getByText('התבנית new_lead (עברית): ממתינה לאישור של Meta — עד שהיא מאושרת, השליחה נכשלת (קוד 132001).').waitFor();
      const team = page.getByRole('region', { name: 'הצוות שמקבל לידים' });
      const michal = team.getByRole('listitem').filter({ hasText: 'מיכל' });
      await michal.getByRole('button', { name: 'שליחת הודעת בדיקה' }).click();
      await michal.getByText('✓ Meta קיבלה את ההודעה (HTTP 200)').waitFor();
      await michal.getByText('message id: wamid.HBgLMTU1NTAxMDAxMjM · status: accepted · wa_id: 15550100123').waitFor();
      const dana = team.getByRole('listitem').filter({ hasText: 'דנה' });
      await dana.getByRole('button', { name: 'שליחת הודעת בדיקה' }).click();
      await dana.getByText('✗ Meta החזירה שגיאה · קוד 131030 · HTTP 400').waitFor();
      await dana.getByText(/רשימה המאושרת שלו/).waitFor();
      await dana.getByText('fbtrace_id: Zx9').waitFor();
      await dana.getByText('התשובה המלאה של Meta').click();
      await dana.getByText(/"code": 131030/).waitFor();
      assert.deepEqual(server.posts.filter((x) => x.action === 'test').map((x) => x.staffId), ['michal', 'dana']);
      const recent = page.getByRole('region', { name: 'הודעות אחרונות' });
      await recent.getByText(/רותם כהן/).waitFor();
      await shot('ld-5-connected.png');
    });

    await step('a member (not the owner): sees the departments and the person, never changes them', async () => {
      const { page: ed, ctx } = await context(DESK, 'editor');
      await goto('/leads/departments', ed);
      await ed.getByText('רק בעלי העסק משנים את ההגדרות כאן.').waitFor({ timeout: 60_000 });
      await ed.getByRole('region', { name: 'מחלקות', exact: true }).getByText('לייזר', { exact: true }).waitFor();
      for (const b of ['+ אדם לצוות', '+ מחלקה', 'עריכה', 'הסרה', 'שליחת הודעת בדיקה']) assert.equal(await ed.getByRole('button', { name: b }).count(), 0, `${b}: owner only`);
      assert.equal(await ed.getByText('+15550100123').count(), 0, 'no numbers for a member');
      await goto('/leads', ed);
      await ed.getByRole('group', { name: 'סינון לפי אחראי' }).getByRole('button', { name: 'הלידים שלי 1' }).click(); // מיכל is this member
      await ed.getByRole('button', { name: /רותם כהן/ }).waitFor();
      const d = await card('רותם כהן', ed);
      await panel(d).getByText('👤 אחראי: מיכל').waitFor();
      assert.equal(await panel(d).getByLabel('העברה לאחראי אחר').count(), 0, 'only the owner moves a lead');
      await ctx.close();
    });

    await step('before the migration: one clear line, and the contacts as before', async () => {
      server.ready = false;
      const { page: p, ctx } = await context(DESK);
      await goto('/leads/departments', p);
      await p.getByText('מחלקות הלידים עוד לא זמינות: חסר עדכון במסד הנתונים (מיגרציה 20261012005300).').waitFor({ timeout: 60_000 });
      await goto('/leads', p);
      await p.getByRole('button', { name: /נועה לוי/ }).waitFor();
      assert.equal(await p.getByRole('link', { name: '🏷️ מחלקות' }).count(), 0);
      assert.equal(await p.getByRole('group', { name: 'סינון לפי אחראי' }).count(), 0);
      await ctx.close();
      server.ready = true;
    });

    await step('a phone: the departments screen, a department\'s editor and the card fit', async () => {
      const { page: phone, ctx } = await context(PHONE);
      await goto('/leads/departments', phone);
      await phone.getByText('💬 וואטסאפ מחובר').waitFor({ timeout: 60_000 });
      await fits(phone, 'the departments screen');
      const depts = phone.getByRole('region', { name: 'מחלקות', exact: true });
      await depts.getByRole('button', { name: '+ מחלקה' }).click();
      await depts.getByLabel('הטופס').waitFor();
      await fits(phone, 'a department\'s editor');
      await shot('ld-6-phone-editor.png', phone);
      await goto('/leads', phone);
      const d = await card('רותם כהן', phone);
      await panel(d).getByText('👤 אחראי: מיכל').waitFor();
      await fits(phone, 'the card');
      await shot('ld-7-phone-card.png', phone);
      await ctx.close();
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
