// 2.124 QA: loadBooksForFile through the real supabase-js client (fetch stubbed): a period with sources that did not post
// (gl_unposted) is refused before any report is read; a clean one reads the reports; a period before / across the start.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://sb.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
const calls: string[] = [];
let unposted = 0;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input.url);
  calls.push(`${init?.method ?? 'GET'} ${url}`);
  const json = (b: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json', ...h } });
  if (url.includes('/gl_unposted')) return new Response(null, { status: 200, headers: { 'content-range': unposted ? `0-${unposted - 1}/${unposted}` : '*/0' } });
  if (url.includes('/rpc/report_journal')) return json({ entries: [], count: 0 });
  if (url.includes('/rpc/report_trial_balance')) return json({ accounts: [], groups: [], total: {} });
  return json([]);
}) as typeof fetch;

test('loadBooksForFile: unposted sources of the period refuse the file, no report is read', async () => {
  const { loadBooksForFile, BOOKS_UNPOSTED } = await import('../src/features/finance/openformat-books-data');
  unposted = 2; calls.length = 0;
  await assert.rejects(loadBooksForFile('2026-10-01', '2026-10-31', '2026-06-01'), (e: Error) => e.message === BOOKS_UNPOSTED(2));
  assert.ok(!calls.some((c) => c.includes('/rpc/')), calls.join('\n'));
  unposted = 1;
  await assert.rejects(loadBooksForFile('2026-10-01', '2026-10-31', '2026-06-01'), (e: Error) => e.message === BOOKS_UNPOSTED(1));
});
test('loadBooksForFile: clean period reads both reports; before the start → null with no call; across → refuses', async () => {
  const { loadBooksForFile } = await import('../src/features/finance/openformat-books-data');
  unposted = 0; calls.length = 0;
  const b = await loadBooksForFile('2026-10-01', '2026-10-31', '2026-06-01');
  assert.deepEqual(b && b.transactions, []);
  assert.ok(calls.some((c) => c.includes('/rpc/report_journal')) && calls.some((c) => c.includes('/rpc/report_trial_balance')));
  calls.length = 0;
  assert.equal(await loadBooksForFile('2026-01-01', '2026-05-31', '2026-06-01'), null);
  assert.equal(calls.length, 0);
  await assert.rejects(loadBooksForFile('2026-05-01', '2026-06-30', '2026-06-01'));
});
test('review 1: the unposted check covers the books\' start to the period\'s end (1414 is the balance of everything before the period)', async () => {
  const { loadBooksForFile } = await import('../src/features/finance/openformat-books-data');
  unposted = 0; calls.length = 0;
  await loadBooksForFile('2026-10-01', '2026-10-31', '2026-06-01');
  const u = calls.find((c) => c.includes('/gl_unposted'));
  assert.ok(u, calls.join('\n'));
  const q = new URL(u!.split(' ')[1]).searchParams.getAll('source_date');
  assert.deepEqual(q.sort(), ['gte.2026-06-01', 'lte.2026-10-31'], u);
});
