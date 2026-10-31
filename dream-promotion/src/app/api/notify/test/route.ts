import { NextResponse } from 'next/server';
import { userFromRequest } from '@/lib/server/admin';
import { pushConfigured, pushToUser } from '@/lib/server/push';

export const runtime = 'nodejs';
export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'unauthorized' }, { status: 401 });
  if (!pushConfigured()) return NextResponse.json({ code: 'not_configured', message: 'חסרים מפתחות התראות ב-Vercel (VAPID).' }, { status: 503 });
  // 2.112: from the calendar — what an appointment's notification looks like
  const calendar = (await req.json().catch(() => ({})))?.from === 'calendar';
  return NextResponse.json(await pushToUser(userId, calendar
    ? { title: 'תור ב-10:15 — בעוד 15 דק׳', body: '✓ ההתראות פועלות — כך תיראה התראה לפני תור.', url: '/appointments', tag: 'test' }
    : { title: 'Dream Promotion', body: '✓ ההתראות פועלות — כך תיראה התראה על עסקה.', url: '/register', tag: 'test' }));
}
