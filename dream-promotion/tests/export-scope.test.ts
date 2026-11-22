/**
 * 2.118 — the Tax Authority's file (INI / BKMVDATA and its two printouts) is the whole business's: it is made only when the caller
 * sees every location (location_filter() = null). Option א of the owner of the system (22.11.2026). Demo ids only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCOPE_CHANGED, SCOPE_ERROR, SCOPE_LIMITED, SCOPE_PICK_ALL, bothScopes, confirmNoGaps, exportScope, holesOf, loadExportScope, numberRanges, offerShowAll,
} from '../src/features/documents/export-scope';

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

// ---------- review round: the scope may change while the documents are read; holes in the numbering; no switch to pick "all" ----------

test('asked before and after the documents are read: the file only when both say "every location"', () => {
  const all = { ok: true } as const, one = { ok: false, message: SCOPE_PICK_ALL } as const, bad = { ok: false, message: SCOPE_ERROR } as const;
  assert.deepEqual(bothScopes(all, all), { ok: true });
  assert.deepEqual(bothScopes(one, all), one, 'a location picked before — its own message');
  assert.deepEqual(bothScopes(all, one), { ok: false, message: SCOPE_CHANGED }, 'switched in another tab / the phone while reading');
  assert.deepEqual(bothScopes(all, { ok: false, message: SCOPE_LIMITED }), { ok: false, message: SCOPE_CHANGED });
  assert.deepEqual(bothScopes(all, bad), bad);
});

test('the loader twice with the scope changing between: no file', async () => {
  let n = 0;
  const db = () => ({ rpc: async (fn: string) => (fn === 'location_filter' ? ok(n++ === 0 ? null : LOC) : ok(null)) }) as any;
  assert.deepEqual(bothScopes(await loadExportScope(db), await loadExportScope(db)), { ok: false, message: SCOPE_CHANGED });
});

test('numbering: per type its lowest, highest and count; a hole when the count is short of max − min + 1', () => {
  const d = (docType: number, docNumber: number) => ({ docType, docNumber });
  const r = numberRanges([d(320, 5), d(320, 8), d(400, 2), d(400, 3), d(320, 6), d(320, 6)]);
  assert.deepEqual(r, [{ docType: 320, min: 5, max: 8, count: 3 }, { docType: 400, min: 2, max: 3, count: 2 }]);
  assert.deepEqual(holesOf(r), [{ docType: 320, min: 5, max: 8, count: 3 }]);
  assert.deepEqual(holesOf(numberRanges([d(330, 9)])), []);
});

const label = (t: number) => (t === 320 ? 'חשבונית מס / קבלה' : `מסמך ${t}`);
/** a fake documents table: count(*) where doc_type = t and doc_number between a and b — over these (type, number) pairs */
function countDb(all: [number, number][] | Error, asked: unknown[] = []) {
  return () => ({ from: () => ({ select: (_c: string, o: any) => {
    assert.deepEqual(o, { count: 'exact', head: true });
    const q: any = { t: 0, a: -Infinity, b: Infinity };
    const chain: any = {
      eq: (_k: string, v: number) => { q.t = v; return chain; }, gte: (_k: string, v: number) => { q.a = v; return chain; },
      lte: (_k: string, v: number) => { q.b = v; asked.push([q.t, q.a, q.b]);
        return Promise.resolve(all instanceof Error ? { count: null, error: { code: '500' } } : { count: all.filter(([t, n]) => t === q.t && n >= q.a && n <= q.b).length, error: null }); },
    };
    return chain;
  } }) }) as any;
}

test('one active location: a hole never blocks the file (as before 2.117.1) — nothing is even asked', async () => {
  const asked: unknown[] = [];
  assert.deepEqual(await confirmNoGaps([{ docType: 320, docNumber: 5 }, { docType: 320, docNumber: 9 }], label, false, countDb([], asked)), { ok: true });
  assert.equal(asked.length, 0);
});

test('several locations: a real hole → no file, naming the type and the numbers between; an error → no file', async () => {
  const docs = [{ docType: 320, docNumber: 5 }, { docType: 320, docNumber: 8 }];
  const r = await confirmNoGaps(docs, label, true, countDb([[320, 5], [320, 6], [320, 8]]));   // 7 is not seen
  assert.equal(r.ok, false); assert.ok(!r.ok && r.message.includes('חשבונית מס / קבלה בין מס׳ 5 ל-8'));
  assert.deepEqual(await confirmNoGaps(docs, label, true, countDb(new Error())), { ok: false, message: SCOPE_ERROR });
  const asked: unknown[] = [];
  assert.deepEqual(await confirmNoGaps([{ docType: 320, docNumber: 5 }, { docType: 320, docNumber: 6 }], label, true, countDb([], asked)), { ok: true });
  assert.equal(asked.length, 0, 'no hole in the period — nothing asked');
});

test('several locations: a big range filled by documents dated outside the period → the file is made (one count per type)', async () => {
  const outside: [number, number][] = Array.from({ length: 5000 }, (_, i) => [320, i + 1]);
  const asked: unknown[] = [];
  assert.deepEqual(await confirmNoGaps([{ docType: 320, docNumber: 1 }, { docType: 320, docNumber: 5000 }, { docType: 400, docNumber: 3 }], label, true, countDb(outside, asked)), { ok: true });
  assert.deepEqual(asked, [[320, 1, 5000]], 'one count query, by range — no list of numbers in the URL');
});

test('"להציג את כל הסניפים": only for "pick all" when the switch is not shown; one location, nothing picked — no message at all', () => {
  const pick = { ok: false, message: SCOPE_PICK_ALL } as const;
  assert.equal(offerShowAll(pick, false), true, 'one active location left, a closed one still picked');
  assert.equal(offerShowAll(pick, true), false, 'the switch is there');
  assert.equal(offerShowAll({ ok: false, message: SCOPE_LIMITED }, false), false);
  assert.equal(offerShowAll({ ok: true }, false), false);
  assert.equal(offerShowAll(null, false), false);
  assert.deepEqual(exportScope(ok(null)), { ok: true }, 'one location, nothing picked: location_filter() null — the file, no note');
});
