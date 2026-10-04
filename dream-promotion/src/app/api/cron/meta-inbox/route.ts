import { NextResponse } from 'next/server';
import { syncInbox } from '@/lib/server/meta-inbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Timer: comments and messages from Meta into the leads board, every 10 minutes (Supabase pg_cron →
 * supabase/cron-meta-inbox.sql). Only accounts switched on, in an open business (a locked one is skipped).
 */
function allowed(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}` || req.headers.get('x-cron-secret') === secret;
}
export async function POST(req: Request) { return GET(req); }
export async function GET(req: Request) {
  if (!allowed(req)) return NextResponse.json({ code: 'forbidden' }, { status: 403 });
  try {
    const { results, ...summary } = await syncInbox({ deadline: Date.now() + 45_000 });
    return NextResponse.json({ ...summary, errorsByPage: results.filter((r) => r.error).map((r) => ({ account: r.account, error: r.error })) });
  } catch (e: any) {
    console.error('[cron/meta-inbox]', e?.message ?? e);
    return NextResponse.json({ code: 'error', message: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
