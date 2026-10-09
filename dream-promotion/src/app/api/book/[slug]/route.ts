import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { attachToCrm, busyBetween, loadBusiness, rulesOf } from '@/lib/server/booking';
import { isFree, openDays } from '@/features/booking/slots';
import { formatIL } from '@/lib/il-time';
import { phoneDigits } from '@/features/crm/crm';
import { UNAVAILABLE } from '@/lib/server/business';
import { MINUTE, PUBLIC_LIMITS, rateLimited } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';

/**
 * Public booking page API — no login. GET: the business card (name, address, services, open days).
 * POST: book. Every booking is re-validated here (service, time inside the rules, not taken), and
 * the database's no-overlap constraint is the last word if two people book the same second.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const params = await ctx.params;   // Next 15: the route's params arrive as a promise
  const limited = rateLimited(req, 'book-read', PUBLIC_LIMITS.bookRead, MINUTE);
  if (limited) return limited;
  const b = await loadBusiness(params.slug);
  if (!b) return NextResponse.json({ code: 'not_found' }, { status: 404 });
  if (b === 'locked') return NextResponse.json(UNAVAILABLE, { status: 403 });
  const s = b.settings;
  return NextResponse.json({
    title: s.title, address: s.address, phone: s.phone, message: s.message,
    services: b.services, days: openDays(rulesOf(s)),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const params = await ctx.params;   // Next 15: the route's params arrive as a promise
  const limited = rateLimited(req, 'book-post', PUBLIC_LIMITS.bookPost, MINUTE);
  if (limited) return limited;
  const b = await loadBusiness(params.slug);
  if (!b) return NextResponse.json({ code: 'not_found', message: 'דף ההזמנות לא זמין' }, { status: 404 });
  if (b === 'locked') return NextResponse.json(UNAVAILABLE, { status: 403 });
  const body = await req.json().catch(() => ({}));
  if (body.website) return NextResponse.json({ ok: true }); // honeypot: bots fill hidden fields
  const name = String(body.name ?? '').trim().slice(0, 80);
  const phone = String(body.phone ?? '').trim().slice(0, 30);
  const email = String(body.email ?? '').trim().slice(0, 120);
  const note = String(body.note ?? '').trim().slice(0, 500);
  if (!name || phoneDigits(phone).length < 9) return NextResponse.json({ code: 'bad_input', message: 'נא למלא שם וטלפון תקין' }, { status: 400 });
  const service = b.services.find((x) => x.id === body.serviceId);
  if (!service) return NextResponse.json({ code: 'bad_input', message: 'השירות לא נמצא' }, { status: 400 });
  const start = new Date(String(body.start ?? ''));
  if (Number.isNaN(+start)) return NextResponse.json({ code: 'bad_input', message: 'זמן לא תקין' }, { status: 400 });
  const end = new Date(+start + service.minutes * 60_000);
  const s = b.settings, userId = s.user_id as string, businessId = s.business_id as string;

  const busy = await busyBetween(businessId, new Date(+start - 864e5).toISOString(), new Date(+end + 864e5).toISOString());
  if (!isFree(start.toISOString(), service.minutes, rulesOf(s), busy)) {
    return NextResponse.json({ code: 'slot_taken', message: 'השעה הזו כבר לא פנויה. בחרו שעה אחרת.' }, { status: 409 });
  }
  // a little protection: at most 3 upcoming bookings for the same phone at one business
  const { data: mine } = await adminDb().from('appointments').select('phone').eq('business_id', businessId)
    .in('status', ['booked', 'confirmed']).gt('start_at', new Date().toISOString()).limit(500);
  if ((mine ?? []).filter((r: any) => phoneDigits(r.phone) === phoneDigits(phone)).length >= 3) {
    return NextResponse.json({ code: 'too_many', message: 'יש כבר כמה תורים עתידיים למספר הזה. לשינוי — פנו לעסק.' }, { status: 429 });
  }

  const whenHe = formatIL(start, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const leadId = await attachToCrm(userId, businessId, { name, phone, email, summary: `נקבע תור אונליין: ${service.name} · ${whenHe}${note ? ` · "${note}"` : ''}` });
  const ins = await adminDb().from('appointments').insert({
    user_id: userId, business_id: businessId, service_id: service.id, service_name: service.name, lead_id: leadId ?? null,
    name, phone, email, note, start_at: start.toISOString(), end_at: end.toISOString(), status: 'booked', source: 'public',
  }).select('id').single();
  if (ins.error) {
    if (ins.error.code === '23P01') return NextResponse.json({ code: 'slot_taken', message: 'השעה הזו נתפסה הרגע. בחרו שעה אחרת.' }, { status: 409 });
    console.error('[book]', ins.error.message);
    return NextResponse.json({ code: 'error', message: 'לא הצלחנו לקבוע את התור. נסו שוב.' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, id: ins.data.id, start: start.toISOString(), end: end.toISOString(), service: service.name, whenHe, title: s.title, address: s.address });
}
