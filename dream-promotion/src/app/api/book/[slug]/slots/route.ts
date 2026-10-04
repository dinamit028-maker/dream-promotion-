import { NextResponse } from 'next/server';
import { busyBetween, loadBusiness, rulesOf } from '@/lib/server/booking';
import { freeSlots } from '@/features/booking/slots';
import { israelToIso } from '@/lib/il-time';
import { UNAVAILABLE } from '@/lib/server/business';

export const runtime = 'nodejs';

/** Free times for one service on one day (Israel time). GET ?service=<id>&date=YYYY-MM-DD */
export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const b = await loadBusiness(params.slug);
  if (!b) return NextResponse.json({ code: 'not_found' }, { status: 404 });
  if (b === 'locked') return NextResponse.json(UNAVAILABLE, { status: 403 });
  const url = new URL(req.url);
  const service = b.services.find((x) => x.id === url.searchParams.get('service'));
  const date = String(url.searchParams.get('date') ?? '');
  if (!service || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ code: 'bad_input' }, { status: 400 });
  const from = israelToIso(date, '00:00'), to = new Date(new Date(from).getTime() + 864e5).toISOString();
  const busy = await busyBetween(b.settings.business_id, from, to);
  const slots = freeSlots(date, service.minutes, rulesOf(b.settings), busy).map((s) => ({ time: s.time, start: s.start }));
  return NextResponse.json({ slots }, { headers: { 'Cache-Control': 'no-store' } });
}
