/**
 * QA of 2.120.0 (stage 3), next to tests/cpa-rules-stage3.test.ts and tests/ita-sample-branches.test.ts:
 *   1. a business that never switched (one location — or several, not switched) renders and exports byte for byte as 2.119.0: the
 *      whole unified file (BKMVDATA + INI), the HTML (original and copy) and the PDF of five documents. The hashes in GOLDEN were
 *      taken from the code of 2.119.0 (commit 8e40302) on the same fixture — not from the code under test
 *   2. a business that switched: every branch field of the file is the code of THE RECORD'S OWN location — C100 1231, D110 1270,
 *      D120 1320, the base's branch 1274 (of the credited invoice, not the credit), B110 1421 (the account's first document), a
 *      deposit (420) of a third location; the main location (no location id) is 01; an unknown location writes nothing, never a
 *      neighbour's code
 * Demo data only (000000075, a fictional dealer number).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { toDoc } from '../src/features/documents/documents';
import { buildOpenFormat, customerKeyField, type BranchInfo } from '../src/features/documents/openformat';

const h = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const B: any = { dealerNumber: '000000075', companyNumber: '', name: 'עסק דמו', street: 'הרצל', houseNo: '1', city: 'תל אביב', zip: '' };
const SW: any = { regNumber: '00000000', name: 'Dream Promotion', version: '', vendorVat: '000000000', vendorName: 'Dream Promotion' };
const BIZ = 'b0000000-0000-4000-8000-000000000120';
const base: any = { user_id: 'u', business_id: BIZ, link_no: 1, issued_at: '2026-11-20T08:00:00Z', doc_date: '2026-11-20', customer_name: 'לקוחה דמו', customer_phone: '0500000001', customer_dealer: '',
  customer_street: '', customer_city: '', print_count: 0, share_token: 'f'.repeat(64), issuer: null, notes: '', source: 'direct', due_date: null, before_discount: 100, discount: 0, after_discount: 100,
  vat_amount: 18, total: 118, vat_rate: 18, location_id: null };
const line = (n: number) => [{ name: 'טיפול', qty: 1, unitPriceExVat: n, discountExVat: 0, totalExVat: n, vatRate: 18, kind: 1 }];
const rows = (extra: Record<string, unknown> = {}) => [
  { ...base, id: '1', doc_type: 305, doc_number: 1, lines: line(100), payments: [] },
  { ...base, id: '2', doc_type: 320, doc_number: 2, doc_date: '2026-11-21', lines: line(100), payments: [{ method: 1, amount: 118, date: '2026-11-21', m: 'cash' }] },
  { ...base, id: '3', doc_type: 330, doc_number: 1, doc_date: '2026-11-22', base_doc_type: 305, base_doc_number: 1, before_discount: 50, after_discount: 50, vat_amount: 9, total: 59, lines: line(50), payments: [] },
  { ...base, id: '4', doc_type: 400, doc_number: 1, doc_date: '2026-11-22', vat_amount: 0, vat_rate: 0, before_discount: 118, after_discount: 118, total: 118, paid_document_id: '1', lines: line(118),
    payments: [{ method: 2, amount: 118, date: '2026-11-22', m: 'cheque', cheque: { bank: '10', branch: '100', account: '0000001', number: '1234', dueDate: '2026-12-01' } }] },
  { ...base, id: '5', doc_type: 300, doc_number: 3, doc_date: '2026-11-23', lines: line(100), payments: [] },
].map((r) => ({ ...r, ...extra }));

const GOLDEN: Record<string, string> = {
  "bkmv": "057cdb85b2613aeb44780c51287dfb277f1a0c84c7611b52b253703becb5f0e3",
  "ini": "0b6b25a44d84ed2277004bc9e0f9cee333964fc55be1d132416ae6261367361e",
  "counts": "{\"A100\":1,\"B110\":1,\"C100\":5,\"D110\":4,\"D120\":2,\"Z900\":1}",
  "html:0:o": "26a089fcb6aaeb1e3164ba93210141f00b840ff4acbc5deb5443491d6db24841",
  "html:0:c": "0490caaf3a848d8baffdf94418d7065ecef1cbcc566020c99c192bf0e80b0a80",
  "html:1:o": "808481e064ccf3f319da4470e8ee573bfaed0a468bd547551632e1d4054850a5",
  "html:1:c": "bb7d5afc373b304e8eed5394debbeca387dc5cafb8df82e3bdd208a29decad5a",
  "html:2:o": "28ecb2f018dce194ab1301e0d98519dd1436424cedfb439027e359bc9333a335",
  "html:2:c": "4c386e1e19cfa7517f8f3e707090a964a10466e52796b4d0835551ad53323a30",
  "html:3:o": "7fe40ad8b218e14105103cf3e5648b1b690af2d1a05f829137a7d96c422fa612",
  "html:3:c": "6ea9895fdf0cd29268f8b181b7d1715fdcaba2628dcf3d908c9a3105e7031cd5",
  "html:4:o": "5a48fd3f69bae367d7e44b70346fa636e7bbf2ef99dcb6a15cb679e527a17a78",
  "html:4:c": "7fc29bca9480014820652bba146c4848a4dc6ef96ea6db7ed4507d3e36cae8c1",
  "pdf:0": "71be77498c3f272e8b156f198b3c5d638d55e2db3f982d381db0f3cc464cfe64",
  "pdf:1": "8d9860920eac17b263108bbbffaafe690cc9477a2a2a678622a3e3b0bc054ba0",
  "pdf:2": "b68e39edfc82fafcf4bb0ac2937504d2542537be4f7811df700c18b2560af057",
  "pdf:3": "8f3797fc2e469f84db15181fdd600086fd5fe6c765f6dfbe7d0376208956e9a3",
  "pdf:4": "230f925d644d4b7c530daacfe6b07d43935357c1b314c36662ffd90ff609151e"
};

async function fingerprint(docs: any[], o: { branches?: BranchInfo | null } = {}) {
  const { docBody } = await import('../src/features/documents/DocumentsTab');
  const { buildDocPdf } = await import('../src/lib/server/doc-pdf');
  const out: Record<string, string> = {};
  const f = buildOpenFormat(B, SW, docs, { from: '2026-11-01', to: '2026-11-30', startedAt: '2026-11-26T10:00:00Z', id: '1234567', ...(o.branches !== undefined ? { branches: o.branches } : {}) });
  out.bkmv = h(f.bkmv); out.ini = h(f.ini); out.counts = JSON.stringify(f.counts);
  docs.forEach((d, i) => { out[`html:${i}:o`] = h(docBody(d, B, 'מקור')); out[`html:${i}:c`] = h(docBody(d, B, 'העתק נאמן למקור')); });
  for (const [i, d] of docs.entries()) {
    const pdf = await buildDocPdf(d, B, { mark: 'מקור', software: 'Dream Promotion', signed: false });
    pdf.setCreationDate(new Date('2026-01-01T00:00:00Z')); pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
    out[`pdf:${i}`] = h(await pdf.save({ useObjectStreams: false }));
  }
  return out;
}

test('a business that never switched: the file, the HTML and the PDF are those of 2.119.0, byte for byte (one location, and several not switched)', async () => {
  process.env.NEXT_PUBLIC_APP_VERSION = '';
  const one = await fingerprint(rows().map((r) => toDoc(r)));
  assert.deepEqual(one, GOLDEN);
  // several locations that never switched: the documents carry their location ids, the file knows no branch (BranchInfo says "not per location")
  const L2 = 'c0000000-0000-4000-8000-000000000121';
  const many = rows().map((r, i) => toDoc({ ...r, location_id: i % 2 ? L2 : null }));
  const notSwitched: BranchInfo = { perLocation: false, businessId: BIZ, codes: new Map([[BIZ, '01'], [L2, '02']]) };
  assert.deepEqual(await fingerprint(many, { branches: notSwitched }), await fingerprint(many), 'perLocation: false = no BranchInfo');
  const f = await fingerprint(many, { branches: notSwitched });
  assert.equal(f.bkmv, GOLDEN.bkmv, 'the file has no branch field and 1034 = 0 — the same bytes as with every document in one location');
  assert.equal(f.ini, GOLDEN.ini);
});

// ---- 2. the branch fields: each record's own location ---------------------------------------------------------------------------
const col = (s: string, a: number, b: number) => s.slice(a - 1, b);
const L1 = BIZ, L2 = 'c0000000-0000-4000-8000-000000000122', L3 = 'c0000000-0000-4000-8000-000000000123', LX = 'c0000000-0000-4000-8000-0000000001ff';
const info = (): BranchInfo => ({ perLocation: true, businessId: BIZ, codes: new Map([[L1, '01'], [L2, '02'], [L3, '03']]) });
const mk = (type: number, number: number, loc: string | null, extra: Record<string, unknown> = {}) => toDoc({ ...base, id: `${type}:${number}`, doc_type: type, doc_number: number, location_id: loc,
  lines: type === 420 ? [] : line(100), payments: type === 320 || type === 400 ? [{ method: 1, amount: 118, date: '2026-11-21', m: 'cash' }] : [],
  customer_name: `לקוח ${loc ?? 'main'}`, customer_phone: `050000${String(number).padStart(4, '0')}`, ...extra });

test('the branch fields of a business that switched are the code of each record\'s own location — C100, D110, D120, the base\'s, B110, a deposit', () => {
  const docs = [
    mk(305, 1000001, null),                                                         // the main location (no location id): 01
    mk(305, 2000001, L2),                                                           // location 02
    mk(320, 2000001, L2, { doc_date: '2026-11-21' }),
    mk(330, 1000001, L1, { base_doc_type: 305, base_doc_number: 2000001, doc_date: '2026-11-22', before_discount: 50, after_discount: 50, vat_amount: 9, total: 59,
      customer_name: 'לקוח ' + L2, customer_phone: '0500000002' }),  // a credit issued at 01 on the invoice of 02: its own branch 01, its base's 02
    mk(305, 7, L2),                                                                 // an invoice of before the switch (the old series), of location 02: still 02
    mk(400, 3000001, L3, { vat_amount: 0, vat_rate: 0, before_discount: 118, after_discount: 118, total: 118 }),
    mk(420, 3000001, L3, { customer_name: '', customer_phone: '', vat_amount: 0, vat_rate: 0, before_discount: 300, after_discount: 300, total: 300,
      payments: [{ method: 1, amount: 100, date: '2026-11-25' }, { method: 2, amount: 200, date: '2026-11-25', cheque: { bank: '10', branch: '100', account: '0000001', number: '99', dueDate: '2026-12-01' } }] }),
    mk(305, 9000001, LX),                                                           // a location the file does not know: no branch, never a neighbour's
  ];
  const f = buildOpenFormat(B, SW, docs, { from: '2026-11-01', to: '2026-11-30', startedAt: '2026-11-26T10:00:00Z', id: '1234567', branches: info() });
  const recs = f.bkmv.split('\r\n').filter(Boolean);
  const ini = f.ini.split('\r\n')[0];
  assert.equal(col(ini, 420, 420), '1', '1034 = 1');
  const expected = new Map<string, string>([['305:1000001', '01'], ['305:2000001', '02'], ['320:2000001', '02'], ['330:1000001', '01'], ['305:7', '02'],
    ['400:3000001', '03'], ['420:3000001', '03'], ['305:9000001', '']]);
  const keyOf = (r: string) => `${Number(col(r, 23, 25))}:${Number(col(r, 26, 45).trim())}`;
  const seen: Record<string, number> = { C100: 0, D110: 0, D120: 0 };
  for (const r of recs) {
    const kind = r.slice(0, 4);
    if (kind === 'C100') { seen.C100++; assert.equal(col(r, 409, 415).trim(), expected.get(keyOf(r)), `C100 1231 of ${keyOf(r)}`); }
    if (kind === 'D110') {
      seen.D110++;
      assert.equal(col(r, 290, 296).trim(), expected.get(keyOf(r)), `D110 1270 of ${keyOf(r)}`);
      // 1274: the credited invoice's branch — only for the credit
      assert.equal(col(r, 312, 318).trim(), keyOf(r) === '330:1000001' ? '02' : '', `D110 1274 of ${keyOf(r)}`);
    }
    if (kind === 'D120') { seen.D120++; assert.equal(col(r, 141, 147).trim(), expected.get(keyOf(r)), `D120 1320 of ${keyOf(r)}`); }
  }
  assert.deepEqual(seen, { C100: 8, D110: 6, D120: 4 }, 'every record checked: 8 documents; a D110 for the six with lines (the 400 and the deposit have none); a D120 per payment (320, 400, the deposit\'s two)');
  // B110 1421: the branch of the account's FIRST document in the file (sorted by type, then number), for every account
  const sorted = [...docs].sort((x, y) => x.docType - y.docType || x.docNumber - y.docNumber);
  const firstOf = new Map<string, string>();
  for (const d of sorted) { const k = customerKeyField(d).trimEnd(); if (!firstOf.has(k)) firstOf.set(k, expected.get(`${d.docType}:${d.docNumber}`) ?? ''); }
  const b110 = recs.filter((r) => r.startsWith('B110'));
  assert.equal(b110.length, firstOf.size, 'one account per customer key, and the bank\'s');
  for (const r of b110) {
    const key = col(r, 23, 37).trimEnd();
    assert.ok(firstOf.has(key), `an account the documents know: ${key}`);
    assert.equal(col(r, 336, 342).trim(), firstOf.get(key), `B110 1421 of ${key}`);
  }
  assert.equal(firstOf.get('BANK'), '03', 'the bank\'s account: the branch of the deposit (location 03)');
});

test('the base document\'s branch when the base is not in the file: from the lookup, else from its number — and a business-series base gives none', () => {
  const credit = mk(330, 1000002, L1, { base_doc_type: 305, base_doc_number: 3000005, doc_date: '2026-11-22', before_discount: 50, after_discount: 50, vat_amount: 9, total: 59 });
  const old = mk(330, 1000003, L1, { base_doc_type: 305, base_doc_number: 5, doc_date: '2026-11-22', before_discount: 50, after_discount: 50, vat_amount: 9, total: 59 });
  const withLookup: BranchInfo = { ...info(), baseLocations: new Map([['305:3000005', L3]]) };
  for (const [inf, label] of [[info(), 'no lookup: the number carries it'], [withLookup, 'the lookup']] as const) {
    const f = buildOpenFormat(B, SW, [credit, old], { from: '2026-11-01', to: '2026-11-30', startedAt: '2026-11-26T10:00:00Z', id: '1234567', branches: inf });
    const d110 = f.bkmv.split('\r\n').filter((r) => r.startsWith('D110'));
    assert.equal(d110.length, 2);
    const of = (n: string) => d110.find((r) => col(r, 26, 45).trim() === n)!;
    assert.equal(col(of('01000002'), 312, 318).trim(), '03', `1274 of a base in location 03 (${label})`);
    assert.equal(col(of('01000003'), 312, 318).trim(), '', '1274 of a base of the old series: none (it is not of a location)');
    assert.equal(col(of('01000002'), 53, 72).trim(), '03000005', '1257 the base\'s number with its eight digits');
    assert.equal(col(of('01000003'), 53, 72).trim(), '5', '1257 of an old-series base as before');
  }
});
