import { NextResponse } from 'next/server';
import { userFromRequest } from '@/lib/server/admin';
import { blockedFor, workBusiness } from '@/lib/server/business';
import { sendReply } from '@/lib/server/meta-inbox';
import { calendarLeads } from '@/lib/server/client-file';

export const runtime = 'nodejs';

/** POST { leadId, text } → answers the contact on Messenger / under their comment, from the card. */
export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  // 2.111: a calendar member ("יומן ולידים") answers the contacts too — the card is theirs (31.10.2026)
  const blocked = await blockedFor(userId);
  if (blocked && blocked.code !== 'calendar_only' && blocked.code !== 'agenda_only') return NextResponse.json(blocked, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const business = await workBusiness(userId);
  const leadId = String(body.leadId ?? '');
  // 2.115: "יומן בלבד" — only a client who is in the calendar
  if (blocked?.code === 'agenda_only' && !(await calendarLeads(business, [leadId])).has(leadId)) {
    return NextResponse.json({ code: 'not_in_calendar', message: 'הכרטיס נפתח רק ללקוחות שיש להם תור ביומן.' }, { status: 403 });
  }
  const r = await sendReply(business, userId, leadId, String(body.text ?? ''));
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ code: 'reply_failed', message: r.message }, { status: r.status });
}
