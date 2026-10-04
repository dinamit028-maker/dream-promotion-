import { NextResponse } from 'next/server';
import { adminDb, userFromRequest } from '@/lib/server/admin';
import { blockedFor, workBusiness } from '@/lib/server/business';
import { syncInbox } from '@/lib/server/meta-inbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Customers → settings → "תגובות והודעות", for the business being worked in.
 *  GET   → its Facebook Pages and Instagram accounts with the switch, last sync and last error
 *  PATCH { accountId, enabled } → turn reading on / off for one account of this business
 *  POST  → "סנכרון עכשיו" for this business
 * Tokens never leave the server.
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
  const { data: accs } = await db.from('social_accounts').select('id, provider, display_name, avatar_url, status, inbox_enabled')
    .eq('business_id', c.biz).in('provider', ['facebook', 'instagram']).order('provider').order('display_name');
  const list = (accs ?? []) as { id: string; provider: string; display_name: string | null; avatar_url: string | null; status: string; inbox_enabled: boolean }[];
  const { data: sync } = await db.from('meta_inbox_sync').select('social_account_id, last_synced_at, last_error')
    .in('social_account_id', list.length ? list.map((a) => a.id) : ['00000000-0000-0000-0000-000000000000']);
  const st = new Map(((sync ?? []) as any[]).map((s) => [s.social_account_id, s]));
  return NextResponse.json({
    accounts: list.map((a) => ({
      id: a.id, provider: a.provider, name: a.display_name ?? '', avatar: a.avatar_url, connected: a.status === 'active', enabled: Boolean(a.inbox_enabled),
      lastSyncedAt: st.get(a.id)?.last_synced_at ?? null, lastError: st.get(a.id)?.last_error || '',
    })),
  });
}

export async function PATCH(req: Request) {
  const c = await context(req);
  if ('res' in c) return c.res;
  const body = await req.json().catch(() => ({}));
  const { data, error } = await adminDb().from('social_accounts').update({ inbox_enabled: Boolean(body.enabled), updated_at: new Date().toISOString() })
    .eq('id', String(body.accountId ?? '')).eq('business_id', c.biz).in('provider', ['facebook', 'instagram']).select('id').maybeSingle();
  if (error) return NextResponse.json({ code: 'db', message: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ code: 'not_found', message: 'החשבון לא שייך לעסק הזה' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request) {
  const c = await context(req);
  if ('res' in c) return c.res;
  const { results, ...summary } = await syncInbox({ deadline: Date.now() + 45_000, businessId: c.biz });
  return NextResponse.json({ ...summary, results: results.map(({ account, stored, contacts, error }) => ({ account, stored, contacts, error })) });
}
