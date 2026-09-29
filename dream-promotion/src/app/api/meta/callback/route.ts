import { NextResponse } from 'next/server';
import { readState } from '@/lib/server/secrets';
import { exchangeCode, saveMetaAccounts, type MetaMode } from '@/lib/server/meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Facebook returns here after consent: Page + Instagram tokens are stored encrypted, then back to the app. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => NextResponse.redirect(new URL(`/integrations?${q}`, url.origin));
  const err = url.searchParams.get('error');
  if (err) return back(`meta=error&reason=${encodeURIComponent(url.searchParams.get('error_reason') || err)}`);
  const state = readState<{ u: string; p: string; m: MetaMode }>(url.searchParams.get('state'));
  const code = url.searchParams.get('code');
  if (!state || state.p !== 'meta' || !code) return back('meta=error&reason=expired');
  try {
    const n = await saveMetaAccounts(state.u, await exchangeCode(req, code), state.m === 'read' ? 'read' : 'full');
    return back(n ? `meta=connected&mode=${state.m}` : 'meta=error&reason=no_pages');
  } catch (e: any) {
    return back(`meta=error&reason=${encodeURIComponent(String(e?.message ?? e).slice(0, 160))}`);
  }
}
