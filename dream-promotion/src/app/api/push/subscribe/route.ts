import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { LOCKED, userLocked } from '@/lib/server/business';

export const runtime = 'nodejs';

/**
 * POST { endpoint, keys: { p256dh, auth }, label } — this device gets the person's notifications (2.112). Through the server,
 * so a calendar member ("יומן ולידים") — whose browser reads no table of the business but the calendar's — turns them on too.
 * The row is always the caller's own (user_id from the session); an endpoint another account had moves to this one.
 */
export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session', message: 'צריך להתחבר מחדש.' }, { status: 401 });
  if (await userLocked(userId)) return NextResponse.json(LOCKED, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const endpoint = String(body?.endpoint ?? '');
  const keys = body?.keys ?? {};
  if (!/^https:\/\/\S{10,2000}$/.test(endpoint) || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string'
      || keys.p256dh.length > 200 || keys.auth.length > 100) {
    return NextResponse.json({ code: 'bad_request', message: 'פרטי ההתראות של המכשיר לא תקינים.' }, { status: 400 });
  }
  const label = String(body?.label ?? '').slice(0, 40);
  const { error } = await adminDb().from('push_subscriptions')
    .upsert({ user_id: userId, endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, label }, { onConflict: 'endpoint' });
  if (error) return NextResponse.json({ code: 'db', message: 'לא נשמר. נסו שוב.' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
