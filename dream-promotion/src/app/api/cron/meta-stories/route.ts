import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { importStories, metaAccount } from '@/lib/server/meta';

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
  const { data } = await adminDb().from('social_accounts').select('id, user_id').eq('provider', 'instagram');
  let added = 0, errors = 0;
  for (const a of data ?? []) {
    try { added += (await importStories(a.user_id, await metaAccount(a.user_id, a.id))).added.length; }
    catch { errors++; }
  }
  return NextResponse.json({ accounts: data?.length ?? 0, added, errors });
}
