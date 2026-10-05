import { NextResponse } from 'next/server';
import { userFromRequest } from '@/lib/server/admin';
import { isSuperAdmin } from '@/lib/server/business';
import { oauthCookie, oauthOnce, signState } from '@/lib/server/secrets';
import { META_OAUTH_COOKIE, metaAuthorizeUrl, metaConfigured } from '@/lib/server/meta';

export const runtime = 'nodejs';

/**
 * Starts the ONE Meta connection (multi-business, stage 3): only the super admin connects, from the
 * admin screen, with every permission in a single request. Pages are then assigned to businesses.
 */
export async function POST(req: Request) {
  if (!metaConfigured()) return NextResponse.json({ code: 'not_configured', message: 'META_APP_ID / META_APP_SECRET / META_CONFIG_FULL missing' }, { status: 503 });
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session', message: 'sign in required' }, { status: 401 });
  if (!(await isSuperAdmin(userId))) return NextResponse.json({ code: 'forbidden', message: 'החיבור ל-Meta מנוהל במסך הניהול' }, { status: 403 });
  try {
    // finished only in this browser (2.52.1): the one-time value is in the state and in this browser's cookie
    const once = oauthOnce();
    const res = NextResponse.json({ url: metaAuthorizeUrl(req, signState({ u: userId, p: 'meta', m: 'full', c: once })) });
    res.headers.append('Set-Cookie', oauthCookie(META_OAUTH_COOKIE, '/api/meta/callback', once));
    return res;
  } catch {
    return NextResponse.json({ code: 'not_configured', message: 'META_CONFIG_FULL missing' }, { status: 503 });
  }
}
