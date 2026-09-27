import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { open } from '@/lib/server/secrets';
import { revoke, tiktokConfigured } from '@/lib/server/tiktok';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The user's connected accounts — names and pictures only, never tokens. */
export async function GET(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const { data, error } = await adminDb().from('social_accounts')
    .select('id, provider, display_name, avatar_url, created_at, refresh_expires_at').eq('user_id', userId).order('created_at');
  if (error) return NextResponse.json({ code: 'db', message: error.message, configured: { tiktok: tiktokConfigured() }, accounts: [] });
  return NextResponse.json({
    configured: { tiktok: tiktokConfigured() },
    accounts: (data ?? []).map((a) => ({
      id: a.id, provider: a.provider, name: a.display_name, avatar: a.avatar_url, connectedAt: a.created_at,
      needsReconnect: a.refresh_expires_at ? new Date(a.refresh_expires_at).getTime() < Date.now() : false,
    })),
  });
}

/** Disconnect: revoke at the provider and delete the stored tokens. */
export async function DELETE(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const id = new URL(req.url).searchParams.get('id');
  const db = adminDb();
  const { data: acc } = await db.from('social_accounts').select('id, provider, access_token').eq('id', id).eq('user_id', userId).maybeSingle();
  if (!acc) return NextResponse.json({ code: 'not_found' }, { status: 404 });
  if (acc.provider === 'tiktok') { try { await revoke(open(acc.access_token)); } catch { /* still delete */ } }
  await db.from('social_accounts').delete().eq('id', acc.id);
  return NextResponse.json({ ok: true });
}
