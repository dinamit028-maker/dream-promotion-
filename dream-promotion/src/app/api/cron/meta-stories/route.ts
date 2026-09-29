import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { importStories, metaAccount } from '@/lib/server/meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Daily safety net (Vercel Cron): saves every connected account's live stories before they expire. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ code: 'forbidden' }, { status: 403 });
  const { data } = await adminDb().from('social_accounts').select('id, user_id').eq('provider', 'instagram');
  let added = 0, errors = 0;
  for (const a of data ?? []) {
    try { added += (await importStories(a.user_id, await metaAccount(a.user_id, a.id))).added.length; }
    catch { errors++; }
  }
  return NextResponse.json({ accounts: data?.length ?? 0, added, errors });
}
