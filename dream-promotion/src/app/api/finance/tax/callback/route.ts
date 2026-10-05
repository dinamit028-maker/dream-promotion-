import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { adminDb } from '@/lib/server/admin';
import { canUseBusiness, memberAccess } from '@/lib/server/business';
import { readState } from '@/lib/server/secrets';
import { TAX_OAUTH_COOKIE, connectBusiness } from '@/lib/server/tax/oauth';

export const runtime = 'nodejs';
/**
 * The Tax Authority sends the user back here with a code. The signed state says which business and which user started
 * the connection, and must match the one-time cookie this browser got when it started (connect/route.ts) — a link
 * finished in another browser stores nothing. The member is checked again (still a full-access member of an accessible
 * business) before the token is stored — on that business only.
 */
function sameBrowser(req: Request, want: unknown): boolean {
  const got = new RegExp(`(?:^|;\\s*)${TAX_OAUTH_COOKIE}=([A-Za-z0-9_-]+)`).exec(req.headers.get('cookie') ?? '')?.[1];
  if (!got || typeof want !== 'string' || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const back = (q: string) => {
    const r = NextResponse.redirect(new URL(`/finance?tab=settings&tax=${q}`, u.origin));
    r.headers.append('Set-Cookie', `${TAX_OAUTH_COOKIE}=; Path=/api/finance/tax/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    return r;
  };
  const st = readState<{ b: string; u: string; p: string; c?: string }>(u.searchParams.get('state'));
  const code = u.searchParams.get('code');
  if (!st || st.p !== 'tax' || !code) return back('failed');
  if (!sameBrowser(req, st.c)) return back('denied');
  const { data: m } = await adminDb().from('business_members').select('user_id').eq('business_id', st.b).eq('user_id', st.u).maybeSingle();
  if (!m || !(await canUseBusiness(st.u, st.b)) || (await memberAccess(st.u, st.b)) !== 'full') return back('denied');
  const r = await connectBusiness(st.b, st.u, code);
  return back(r.ok ? 'connected' : 'failed');
}
