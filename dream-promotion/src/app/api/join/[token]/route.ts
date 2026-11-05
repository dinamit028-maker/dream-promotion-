import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { businessOpen } from '@/lib/server/business';
import { MINUTE, PUBLIC_LIMITS, rateLimited } from '@/lib/server/rate-limit';
import { readInvite, takeInvite, type InviteRow } from '@/lib/server/invites';
import { homeOf, isInviteToken } from '@/features/admin/invite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The invited person's link: /join/<token> (2.114, migration 6500). No sign-in; only the sha-256 of the token is in the database.
 *   GET   what the page shows: the business's name and the email of the sign-in — nothing is used (WhatsApp's preview reads it too)
 *   POST  the tap: a one-time sign-in for that person (generateLink — a hashed token the page turns into a session with
 *         verifyOtp), and the link is used — once (a conditional update; the sign-in is made first, so a failure leaves the link
 *         as it was). The page then asks them to choose their own password.
 */
const gone = (code: string, status = 410) => NextResponse.json({ code }, { status, headers: { 'cache-control': 'no-store' } });

type Loaded = { db: ReturnType<typeof adminDb>; row: InviteRow; email: string; business: string; access: string };
async function load(token: string): Promise<{ error: Response } | Loaded> {
  const db = adminDb();
  const { row, state } = await readInvite(db, token);
  if (!row || state !== 'ok') return { error: gone(state === 'ok' ? 'not_found' : state, state === 'not_found' ? 404 : 410) };
  if (!(await businessOpen(row.business_id))) return { error: gone('closed') };
  // still a member — a person removed after the link was sent is not let in by it
  const { data: m } = await db.from('business_members').select('access').eq('business_id', row.business_id).eq('user_id', row.user_id).maybeSingle();
  if (!m) return { error: gone('revoked') };
  const [{ data: biz }, { data: who }] = await Promise.all([
    db.from('businesses').select('name').eq('id', row.business_id).maybeSingle(),
    db.auth.admin.getUserById(row.user_id),
  ]);
  const email = who?.user?.email ?? '';
  if (!email) return { error: gone('not_found', 404) };
  return { db, row, email, business: (biz as { name?: string } | null)?.name ?? '', access: String((m as { access?: string }).access ?? row.access) };
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const limited = rateLimited(req, 'join-read', PUBLIC_LIMITS.joinRead, MINUTE);
  if (limited) return limited;
  const { token } = await ctx.params;
  if (!isInviteToken(token)) return gone('not_found', 404);
  const got = await load(token);
  if ('error' in got) return got.error;
  return NextResponse.json({ business: got.business, email: got.email, expiresAt: got.row.expires_at }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const limited = rateLimited(req, 'join-use', PUBLIC_LIMITS.joinUse, MINUTE);
  if (limited) return limited;
  const { token } = await ctx.params;
  if (!isInviteToken(token)) return gone('not_found', 404);
  const got = await load(token);
  if ('error' in got) return got.error;
  const { db, row, email } = got;
  const { data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email });
  const hashed = data?.properties?.hashed_token;
  if (error || !hashed) return NextResponse.json({ code: 'failed', message: 'לא הצלחנו להכניס אותך. נסו שוב בעוד רגע.' }, { status: 502 });
  if (!(await takeInvite(db, row.id))) return gone('used');
  // they work in this business from now on
  await db.from('profiles').update({ current_business_id: row.business_id }).eq('id', row.user_id);
  return NextResponse.json({ tokenHash: hashed, email, home: homeOf(got.access) }, { headers: { 'cache-control': 'no-store' } });
}
