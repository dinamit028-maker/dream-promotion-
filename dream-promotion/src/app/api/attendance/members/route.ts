import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { attendanceCaller } from '@/lib/server/attendance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The members of the business worked in now and their part in attendance (2.107) — for "מחלקות ומאשרים" (who may approve).
 * The attendance admin only; names and e-mails of the business's own members, nothing else.
 */
export async function GET(req: Request) {
  const c = await attendanceCaller(req, 'admin');
  if (!c.ok) return NextResponse.json(c.body, { status: c.status });
  const db = adminDb();
  const { data: m, error } = await db.from('business_members').select('user_id, role, access, attendance_role').eq('business_id', c.businessId);
  if (error) return NextResponse.json({ code: 'db', message: 'לא הצלחנו לטעון את המשתמשים.' }, { status: 500 });
  const ids = (m ?? []).map((r: any) => r.user_id);
  const { data: p } = ids.length ? await db.from('profiles').select('id, full_name, email').in('id', ids) : { data: [] };
  const person = new Map((p ?? []).map((r: any) => [r.id, r]));
  const members = (m ?? []).filter((r: any) => r.access !== 'register' && r.access !== 'calendar').map((r: any) => ({
    userId: r.user_id, role: r.role, attendanceRole: r.attendance_role ?? null,
    name: person.get(r.user_id)?.full_name ?? '', email: person.get(r.user_id)?.email ?? '',
  }));
  return NextResponse.json({ members }, { headers: { 'Cache-Control': 'no-store' } });
}
