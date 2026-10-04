import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { blockedFor, workBusiness } from '@/lib/server/business';
import { syncLeads } from '@/lib/server/meta-leads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Customers → settings → "ייבוא לידים מ-Meta", for the business being worked in.
 *  GET   → its Facebook Pages with the switch, last sync, last error, and whether the Meta connection
 *          was approved with the leads permission
 *  PATCH { accountId, enabled } → turn importing on / off for one Page of this business
 *  POST  → "סנכרון עכשיו" for this business's switched-on Pages
 * Tokens never leave the server: only named columns are read.
 */
async function context(req: Request) {
  const userId = await userFromRequest(req);
  if (!userId) return { res: NextResponse.json({ code: 'no_session' }, { status: 401 }) };
  const blocked = await blockedFor(userId);
  if (blocked) return { res: NextResponse.json(blocked, { status: 403 }) };
  return { userId, biz: await workBusiness(userId) };
}

export async function GET(req: Request) {
  const c = await context(req);
  if ('res' in c) return c.res;
  const db = adminDb();
  const { data: pages } = await db.from('social_accounts').select('id, display_name, avatar_url, status, leads_enabled, connection_id')
    .eq('business_id', c.biz).eq('provider', 'facebook').order('display_name');
  const list = (pages ?? []) as { id: string; display_name: string | null; avatar_url: string | null; status: string; leads_enabled: boolean; connection_id: string | null }[];
  const ids = list.map((p) => p.id);
  const conns = [...new Set(list.map((p) => p.connection_id).filter(Boolean))] as string[];
  const NONE = ['00000000-0000-0000-0000-000000000000'];
  const [{ data: sync }, { data: cs }] = await Promise.all([
    db.from('meta_lead_sync').select('social_account_id, last_synced_at, last_error, imported_total').in('social_account_id', ids.length ? ids : NONE),
    db.from('meta_connections').select('id, scopes').in('id', conns.length ? conns : NONE),
  ]);
  const st = new Map(((sync ?? []) as any[]).map((s) => [s.social_account_id, s]));
  const scopes = new Map(((cs ?? []) as any[]).map((x) => [x.id, (x.scopes ?? []) as string[]]));
  return NextResponse.json({
    pages: list.map((p) => ({
      id: p.id, name: p.display_name ?? '', avatar: p.avatar_url, connected: p.status === 'active', enabled: Boolean(p.leads_enabled),
      // null = unknown (connected before scopes were recorded)
      leadsPermission: p.connection_id && scopes.has(p.connection_id) ? scopes.get(p.connection_id)!.includes('leads_retrieval') : null,
      lastSyncedAt: st.get(p.id)?.last_synced_at ?? null, lastError: st.get(p.id)?.last_error || '', importedTotal: st.get(p.id)?.imported_total ?? 0,
    })),
  });
}

export async function PATCH(req: Request) {
  const c = await context(req);
  if ('res' in c) return c.res;
  const body = await req.json().catch(() => ({}));
  const { data, error } = await adminDb().from('social_accounts').update({ leads_enabled: Boolean(body.enabled), updated_at: new Date().toISOString() })
    .eq('id', String(body.accountId ?? '')).eq('business_id', c.biz).eq('provider', 'facebook').select('id').maybeSingle();
  if (error) return NextResponse.json({ code: 'db', message: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ code: 'not_found', message: 'העמוד לא שייך לעסק הזה' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request) {
  const c = await context(req);
  if ('res' in c) return c.res;
  const { results, ...summary } = await syncLeads({ deadline: Date.now() + 45_000, businessId: c.biz });
  return NextResponse.json({ ...summary, results: results.map(({ page, imported, noted, error }) => ({ page, imported, noted, error })) });
}
