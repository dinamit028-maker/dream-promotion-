import { NextResponse } from 'next/server';

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Gate for every paid call (AI, images, video, voice, transcription).
 * Passes when EITHER the request carries a valid signed-in user session
 * OR the APP_ACCESS_CODE header matches (when one is set).
 * With accounts configured (Supabase), a session or the code is ALWAYS required — before,
 * leaving APP_ACCESS_CODE empty left these endpoints open to anyone on the internet, spending
 * the owner's AI credit. Only a local copy without Supabase and without a code stays open.
 */
export async function accessDenied(req: Request) {
  const code = process.env.APP_ACCESS_CODE;
  if (code && req.headers.get('x-access-code') === code) return null;
  if (!code && !(SB_URL && SB_ANON)) return null; // local demo: no accounts, no code

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
