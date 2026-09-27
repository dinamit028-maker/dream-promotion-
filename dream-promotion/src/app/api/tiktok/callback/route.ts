import { NextResponse } from 'next/server';
import { readState } from '@/lib/server/secrets';
import { exchangeCode, saveAccount } from '@/lib/server/tiktok';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** TikTok sends the user back here after consent; tokens are stored encrypted, then back to the app. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => NextResponse.redirect(new URL(`/integrations?${q}`, url.origin));
  const err = url.searchParams.get('error');
  if (err) return back(`tiktok=error&reason=${encodeURIComponent(url.searchParams.get('error_description') || err)}`);
  const state = readState<{ u: string; p: string }>(url.searchParams.get('state'));
  const code = url.searchParams.get('code');
  if (!state || state.p !== 'tiktok' || !code) return back('tiktok=error&reason=expired');
  try {
    await saveAccount(state.u, await exchangeCode(req, code));
    return back('tiktok=connected');
  } catch (e: any) {
    return back(`tiktok=error&reason=${encodeURIComponent(String(e?.message ?? e).slice(0, 160))}`);
  }
}
