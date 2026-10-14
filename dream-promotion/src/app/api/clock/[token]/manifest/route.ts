import { NextResponse } from 'next/server';
import { clockManifest, isClockToken } from '@/features/timeclock/clock-app';

/**
 * The home-screen manifest of one employee's clock (clockManifest) — the clock page links here instead of Dream's
 * /manifest.webmanifest, whose start_url (/dashboard) opened Dream's sign-in from the icon. No database read: the
 * file only repeats the address the phone already has; the page itself checks the token.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;   // Next 15+: the route's params arrive as a promise
  if (!isClockToken(token)) return NextResponse.json({ code: 'not_found' }, { status: 404 });
  return new NextResponse(JSON.stringify(clockManifest(token)), {
    headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
