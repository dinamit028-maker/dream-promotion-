/**
 * 2.118 — the Tax Authority's file (INI / BKMVDATA and its two printouts) is the whole business's: it is made only when the caller
 * sees every location (location_filter() = null). Option א of the owner of the system (22.11.2026). Demo ids only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCOPE_ERROR, SCOPE_LIMITED, SCOPE_PICK_ALL, exportScope, loadExportScope } from '../src/features/documents/export-scope';

const ok = (data: unknown) => ({ data, error: null });
const err = (code: string, message = 'x') => ({ data: null, error: { code, message } });
const LOC = ['00000000-0000-4000-8000-0000000000a1'];

test('every location seen (one location, or "all locations" picked): the file is made — exactly as before', () => {
  assert.deepEqual(exportScope(ok(null)), { ok: true });
});

test('one location picked at the top by someone who may pick all: no file — "בחרו כל הסניפים"', () => {
  assert.deepEqual(exportScope(ok(LOC), ok(null)), { ok: false, message: SCOPE_PICK_ALL });
});

test('a member limited to some locations: no file — only who sees every location makes it', () => {
  assert.deepEqual(exportScope(ok(LOC), ok(LOC)), { ok: false, message: SCOPE_LIMITED });
  assert.deepEqual(exportScope(ok([]), ok([])), { ok: false, message: SCOPE_LIMITED }, 'an empty list is not "all"');
});

test('fail closed: an error asking the database — no file; only a missing function (before migration 4600) means no locations', () => {
  assert.deepEqual(exportScope(err('500')), { ok: false, message: SCOPE_ERROR });
  assert.deepEqual(exportScope(err('42501', 'permission denied')), { ok: false, message: SCOPE_ERROR });
  assert.deepEqual(exportScope(ok(LOC), err('500')), { ok: false, message: SCOPE_ERROR }, 'my_locations failed — still no file');
  assert.deepEqual(exportScope(ok(LOC)), { ok: false, message: SCOPE_ERROR }, 'not asked — no file');
  assert.deepEqual(exportScope(err('PGRST202', 'Could not find the function public.location_filter')), { ok: true });
  assert.deepEqual(exportScope(err('42883', 'function public.location_filter() does not exist')), { ok: true });
});

test('the loader asks location_filter, and my_locations only when needed; a thrown error — no file', async () => {
  const calls: string[] = [];
  const db = (answers: Record<string, unknown>) => () => ({ rpc: async (fn: string) => { calls.push(fn); const a = answers[fn]; if (a instanceof Error) throw a; return a; } }) as any;
  assert.deepEqual(await loadExportScope(db({ location_filter: ok(null) })), { ok: true });
  assert.deepEqual(calls, ['location_filter'], 'one location / all picked: one question only');
  assert.deepEqual(await loadExportScope(db({ location_filter: ok(LOC), my_locations: ok(null) })), { ok: false, message: SCOPE_PICK_ALL });
  assert.deepEqual(await loadExportScope(db({ location_filter: ok(LOC), my_locations: ok(LOC) })), { ok: false, message: SCOPE_LIMITED });
  assert.deepEqual(await loadExportScope(db({ location_filter: new Error('network') })), { ok: false, message: SCOPE_ERROR });
  assert.deepEqual(await loadExportScope(() => { throw new Error('supabase_not_configured'); }), { ok: false, message: SCOPE_ERROR });
});
