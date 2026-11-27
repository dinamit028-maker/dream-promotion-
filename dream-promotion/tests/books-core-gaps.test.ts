/**
 * QA of 2.121.0 (stage 4ב), next to tests/books-core.test.ts and tests/openformat-customer-key.test.ts:
 *   existing documents' unified file stays byte for byte as 2.120.0's — BKMVDATA and INI of a portfolio of eight customers (a phone with
 *   and without a dash, Hebrew and Latin names, no name and no phone, a name longer than 15, a trailing space, a phone only) — with no
 *   books start (a database before 7100), with a start AFTER the documents (a file already given is never written differently), and
 *   with a start BEFORE them for customers whose key is a plain one (the books' key is then the same key). The sha256 below were taken
 *   from the code of 2.120.0 (the last commit before 2.121.0, c005746's parent chain: 0de1e2c^) on the same fixture, not from the code
 *   under test. A key that looks like a system account's changes only from the start (the "C-" rule).
 * Demo data only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { toDoc } from '../src/features/documents/documents';
import { buildOpenFormat } from '../src/features/documents/openformat';

const h = (s: string) => createHash('sha256').update(s).digest('hex');
const GOLDEN = { bkmv: '491747ec3951e91c2fe8a16288f826e627e47c48ba740bf4d733952c575f6c42', ini: '27c9c0d8343557e5fbd5496f0d05d6b14b66d3b723aac7d50a01612c3990d934',
  counts: { A100: 1, B110: 8, C100: 8, D110: 8, D120: 4, Z900: 1 } };
const base: any = { user_id: 'u', business_id: 'b', link_no: 1, issued_at: '2026-11-20T08:00:00Z', doc_date: '2026-11-26', customer_dealer: '', customer_street: '', customer_city: '', print_count: 0,
  share_token: 'f'.repeat(64), issuer: null, notes: '', source: 'direct', due_date: null, before_discount: 100, discount: 0, after_discount: 100, vat_amount: 18, total: 118, vat_rate: 18, location_id: null };
const line = [{ name: 'טיפול', qty: 1, unitPriceExVat: 100, discountExVat: 0, totalExVat: 100, vatRate: 18, kind: 1 }];
const CUSTOMERS: [string, string][] = [['0500000001', 'דנה כהן'], ['050-0000071', 'לקוחה דוגמה'], ['', 'שם לקוחה בעברית בלבד'], ['', ''],
  ['', 'שם ארוך מאוד של לקוחה לדוגמה שעובר חמש עשרה תווים'], ['', 'מסעדת הים '], ['0500000009', ''], ['', 'Dana Levi']];
const docs = (list: [string, string][] = CUSTOMERS) => list.map(([ph, nm], i) => toDoc({ ...base, id: String(i), doc_type: i % 2 ? 305 : 320, doc_number: i + 1, link_no: i + 1, customer_phone: ph, customer_name: nm,
  lines: line, payments: i % 2 ? [] : [{ method: 1, amount: 118, date: '2026-11-26', m: 'cash' }] }));
const B: any = { dealerNumber: '000000075', companyNumber: '', name: 'עסק דמו', street: 'הרצל', houseNo: '1', city: 'תל אביב', zip: '' };
const SW: any = { regNumber: '00000000', name: 'Dream Promotion', version: '', vendorVat: '000000000', vendorName: 'Dream Promotion' };
const file = (d: any[], booksStart?: string | null) => buildOpenFormat(B, SW, d, { from: '2026-11-01', to: '2026-11-30', startedAt: '2026-11-27T10:00:00Z', id: '1234567', ...(booksStart !== undefined ? { booksStart } : {}) });

test('existing documents: the file is 2.120.0\'s byte for byte — no books start, a start after the documents, and a start before them (plain keys)', () => {
  for (const [label, start] of [['no booksStart', undefined], ['null (a database before 7100)', null], ['a start after the documents', '2026-12-01'], ['a start long after', '2030-01-01'], ['a start before them — plain keys', '2026-11-01']] as const) {
    const f = file(docs(), start);
    assert.equal(h(f.bkmv), GOLDEN.bkmv, `BKMVDATA — ${label}`);
    assert.equal(h(f.ini), GOLDEN.ini, `INI — ${label}`);
    assert.deepEqual(f.counts, GOLDEN.counts, `the counts — ${label}`);
  }
});

test('a key that looks like a system account: as before until the books start, "C-" from it — and B110 / C100 agree in the same file', () => {
  const odd: [string, string][] = [['', '1300'], ['', 'bank'], ['', '1100-1'], ['0500000003', 'x']];
  const col = (r: string, a: number, b: number) => r.slice(a - 1, b).trim();   // X(15)
  const keys = (f: ReturnType<typeof file>) => ({ c100: f.bkmv.split('\r\n').filter((r) => r.startsWith('C100')).map((r) => col(r, 375, 389)),
    b110: f.bkmv.split('\r\n').filter((r) => r.startsWith('B110')).map((r) => col(r, 23, 37)) });
  const before = keys(file(docs(odd), '2026-12-01'));
  const legacy = keys(file(docs(odd), null));
  assert.deepEqual(before, legacy, 'before the books start: the file as before');
  const after = keys(file(docs(odd), '2026-11-01'));
  assert.notDeepEqual(after, legacy, 'from the start the system-looking keys get "C-"');
  for (const k of after.c100) assert.ok(after.b110.includes(k), `every 1225 (${k}) is a B110 of the same file (1403)`);
  assert.ok(after.c100.some((k) => k === 'C-1300') && after.c100.some((k) => k === 'C-bank') && after.c100.some((k) => k === 'C-1100-1') && after.c100.includes('0500000003'), 'C-1300, C-bank, C-1100-1; a phone stays');
  // a customer with documents on both sides of the start has two accounts in one file — each is its own B110 (documented)
  const mixed = [...docs([['', '1300']]), toDoc({ ...base, id: 'm', doc_type: 305, doc_number: 99, link_no: 99, doc_date: '2026-11-28', customer_phone: '', customer_name: '1300', lines: line, payments: [] })];
  const mk = keys(file(mixed, '2026-11-27'));
  assert.deepEqual([...new Set(mk.c100)].sort(), ['1300', 'C-1300'], 'before the start 1300, after it C-1300');
  for (const k of mk.c100) assert.ok(mk.b110.includes(k), 'and each has its B110');
});
