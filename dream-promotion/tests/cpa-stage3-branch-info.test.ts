/**
 * 2.120 — the unified file of a business that numbers per location is never written without its branch fields (review of 2.120,
 * item 1): loadBranchInfo against a stubbed PostgREST (global fetch). The public keys are set first (./supabase-test-env — the
 * browser client reads them when its module loads). Demo ids only.
 */
import './supabase-test-env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseBranchOf } from '../src/features/documents/openformat';

const BIZ_ID = 'd3e00000-0000-4000-8000-0000000000b1', LOC2 = 'd3e00000-0000-4000-8000-0000000000b2';

// ---- 7. the export never writes a switched business without its branch fields (review 2.120, item 1) ---------------------------
test('loadBranchInfo: before 7000 / not switched — null (the file as before); switched — the codes, else a refusal in Hebrew', async () => {
  const realFetch = globalThis.fetch;
  let answer: { status: number; body: unknown } = { status: 200, body: null };
  const asked: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const u = String(typeof input === 'string' ? input : input.url);
    asked.push(u);
    if (u.includes('/rest/v1/documents')) return new Response(JSON.stringify([{ doc_type: 320, doc_number: 7, location_id: LOC2 }]), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const { loadBranchInfo, BRANCH_INFO_MISSING } = await import('../src/features/finance/numbering-data');
    const state = (per: boolean) => ({ perLocation: per, since: null, activeLocations: 2, business: {},
      locations: [{ id: BIZ_ID, name: 'ראשי', active: true, branchCode: per ? '01' : null, codeFixed: false, series: [] },
        { id: LOC2, name: 'סניף', active: true, branchCode: per ? '02' : null, codeFixed: false, series: [] }] });
    const docs = [{ docType: 330, docNumber: 1_000_001, baseDocType: 320, baseDocNumber: 7 }];
    answer = { status: 404, body: { code: 'PGRST202', message: 'Could not find the function public.document_numbering_state' } };
    assert.equal(await loadBranchInfo(docs, BIZ_ID), null, 'before 7000');
    answer = { status: 200, body: state(false) };
    assert.equal(await loadBranchInfo(docs, BIZ_ID), null, 'not switched');
    answer = { status: 200, body: state(true) };
    await assert.rejects(loadBranchInfo(docs, null), (e: Error) => e.message === BRANCH_INFO_MISSING, 'switched, no business id — refused');
    const info = (await loadBranchInfo(docs, BIZ_ID))!;
    assert.equal(info.perLocation, true);
    assert.deepEqual([...info.codes], [[BIZ_ID, '01'], [LOC2, '02']]);
    assert.equal(info.baseLocations?.get('320:7'), LOC2, 'a base of before the switch, read from the database');
    assert.equal(baseBranchOf(info, docs[0]), '02');
    answer = { status: 200, body: { ...state(true), locations: state(true).locations.map((l) => ({ ...l, branchCode: null })) } };
    await assert.rejects(loadBranchInfo(docs, BIZ_ID), (e: Error) => e.message === BRANCH_INFO_MISSING, 'switched, no codes — refused');
  } finally { globalThis.fetch = realFetch; }
});

