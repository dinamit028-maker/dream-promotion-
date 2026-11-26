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
 * The timer (/api/cron/backup, daily) backs up what is due: backup_due(today) — every (kind, period, business) with no "ok" copy,
 * oldest first, so a missed month is caught up, not only the last one (a database without it: the month that ended — and in January
 * the year — for every business, by the day in Israel). One file per business and period: backups/<business>/<kind>/<period>/<run>
 * .json.gz — every table of backup_tables(), page by page (keyset — backup_export_after), as JSON, gzipped; its
 * sha256, size and row counts go to backup_run_finish. Never a secret (the database's list leaves out terminal keys, tokens,
 * members and logins; a document's / quote's share token only as its sha256), and nothing of the content in the logs or the alerts — only codes and counts.
 *
 * One business never stops the others: each gets its share of the time (the first of the day — a different one every day — a larger
 * share), a business out of its share stops there (its run stays "running"; the same period returns the same run the next day) and
 * the next business goes on. The clock is checked again before the gzip and the upload. A file above the bucket's limit is not
 * uploaded (the run fails "too_large" and the super admin is told — splitting one business's file needs the database, see STATUS).
 *
 * The super admin is told (a phone notification, and an email to ADMIN_EMAILS when the mail service is set up — no new secret) when a
 * run failed, a business's file could not be made in its whole share of time or was too large, or something due is older than 7 days.
 *
 * The delivered PDFs (bucket delivered-documents) are NOT copied into the backup: their rows (document_delivery_files — the path and
 * the sha256 of each file) are, and the files themselves are never replaced or removed (storage_objects_keep). The accountant's
 * answer "20 נוסף": a backup of attached files is not required.
 */
export type BackupKind = 'monthly' | 'yearly';
export interface DuePeriod { kind: BackupKind; period: string }
export interface DueItem extends DuePeriod { business: string }

/** what is due on this moment's day in Israel: the month that ended, and in January also the year that ended (the fallback) */
export function periodsDue(at: Date | number): DuePeriod[] {
  const [y, m] = israelParts(at).date.split('-').map(Number);
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const due: DuePeriod[] = [{ kind: 'monthly', period: `${prev.y}-${String(prev.m).padStart(2, '0')}` }];
  if (m === 1) due.push({ kind: 'yearly', period: String(y - 1) });
  return due;
}
/** the first day after a period (as backup_period_end) */
export function periodEnd(p: DuePeriod): string {
  if (p.kind === 'yearly') return `${Number(p.period) + 1}-01-01`;
  const [y, m] = p.period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
/** whole days from a period's end to today (Israel) — "older than 7 days" alerts */
export const daysLate = (p: DuePeriod, today: string) => Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${periodEnd(p)}T12:00:00Z`)) / 864e5);

/** the businesses in the order of today: rotated by the day, so a different one starts (and gets the larger share) every day */
export function rotate<T>(list: T[], today: string): T[] {
  if (!list.length) return list;
  const k = Math.floor(Date.parse(`${today}T12:00:00Z`) / 864e5) % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}

export const BACKUP_BUCKET = 'backups';
export const BACKUP_FORMAT = 'dream-promotion-backup/1';
/**
 * the largest file uploaded: the bucket allows 500 MB (6900), but the project's global upload limit is 50 MB on Supabase's default
 * settings — so 45 MB unless BACKUP_MAX_BYTES says otherwise (set it after raising the project's limit). A larger file is not split:
 * a run is one object (storage_objects_keep takes only the run's object_path), so the run fails "too_large" and the super admin is told.
 */
export const maxBytes = (env: Record<string, string | undefined> = process.env) => {
  const n = Number(env.BACKUP_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 45 * 1024 * 1024;
};
/** the JSON of one business's rows, before gzip — above it the export stops (BACKUP_MAX_RAW_BYTES, else 300 MB), out of memory's way */
export const maxRawBytes = (env: Record<string, string | undefined> = process.env) => {
  const n = Number(env.BACKUP_MAX_RAW_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 300 * 1024 * 1024;
};
/** a period refused as too large is not exported again with the same limits; it is told about once a week (Sunday, in Israel) */
export const tooLargeAgain = (lastError: string, caps: { file: number; raw: number }) =>
  /^too_large:/.test(lastError) && (lastError.includes(`(max ${caps.file})`) || lastError.includes(`(max raw ${caps.raw})`));
/** a business that used this much of its share without finishing is "stuck" (told to the super admin) */
export const STUCK_MS = 20_000;
/** the export of 6900: keyset paging only (its backup_export by offset was removed before 6900 ever ran) */
export const KEYSET_FN = 'backup_export_after';

type Outcome = 'ok' | 'failed' | 'busy' | 'out_of_time' | 'too_large';
export interface BackupReport {
  ready: boolean; due: number; ok: number; skipped: number; failed: number; busy: number; outOfTime: boolean; tooLarge: number; tooLargeKnown: number; stuck: number;
  expired: number; expireErrors: number; orphansRemoved: number; lateDue: number; alerted: boolean;
}
export interface BackupAlert { failed: number; tooLarge: number; stuck: number; lateDue: number; oldestLateDays: number; originalsFailed: number }

const uuidOf = (x: unknown) => (typeof x === 'string' ? x : x && typeof x === 'object' ? String(Object.values(x as Record<string, unknown>)[0] ?? '') : '');
const errCode = (e: any) => String(e?.code ?? e?.statusCode ?? 'error').slice(0, 40);

/**
 * one page of one table (6900's backup_export_after — keyset, in the order of its primary key): p_after = the previous page's `last`
 * exactly (null for the first page). {table, count, total (first page only), more, last, rows}
 */
async function page(db: SupabaseClient, business: string, table: string, after: unknown, limit: number)
  : Promise<{ rows: unknown[]; more: boolean; last: unknown; error?: unknown }> {
  const { data, error } = await db.rpc(KEYSET_FN, { p_business: business, p_table: table, p_after: after ?? null, p_limit: limit });
  if (error || !data || !Array.isArray(data.rows)) return { rows: [], more: false, last: null, error: error ?? 'bad_page' };
  const more = Boolean(data.more) && data.rows.length > 0;
  if (more && (data.last === null || data.last === undefined)) return { rows: [], more: false, last: null, error: 'no_last_key' };
  return { rows: data.rows, more, last: data.last ?? null };
}

/** one business and period: export, gzip, upload (never replacing), finish — or fail the run (its error: a code, never data) */
export async function backupOne(db: SupabaseClient, run: { id: string; object_path: string }, p: DuePeriod, business: string, tables: string[],
  deadline: number, pageSize = 5000, clock: () => number = Date.now, o: { maxBytes?: number; maxRawBytes?: number } = {}): Promise<Outcome> {
  const out: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const rawCap = o.maxRawBytes ?? maxRawBytes(), fileCap = o.maxBytes ?? maxBytes();
  let raw = 0;   // the JSON of the rows so far, in bytes — counted page by page, so a huge business stops before it is all in memory
  const fail = async (why: string) => { await db.rpc('backup_run_fail', { p_run: run.id, p_error: why.slice(0, 500) }); return 'failed' as const; };
  for (const table of tables) {
    const rows: unknown[] = [];
    for (let after: unknown = null; ;) {
      // out of time: nothing uploaded, the run stays "running" — picked up again (6 hours later backup_run_start fails it)
      if (clock() > deadline) return 'out_of_time';
      const pg = await page(db, business, table, after, pageSize);
      if (pg.error) return fail(`export ${table}: ${errCode(pg.error)}`);
      raw += Buffer.byteLength(JSON.stringify(pg.rows));
      if (raw > rawCap) { await fail(`too_large: raw ${raw} bytes (max raw ${rawCap})`); return 'too_large'; }
      rows.push(...pg.rows);
      if (!pg.more) break;
      after = pg.last;
    }
    out[table] = rows;
    counts[table] = rows.length;
  }
  if (clock() > deadline) return 'out_of_time';   // again before the gzip and the upload (the function's own limit is near)
  const file = gzipSync(Buffer.from(JSON.stringify({ format: BACKUP_FORMAT, kind: p.kind, period: p.period, business_id: business, run_id: run.id,
    made_at: new Date(clock()).toISOString(), tables: out })));
  if (file.byteLength > fileCap) { await fail(`too_large: ${file.byteLength} bytes (max ${fileCap})`); return 'too_large'; }
  if (clock() > deadline) return 'out_of_time';
  const sha256 = createHash('sha256').update(file).digest('hex');
  const up = await db.storage.from(BACKUP_BUCKET).upload(run.object_path, file, { contentType: 'application/gzip', upsert: false });
  if (up.error) {
    // the file of this run is there already: another call is writing it, or one stopped after the upload — left alone (never
    // replaced); 6 hours later backup_run_start marks the run failed, and the next day makes a new one (backup_orphans removes it)
    if (/exists|duplicate|409/i.test(`${(up.error as any).statusCode ?? ''} ${up.error.message ?? ''}`)) return 'busy';
    return fail(`upload: ${errCode(up.error)}`);
  }
  const { error } = await db.rpc('backup_run_finish', { p_run: run.id, p_sha256: sha256, p_bytes: file.byteLength, p_counts: counts });
  if (error) return fail(`finish: ${errCode(error)}`);
  return 'ok';
}

/** what is due: backup_due (6900 — every period with no "ok" copy, oldest first); without it — the periods of today, every business */
async function dueItems(db: SupabaseClient, now: Date | number, businesses: string[]): Promise<DueItem[] & { exact?: boolean }> {
  const { data, error } = await db.rpc('backup_due', { p_today: israelParts(now).date });
  if (!error && Array.isArray(data)) {
    return Object.assign((data as any[]).map((x) => ({ kind: x.kind, period: String(x.period), business: uuidOf(x.business_id ?? x.business) }))
      .filter((x) => (x.kind === 'monthly' || x.kind === 'yearly') && x.business), { exact: true });
  }
  return periodsDue(now).flatMap((p) => businesses.map((business) => ({ ...p, business })));
}

/** the super admin(s): a phone notification and (when the mail service is set up) an email to ADMIN_EMAILS — counts only, no names */
export async function alertSuperAdmins(db: SupabaseClient, a: BackupAlert, today: string): Promise<void> {
  const parts = [a.failed ? `${a.failed} גיבויים נכשלו` : '', a.tooLarge ? `${a.tooLarge} קבצים גדולים מדי` : '', a.stuck ? `${a.stuck} עסקים לא הספיקו בזמן` : '',
    a.lateDue ? `${a.lateDue} גיבויים מאחרים (הוותיק — ${a.oldestLateDays} ימים)` : '',
    a.originalsFailed ? `${a.originalsFailed} קובצי מקור שנמסרו לא נשמרו` : ''].filter(Boolean);
  const body = `${parts.join(' · ')}. הפרטים ב-backup_runs (SQL Editor).`;
  const { pushToUser } = await import('./push');
  const { data } = await db.from('profiles').select('id').eq('is_super_admin', true);
  for (const p of (data ?? []) as { id: string }[]) await pushToUser(p.id, { title: 'גיבוי חודשי / שנתי — דורש בדיקה', body, url: '/admin', tag: `backup-${today}` }).catch(() => null);
  const to = (process.env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  const from = process.env.RESEND_FALLBACK_FROM;
  if (to.length && from) {
    const { sendEmail } = await import('./email');
    for (const t of to) await sendEmail({ from, to: t, subject: 'Dream — גיבוי חודשי / שנתי דורש בדיקה', text: body, html: `<p dir="rtl">${body}</p>`, key: `dp-backup-alert-${today}-${t}` }).catch(() => null);
  }
}

/**
 * The timer's work: the files nobody needs any more (backup_orphans — a failed / expired run's object), every business and period
 * due (each in its share of the time), then the copies past their retention — backup_expire first (the database refuses one that must
 * stay), and only then the file is removed from Storage. Then, when something needs a person, the super admin is told.
 */
export async function backupCron(db: SupabaseClient, now: Date | number = Date.now(), deadline = Date.now() + 45_000,
  o: { pageSize?: number; clock?: () => number; maxBytes?: number; maxRawBytes?: number; originalsFailed?: number;
       alert?: (a: BackupAlert, today: string) => Promise<void> } = {}): Promise<BackupReport> {
  const clock = o.clock ?? Date.now;
  const today = israelParts(now).date, sunday = israelParts(now).weekday === 0;
  const caps = { file: o.maxBytes ?? maxBytes(), raw: o.maxRawBytes ?? maxRawBytes() };
  const report: BackupReport = { ready: true, due: 0, ok: 0, skipped: 0, failed: 0, busy: 0, outOfTime: false, tooLarge: 0, tooLargeKnown: 0, stuck: 0,
    expired: 0, expireErrors: 0, orphansRemoved: 0, lateDue: 0, alerted: false };
  const [t, b] = await Promise.all([db.rpc('backup_tables'), db.rpc('backup_businesses')]);
  // before migration 20261126006900: nothing to do (and nothing to say but that)
  if (t.error || b.error || !Array.isArray(t.data)) return { ...report, ready: false };
  const tables = (t.data as unknown[]).map(String);
  const businesses = ((b.data ?? []) as unknown[]).map(uuidOf).filter(Boolean);
  const phase = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e: any) { console.error(`[cron/backup] ${name}`, e?.name ?? 'error'); } };
  let due: DueItem[] & { exact?: boolean } = [];
  const known = new Set<DueItem>();   // refused as too large before, with the same limits — not exported again

  try {
    // a failed / expired run's file that is still there (an upload that stopped half way, a removal that failed): backup_expire first
    // (idempotent — "changed: false" the second time; a failed run is refused, and its file may go anyway), then the file; a removal
    // that fails is tried again the next day (it is still listed)
    await phase('orphans', async () => {
      const orph = await db.rpc('backup_orphans');
      if (orph.error || !Array.isArray(orph.data)) return;
      for (const x of orph.data as { id?: string; status?: string; object_path?: string }[]) {
        if (!x?.object_path) continue;
        if (x.id && x.status !== 'failed') { const e = await db.rpc('backup_expire', { p_run: x.id }); if (e.error) continue; }
        const rm = await db.storage.from(BACKUP_BUCKET).remove([x.object_path]);
        if (!rm.error) report.orphansRemoved++;
      }
    });

    due = await dueItems(db, now, businesses);
    report.due = due.length;
    const byBusiness = new Map<string, DueItem[]>();
    for (const d of due) byBusiness.set(d.business, [...(byBusiness.get(d.business) ?? []), d]);
    const order = rotate([...byBusiness.keys()], today);
    for (let i = 0; i < order.length; i++) {
      const left = deadline - clock();
      if (left <= 0) { report.outOfTime = true; break; }
      // the share of time: what is left over the businesses left; the first of the day gets at least 30 s (when there is so much)
      const share = i === 0 ? Math.max(left / (order.length - i), Math.min(left, 30_000)) : left / (order.length - i);
      const began = clock(), until = Math.min(deadline, began + share);
      for (const item of byBusiness.get(order[i])!) {
        if (clock() > until) { report.outOfTime = true; break; }
        // the last run of this period refused it as too large with the same limits: not exported again (told once a week)
        const { data: last } = await db.from('backup_runs').select('status, error').eq('kind', item.kind).eq('period', item.period).eq('business_id', item.business)
          .order('started_at', { ascending: false }).limit(1).maybeSingle();
        if ((last as any)?.status === 'failed' && tooLargeAgain(String((last as any)?.error ?? ''), caps)) { report.tooLargeKnown++; known.add(item); continue; }
        const { data: run, error } = await db.rpc('backup_run_start', { p_kind: item.kind, p_period: item.period, p_business: item.business });
        if (error || !run?.id) { report.failed++; console.error('[cron/backup] start', item.kind, item.period, errCode(error)); continue; }
        if (run.status === 'ok') { report.skipped++; continue; }
        let r: Outcome;
        try { r = await backupOne(db, run, item, item.business, tables, until, o.pageSize, clock, { maxBytes: caps.file, maxRawBytes: caps.raw }); }
        catch (e: any) {
          // one business's exception (out of memory, a bad row) never stops the others: its run fails, the next one goes on
          r = 'failed';
          await db.rpc('backup_run_fail', { p_run: run.id, p_error: `exception: ${String(e?.name ?? 'error').slice(0, 60)}` }).then(() => null, () => null);
        }
        if (r === 'out_of_time') {
          report.outOfTime = true;
          if (clock() - began >= STUCK_MS) report.stuck++;   // it had a real share and still did not finish
          break;                                              // this business stops here; the next one goes on
        }
        if (r === 'ok') report.ok++;
        else if (r === 'busy') report.busy++;
        else if (r === 'too_large') { report.tooLarge++; console.error('[cron/backup] a file too large', item.kind, item.period); }
        else { report.failed++; console.error('[cron/backup] a run failed', item.kind, item.period); }
      }
    }
  } finally {
    // whatever happened above: the expiry, and the alert
    await phase('expire', async () => {
      if (clock() > deadline) return;
      const { data: list, error } = await db.rpc('backup_expirable');
      if (error || !Array.isArray(list)) return;
      for (const x of list as { id: string; object_path: string }[]) {
        if (clock() > deadline) { report.outOfTime = true; break; }
        const e = await db.rpc('backup_expire', { p_run: x.id });
        if (e.error) { report.expireErrors++; continue; }
        const rm = await db.storage.from(BACKUP_BUCKET).remove([x.object_path]);
        if (rm.error) { report.expireErrors++; console.error('[cron/backup] remove an expired copy', errCode(rm.error)); continue; }
        report.expired++;
      }
    });
    await phase('alert', async () => {
      // what is still due and older than 7 days (backup_due again — what this run did not finish); only by backup_due (the fallback
      // list holds periods that may be "ok" already); a period known to be too large is in the weekly line, not every day
      const stillDue = !due.exact ? [] : report.ok ? await dueItems(db, now, businesses) : due;
      const isKnown = (d: DueItem) => [...known].some((k) => k.kind === d.kind && k.period === d.period && k.business === d.business);
      const lateNow = stillDue.filter((d) => daysLate(d, today) > 7 && !isKnown(d));
      report.lateDue = lateNow.length;
      const tooLarge = report.tooLarge + (sunday ? report.tooLargeKnown : 0);
      const originalsFailed = o.originalsFailed ?? 0;
      if (report.failed || tooLarge || report.stuck || report.lateDue || originalsFailed) {
        const a: BackupAlert = { failed: report.failed, tooLarge, stuck: report.stuck, lateDue: report.lateDue,
          oldestLateDays: lateNow.reduce((m, d) => Math.max(m, daysLate(d, today)), 0), originalsFailed };
        await (o.alert ?? ((x, d) => alertSuperAdmins(db, x, d)))(a, today);
        report.alerted = true;
      }
    });
  }
  return report;
}
