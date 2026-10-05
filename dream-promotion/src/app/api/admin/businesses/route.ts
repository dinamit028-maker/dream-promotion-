import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { requireAdmin } from '@/lib/server/admin-auth';
import { isSuperAdmin } from '@/lib/server/business';
import { signedUpUser } from '@/lib/server/admin-users';
import { israelToIso } from '@/lib/il-time';
import { bizView, extendMonth, todayIL, validSlug } from '@/features/admin/business-state';
import { FIRST_OF, type Milestones } from '@/features/admin/milestones';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The super admin's dashboard of businesses (admin → "עסקים"). Super admin only — an owner can never
 * change status, payment date, lock or members (the database refuses it too, stage 4).
 *  GET   → every business: state, payment, members, assets (+ disconnected), this month's posts / leads / cost, and the
 *          pilot milestones (dates only: opened, onboarded, first customer / appointment / sale / document / expense / quote)
 *  POST  { name, slug, ownerEmail?, paidUntil? } → a new business (+ its owner, who must already have signed up)
 *  PATCH { id, action: 'extend' | 'paid_until' | 'lock' | 'unlock' | 'enter', paidUntil?, reason? }
 *  PATCH { id, action: 'add_member', email, access: 'full' | 'register' } — a person who already signed up joins the
 *        business (register = "קופאי/ת": the register only) and starts working in it; 'remove_member' { email }
 */
/** the super admin's id, or a ready refusal */
async function superAdminOnly(req: Request): Promise<string | Response> {
  const r = await requireAdmin(req);
  if (!r.admin) return r.denied ?? NextResponse.json({ code: 'forbidden' }, { status: 403 });
  if (!(await isSuperAdmin(r.admin.id))) return NextResponse.json({ code: 'forbidden', message: 'מנהל-על בלבד' }, { status: 403 });
  return r.admin.id;
}
const bad = (message: string, status = 400) => NextResponse.json({ code: 'bad_request', message }, { status });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const userId = await superAdminOnly(req);
  if (typeof userId !== 'string') return userId;
  const db = adminDb();
  const monthStart = israelToIso(`${todayIL().slice(0, 7)}-01`, '00:00');
  const [biz, members, assets, posts, leads, costs, me] = await Promise.all([
    db.from('businesses').select('id, name, slug, status, paid_until, grace_days, lock_reason, notes, created_at').order('created_at'),
    db.from('business_members').select('*'),
    db.from('social_accounts').select('business_id, provider, display_name, status'),
    db.from('scheduled_posts').select('business_id').in('status', ['done', 'partial']).gte('last_run_at', monthStart),
    db.from('leads').select('business_id').gte('created_at', monthStart),
    db.from('ai_generations').select('business_id, actual_cost_usd, estimated_cost_usd, status').gte('created_at', monthStart).neq('status', 'cancelled'),
    db.from('profiles').select('current_business_id').eq('id', userId).maybeSingle(),
  ]);
  if (biz.error) return NextResponse.json({ code: 'db', message: biz.error.message }, { status: 500 });
  const ids = [...new Set((members.data ?? []).map((m) => m.user_id))];
  const { data: people } = await db.from('profiles').select('id, email, full_name').in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  const person = new Map((people ?? []).map((p) => [p.id, p]));
  // pilot milestones: the date of the first row of each kind, per business — dates only, nothing else leaves the table
  const bizIds = (biz.data ?? []).map((b) => b.id);
  const brands = (await db.from('brands').select('business_id, onboarded, updated_at').in('business_id', bizIds.length ? bizIds : ['00000000-0000-0000-0000-000000000000'])).data ?? [];
  const firsts = await Promise.all(bizIds.flatMap((id) => Object.entries(FIRST_OF).map(async ([key, f]) => {
    const { data } = await db.from(f.table).select(f.column).eq('business_id', id).order(f.column, { ascending: true }).limit(1).maybeSingle();
    return { id, key, at: data ? String((data as unknown as Record<string, unknown>)[f.column] ?? '') || null : null };
  })));
  const milestonesOf = (b: { id: string; created_at: string }): Milestones => {
    const brand = brands.find((x: any) => x.business_id === b.id) as any;
    const m: Milestones = { created: b.created_at, onboarded: brand?.onboarded ? brand.updated_at ?? null : null };
    for (const f of firsts) if (f.id === b.id) (m as Record<string, string | null>)[f.key] = f.at;
    return m;
  };
  const count = (rows: { business_id: string | null }[] | null, id: string) => (rows ?? []).filter((r) => r.business_id === id).length;

  return NextResponse.json({
    current: me.data?.current_business_id ?? null,
    unassignedAssets: (assets.data ?? []).filter((s) => !s.business_id).length,
    businesses: (biz.data ?? []).map((b) => {
      const mine = (assets.data ?? []).filter((s) => s.business_id === b.id);
      const cost = (costs.data ?? []).filter((c) => c.business_id === b.id)
        .reduce((sum, c) => sum + Number(c.actual_cost_usd ?? c.estimated_cost_usd ?? 0), 0);
      return {
        id: b.id, name: b.name, slug: b.slug, status: b.status, paidUntil: b.paid_until, graceDays: b.grace_days,
        lockReason: b.lock_reason, ...bizView(b),
        members: (members.data ?? []).filter((m) => m.business_id === b.id)
          .map((m: any) => ({ role: m.role, access: m.access === 'register' ? 'register' : 'full', email: person.get(m.user_id)?.email ?? '', name: person.get(m.user_id)?.full_name ?? '' })),
        assets: mine.length,
        missing: mine.filter((s) => s.status === 'missing').map((s) => `${s.provider} · ${s.display_name ?? ''}`),
        month: { posts: count(posts.data, b.id), leads: count(leads.data, b.id), costUsd: Math.round(cost * 100) / 100 },
        milestones: milestonesOf(b),
      };
    }),
  });
}

export async function POST(req: Request) {
  const userId = await superAdminOnly(req);
  if (typeof userId !== 'string') return userId;
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? '').trim().slice(0, 80);
  const slug = String(body.slug ?? '').trim().toLowerCase();
  const paidUntil = body.paidUntil ? String(body.paidUntil) : null;
  const ownerEmail = String(body.ownerEmail ?? '').trim().toLowerCase();
  if (!name) return bad('נא לכתוב שם לעסק');
  if (!validSlug(slug)) return bad('מזהה באנגלית: אותיות קטנות, ספרות ומקפים (לפחות 2 תווים)');
  if (paidUntil && !DATE.test(paidUntil)) return bad('תאריך לא תקין');
  const db = adminDb();

  let ownerId: string | null = null;
  if (ownerEmail) {
    ownerId = await signedUpUser(db, ownerEmail);
    if (!ownerId) return bad(`המשתמש ${ownerEmail} עוד לא נרשם לאפליקציה (או שלא אישר את כתובת המייל). אפשר ליצור את העסק בלי בעלים ולהוסיף אחר כך.`);
  }
  const { data: b, error } = await db.from('businesses').insert({ name, slug, paid_until: paidUntil }).select('id').single();
  if (error) return bad(/duplicate|unique/i.test(error.message) ? 'המזהה כבר תפוס — בחרו אחר' : error.message);
  if (ownerId) {
    const m = await db.from('business_members').insert({ business_id: b.id, user_id: ownerId, role: 'owner' });
    if (m.error) return bad(`העסק נוצר, אבל הבעלים לא נוסף: ${m.error.message}`);
  }
  return NextResponse.json({ ok: true, id: b.id });
}

export async function PATCH(req: Request) {
  const userId = await superAdminOnly(req);
  if (typeof userId !== 'string') return userId;
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? '');
  const db = adminDb();
  const { data: b } = await db.from('businesses').select('id, status, paid_until').eq('id', id).maybeSingle();
  if (!b) return NextResponse.json({ code: 'not_found', message: 'העסק לא נמצא' }, { status: 404 });

  let patch: Record<string, unknown>;
  switch (body.action) {
    case 'extend': {
      const next = extendMonth(b.paid_until);
      if (!next) return bad('לעסק הזה אין תאריך תפוגה — אין מה להאריך');
      patch = { paid_until: next };
      break;
    }
    case 'paid_until': {
      const d = body.paidUntil ? String(body.paidUntil) : null; // empty = no limit
      if (d && !DATE.test(d)) return bad('תאריך לא תקין');
      patch = { paid_until: d };
      break;
    }
    case 'lock': patch = { status: 'locked', lock_reason: String(body.reason ?? '').slice(0, 200) }; break;
    case 'unlock': patch = { status: 'active', lock_reason: '' }; break;
    case 'enter': {
      // the super admin works inside this business from now on (new rows are filed under it)
      const { error } = await db.from('profiles').update({ current_business_id: id }).eq('id', userId);
      return error ? bad(error.message) : NextResponse.json({ ok: true });
    }
    case 'add_member': {
      const email = String(body.email ?? '').trim().toLowerCase();
      const access = body.access === 'register' ? 'register' : 'full';
      if (!email) return bad('נא לכתוב מייל');
      const uid = await signedUpUser(db, email);
      if (!uid) return bad(`${email} עוד לא נרשם/ה לאפליקציה (או שלא אישר/ה את כתובת המייל). אחרי ההרשמה אפשר להוסיף.`);
      const p = { id: uid };
      const { error } = await db.from('business_members').upsert(
        { business_id: id, user_id: p.id, role: access === 'register' ? 'editor' : 'owner', access }, { onConflict: 'business_id,user_id' });
      if (error) return bad(/access/.test(error.message) ? 'צריך להריץ את מיגרציה 20261004003000 (הרשאות קופה).' : error.message);
      // a new member works in this business from now on (a cashier has nowhere else to work)
      await db.from('profiles').update({ current_business_id: id }).eq('id', p.id);
      return NextResponse.json({ ok: true });
    }
    case 'remove_member': {
      const email = String(body.email ?? '').trim().toLowerCase();
      const uid = await signedUpUser(db, email);
      if (!uid) return bad('המשתמש לא נמצא');
      const p = { id: uid };
      const { error } = await db.from('business_members').delete().eq('business_id', id).eq('user_id', p.id);
      if (error) return bad(error.message);
      await db.from('profiles').update({ current_business_id: null }).eq('id', p.id).eq('current_business_id', id);
      return NextResponse.json({ ok: true });
    }
    default: return bad('פעולה לא מוכרת');
  }
  const { error } = await db.from('businesses').update(patch).eq('id', id);
  if (error) return bad(error.message);
  return NextResponse.json({ ok: true, ...patch });
}
