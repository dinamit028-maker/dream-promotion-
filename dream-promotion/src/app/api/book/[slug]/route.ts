import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { attachToCrm, bookingLocation, busyBetween, depositsOpen, loadBusiness, rulesOf } from '@/lib/server/booking';
import { appOrigin, sendPaylink } from '@/lib/server/paylinks';
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
 * A service with a deposit (migration 4300), at a business that takes payment links now: the booking's answer carries the
 * deposit's link (the customer's /pay page; also by email when one was given). The deposit is the service's, never the
 * browser's; a link that could not be made leaves the booking as it is (the owner can send one from the appointment).
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const params = await ctx.params;   // Next 15: the route's params arrive as a promise
  const limited = rateLimited(req, 'book-read', PUBLIC_LIMITS.bookRead, MINUTE);
  if (limited) return limited;
  const b = await loadBusiness(params.slug);
  if (!b) return NextResponse.json({ code: 'not_found' }, { status: 404 });
  if (b === 'locked') return NextResponse.json(UNAVAILABLE, { status: 403 });
  const s = b.settings;
  const deposits = b.services.some((x) => (x.deposit ?? 0) > 0) && await depositsOpen(s.business_id);
  return NextResponse.json({
    title: s.title, address: s.address, phone: s.phone, message: s.message,
    services: b.services.map((x) => ({ id: x.id, name: x.name, minutes: x.minutes, price: x.price, deposit: deposits && (x.deposit ?? 0) > 0 ? x.deposit : null })),
    days: openDays(rulesOf(s)),
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

  // several locations (2.91): the page books at the main one — its free hours, and the appointment goes there
  const where = await bookingLocation(businessId);
  const busy = await busyBetween(businessId, new Date(+start - 864e5).toISOString(), new Date(+end + 864e5).toISOString(), where);
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
    ...(where ? { location_id: where } : {}),
  }).select('id').single();
  if (ins.error) {
    if (ins.error.code === '23P01') return NextResponse.json({ code: 'slot_taken', message: 'השעה הזו נתפסה הרגע. בחרו שעה אחרת.' }, { status: 409 });
    console.error('[book]', ins.error.message);
    return NextResponse.json({ code: 'error', message: 'לא הצלחנו לקבוע את התור. נסו שוב.' }, { status: 500 });
  }
  let deposit: { amount: number; url: string } | null = null;
  if ((service.deposit ?? 0) > 0 && await depositsOpen(businessId)) {
    const days = Math.min(7, Math.max(1, Math.ceil((+start - Date.now()) / 864e5)));
    const r = await sendPaylink({ businessId, userId: null }, { kind: 'deposit', target: ins.data.id, amount: Number(service.deposit), days, via: email ? 'email' : 'link' }, appOrigin(req))
      .catch((e) => { console.error('[book] deposit', e?.message ?? e); return null; });
    if (r?.ok) deposit = { amount: Number(r.link.amount), url: r.url };
  }
  return NextResponse.json({ ok: true, id: ins.data.id, start: start.toISOString(), end: end.toISOString(), service: service.name, whenHe, title: s.title, address: s.address, deposit });
}
