import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { requireAdmin } from '@/lib/server/admin-auth';
import { isSuperAdmin } from '@/lib/server/business';
import { metaConfigured } from '@/lib/server/meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The one Meta connection and every social asset, for the super admin (admin screen → "חיבורים").
 *  GET   → connections (no tokens), assets with their business and status, the businesses to assign to
 *  PATCH { accountId, businessId | null } → assign an asset to a business (or un-assign it)
 * Tokens never leave the server: only named columns are selected.
 */
async function superAdminOnly(req: Request) {
  const r = await requireAdmin(req);
  if ('denied' in r) return { denied: r.denied };
  if (!(await isSuperAdmin(r.admin.id))) return { denied: NextResponse.json({ code: 'forbidden', message: 'super admin only' }, { status: 403 }) };
  return { userId: r.admin.id };
}

export async function GET(req: Request) {
  const a = await superAdminOnly(req);
  if ('denied' in a) return a.denied;
  const db = adminDb();
  const [conns, assets, biz] = await Promise.all([
    db.from('meta_connections').select('id, fb_user_id, fb_user_name, scopes, expires_at, last_synced_at, created_at').order('created_at'),
    db.from('social_accounts').select('id, provider, external_id, display_name, avatar_url, business_id, status, connection_id, missing_since, updated_at').order('provider').order('display_name'),
    db.from('businesses').select('id, name, slug, status').order('name'),
  ]);
  return NextResponse.json({
    configured: metaConfigured(),
    connections: (conns.data ?? []).map((c) => ({ id: c.id, fbUserId: c.fb_user_id, fbUserName: c.fb_user_name, scopes: c.scopes, expiresAt: c.expires_at, lastSyncedAt: c.last_synced_at })),
    assets: (assets.data ?? []).map((s) => ({
      id: s.id, provider: s.provider, externalId: s.external_id, name: s.display_name, avatar: s.avatar_url,
      businessId: s.business_id, status: s.status, connectionId: s.connection_id, missingSince: s.missing_since,
    })),
    businesses: (biz.data ?? []).map((b) => ({ id: b.id, name: b.name, slug: b.slug, status: b.status })),
  });
}

export async function PATCH(req: Request) {
  const a = await superAdminOnly(req);
  if ('denied' in a) return a.denied;
  const body = await req.json().catch(() => ({}));
  const accountId = String(body.accountId ?? '');
  const businessId = body.businessId ? String(body.businessId) : null;
  const db = adminDb();
  if (businessId) {
    const { data: b } = await db.from('businesses').select('id').eq('id', businessId).maybeSingle();
    if (!b) return NextResponse.json({ code: 'not_found', message: 'no such business' }, { status: 404 });
  }
  const { data, error } = await db.from('social_accounts').update({ business_id: businessId, updated_at: new Date().toISOString() })
    .eq('id', accountId).select('id').maybeSingle();
  if (error) return NextResponse.json({ code: 'db', message: error.message }, { status: 400 });
  if (!data) return NextResponse.json({ code: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
