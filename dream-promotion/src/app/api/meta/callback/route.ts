import { NextResponse } from 'next/server';
import { readState } from '@/lib/server/secrets';
import { isSuperAdmin } from '@/lib/server/business';
import { exchangeCode, saveMetaConnection } from '@/lib/server/meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Facebook returns here after consent: the connection and every page / Instagram account are synced, then back to the admin screen. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => NextResponse.redirect(new URL(`/admin?tab=connections&${q}`, url.origin));
  const err = url.searchParams.get('error');
  if (err) return back(`meta=error&reason=${encodeURIComponent(url.searchParams.get('error_reason') || err)}`);
  const state = readState<{ u: string; p: string; m: string }>(url.searchParams.get('state'));
  const code = url.searchParams.get('code');
  if (!state || state.p !== 'meta' || !code) return back('meta=error&reason=expired');
  if (!(await isSuperAdmin(state.u))) return back('meta=error&reason=admin_only');
  try {
    const r = await saveMetaConnection(state.u, await exchangeCode(req, code));
    if (!r.assets) return back('meta=error&reason=no_pages');
    return back(`meta=connected&added=${r.added}&missing=${encodeURIComponent(r.missing.join('|'))}`);
  } catch (e: any) {
    return back(`meta=error&reason=${encodeURIComponent(String(e?.message ?? e).slice(0, 160))}`);
  }
}
