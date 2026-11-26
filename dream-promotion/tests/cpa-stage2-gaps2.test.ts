/**
 * QA round 2 of 2.119.0: the backup timer over several days, with the rules of the database in the fake (backup_run_start fails a run
 * that is 6 hours old; a Storage object is never replaced; backup_orphans lists the files of failed / expired runs):
 *   - a run that timed out on one day is finished on the next, and the period has exactly ONE file at the end
 *   - an upload that succeeded and a "finish" that did not: the next day removes that file, makes a new run — still exactly one file
 *   - two timers at the same moment: one file, one "ok" run, nothing replaced
 * Demo data only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fakeDb } from './fakedb';
import { backupCron } from '../src/lib/server/backup';

const B = 'b1000000-0000-4000-8000-000000000693';
type Run = { id: string; kind: string; period: string; business: string; status: string; started: number; object_path: string; error?: string };

function world(o: { failFinishOnce?: boolean } = {}) {
  const runs: Run[] = [];
  const files = new Map<string, Uint8Array>();
  const uploads: { key: string; ok: boolean }[] = [];
  let wall = Date.parse('2026-12-01T06:00:00Z');   // the database's now(), moved by the test
  let failFinish = Boolean(o.failFinishOnce);
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `${B}-${i}`, business_id: B }));
  const rpc: Record<string, (a: any) => any> = {
    backup_tables: () => ['documents'],
    backup_businesses: () => [B],
    backup_due: () => (runs.some((r) => r.kind === 'monthly' && r.period === '2026-11' && ['ok', 'expired'].includes(r.status)) ? []
      : [{ kind: 'monthly', period: '2026-11', business_id: B, running: runs.some((r) => r.status === 'running') }]),
    backup_orphans: () => runs.filter((r) => ['failed', 'expired'].includes(r.status) && files.has(`backups/${r.object_path}`)).map((r) => ({ id: r.id, status: r.status, object_path: r.object_path })),
    backup_run_start: (a: any) => {
      for (const r of runs) if (r.status === 'running' && r.started < wall - 6 * 3600e3 && r.kind === a.p_kind && r.period === a.p_period) { r.status = 'failed'; r.error = 'timeout: no answer within 6 hours'; }
      const live = runs.find((r) => r.kind === a.p_kind && r.period === a.p_period && r.business === a.p_business && ['running', 'ok'].includes(r.status));
      if (live) return { id: live.id, object_path: live.object_path, status: live.status, created: false };
      const id = randomUUID(); const n: Run = { id, kind: a.p_kind, period: a.p_period, business: a.p_business, status: 'running', started: wall, object_path: `${a.p_business}/${a.p_kind}/${a.p_period}/${id}.json.gz` };
      runs.push(n); return { id, object_path: n.object_path, status: 'running', created: true };
    },
    backup_export_after: (a: any) => {
      const from = a.p_after ? rows.findIndex((r) => r.id === a.p_after.id) + 1 : 0;
      const page = rows.slice(from, from + a.p_limit);
      return { table: a.p_table, count: page.length, total: a.p_after ? null : rows.length, more: from + page.length < rows.length, last: page.length ? { id: page[page.length - 1].id } : null, rows: page };
    },
    backup_run_finish: (a: any) => {
      const r = runs.find((x) => x.id === a.p_run)!;
      if (failFinish) { failFinish = false; throw new Error('finish: the connection dropped'); }
      if (r.status !== 'running') throw new Error(`backup_run_not_running: ${r.status}`);
      if (!files.has(`backups/${r.object_path}`)) throw new Error('backup_file_missing');
      r.status = 'ok'; return { id: r.id, status: 'ok' };
    },
    backup_run_fail: (a: any) => { const r = runs.find((x) => x.id === a.p_run)!; if (r.status === 'running') { r.status = 'failed'; r.error = a.p_error; } return { id: r.id, status: r.status }; },
    backup_expirable: () => [],
    backup_expire: (a: any) => ({ id: a.p_run, changed: false }),
  };
  // the fake's rpc turns a thrown error into { error } the way PostgREST answers
  const db: any = fakeDb({ backup_runs: runs }, { rpc });
  const inner = db.rpc; db.rpc = async (fn: string, args: any) => { try { return await inner(fn, args); } catch (e: any) { return { data: null, error: { code: 'P0001', message: String(e.message) } }; } };
  db.storage = { from: (bucket: string) => ({
    upload: async (key: string, body: Uint8Array, opt: { upsert?: boolean }) => {
      assert.equal(opt.upsert, false, 'a backup is never replaced');
      const k = `${bucket}/${key}`;
      if (files.has(k)) { uploads.push({ key: k, ok: false }); return { data: null, error: { statusCode: '409', message: 'The resource already exists' } }; }
      files.set(k, new Uint8Array(body)); uploads.push({ key: k, ok: true }); return { data: { path: key }, error: null };
    },
    remove: async (keys: string[]) => { for (const k of keys) files.delete(`${bucket}/${k}`); return { data: keys.map((name) => ({ name })), error: null }; },
  }) };
  return { db, runs, files, uploads, at: (iso: string) => { wall = Date.parse(iso); return new Date(iso); } };
}
const okFiles = (w: ReturnType<typeof world>) => [...w.files.keys()].filter((k) => k.startsWith('backups/'));

test('a run that timed out on one day is finished the next — one file for the period, no leftovers, nothing replaced', async () => {
  const w = world();
  // day 1 (1.12, 08:00 Israel): the deadline passes while the first business is being exported → nothing uploaded, the run stays "running"
  let t = 0;
  const day1 = await backupCron(w.db, w.at('2026-12-01T06:00:00Z'), 1, { pageSize: 1, clock: () => (t++ > 3 ? 10 : 0) });
  assert.equal(day1.outOfTime, true); assert.equal(day1.ok, 0);
  assert.equal(w.runs.length, 1); assert.equal(w.runs[0].status, 'running'); assert.equal(okFiles(w).length, 0, 'nothing uploaded on the day it timed out');
  // the same day, an hour later: the same run (not yet 6 hours old) — it is not started a second time
  t = 0;
  const later = await backupCron(w.db, w.at('2026-12-01T07:00:00Z'), 1, { pageSize: 1, clock: () => (t++ > 3 ? 10 : 0) });
  assert.equal(later.ok, 0); assert.equal(w.runs.length, 1, 'the same run again');
  // day 2: the old run is 24 hours old → failed by the database; a new run is made and finished
  const day2 = await backupCron(w.db, w.at('2026-12-02T06:00:00Z'), 1e15, { pageSize: 2, clock: () => 0 });
  assert.equal(day2.ok, 1);
  assert.deepEqual(w.runs.map((r) => r.status), ['failed', 'ok']);
  assert.equal(w.runs[0].error, 'timeout: no answer within 6 hours');
  assert.deepEqual(okFiles(w), [`backups/${w.runs[1].object_path}`], 'exactly one file: the new run\'s');
  assert.equal(w.files.has(`backups/${w.runs[0].object_path}`), false, 'none for the run that timed out');
  assert.equal(w.uploads.length, 1, 'one upload in all');
  const j = JSON.parse(gunzipSync(w.files.get(`backups/${w.runs[1].object_path}`)!).toString());
  assert.equal(j.tables.documents.length, 5, 'all the rows, once each (pages of 2: 2 + 2 + 1)');
  assert.deepEqual(j.tables.documents.map((d: any) => d.id), Array.from({ length: 5 }, (_, i) => `${B}-${i}`));
  // day 3 and again on day 2: nothing is done twice
  for (const d of ['2026-12-02T09:00:00Z', '2026-12-03T06:00:00Z']) { const r = await backupCron(w.db, w.at(d), 1e15, { clock: () => 0 }); assert.equal(r.ok, 0); assert.equal(r.due, 0); }
  assert.equal(w.uploads.length, 1); assert.equal(okFiles(w).length, 1);
});

test('an upload that went through and a finish that did not: the next day removes that file, makes a new run — still one file', async () => {
  const w = world({ failFinishOnce: true });
  const day1 = await backupCron(w.db, w.at('2026-12-01T06:00:00Z'), 1e15, { clock: () => 0 });
  assert.equal(day1.failed, 1); assert.equal(day1.ok, 0);
  assert.equal(w.runs[0].status, 'failed'); assert.match(w.runs[0].error ?? '', /^finish: /);
  assert.equal(okFiles(w).length, 1, 'the file of the failed run is still there (storage_objects_keep lets only a failed / expired run\'s file go)');
  const day2 = await backupCron(w.db, w.at('2026-12-02T06:00:00Z'), 1e15, { clock: () => 0 });
  assert.equal(day2.orphansRemoved, 1); assert.equal(day2.ok, 1);
  assert.deepEqual(w.runs.map((r) => r.status), ['failed', 'ok']);
  assert.deepEqual(okFiles(w), [`backups/${w.runs[1].object_path}`], 'exactly one file for the period, the ok run\'s');
  assert.ok(w.uploads.every((u) => u.ok), 'never an attempt to write over a file');
});

test('two timers at the same moment: one file, one "ok" run, nothing replaced — the other finds the file and stops (busy)', async () => {
  const w = world();
  const at = w.at('2026-12-01T06:00:00Z');
  const [a, b] = await Promise.all([backupCron(w.db, at, 1e15, { clock: () => 0, pageSize: 2 }), backupCron(w.db, at, 1e15, { clock: () => 0, pageSize: 2 })]);
  assert.equal(a.ok + b.ok, 1, 'exactly one of them finished the run');
  assert.equal(a.busy + b.busy, 1, 'the other met the file and left it alone');
  assert.equal(w.runs.length, 1); assert.equal(w.runs[0].status, 'ok');
  assert.equal(okFiles(w).length, 1); assert.equal(w.uploads.filter((u) => u.ok).length, 1); assert.equal(w.uploads.filter((u) => !u.ok).length, 1);
});
