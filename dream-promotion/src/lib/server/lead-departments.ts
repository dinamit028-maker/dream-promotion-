import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from './admin';
import { LOCKED, REGISTER_ONLY, businessOf, canUseBusiness, memberRole, registerOnly } from './business';
import { whatsappConfigured } from './whatsapp';
import { staffPhoneShow, type NoticeView, type RoutingView, type RuleView } from '@/features/crm/lead-routing';

/**
 * The screens of lead departments (2.99) on the server: who may see them (a member of the business, not a cashier) and change
 * them (its owner only — the team's phones, the rules, moving a lead to another person), and the view they get.
 * The tables are the server's only (migration 20261012005300): the browser reaches them through these routes.
 */
export type LeadsCaller = { userId: string; biz: string; owner: boolean };
export const OWNER_ONLY = { code: 'owner_only', message: 'רק בעלי העסק יכולים לשנות את זה.' } as const;
export const NOT_READY = { code: 'not_ready', message: 'מחלקות הלידים עוד לא זמינות: חסר עדכון במסד הנתונים (מיגרציה 20261012005300).' } as const;

export async function leadsCaller(req: Request, write: boolean): Promise<LeadsCaller | { res: Response }> {
  const userId = await userFromRequest(req);
  if (!userId) return { res: NextResponse.json({ code: 'no_session', message: 'צריך להתחבר מחדש.' }, { status: 401 }) };
  const biz = await businessOf(userId);
  if (!biz || !(await canUseBusiness(userId, biz))) return { res: NextResponse.json(LOCKED, { status: 403 }) };
  if (await registerOnly(userId)) return { res: NextResponse.json(REGISTER_ONLY, { status: 403 }) };
  const owner = (await memberRole(userId, biz)) === 'owner';
  if (write && !owner) return { res: NextResponse.json(OWNER_ONLY, { status: 403 }) };
  return { userId, biz, owner };
}

/** the business's team and departments; the owner also gets the numbers and the rules. null: before the migration */
export async function routingView(c: LeadsCaller): Promise<RoutingView | null> {
  const db = adminDb();
  const [staff, depts, rules, setting, site] = await Promise.all([
    db.from('lead_staff').select('id, name, phone, active, member_user_id, created_at').eq('business_id', c.biz).order('created_at', { ascending: true }),
    db.from('lead_departments').select('id, name, staff_id, position, active').eq('business_id', c.biz).order('position', { ascending: true }),
    c.owner ? db.from('lead_department_rules').select('department_id, kind, form_id, form_name, campaign, question, answer, created_at').eq('business_id', c.biz).order('created_at', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    db.from('lead_routing').select('default_staff_id').eq('business_id', c.biz).maybeSingle(),
    // 2.102: its own query — before migration 20261017005400 the column is not there, and the rest stays as it was
    db.from('lead_routing').select('site_department_id').eq('business_id', c.biz).maybeSingle(),
  ]);
  if (staff.error || depts.error || (rules as any).error) return null;
  const byDept = new Map<string, RuleView[]>();
  for (const r of ((rules as any).data ?? []) as any[]) {
    const list = byDept.get(r.department_id) ?? [];
    list.push({ kind: r.kind, formId: r.form_id ?? '', formName: r.form_name ?? '', campaign: r.campaign ?? '', question: r.question ?? '', answer: r.answer ?? '' });
    byDept.set(r.department_id, list);
  }
  const team = (staff.data ?? []) as { id: string; name: string; phone: string; active: boolean; member_user_id: string | null }[];
  return {
    ready: true, connected: whatsappConfigured(), owner: c.owner,
    me: team.filter((s) => s.active && s.member_user_id === c.userId).map((s) => s.id),
    staff: team.map((s) => ({
      id: s.id, name: s.name, active: s.active, memberUserId: s.member_user_id,
      ...(c.owner ? { phone: s.phone, phoneShown: staffPhoneShow(s.phone) } : {}),
    })),
    departments: ((depts.data ?? []) as any[]).map((d) => ({
      id: d.id, name: d.name, staffId: d.staff_id, position: d.position ?? 0, active: Boolean(d.active),
      ...(c.owner ? { rules: byDept.get(d.id) ?? [] } : {}),
    })),
    defaultStaffId: ((setting.data as any)?.default_staff_id as string | null) ?? null,
    ...(site.error ? {} : { siteDepartmentId: ((site.data as any)?.site_department_id as string | null) ?? null }),
  };
}

/** the business's members, for "who is this person in Dream" (the owner's screen) */
export async function memberChoices(biz: string): Promise<{ userId: string; name: string; role: string }[]> {
  const db = adminDb();
  const { data: members } = await db.from('business_members').select('user_id, role').eq('business_id', biz);
  const ids = ((members ?? []) as { user_id: string }[]).map((m) => m.user_id);
  if (!ids.length) return [];
  const { data: profiles } = await db.from('profiles').select('id, full_name, email').in('id', ids);
  const byId = new Map(((profiles ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((p) => [p.id, p]));
  return ((members ?? []) as { user_id: string; role: string }[]).map((m) => {
    const p = byId.get(m.user_id);
    return { userId: m.user_id, name: (p?.full_name || p?.email || 'חשבון בלי שם').slice(0, 80), role: m.role };
  });
}

export const noticeView = (r: any): NoticeView => ({
  id: r.id, leadId: r.lead_id, staffId: r.staff_id, staffName: r.staff_name ?? '', kind: r.kind, status: r.status, reason: r.reason ?? '',
  attempts: r.attempts ?? 0, errorCode: r.error_code ?? '',
  error: r.error ? { message: String(r.error.message ?? ''), details: String(r.error.details ?? ''), fbtrace: String(r.error.fbtrace ?? ''), type: String(r.error.type ?? '') } : null,
  sentAt: r.sent_at ?? null, claimedAt: r.claimed_at ?? null, createdAt: r.created_at,
});
export const NOTICE_COLUMNS = 'id, lead_id, staff_id, staff_name, kind, status, reason, attempts, error_code, error, sent_at, claimed_at, created_at';
