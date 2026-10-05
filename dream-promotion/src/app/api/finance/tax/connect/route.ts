import { randomBytes } from 'node:crypto';
import { financeCaller } from '@/lib/server/finance';
import { signState } from '@/lib/server/secrets';
import { TAX_OAUTH_COOKIE, authorizeUrl, oauthConfig } from '@/lib/server/tax/oauth';

export const runtime = 'nodejs';
/**
 * Start connecting the business worked in now to the Tax Authority (OAuth 2.0). Only a full-access member of that
 * business — not a super admin from outside it. The signed state names the business and the user (15 minutes), and a
 * one-time value that is also put in a cookie of this browser: the callback stores a token only when both match, so a
 * link that was started here and finished by someone else (with their Tax Authority login) connects nothing.
 */
export async function POST(req: Request) {
  const c = await financeCaller(req, { write: true });
  if (!c.ok) return Response.json(c.body, { status: c.status });
  if (!c.member) return Response.json({ code: 'members_only', message: 'רק חבר/ה בעסק מחבר/ת אותו לרשות המסים.' }, { status: 403 });
  const cfg = oauthConfig();
  if (!cfg) return Response.json({ code: 'not_configured', message: 'החיבור לרשות המסים לא הוגדר בשרת (משתני ITA_*).' }, { status: 400 });
  const once = randomBytes(18).toString('base64url');
  const res = Response.json({ url: authorizeUrl(cfg, signState({ b: c.businessId, u: c.userId, p: 'tax', c: once })) });
  res.headers.append('Set-Cookie', `${TAX_OAUTH_COOKIE}=${once}; Path=/api/finance/tax/callback; Max-Age=900; HttpOnly; Secure; SameSite=Lax`);
  return res;
}
