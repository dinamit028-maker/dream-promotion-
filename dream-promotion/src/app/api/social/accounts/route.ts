import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { businessOf, isSuperAdmin } from '@/lib/server/business';
import { open } from '@/lib/server/secrets';
import { revoke, tiktokConfigured } from '@/lib/server/tiktok';
import { metaConfigured } from '@/lib/server/meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The current business's connected accounts — names, pictures and status only, never tokens. */
export async function GET(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const [biz, superAdmin] = await Promise.all([businessOf(userId), isSuperAdmin(userId)]);
  const configured = { tiktok: tiktokConfigured(), meta: metaConfigured() };
  if (!biz) return NextResponse.json({ configured, superAdmin, accounts: [] });
  const { data, error } = await adminDb().from('social_accounts')
    .select('id, provider, display_name, avatar_url, created_at, refresh_expires_at, scope, status').eq('business_id', biz).order('created_at');
  if (error) return NextResponse.json({ code: 'db', message: error.message, configured, superAdmin, accounts: [] });
  return NextResponse.json({
    configured, superAdmin,
    accounts: (data ?? []).map((a) => ({
      id: a.id, provider: a.provider, name: a.display_name, avatar: a.avatar_url, connectedAt: a.created_at,
      needsReconnect: a.refresh_expires_at ? new Date(a.refresh_expires_at).getTime() < Date.now() : false,
      readOnly: a.provider !== 'tiktok' && a.scope === 'read',
      missing: a.status === 'missing',
    })),
  });
}

/**
 * Disconnect a TikTok account: revoke at TikTok and delete its stored tokens.
 * Facebook / Instagram are never deleted here — they come from the one Meta connection on the admin screen.
 */
export async function DELETE(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return NextResponse.json({ code: 'no_session' }, { status: 401 });
  const id = new URL(req.url).searchParams.get('id');
  const db = adminDb();
  const biz = await businessOf(userId);
  const { data: acc } = await db.from('social_accounts').select('id, provider, access_token').eq('id', id).eq('business_id', biz ?? '00000000-0000-0000-0000-000000000000').maybeSingle();
  if (!acc) return NextResponse.json({ code: 'not_found' }, { status: 404 });
  if (acc.provider !== 'tiktok') return NextResponse.json({ code: 'managed_by_admin', message: 'עמודי פייסבוק ואינסטגרם מנוהלים במסך הניהול' }, { status: 400 });
  try { await revoke(open(acc.access_token)); } catch { /* still delete */ }
  await db.from('social_accounts').delete().eq('id', acc.id);
  return NextResponse.json({ ok: true });
}
