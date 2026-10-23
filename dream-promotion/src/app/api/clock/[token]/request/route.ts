import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { UNAVAILABLE, businessOpen } from '@/lib/server/business';
import { MINUTE, rateLimited } from '@/lib/server/rate-limit';
import { LINK_NOT_VALID, isClockToken } from '@/features/timeclock/clock-app';
import { clockRequestInput } from '@/features/attendance/clock-request';

export const runtime = 'nodejs';

/**
 * An employee asks, from their personal link (2.107 — the clock's screens for it come in stage 2): to complete a report (a
 * missing clock-in or clock-out, a shift that was not reported, a fix) or an absence. Nothing is written into the hours: it waits
 * for a manager (att_request_create / att_absence_add — the database checks the employee, the entry, the closed month). The
 * caller sets the request's id, so a retry is the same request. The clock itself (/api/clock/<token>) is not touched.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const limited = rateLimited(req, 'clock-request', 20, MINUTE);
  if (limited) return limited;
  const { token } = await ctx.params;
  if (!isClockToken(token)) return NextResponse.json({ code: 'not_found', message: LINK_NOT_VALID }, { status: 404 });
  const db = adminDb();
  const { data: emp } = await db.from('employees').select('id, business_id, active').eq('token', token).maybeSingle();
  if (!emp) return NextResponse.json({ code: 'not_found', message: LINK_NOT_VALID }, { status: 404 });
  if (!(await businessOpen((emp as any).business_id))) return NextResponse.json(UNAVAILABLE, { status: 403 });
  if (!(emp as any).active) return NextResponse.json({ code: 'inactive', message: 'העובד/ת לא פעיל/ה. פנו למנהל/ת.' }, { status: 403 });
  const v = clockRequestInput(await req.json().catch(() => null));
  if (!v.ok) return NextResponse.json({ code: 'bad_input', message: v.error }, { status: 400 });
  const r = v.input;
  const { error } = r.type === 'request'
    ? await db.rpc('att_request_create', { p_id: r.id, p_employee: (emp as any).id, p_kind: r.kind, p_entry: r.entryId, p_in: r.clockIn, p_out: r.clockOut, p_note: r.note })
    : await db.rpc('att_absence_add', { p_id: r.id, p_employee: (emp as any).id, p_kind: r.kind, p_from: r.from, p_to: r.to, p_minutes: r.minutes, p_note: r.note, p_file: '' });
  if (error) {
    const m = error.message ?? '';
    const message = /month is closed/.test(m) ? 'החודש כבר נסגר. פנו למנהל/ת.' : /already waiting/.test(m) ? 'כבר נשלחה בקשה על המשמרת הזו.'
      : /future/.test(m) ? 'אי אפשר לבקש על שעות שעוד לא היו.' : /not open/.test(m) ? 'המשמרת כבר נסגרה.' : 'הבקשה לא נשלחה. נסו שוב.';
    if (!/month is closed|already waiting|future|not open/.test(m)) console.error('[clock request]', m);
    return NextResponse.json({ code: 'refused', message }, { status: /function|does not exist/.test(m) ? 503 : 409 });
  }
  return NextResponse.json({ ok: true, id: r.id });
}
