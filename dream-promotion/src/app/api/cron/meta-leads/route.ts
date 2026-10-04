import { NextResponse } from 'next/server';
import { syncLeads } from '@/lib/server/meta-leads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Timer: leads from Meta Lead Ads forms into the CRM, every 10 minutes (Supabase pg_cron →
 * supabase/cron-meta-leads.sql). Only Pages switched on, in an open business (a locked one is skipped).
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
    const { results, ...summary } = await syncLeads({ deadline: Date.now() + 45_000 });
    return NextResponse.json({ ...summary, errorsByPage: results.filter((r) => r.error).map((r) => ({ page: r.page, error: r.error })) });
  } catch (e: any) {
    console.error('[cron/meta-leads]', e?.message ?? e);
    return NextResponse.json({ code: 'error', message: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
