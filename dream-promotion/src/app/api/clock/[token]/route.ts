import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { israelToIso, israelParts } from '@/lib/il-time';

export const runtime = 'nodejs';

/**
 * An employee's private clock page API — /clock/<token>, no login. The token is the key (random,
 * 30+ characters, revocable by the owner). Times are always the server's, never the phone's.
 */
async function employeeOf(token: string) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  const db = adminDb();
  const { data: emp } = await db.from('employees').select('id, user_id, name, active').eq('token', token).maybeSingle();
  if (!emp) return null;
  const { data: brand } = await db.from('brands').select('name').eq('user_id', emp.user_id).maybeSingle();
  return { ...(emp as any), business: (brand as any)?.name ?? '' };
}

async function state(emp: any) {
  const db = adminDb();
  const dayStart = israelToIso(israelParts(Date.now()).date, '00:00');
  const { data: recent } = await db.from('time_entries').select('id, clock_in, clock_out')
    .eq('employee_id', emp.id).gte('clock_in', new Date(Date.now() - 14 * 864e5).toISOString()).order('clock_in', { ascending: false }).limit(20);
  const rows = (recent ?? []) as any[];
  const open = rows.find((r) => !r.clock_out) ?? null;
  const todayMin = rows.filter((r) => r.clock_in >= dayStart)
    .reduce((a, r) => a + Math.max(0, Math.round(((r.clock_out ? +new Date(r.clock_out) : Date.now()) - +new Date(r.clock_in)) / 60_000)), 0);
  return {
    name: emp.name, business: emp.business, active: emp.active,
    openSince: open?.clock_in ?? null, todayMinutes: todayMin,
    recent: rows.filter((r) => r.clock_out).slice(0, 5).map((r) => ({ in: r.clock_in, out: r.clock_out })),
  };
}

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const emp = await employeeOf(params.token);
  if (!emp) return NextResponse.json({ code: 'not_found', message: 'הקישור לא תקין או שבוטל' }, { status: 404 });
  return NextResponse.json(await state(emp), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request, { params }: { params: { token: string } }) {
  const emp = await employeeOf(params.token);
  if (!emp) return NextResponse.json({ code: 'not_found', message: 'הקישור לא תקין או שבוטל' }, { status: 404 });
  if (!emp.active) return NextResponse.json({ code: 'inactive', message: 'העובד/ת לא פעיל/ה. פנו למנהל/ת.' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 180 ? v : null);
  const lat = num(body.lat), lng = num(body.lng);
  const db = adminDb();
  const now = new Date().toISOString();
  const { data: open } = await db.from('time_entries').select('id, clock_in').eq('employee_id', emp.id).is('clock_out', null).maybeSingle();

  if (body.action === 'in') {
    if (open) return NextResponse.json({ code: 'already_in', message: 'כבר במשמרת', ...(await state(emp)) }, { status: 409 });
    const { error } = await db.from('time_entries').insert({ user_id: emp.user_id, employee_id: emp.id, clock_in: now, in_lat: lat, in_lng: lng, source: 'self' });
    if (error) {
      if (error.code === '23505') return NextResponse.json({ code: 'already_in', message: 'כבר במשמרת', ...(await state(emp)) }, { status: 409 });
      console.error('[clock] in', error.message);
      return NextResponse.json({ code: 'error', message: 'לא נשמר. נסו שוב.' }, { status: 500 });
    }
  } else if (body.action === 'out') {
    if (!open) return NextResponse.json({ code: 'not_in', message: 'אין משמרת פתוחה', ...(await state(emp)) }, { status: 409 });
    // a tap seconds after clocking in is almost always a double tap
    if (Date.now() - +new Date((open as any).clock_in) < 60_000) {
      return NextResponse.json({ code: 'too_soon', message: 'נכנסת לפני פחות מדקה. אם זו טעות — לחצו שוב בעוד רגע.', ...(await state(emp)) }, { status: 409 });
    }
    const { error } = await db.from('time_entries').update({ clock_out: now, out_lat: lat, out_lng: lng }).eq('id', (open as any).id).is('clock_out', null);
    if (error) { console.error('[clock] out', error.message); return NextResponse.json({ code: 'error', message: 'לא נשמר. נסו שוב.' }, { status: 500 }); }
  } else {
    return NextResponse.json({ code: 'bad_input' }, { status: 400 });
  }
  return NextResponse.json({ ok: true, at: now, ...(await state(emp)) });
}
