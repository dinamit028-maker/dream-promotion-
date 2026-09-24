import { NextResponse } from 'next/server';

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Gate for every paid call (AI, images, video, voice).
 * Passes when EITHER the request carries a valid signed-in user session
 * (works in any browser, incognito included — no code to type)
 * OR the legacy APP_ACCESS_CODE header matches. With no APP_ACCESS_CODE set, the gate is open.
 */
export async function accessDenied(req: Request) {
  const code = process.env.APP_ACCESS_CODE;
  if (!code) return null;
  if (req.headers.get('x-access-code') === code) return null;

  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ') && SB_URL && SB_ANON) {
    try {
      const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { Authorization: auth, apikey: SB_ANON }, cache: 'no-store' });
      if (r.ok) return null;
    } catch { /* fall through to 401 */ }
  }
  return NextResponse.json(
    { code: 'access_denied', message: 'Not signed in and no valid access code' },
    { status: 401 },
  );
}
