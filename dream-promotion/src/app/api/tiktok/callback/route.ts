import { NextResponse } from 'next/server';
import { oauthCookie, readState, sameBrowser } from '@/lib/server/secrets';
import { canUseBusiness, memberAccess } from '@/lib/server/business';
import { TIKTOK_OAUTH_COOKIE, exchangeCode, saveAccount } from '@/lib/server/tiktok';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * TikTok sends the user back here after consent. The state must match this browser's one-time cookie (connect/route.ts),
 * the user must still be able to work in that business with full access, and the account is saved to that business only
 * (never moved from another business). Tokens are stored encrypted, then back to the app; the cookie is cleared.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => {
    const r = NextResponse.redirect(new URL(`/integrations?${q}`, url.origin));
    r.headers.append('Set-Cookie', oauthCookie(TIKTOK_OAUTH_COOKIE, '/api/tiktok/callback', ''));
    return r;
  };
  const err = url.searchParams.get('error');
  if (err) return back(`tiktok=error&reason=${encodeURIComponent(url.searchParams.get('error_description') || err)}`);
  const state = readState<{ u: string; b?: string; p: string; c?: string }>(url.searchParams.get('state'));
  const code = url.searchParams.get('code');
  if (!state || state.p !== 'tiktok' || !code || !state.b) return back('tiktok=error&reason=expired');
  if (!sameBrowser(req, TIKTOK_OAUTH_COOKIE, state.c)) return back('tiktok=error&reason=denied');
  if (!(await canUseBusiness(state.u, state.b)) || (await memberAccess(state.u, state.b)) !== 'full') return back('tiktok=error&reason=denied');
  try {
    await saveAccount(state.u, state.b, await exchangeCode(req, code));
    return back('tiktok=connected');
  } catch (e: any) {
    const m = String(e?.message ?? e);
    return back(`tiktok=error&reason=${/other_business/.test(m) ? 'other_business' : encodeURIComponent(m.slice(0, 160))}`);
  }
}
