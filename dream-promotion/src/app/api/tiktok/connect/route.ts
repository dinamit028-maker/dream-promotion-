import { NextResponse } from 'next/server';
import { userFromRequest } from '@/lib/server/admin';
import { signState } from '@/lib/server/secrets';
import { authorizeUrl, tiktokConfigured } from '@/lib/server/tiktok';

export const runtime = 'nodejs';

/** Starts "connect TikTok": returns the TikTok consent URL for this signed-in user. */
export async function POST(req: Request) {
  if (!tiktokConfigured()) return NextResponse.json({ code: 'not_configured', message: 'TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET missing' }, { status: 503 });
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session', message: 'sign in required' }, { status: 401 });
  return NextResponse.json({ url: authorizeUrl(req, signState({ u: userId, p: 'tiktok' })) });
}
