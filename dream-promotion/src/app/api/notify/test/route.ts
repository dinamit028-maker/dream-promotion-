import { NextResponse } from 'next/server';
import { userFromRequest } from '@/lib/server/admin';
import { pushConfigured, pushToUser } from '@/lib/server/push';

export const runtime = 'nodejs';
export async function POST(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'unauthorized' }, { status: 401 });
  if (!pushConfigured()) return NextResponse.json({ code: 'not_configured', message: 'חסרים מפתחות התראות ב-Vercel (VAPID).' }, { status: 503 });
  return NextResponse.json(await pushToUser(userId, { title: 'Dream Promotion', body: '✓ ההתראות פועלות — כך תיראה התראה על עסקה.', url: '/register', tag: 'test' }));
}
