import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { importStories, metaAccount } from '@/lib/server/meta';
import { businessOpen } from '@/lib/server/business';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Saves every connected account's live stories into the media library.
 * Runs every 10 minutes from Supabase (pg_cron → supabase/cron-stories.sql) and once a day from
 * Vercel Cron as a safety net. Both send CRON_SECRET: Vercel as "Authorization: Bearer", Supabase as "x-cron-secret".
 */
function allowed(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}` || req.headers.get('x-cron-secret') === secret;
}
export async function POST(req: Request) { return GET(req); }
export async function GET(req: Request) {
  if (!allowed(req)) return NextResponse.json({ code: 'forbidden' }, { status: 403 });
  // assigned, still-approved accounts only (an unassigned or 'missing' one has no business to save into)
  const { data } = await adminDb().from('social_accounts').select('id, user_id, business_id').eq('provider', 'instagram').eq('status', 'active').not('business_id', 'is', null);
  let added = 0, errors = 0, skipped = 0;
  const open = new Map<string, boolean>(); // a locked business is not served (stage 5)
  for (const a of data ?? []) {
    if (!open.has(a.business_id)) open.set(a.business_id, await businessOpen(a.business_id));
    if (!open.get(a.business_id)) { skipped++; continue; }
    try { added += (await importStories(a.user_id, await metaAccount(a.user_id, a.id))).added.length; }
    catch { errors++; }
  }
  return NextResponse.json({ accounts: data?.length ?? 0, added, errors, skipped });
}
