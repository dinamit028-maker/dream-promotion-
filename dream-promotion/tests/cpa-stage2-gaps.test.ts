/**
 * Gaps found by QA of 2.119.0 (stage 2), next to tests/cpa-rules-stage2.test.ts:
 *  - the staff's screens never reach the customer's door: nothing but a message / a copied link carries /d/<token>; no window,
 *    link or fetch of a screen opens /d/<token> or /api/doc/<token> (only the old-database fallback of staffPdf, after "missing")
 *  - the customer's door answers a document waiting for its number with the code and the message only, on every channel
 *  - an old database: the helpers the screens use answer "as before" (no view, no function)
 *  - findings, fixed in 2.119.0 (finance-agent) — now real tests:
 *      QA-2119-1  HEAD on /api/doc/<token> and /pdf was answered by Next from GET: a crawler's HEAD recorded a delivery (the original gone)
 *      QA-2119-2  any error whose text said "does not exist" from document_share_open fell back to the 2.118 way (a waiting document opened)
 * Demo data only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fakeDb } from './fakedb';
import { AWAITING_CUSTOMER, isMissing, isAwaiting } from '../src/features/finance/delivery';

const SRC = path.resolve(__dirname, '../src');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/');

test('the staff\'s screens never open the customer\'s link: /d/<token> only inside a message or a copy, /api/doc/<token> only in the old-database fallback', () => {
  const offenders: string[] = [];
  for (const f of walk(SRC)) {
    const r = rel(f);
    if (r.startsWith('app/d/') || r.startsWith('app/api/doc/') || r === 'lib/server/doc-share.ts') continue;   // the customer's own door
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\/d\/\$\{|\/api\/doc\/\$\{/.test(line)) return;
      const opens = /window\.open|location\.href|href=\{`[^`]*\/(d|api\/doc)\/\$|fetch\(`[^`]*\/api\/doc\/\$|\bgo\(/.test(line);
      if (opens) offenders.push(`${r}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  // the one allowed: staffPdf, only when the database has no document_delivery_record (before 6900), and only with a token
  const allowed = offenders.filter((o) => o.startsWith('features/documents/deliver.ts:') && /\/api\/doc\/\$\{doc\.shareToken\}\/pdf/.test(o));
  assert.equal(allowed.length, 1, 'the fallback is where it was');
  assert.deepEqual(offenders.filter((o) => !allowed.includes(o)), [], 'no other screen opens the customer\'s link');
  const src = readFileSync(path.join(SRC, 'features/documents/deliver.ts'), 'utf8');
  const at = src.indexOf('/api/doc/${doc.shareToken}/pdf');
  const before = src.slice(Math.max(0, at - 220), at);
  assert.match(before, /reason === 'missing'/, 'the fallback is behind "the function is missing" — never behind a failure or a refusal');
});

test('the customer\'s door: a document waiting for its number — the code and the message only, on every channel; nothing kept', async () => {
  const BIZ = 'b0000000-0000-4000-8000-000000000692', DOC = 'd0000000-0000-4000-8000-000000000692', TOKEN = 'c'.repeat(64);
  const row = { id: DOC, business_id: BIZ, user_id: 'a0000000-0000-4000-8000-000000000692', share_token: TOKEN, doc_type: 305, doc_number: 777, doc_date: '2026-11-26',
    customer_name: 'לקוח סודי בע״מ', customer_dealer: '000000059', customer_phone: '0500000002', customer_street: 'רחוב סודי 9', customer_city: 'עיר סודית',
    lines: [{ name: 'שירות סודי', qty: 1, unitPriceExVat: 7000, discountExVat: 0, totalExVat: 7000, vatRate: 18, kind: 1 }], payments: [], before_discount: 7000, discount: 0,
    after_discount: 7000, vat_amount: 1260, total: 8260, vat_rate: 18, print_count: 0, issued_at: '2026-11-26T08:00:00Z', issuer: null };
  const opens: string[] = [];
  const db: any = fakeDb({ documents: [row], businesses: [{ id: BIZ, status: 'active', paid_until: null, grace_days: 0 }] },
    { rpc: { document_share_open: (a: any) => { opens.push(a.p_channel); return { ok: false, code: 'awaiting_allocation' }; } } });
  const uploads: string[] = [];
  db.storage = { from: () => ({ upload: async (k: string) => { uploads.push(k); return { data: null, error: null }; }, remove: async () => ({ data: [], error: null }) }) };
  (globalThis as any).__DP_TEST_ADMIN_DB__ = db;
  const route = await import('../src/app/api/doc/[token]/route');
  const pdf = await import('../src/app/api/doc/[token]/pdf/route');
  const ctx = { params: Promise.resolve({ token: TOKEN }) };
  const answers = [await route.GET(new Request('http://x'), ctx), await pdf.GET(new Request('http://x'), ctx), await pdf.GET(new Request('http://x?via=storefront'), ctx),
    await pdf.GET(new Request('http://x?via=%27%3B--'), ctx)];
  for (const r of answers) {
    assert.equal(r.status, 409);
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { code: 'awaiting_allocation', message: AWAITING_CUSTOMER });
    for (const secret of ['סודי', '000000059', '0500000002', '777', '8260', '7000', '1260', TOKEN, DOC, BIZ]) assert.ok(!text.includes(secret), `the answer does not tell ${secret}`);
    assert.ok(!/pdf/i.test(r.headers.get('content-type') ?? ''), 'not a PDF');
    assert.ok(!r.headers.get('content-disposition'), 'no file name (it would carry the type and the number)');
  }
  assert.deepEqual(opens, ['link', 'pdf', 'storefront', 'pdf'], 'every door asked the database, an odd ?via= is the plain PDF channel');
  assert.deepEqual(uploads, [], 'nothing kept');
});

test('an old database (before 6900): the helpers of the screens answer "as before"', async () => {
  const missing = [{ code: 'PGRST202', message: 'Could not find the function public.document_delivery_record' }, { code: 'PGRST205', message: "Could not find the table 'public.document_allocation_status'" },
    { code: '42883', message: 'function x does not exist' }, { code: '42P01', message: 'relation "x" does not exist' }];
  for (const e of missing) assert.ok(isMissing(e), e.code);
  for (const e of [{ code: '42501', message: 'not allowed' }, { code: '55000', message: 'awaiting_allocation: …' }, { code: '57014', message: 'canceling statement due to statement timeout' }, null, undefined]) assert.ok(!isMissing(e as any), String((e as any)?.code));
  assert.ok(isAwaiting({ code: '55000' }) && isAwaiting({ message: 'awaiting_allocation: x' }) && !isAwaiting({ code: '42501' }));
});

// ---- findings (fixed in 2.119.0) -------------------------------------------------------------------------------------------
test('QA-2119-1: HEAD on the customer\'s API doors is answered without recording a delivery', async () => {
  const calls: string[] = [];
  const db: any = fakeDb({}, { rpc: { document_share_open: () => { calls.push('open'); return { ok: false, code: 'not_found' }; } } });
  const orig = db.from; db.from = (t: string) => { calls.push(`from:${t}`); return orig(t); };
  (globalThis as any).__DP_TEST_ADMIN_DB__ = db;
  for (const mod of ['../src/app/api/doc/[token]/route', '../src/app/api/doc/[token]/pdf/route']) {
    const route: any = await import(mod);
    assert.equal(typeof route.HEAD, 'function', `${mod} exports its own HEAD`);
    const r: Response = await route.HEAD(new Request('http://x', { method: 'HEAD' }), { params: Promise.resolve({ token: 'c'.repeat(64) }) });
    assert.equal(r.status, 405); assert.equal(r.headers.get('allow'), 'GET'); assert.equal(await r.text(), '', 'headers only');
  }
  assert.deepEqual(calls, [], 'nothing asked of the database — no delivery, nothing kept');
});

test('QA-2119-2: an error of document_share_open that is not "the function is missing" never opens a waiting document the 2.118 way', async () => {
  const BIZ = 'b0000000-0000-4000-8000-000000000693', TOKEN = 'd'.repeat(64);
  const row = { id: 'd0000000-0000-4000-8000-000000000693', business_id: BIZ, user_id: 'a0000000-0000-4000-8000-000000000693', share_token: TOKEN, doc_type: 305, doc_number: 1, doc_date: '2026-11-26',
    customer_name: 'לקוח סודי', customer_dealer: '000000059', lines: [], payments: [], before_discount: 7000, discount: 0, after_discount: 7000, vat_amount: 1260, total: 8260, vat_rate: 18, print_count: 0, issued_at: '2026-11-26T08:00:00Z', issuer: null };
  const db: any = fakeDb({ documents: [row], businesses: [{ id: BIZ, status: 'active', paid_until: null, grace_days: 0 }], register_settings: [], brands: [] });
  db.rpc = async () => ({ data: null, error: { code: '42703', message: 'column d.print_count does not exist' } });
  (globalThis as any).__DP_TEST_ADMIN_DB__ = db;
  const route = await import('../src/app/api/doc/[token]/route');
  const r = await route.GET(new Request('http://x'), { params: Promise.resolve({ token: TOKEN }) });
  assert.notEqual(r.status, 200, 'a database error is an error, not the old way');
  assert.equal(r.status, 503); assert.equal((await r.json()).code, 'error');
  for (const e of [{ code: '42703', message: 'column x does not exist' }, { code: 'XX000', message: 'Could not find the function — or so it says' }]) {
    db.rpc = async () => ({ data: null, error: e });
    assert.equal((await route.GET(new Request('http://x'), { params: Promise.resolve({ token: TOKEN }) })).status, 503, `${e.code}: closed`);
    assert.equal(isMissing(e), false, `${e.code}: not "old database" for the screens either`);
  }
  // only "no such function" is the old database
  db.rpc = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.document_share_open' } });
  assert.equal((await route.GET(new Request('http://x'), { params: Promise.resolve({ token: TOKEN }) })).status, 200, 'before 6900: as before');
});
