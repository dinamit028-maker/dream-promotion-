import { NextResponse } from 'next/server';
import { publishDue } from '@/lib/server/scheduler';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Timer: publishes scheduled posts that are due. Called every 5 minutes by Supabase pg_cron (supabase/cron-publish.sql). */
function allowed(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}` || req.headers.get('x-cron-secret') === secret;
}
export async function POST(req: Request) { return GET(req); }
export async function GET(req: Request) {
  if (!allowed(req)) return NextResponse.json({ code: 'forbidden' }, { status: 403 });
  try {
    return NextResponse.json(await publishDue({ deadline: Date.now() + 45_000 }));
  } catch (e: any) {
    console.error('[cron/publish-due]', e?.message ?? e);
    return NextResponse.json({ code: 'error', message: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
