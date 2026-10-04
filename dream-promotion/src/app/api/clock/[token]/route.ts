import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { israelToIso, israelParts } from '@/lib/il-time';
import { distanceMeters } from '@/features/timeclock/hours';
import { UNAVAILABLE, businessOpen } from '@/lib/server/business';

export const runtime = 'nodejs';

/**
 * An employee's private clock page API — /clock/<token>, no login. The token is the key (random,
 * 30+ characters, revocable by the owner). Times are always the server's, never the phone's.
 */
async function employeeOf(token: string) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  const db = adminDb();
  const { data: emp } = await db.from('employees').select('id, user_id, business_id, name, active').eq('token', token).maybeSingle();
  if (!emp) return null;
  if (!(await businessOpen((emp as any).business_id))) return 'locked' as const;
  const { data: brand } = await db.from('brands').select('name').eq('business_id', (emp as any).business_id).maybeSingle();
  // the business's QR rules (table from migration 20261003001300; absent = not set up yet)
  const { data: rules } = await db.from('timeclock_settings').select('site_code, require_qr, geo_lat, geo_lng, geo_radius_m')
    .eq('business_id', (emp as any).business_id).maybeSingle().then((r) => r, () => ({ data: null }));
  return { ...(emp as any), business: (brand as any)?.name ?? '', rules: (rules as any) ?? null };
}

/** QR is required once the business created its code (and did not switch the requirement off) */
const scanRequired = (emp: any) => Boolean(emp.rules?.site_code && emp.rules?.require_qr !== false);
const locationLocked = (emp: any) => emp.rules?.geo_lat != null && emp.rules?.geo_lng != null;

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
    requireScan: scanRequired(emp), needsLocation: locationLocked(emp),
    openSince: open?.clock_in ?? null, todayMinutes: todayMin,
    recent: rows.filter((r) => r.clock_out).slice(0, 5).map((r) => ({ in: r.clock_in, out: r.clock_out })),
  };
}

export async function GET(req: Request, { params }: { params: { token: string } }) {
  const emp = await employeeOf(params.token);
  if (!emp) return NextResponse.json({ code: 'not_found', message: 'הקישור לא תקין או שבוטל' }, { status: 404 });
  if (emp === 'locked') return NextResponse.json(UNAVAILABLE, { status: 403 });
  const site = new URL(req.url).searchParams.get('site');
  const siteOk = !scanRequired(emp) || (Boolean(site) && site === emp.rules.site_code);
  return NextResponse.json({ ...(await state(emp)), siteOk }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request, { params }: { params: { token: string } }) {
  const emp = await employeeOf(params.token);
  if (!emp) return NextResponse.json({ code: 'not_found', message: 'הקישור לא תקין או שבוטל' }, { status: 404 });
  if (emp === 'locked') return NextResponse.json(UNAVAILABLE, { status: 403 });
  if (!emp.active) return NextResponse.json({ code: 'inactive', message: 'העובד/ת לא פעיל/ה. פנו למנהל/ת.' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 180 ? v : null);
  const lat = num(body.lat), lng = num(body.lng);
  // clocking happens at the business: the scanned QR code must be the business's current one
  if (scanRequired(emp) && String(body.site ?? '') !== emp.rules.site_code) {
    return NextResponse.json({ code: 'scan_required', message: body.site ? 'הקוד שנסרק כבר לא בתוקף. סרקו את הקוד שתלוי בעסק.' : 'כדי להחתים — סרקו את קוד ה-QR שתלוי בעסק.' }, { status: 403 });
  }
  if (locationLocked(emp)) {
    if (lat == null || lng == null) return NextResponse.json({ code: 'location_required', message: 'צריך לאשר גישה למיקום כדי להחתים.' }, { status: 403 });
    const d = distanceMeters({ lat, lng }, { lat: emp.rules.geo_lat, lng: emp.rules.geo_lng });
    // + 75 m for normal phone GPS inaccuracy indoors
    if (d > (emp.rules.geo_radius_m ?? 150) + 75) return NextResponse.json({ code: 'too_far', message: `נראה שאתם במרחק ${d.toLocaleString('he-IL')} מ׳ מהעסק. ההחתמה אפשרית רק בעסק.` }, { status: 403 });
  }
  const db = adminDb();
  const now = new Date().toISOString();
  const { data: open } = await db.from('time_entries').select('id, clock_in').eq('employee_id', emp.id).is('clock_out', null).maybeSingle();

  if (body.action === 'in') {
    if (open) return NextResponse.json({ code: 'already_in', message: 'כבר במשמרת', ...(await state(emp)) }, { status: 409 });
    const { error } = await db.from('time_entries').insert({ user_id: emp.user_id, business_id: emp.business_id, employee_id: emp.id, clock_in: now, in_lat: lat, in_lng: lng, source: scanRequired(emp) ? 'qr' : 'self' });
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
