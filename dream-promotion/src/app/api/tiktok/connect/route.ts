import { NextResponse } from 'next/server';
import { userFromRequest } from '@/lib/server/admin';
import { blockedFor, businessOf } from '@/lib/server/business';
import { oauthCookie, oauthOnce, signState } from '@/lib/server/secrets';
import { TIKTOK_OAUTH_COOKIE, authorizeUrl, tiktokConfigured } from '@/lib/server/tiktok';

export const runtime = 'nodejs';

/**
 * Starts "connect TikTok" for the business worked in now. The signed state names the user and the business, and a
 * one-time value that is also put in a cookie of this browser (2.52.1): the callback saves the account only when both
 * match — a consent link finished in another browser connects nothing. A locked business or a cashier can't connect.
 */
export async function POST(req: Request) {
  if (!tiktokConfigured()) return NextResponse.json({ code: 'not_configured', message: 'TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET missing' }, { status: 503 });
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session', message: 'צריך להתחבר.' }, { status: 401 });
  const blocked = await blockedFor(userId);
  if (blocked) return NextResponse.json(blocked, { status: 403 });
  const biz = await businessOf(userId);
  if (!biz) return NextResponse.json({ code: 'no_business', message: 'החשבון עוד לא משויך לעסק.' }, { status: 403 });
  const once = oauthOnce();
  const res = NextResponse.json({ url: authorizeUrl(req, signState({ u: userId, b: biz, p: 'tiktok', c: once })) });
  res.headers.append('Set-Cookie', oauthCookie(TIKTOK_OAUTH_COOKIE, '/api/tiktok/callback', once));
  return res;
}
