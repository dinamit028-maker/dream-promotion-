import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { UNAVAILABLE, businessManagers, businessOpen } from '@/lib/server/business';
import { pushConfigured, pushToUser } from '@/lib/server/push';
import { computeLines } from '@/features/finance/compose';
import { toQuote } from '@/features/finance/quotes';
import { israelParts } from '@/lib/il-time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A customer's link to a quote: /q/<token> (64 random hex, set by the database). The customer can read it and answer it —
 * accept or decline, with their name — once, while it is "sent" and still valid. Nothing internal leaves the server
 * (no user, business, lead or token ids). A locked business answers "השירות אינו זמין".
 */
async function find(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const { data } = await adminDb().from('quotes').select('*').eq('share_token', token).maybeSingle();
  return data as any;
}
function publicView(r: any) {
  const q = toQuote(r);
  const lines = computeLines(q.body.lines ?? [], { pricesIncludeVat: q.body.pricesIncludeVat ?? true, discount: q.body.discount, rate: q.vatRate }).lines;
  const today = israelParts(Date.now()).date;
  return {
    number: q.number, status: q.status === 'sent' && q.validUntil && q.validUntil < today ? 'expired' : q.status, customerName: q.customerName, customerDealer: q.customerDealer,
    lines: lines.map((l) => ({ name: l.name, qty: l.qty, unitPriceExVat: l.unitPriceExVat, totalExVat: l.totalExVat })),
    beforeDiscount: q.beforeDiscount, discount: q.discount, afterDiscount: q.afterDiscount, vatRate: q.vatRate, vatAmount: q.vatAmount, total: q.total,
    validUntil: q.validUntil, notes: q.notes, createdAt: q.createdAt, decidedAt: q.decidedAt, decisionBy: q.decisionBy,
    issuer: q.issuer ? { name: q.issuer.name, tradingName: q.issuer.tradingName, dealerNumber: q.issuer.dealerNumber, entityType: q.issuer.entityType,
      phone: q.issuer.phone, email: q.issuer.email, street: q.issuer.street, houseNo: q.issuer.houseNo, city: q.issuer.city } : null,
  };
}

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const r = await find(params.token);
  if (!r) return NextResponse.json({ code: 'not_found' }, { status: 404 });
  if (!(await businessOpen(r.business_id))) return NextResponse.json(UNAVAILABLE, { status: 403 });
  return NextResponse.json({ quote: publicView(r) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request, { params }: { params: { token: string } }) {
  const r = await find(params.token);
  if (!r) return NextResponse.json({ code: 'not_found' }, { status: 404 });
  if (!(await businessOpen(r.business_id))) return NextResponse.json(UNAVAILABLE, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const decision = body?.decision === 'accept' ? 'accepted' : body?.decision === 'reject' ? 'rejected' : null;
  const name = String(body?.name ?? '').trim().slice(0, 80);
  if (!decision || name.length < 2) return NextResponse.json({ code: 'bad_request', message: 'צריך לבחור ולכתוב שם.' }, { status: 400 });
  const today = israelParts(Date.now()).date;
  if (r.status !== 'sent') return NextResponse.json({ code: 'decided', message: 'כבר התקבלה תשובה להצעה הזו.' }, { status: 409 });
  if (r.valid_until && r.valid_until < today) return NextResponse.json({ code: 'expired', message: 'תוקף ההצעה פג. אפשר לפנות לעסק להצעה מעודכנת.' }, { status: 409 });
  // only while it is still "sent" — two answers at once: the second one changes nothing
  const { data, error } = await adminDb().from('quotes').update({ status: decision, decision_by: name, decision_note: String(body?.note ?? '').trim().slice(0, 500) })
    .eq('id', r.id).eq('status', 'sent').select('*').maybeSingle();
  if (error || !data) return NextResponse.json({ code: 'decided', message: 'כבר התקבלה תשובה להצעה הזו.' }, { status: 409 });
  if (pushConfigured()) {
    for (const u of await businessManagers(r.business_id)) {
      void pushToUser(u, { title: decision === 'accepted' ? `✓ הצעת מחיר ${r.quote_number} אושרה` : `הצעת מחיר ${r.quote_number} נדחתה`, body: `${name} · ₪${Number(r.total).toLocaleString('he-IL')}`, url: '/finance/quotes', tag: `quote-${r.id}` });
    }
  }
  return NextResponse.json({ quote: publicView(data) });
}
