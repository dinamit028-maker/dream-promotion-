import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { open } from '@/lib/server/secrets';
import { leadFormsDetailed } from '@/lib/server/meta';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { sendNewLead, whatsappConfigured, whatsappHealth } from '@/lib/server/whatsapp';
import { NOTICE_COLUMNS, NOT_READY, leadsCaller, memberChoices, noticeView, routingView, type LeadsCaller } from '@/lib/server/lead-departments';
import { NO_STAFF_PHONE, WA_NOT_CONNECTED, oneLine, staffPhone, testTemplateParams, waErrorCode, waErrorHint, type RuleKind } from '@/features/crm/lead-routing';
import { isCalendarColor } from '@/features/booking/calendar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Lead departments (2.99): the team, the departments and how a lead is recognised, the default recipient, and the test message.
 *  GET                → the view (any member, not a cashier: names; the owner: numbers and rules too)
 *  GET ?view=setup    → + the members (who is this person in Dream), WhatsApp's state (the number, the template), the last messages
 *  GET ?view=forms    → the lead forms of the business's Facebook Pages, with their questions and choices
 *  POST { action }    → the owner only: staff.save / staff.remove / department.save / department.remove / default.set / site.set / test
 *                       / staff.calendar (2.105: a practitioner of the calendar and her colour — migration 20261018005700)
 * The test sends the team's template with test values to that person only and answers with Meta's own answer, or its error in full.
 */
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const bad = (message: string, code = 'invalid', status = 400) => json({ code, message }, status);

export async function GET(req: Request) {
  const c = await leadsCaller(req, false);
  if ('res' in c) return c.res;
  const view = await routingView(c);
  if (!view) return json({ ready: false, connected: whatsappConfigured(), owner: c.owner, ...NOT_READY });
  const which = new URL(req.url).searchParams.get('view');
  if (which === 'setup' && c.owner) {
    const [members, health, recent] = await Promise.all([
      memberChoices(c.biz),
      whatsappHealth().catch(() => ({ connected: whatsappConfigured() })),
      recentNotices(c.biz),
    ]);
    return json({ ...view, members, health, recent });
  }
  if (which === 'forms' && c.owner) return json(await businessForms(c.biz));
  return json(view);
}

async function recentNotices(biz: string) {
  const db = adminDb();
  const { data } = await db.from('lead_notifications').select(NOTICE_COLUMNS).eq('business_id', biz).order('created_at', { ascending: false }).limit(20);
  const rows = (data ?? []).map(noticeView);
  const ids = [...new Set(rows.map((r) => r.leadId))];
  if (ids.length) {
    const { data: leads } = await db.from('leads').select('id, name').in('id', ids).eq('business_id', biz);
    const names = new Map(((leads ?? []) as { id: string; name: string }[]).map((l) => [l.id, l.name]));
    for (const r of rows) r.leadName = names.get(r.leadId) ?? '';
  }
  return rows;
}

/** every lead form of the business's Facebook Pages (any Page of the business, switched on for leads or not) */
async function businessForms(biz: string) {
  const { data: pages } = await adminDb().from('social_accounts').select('id, external_id, access_token, display_name')
    .eq('business_id', biz).eq('provider', 'facebook').eq('status', 'active');
  const forms: { id: string; name: string; status: string; page: string; questions: { key: string; label: string; options: string[] }[] }[] = [];
  const errors: { page: string; message: string }[] = [];
  for (const p of (pages ?? []) as { external_id: string; access_token: string; display_name: string | null }[]) {
    try {
      for (const f of await leadFormsDetailed(open(p.access_token), p.external_id)) forms.push({ ...f, page: p.display_name ?? p.external_id });
    } catch (e: any) {
      errors.push({ page: p.display_name ?? p.external_id, message: String(e?.message ?? e).replace(/^[a-z_0-9]+:\s*/i, '').slice(0, 200) });
    }
  }
  return { forms, errors, pages: (pages ?? []).length };
}

type Rule = { kind: RuleKind; formId: string; formName: string; campaign: string; question: string; answer: string };
/** a department's rules as typed: each one whole, or the message that says what is missing */
function cleanRules(raw: unknown): Rule[] | string {
  if (!Array.isArray(raw)) return [];
  if (raw.length > 20) return 'עד 20 כללי זיהוי למחלקה.';
  const out: Rule[] = [];
  for (const r of raw as any[]) {
    const kind = r?.kind as RuleKind;
    if (kind === 'form') {
      const formId = String(r.formId ?? '').trim();
      if (!/^\d{1,30}$/.test(formId)) return 'טופס: צריך לבחור טופס מהרשימה, או להקליד את המזהה שלו (ספרות בלבד).';
      out.push({ kind, formId, formName: oneLine(r.formName, 200), campaign: '', question: '', answer: '' });
    } else if (kind === 'campaign') {
      const campaign = oneLine(r.campaign, 200);
      if (!campaign) return 'קמפיין: צריך שם (או חלק ממנו) או מזהה.';
      out.push({ kind, formId: '', formName: '', campaign, question: '', answer: '' });
    } else if (kind === 'answer') {
      const question = oneLine(r.question, 300), answer = oneLine(r.answer, 300);
      if (!question || !answer) return 'שאלה ותשובה: צריך גם את השאלה וגם את התשובה.';
      out.push({ kind, formId: '', formName: '', campaign: '', question, answer });
    } else return 'סוג כלל לא מוכר.';
  }
  return out;
}

const uniqueMessage = (m: string) =>
  /lead_staff_phone_uq/.test(m) ? 'המספר הזה כבר ברשימת הצוות.'
    : /lead_staff_member_uq/.test(m) ? 'החשבון הזה ב-Dream כבר משויך לאדם אחר בצוות.'
      : /lead_departments_name_uq/.test(m) ? 'כבר יש מחלקה בשם הזה.' : 'הפרטים כבר קיימים.';
/** 2.105: the calendar's columns (practitioner, color) and a person with no number — before migration 20261018005700 */
const CALENDAR_NOT_READY = 'צריך קודם להריץ את מיגרציה 20261018005700 (יומן התורים והמטפלות).';
const calendarMissing = (e: { code?: string; message: string }) =>
  e.code === '23502' || e.code === 'PGRST204' || /practitioner|color|null value in column "phone"/.test(e.message);

export async function POST(req: Request) {
  const c = await leadsCaller(req, true);
  if ('res' in c) return c.res;
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  const db = adminDb();
  if (!(await routingView(c))) return json(NOT_READY, 409);
  const staffOf = async (id: unknown) => {
    if (typeof id !== 'string' || !id) return null;
    const { data } = await db.from('lead_staff').select('id, name, phone, active').eq('id', id).eq('business_id', c.biz).maybeSingle();
    return (data as { id: string; name: string; phone: string | null; active: boolean } | null);
  };
  const done = async () => json(await routingView(c));

  switch (body.action) {
    case 'staff.save': {
      const name = oneLine(body.name, 60);
      if (!name) return bad('צריך שם.');
      // 2.105: no number — a person who gets no WhatsApp (a practitioner of the calendar); a number that is typed must be one
      const typed = String(body.phone ?? '').trim();
      const phone = typed ? staffPhone(typed) : null;
      if (typed && !phone) return bad('מספר וואטסאפ לא תקין. למשל 050-1234567, או מספר בחו״ל עם קידומת: ‎+1 555 010 0123');
      let member: string | null = null;
      if (body.memberUserId) {
        const { data } = await db.from('business_members').select('user_id').eq('business_id', c.biz).eq('user_id', String(body.memberUserId)).maybeSingle();
        if (!data) return bad('החשבון שנבחר הוא לא חבר בעסק.');
        member = String(body.memberUserId);
      }
      const row: Record<string, unknown> = { name, phone, member_user_id: member };
      // the calendar's columns only when sent: an edit from this screen never touches a practitioner's colour
      if (body.practitioner !== undefined) row.practitioner = Boolean(body.practitioner);
      if (body.color !== undefined) {
        if (body.color !== '' && !isCalendarColor(body.color)) return bad('צבע לא מוכר.');
        row.color = body.color;
      }
      const res = body.id
        ? await db.from('lead_staff').update(row).eq('id', String(body.id)).eq('business_id', c.biz).eq('active', true).select('id')
        : await db.from('lead_staff').insert({ ...row, business_id: c.biz, active: true }).select('id');
      if (res.error) {
        if ((res.error as any).code === '23505') return bad(uniqueMessage(res.error.message), 'duplicate', 409);
        return calendarMissing(res.error as any) ? bad(CALENDAR_NOT_READY, 'not_ready', 409) : bad(res.error.message, 'db', 500);
      }
      if (body.id && !(res.data ?? []).length) return bad('האדם הזה לא נמצא ברשימת הצוות.', 'not_found', 404);
      return done();
    }
    // 2.105: who is a practitioner of the calendar, and her colour — nothing else of the person changes
    case 'staff.calendar': {
      const s = await staffOf(body.id);
      if (!s?.active) return bad('האדם הזה לא נמצא ברשימת הצוות.', 'not_found', 404);
      const patch: Record<string, unknown> = {};
      if (body.practitioner !== undefined) patch.practitioner = Boolean(body.practitioner);
      if (body.color !== undefined) {
        if (body.color !== '' && !isCalendarColor(body.color)) return bad('צבע לא מוכר.');
        patch.color = body.color;
      }
      if (!Object.keys(patch).length) return bad('אין מה לשמור.');
      const res = await db.from('lead_staff').update(patch).eq('id', s.id).eq('business_id', c.biz).eq('active', true).select('id');
      if (res.error) return calendarMissing(res.error as any) ? bad(CALENDAR_NOT_READY, 'not_ready', 409) : bad(res.error.message, 'db', 500);
      return done();
    }
    case 'staff.remove': {
      const s = await staffOf(body.id);
      if (!s?.active) return bad('האדם הזה לא נמצא ברשימת הצוות.', 'not_found', 404);
      const [{ data: depts }, { data: setting }] = await Promise.all([
        db.from('lead_departments').select('name').eq('business_id', c.biz).eq('staff_id', s.id).eq('active', true),
        db.from('lead_routing').select('default_staff_id').eq('business_id', c.biz).maybeSingle(),
      ]);
      if ((depts ?? []).length) return bad(`באחריות ${s.name}: ${(depts as { name: string }[]).map((d) => d.name).join(', ')}. קודם להעביר את המחלקה לאדם אחר בצוות.`, 'in_use', 409);
      if ((setting as any)?.default_staff_id === s.id) return bad(`לידים בלי מחלקה נשלחים אל ${s.name}. קודם לבחור לזה אדם אחר.`, 'in_use', 409);
      await db.from('lead_staff').update({ active: false }).eq('id', s.id).eq('business_id', c.biz);
      return done();
    }
    case 'department.save': {
      const name = oneLine(body.name, 60);
      if (!name) return bad('צריך שם למחלקה.');
      const s = await staffOf(body.staffId);
      if (!s?.active) return bad('צריך לבחור מהצוות את האחראי על המחלקה.');
      const rules = cleanRules(body.rules);
      if (typeof rules === 'string') return bad(rules);
      let id = typeof body.id === 'string' ? body.id : '';
      if (id) {
        const res = await db.from('lead_departments').update({ name, staff_id: s.id }).eq('id', id).eq('business_id', c.biz).eq('active', true).select('id');
        if (res.error) return (res.error as any).code === '23505' ? bad(uniqueMessage(res.error.message), 'duplicate', 409) : bad(res.error.message, 'db', 500);
        if (!(res.data ?? []).length) return bad('המחלקה לא נמצאה.', 'not_found', 404);
      } else {
        const { data: all } = await db.from('lead_departments').select('position').eq('business_id', c.biz);
        const position = Math.max(-1, ...((all ?? []) as { position: number | null }[]).map((d) => d.position ?? 0)) + 1;
        const res = await db.from('lead_departments').insert({ business_id: c.biz, name, staff_id: s.id, position, active: true }).select('id').single();
        if (res.error) return (res.error as any).code === '23505' ? bad(uniqueMessage(res.error.message), 'duplicate', 409) : bad(res.error.message, 'db', 500);
        id = (res.data as any).id;
      }
      // the rules: the new set in first, then the old ones out — a failure in the middle never leaves a department without rules
      const { data: old } = await db.from('lead_department_rules').select('id').eq('department_id', id).eq('business_id', c.biz);
      if (rules.length) {
        const ins = await db.from('lead_department_rules').insert(rules.map((r) => ({
          business_id: c.biz, department_id: id, kind: r.kind, form_id: r.formId, form_name: r.formName, campaign: r.campaign, question: r.question, answer: r.answer,
        })));
        if (ins.error) return bad(ins.error.message, 'db', 500);
      }
      const oldIds = ((old ?? []) as { id: string }[]).map((r) => r.id);
      if (oldIds.length) await db.from('lead_department_rules').delete().in('id', oldIds).eq('business_id', c.biz);
      return done();
    }
    case 'department.remove': {
      const res = await db.from('lead_departments').update({ active: false }).eq('id', String(body.id ?? '')).eq('business_id', c.biz).eq('active', true).select('id');
      if (!(res.data ?? []).length) return bad('המחלקה לא נמצאה.', 'not_found', 404);
      return done();
    }
    case 'default.set': {
      let staffId: string | null = null;
      if (body.staffId) {
        const s = await staffOf(body.staffId);
        if (!s?.active) return bad('צריך לבחור אדם מהצוות.');
        staffId = s.id;
      }
      const res = await db.from('lead_routing').upsert({ business_id: c.biz, default_staff_id: staffId }, { onConflict: 'business_id' });
      if (res.error) return bad(res.error.message, 'db', 500);
      return done();
    }
    // 2.102: the department that gets the site's requests (none = by the rules, else the default recipient)
    case 'site.set': {
      let departmentId: string | null = null;
      if (body.departmentId) {
        const { data } = await db.from('lead_departments').select('id').eq('id', String(body.departmentId)).eq('business_id', c.biz).eq('active', true).maybeSingle();
        if (!data) return bad('צריך לבחור מחלקה מהרשימה.');
        departmentId = String(body.departmentId);
      }
      const res = await db.from('lead_routing').upsert({ business_id: c.biz, site_department_id: departmentId }, { onConflict: 'business_id' });
      if (res.error) return /site_department_id/.test(res.error.message) ? bad('צריך קודם להריץ את מיגרציה 20261017005400 (פניות מהאתר).', 'not_ready', 409) : bad(res.error.message, 'db', 500);
      return done();
    }
    case 'test': return testMessage(req, c, body, staffOf);
  }
  return bad('פעולה לא מוכרת.');
}

/** "שליחת הודעת בדיקה": the template with test values to that person — Meta's answer as it is, or its error in full */
async function testMessage(req: Request, c: LeadsCaller, body: Record<string, any>, staffOf: (id: unknown) => Promise<{ id: string; name: string; phone: string | null; active: boolean } | null>) {
  const limited = rateLimited(req, 'lead-wa-test', 10, MINUTE);
  if (limited) return limited;
  const s = await staffOf(body.staffId);
  if (!s?.active) return bad('האדם הזה לא נמצא ברשימת הצוות.', 'not_found', 404);
  if (!s.phone) return bad(`ל${s.name}: ${NO_STAFF_PHONE}.`, 'no_phone', 409);
  if (!whatsappConfigured()) return json({ code: 'not_connected', message: WA_NOT_CONNECTED }, 409);
  const { data: dept } = await adminDb().from('lead_departments').select('name').eq('business_id', c.biz).eq('staff_id', s.id).eq('active', true).order('position', { ascending: true }).limit(1);
  const r = await sendNewLead(s.phone, testTemplateParams({ phone: s.phone }, ((dept ?? [])[0] as any)?.name ?? ''));
  if (r.ok) return json({ ok: true, http: r.http, messageId: r.messageId, waId: r.waId, status: r.status, response: r.body });
  const code = waErrorCode(r.error);
  return json({ ok: false, http: r.http, code, hint: waErrorHint(code), error: r.error, response: r.body });
}
