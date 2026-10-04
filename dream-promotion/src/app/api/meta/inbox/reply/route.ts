import { NextResponse } from 'next/server';
import { userFromRequest } from '@/lib/server/admin';
import { LOCKED, userLocked, workBusiness } from '@/lib/server/business';
import { sendReply } from '@/lib/server/meta-inbox';

export const runtime = 'nodejs';

/** POST { leadId, text } → answers the contact on Messenger / under their comment, from the card. */
export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  if (await userLocked(userId)) return NextResponse.json(LOCKED, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const r = await sendReply(await workBusiness(userId), userId, String(body.leadId ?? ''), String(body.text ?? ''));
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ code: 'reply_failed', message: r.message }, { status: r.status });
}
