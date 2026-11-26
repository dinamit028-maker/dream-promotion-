import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { backupCron } from '@/lib/server/backup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * 2.119 — the monthly / yearly backups (the accountant's answer 20; lib/server/backup.ts). Vercel Cron, once a day (vercel.json):
 * what is due (the month that ended; in January also the year) is backed up business by business until 45 seconds are used — the
 * rest the next day (the same period returns the same run). Then the copies past their retention go. Protected by CRON_SECRET
 * (Vercel sends "Authorization: Bearer"; Supabase's pg_cron, if ever used, "x-cron-secret"), as the other timers.
 * The answer carries counts only — never a business, a table's content or a path.
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
    const r = await backupCron(adminDb(), Date.now(), Date.now() + 45_000);
    return NextResponse.json(r, { status: r.ready ? 200 : 503 });
  } catch (e: any) {
    console.error('[cron/backup]', e?.name ?? 'error');
    return NextResponse.json({ code: 'error' }, { status: 500 });
  }
}
