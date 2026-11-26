import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { SupabaseClient } from '@supabase/supabase-js';
import { israelParts } from '@/lib/il-time';

/**
 * 2.119 — the monthly and yearly backups (the accountant's answer 20 of 25.11.2026, docs/ita-registration/CPA_ANSWERS_HE.md: daily,
 * then monthly, then yearly — 7 years; the owner's decision of 26.11.2026: a private Supabase Storage bucket). Daily copies are
 * Supabase's own. Migration 20261126006900 keeps the record and the rules (backup_runs — running → ok / failed, ok → expired only
 * after its keep_until: 12 months for a monthly copy, 7 years for a yearly one, and a monthly copy never before a later yearly one).
 *
 * The timer (/api/cron/backup, daily) backs up what is due by the day in Israel (Asia/Jerusalem — on the 1st at 01:00 it is
 * still the 30th in UTC): the month that ended, and in January the year that ended. A day that missed it (a failure, out of time)
 * is made up the next day — the same period and business returns the same run (backup_run_start), an "ok" one is skipped.
 * One file per business and period: backups/<business>/<kind>/<period>/<run>.json.gz — every table of backup_tables(), page by page
 * (backup_export), as JSON, gzipped; its sha256, size and row counts go to backup_run_finish. Never a secret (the database's list
 * leaves out terminal keys, tokens, members and logins), and nothing of the content in the logs — only codes and counts.
 *
 * The delivered PDFs (bucket delivered-documents) are NOT copied into the backup: their rows (document_delivery_files — the path and
 * the sha256 of each file) are, and the files themselves are never replaced or removed (storage_objects_keep). The accountant's
 * answer "20 נוסף": a backup of attached files is not required.
 */
export type BackupKind = 'monthly' | 'yearly';
export interface DuePeriod { kind: BackupKind; period: string }

/** what is due on this moment's day in Israel: the month that ended, and in January also the year that ended */
export function periodsDue(at: Date | number): DuePeriod[] {
  const [y, m] = israelParts(at).date.split('-').map(Number);
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const due: DuePeriod[] = [{ kind: 'monthly', period: `${prev.y}-${String(prev.m).padStart(2, '0')}` }];
  if (m === 1) due.push({ kind: 'yearly', period: String(y - 1) });
  return due;
}

export const BACKUP_BUCKET = 'backups';
export const BACKUP_FORMAT = 'dream-promotion-backup/1';
type Outcome = 'ok' | 'skipped' | 'failed' | 'busy' | 'out_of_time';
export interface BackupReport {
  ready: boolean; due: DuePeriod[]; ok: number; skipped: number; failed: number; busy: number; outOfTime: boolean;
  expired: number; expireErrors: number;
}

const uuidOf = (x: unknown) => (typeof x === 'string' ? x : x && typeof x === 'object' ? String(Object.values(x as Record<string, unknown>)[0] ?? '') : '');
const errCode = (e: any) => String(e?.code ?? e?.statusCode ?? 'error').slice(0, 40);

/** one business and period: export, gzip, upload (never replacing), finish — or fail the run (its error: a code, never data) */
export async function backupOne(db: SupabaseClient, run: { id: string; object_path: string }, p: DuePeriod, business: string, tables: string[],
  deadline: number, pageSize = 5000, clock: () => number = Date.now): Promise<Outcome> {
  const out: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const fail = async (why: string) => { await db.rpc('backup_run_fail', { p_run: run.id, p_error: why.slice(0, 500) }); return 'failed' as const; };
  for (const table of tables) {
    const rows: unknown[] = [];
    for (let offset = 0; ;) {
      // out of time: nothing uploaded, the run stays "running" — the next day picks it up again (6 hours later backup_run_start fails it)
      if (clock() > deadline) return 'out_of_time';
      const { data, error } = await db.rpc('backup_export', { p_business: business, p_table: table, p_offset: offset, p_limit: pageSize });
      if (error || !data || !Array.isArray(data.rows)) return fail(`export ${table}: ${errCode(error)}`);
      rows.push(...data.rows);
      if (!data.more || !data.count) break;
      offset += Number(data.count);
    }
    out[table] = rows;
    counts[table] = rows.length;
  }
  const file = gzipSync(Buffer.from(JSON.stringify({ format: BACKUP_FORMAT, kind: p.kind, period: p.period, business_id: business, run_id: run.id,
    made_at: new Date(clock()).toISOString(), tables: out })));
  const sha256 = createHash('sha256').update(file).digest('hex');
  const up = await db.storage.from(BACKUP_BUCKET).upload(run.object_path, file, { contentType: 'application/gzip', upsert: false });
  if (up.error) {
    // the file of this run is there already: another call is writing it, or one stopped after the upload — left alone (never
    // replaced); 6 hours later backup_run_start marks the run failed and the next day makes a new one
    if (/exists|duplicate|409/i.test(`${(up.error as any).statusCode ?? ''} ${up.error.message ?? ''}`)) return 'busy';
    return fail(`upload: ${errCode(up.error)}`);
  }
  const { error } = await db.rpc('backup_run_finish', { p_run: run.id, p_sha256: sha256, p_bytes: file.byteLength, p_counts: counts });
  if (error) return fail(`finish: ${errCode(error)}`);
  return 'ok';
}

/**
 * The timer's work: every business, every period due (until the deadline), then the copies past their retention — backup_expire
 * first (the database refuses one that must stay), and only then the file is removed from Storage.
 */
export async function backupCron(db: SupabaseClient, now: Date | number = Date.now(), deadline = Date.now() + 45_000,
  o: { pageSize?: number; clock?: () => number } = {}): Promise<BackupReport> {
  const clock = o.clock ?? Date.now;
  const due = periodsDue(now);
  const report: BackupReport = { ready: true, due, ok: 0, skipped: 0, failed: 0, busy: 0, outOfTime: false, expired: 0, expireErrors: 0 };
  const [t, b] = await Promise.all([db.rpc('backup_tables'), db.rpc('backup_businesses')]);
  // before migration 20261126006900: nothing to do (and nothing to say but that)
  if (t.error || b.error || !Array.isArray(t.data)) return { ...report, ready: false };
  const tables = (t.data as unknown[]).map(String);
  const businesses = ((b.data ?? []) as unknown[]).map(uuidOf).filter(Boolean);
  outer: for (const p of due) {
    for (const business of businesses) {
      if (clock() > deadline) { report.outOfTime = true; break outer; }
      const { data: run, error } = await db.rpc('backup_run_start', { p_kind: p.kind, p_period: p.period, p_business: business });
      if (error || !run?.id) { report.failed++; console.error('[cron/backup] start', p.kind, p.period, errCode(error)); continue; }
      if (run.status === 'ok') { report.skipped++; continue; }
      const r = await backupOne(db, run, p, business, tables, deadline, o.pageSize, clock);
      if (r === 'out_of_time') { report.outOfTime = true; break outer; }
      if (r === 'ok') report.ok++; else if (r === 'busy') report.busy++; else { report.failed++; console.error('[cron/backup] a run failed', p.kind, p.period); }
    }
  }
  if (clock() <= deadline) {
    const { data: list, error } = await db.rpc('backup_expirable');
    if (!error && Array.isArray(list)) {
      for (const x of list as { id: string; object_path: string }[]) {
        if (clock() > deadline) { report.outOfTime = true; break; }
        const e = await db.rpc('backup_expire', { p_run: x.id });
        if (e.error) { report.expireErrors++; continue; }
        const rm = await db.storage.from(BACKUP_BUCKET).remove([x.object_path]);
        if (rm.error) { report.expireErrors++; console.error('[cron/backup] remove an expired copy', errCode(rm.error)); continue; }
        report.expired++;
      }
    }
  }
  return report;
}
