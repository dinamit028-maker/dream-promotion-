import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { backupCron } from '@/lib/server/backup';
import { keepUnsavedOriginals } from '@/lib/server/doc-share';
import { replayPending } from '@/lib/server/books';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * 2.119 — the monthly / yearly backups (the accountant's answer 20; lib/server/backup.ts). Vercel Cron, once a day (vercel.json):
 * what is due (the month that ended; in January also the year) is backed up business by business until 45 seconds are used — the
 * rest the next day (the same period returns the same run). Then the copies past their retention go. Protected by CRON_SECRET
 * (Vercel sends "Authorization: Bearer"; Supabase's pg_cron, if ever used, "x-cron-secret"), as the other timers.
 * First (up to 10 seconds): the originals whose PDF was not kept (delivery_originals_unsaved — the save after the answer failed)
 * are rendered again with "מקור" and kept (keepUnsavedOriginals, the accountant's answer 6 נוסף).
 * Then (2.121, up to 8 seconds): the books' sources that did not post are posted again (replayPending → gl_replay_pending, migration
 * 7100) — before the backup, so the night's copy has them; a database without it — skipped.
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
    const start = Date.now(), db = adminDb();
    const originals = await keepUnsavedOriginals(db, start + 10_000).catch(() => ({ ready: false, kept: 0, failed: 0, left: 0 }));
    const books = await replayPending(db, Date.now() + 8_000).catch(() => ({ ready: false, posted: 0, failed: 0, left: null, calls: 0 }));
    // the originals that could not be kept go into the same alert (counts only)
    const r = await backupCron(db, Date.now(), start + 45_000, { originalsFailed: originals.failed });
    return NextResponse.json({ ...r, originals, books }, { status: r.ready ? 200 : 503 });
  } catch (e: any) {
    console.error('[cron/backup]', e?.name ?? 'error');
    return NextResponse.json({ code: 'error' }, { status: 500 });
  }
}
