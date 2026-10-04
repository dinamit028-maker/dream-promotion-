import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { UNAVAILABLE, businessOpen } from '@/lib/server/business';

export const runtime = 'nodejs';
/** A customer's link to their document: /d/<token>. The token is random (64 hex), set when the document was issued. */
export async function GET(_req: Request, { params }: { params: { token: string } }) {
  if (!/^[a-f0-9]{64}$/.test(params.token)) return NextResponse.json({ code: 'not_found' }, { status: 404 });
  const db = adminDb();
  const { data: d } = await db.from('documents').select('*').eq('share_token', params.token).maybeSingle();
  if (!d) return NextResponse.json({ code: 'not_found' }, { status: 404 });
  if (!(await businessOpen((d as any).business_id))) return NextResponse.json(UNAVAILABLE, { status: 403 });
  const [{ data: s }, { data: b }] = await Promise.all([
    db.from('register_settings').select('dealer_number, legal_name, street, house_no, city, zip').eq('user_id', d.user_id).maybeSingle(),
    db.from('brands').select('name').eq('user_id', d.user_id).maybeSingle(),
  ]);
  const { user_id: _u, business_id: _b, lead_id: _l, sale_id: _s, share_token: _t, ...doc } = d as any;
  return NextResponse.json({
    doc, business: { dealerNumber: s?.dealer_number ?? '', name: s?.legal_name || (b as any)?.name || '', street: s?.street ?? '', houseNo: s?.house_no ?? '', city: s?.city ?? '', zip: s?.zip ?? '' },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
