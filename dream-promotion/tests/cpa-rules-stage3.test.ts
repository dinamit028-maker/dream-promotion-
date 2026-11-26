/**
 * 2.120 — the accountant's answers of 25.11.2026, stage 3 (docs/ita-registration/CPA_ANSWERS_HE.md rows 5 and 18; the owner's
 * decisions of 26.11.2026; the database side is migration 20261127007000 and tests/sql/cpa-rules-stage3.check.sql):
 *    5 numbering per location: the branch code (two digits) and then the location's running number — doc_number = code × 1,000,000
 *      + n, shown and written with eight digits (01000001); the business's own series (below 1,000,000) exactly as before
 *   18 a bank deposit is a document, 420 "הפקדת בנק": C100 + D120 (a line per payment), no D110
 * And: a document issued before this version (or by a business that never switches) looks exactly as before — on the screen, the
 * print, the PDF and in the unified file. Demo data only (fictitious numbers: 000000…, 050-00000NN).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DOC_LABEL, baseDocLine, docNumberLabel, isDepositDoc, toDoc, totalLabel } from '../src/features/documents/documents';
import {
  A000, B110, C100, D110, D120, NO_D110, accountsOf, baseBranchOf, branchOf, buildOpenFormat, docTypeReport, seriesNumber, type BranchInfo, type Doc,
} from '../src/features/documents/openformat';
import { holesOf, numberRanges } from '../src/features/documents/export-scope';
import { docRanges } from '../src/features/register/shift';
import { toSummary } from '../src/features/finance/Overview';
import { financeError } from '../src/features/finance/rows';
import {
  NUMBERING_HE, SWITCH_CONFIRM, branchCodeProblem, branchInfoOf, canSwitch, normalizeCode, numberingError, showNumbering, toNumberingState,
} from '../src/features/finance/numbering';
import { depositDoneLabel, toDepositDoc, toDeposits } from '../src/features/finance/desks';
import { reminderDoc } from '../src/features/finance/reminders';
import { documentsCsv } from '../src/features/finance/reports';

const h = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const col = (s: string, from: number, to: number) => s.slice(from - 1, to);   // spec columns are 1-based, inclusive
const BIZ_ID = 'd3e00000-0000-4000-8000-0000000000b1', LOC2 = 'd3e00000-0000-4000-8000-0000000000b2';
const BIZ = { dealerNumber: '000000109', companyNumber: '', name: 'עסק דמו', street: 'הדמו', houseNo: '1', city: 'עיר דמו', zip: '', entityType: 'licensed_dealer' };
const SW = { regNumber: '00000000', name: 'Dream Promotion', version: '', vendorVat: '000000000', vendorName: 'Dream Promotion' };
const issuer = { name: 'עסק דמו', dealerNumber: '000000109', entityType: 'licensed_dealer', street: 'הדמו', houseNo: '1', city: 'עיר דמו' };
const base = { user_id: 'u1', link_no: 1, issued_at: '2026-11-26T07:30:00Z', doc_date: '2026-11-26', customer_name: 'לקוחה דמו', customer_phone: '0500000001',
  customer_dealer: '', customer_street: '', customer_city: '', print_count: 0, share_token: 't', issuer, notes: '', vat_rate: 18 };
const line = { name: 'טיפול פנים', qty: 1, unitPriceExVat: 100, discountExVat: 0, totalExVat: 100, vatRate: 18, kind: 1 };
const inv = (o: Record<string, unknown>) => ({ ...base, id: 'I', doc_type: 320, doc_number: 41, lines: [line], payments: [{ method: 1, amount: 118, date: '2026-11-26', m: 'cash' }],
  before_discount: 100, discount: 0, after_discount: 100, vat_amount: 18, total: 118, ...o });

// ---- 1. one function for the number ------------------------------------------------------------------------------------------
test('docNumberLabel: the business series exactly as before; a location series — eight digits; the file writes the same', () => {
  for (const n of [1, 41, 999, 999_999]) { assert.equal(docNumberLabel(n), String(n)); assert.equal(seriesNumber(n), String(n)); }
  assert.equal(docNumberLabel(1_000_001), '01000001');
  assert.equal(docNumberLabel(2_000_003), '02000003');
  assert.equal(docNumberLabel(99_999_999), '99999999');
  assert.equal(docNumberLabel({ docNumber: 1_000_001, seriesLocationId: LOC2 }), '01000001');
  assert.equal(docNumberLabel({ docNumber: 41 }), '41');
  assert.equal(docNumberLabel(null), ''); assert.equal(docNumberLabel(undefined), '');
  assert.equal(seriesNumber(1_000_001), docNumberLabel(1_000_001));
  // a base document's line names its number the same way
  assert.equal(baseDocLine({ docType: 330, baseDocType: 320, baseDocNumber: 2_000_003 }), 'זיכוי עבור חשבונית מס / קבלה מס׳ 02000003');
  assert.equal(baseDocLine({ docType: 330, baseDocType: 320, baseDocNumber: 7 }), 'זיכוי עבור חשבונית מס / קבלה מס׳ 7');
  assert.equal(reminderDoc(305, 1_000_012, null, null), 'חשבונית מס מס׳ 01000012');
  assert.equal(reminderDoc(305, 12, 2, 3), 'תשלום 2 מתוך 3 של חשבונית מס מס׳ 12');
  assert.equal(DOC_LABEL[420], 'הפקדת בנק');
  assert.equal(totalLabel(420, 500), 'סה״כ הופקד');
  assert.equal(totalLabel(320, 118), 'סה״כ שולם');
});

// ---- 2. a document as it was: the new columns (null after 7000) change nothing ------------------------------------------------
test('a document issued before 7000 (series_location_id / deposit_id null) renders byte for byte as without the columns: HTML, PDF, C100, D110, D120, CSV', async () => {
  process.env.NEXT_PUBLIC_APP_VERSION = '';
  const { docBody } = await import('../src/features/documents/DocumentsTab');
  const { buildDocPdf } = await import('../src/lib/server/doc-pdf');
  const old = toDoc(inv({})), now = toDoc(inv({ series_location_id: null, deposit_id: null }));
  assert.deepEqual(now, old);
  assert.ok(!('seriesLocationId' in now) && !('depositId' in now));
  const b = { dealerNumber: BIZ.dealerNumber, companyNumber: '', name: BIZ.name };
  for (const mark of ['מקור', 'העתק נאמן למקור']) {
    assert.equal(h(docBody(now, BIZ, mark)), h(docBody(old, BIZ, mark)));
    assert.ok(docBody(now, BIZ, mark).includes('מס׳ 41</strong>'));
    const p1 = await buildDocPdf(old, BIZ, { mark, software: 'Dream Promotion', signed: false }), p2 = await buildDocPdf(now, BIZ, { mark, software: 'Dream Promotion', signed: false });
    for (const p of [p1, p2]) { p.setCreationDate(new Date('2026-01-01T00:00:00Z')); p.setModificationDate(new Date('2026-01-01T00:00:00Z')); }
    assert.equal(h(await p2.save({ useObjectStreams: false })), h(await p1.save({ useObjectStreams: false })));
  }
  assert.equal(C100(5, b, now), C100(5, b, old));
  assert.equal(col(C100(5, b, now), 26, 45), '41'.padEnd(20, ' '));
  assert.equal(col(C100(5, b, now), 409, 415), ' '.repeat(7), '1231 empty');
  assert.equal(D110(6, b, now, now.lines[0], 1), D110(6, b, old, old.lines[0], 1));
  assert.equal(D120(7, b, now, now.payments[0], 1), D120(7, b, old, old.payments[0], 1));
  assert.equal(documentsCsv([now]), documentsCsv([old]));
});

test('a business that did not switch: the whole file is the same with branches null / not per location — 1034 = 0, no branch field', () => {
  const docs = [toDoc(inv({})), toDoc(inv({ id: 'C', doc_type: 330, doc_number: 3, base_doc_type: 320, base_doc_number: 41, payments: [], location_id: LOC2 }))];
  const at = { from: '2026-11-01', to: '2026-11-30', startedAt: '2026-11-26T08:00:00Z', id: '123456789012345' };
  const a = buildOpenFormat(BIZ, SW, docs, at);
  const notPer: BranchInfo = { perLocation: false, businessId: BIZ_ID, codes: new Map([[BIZ_ID, '01'], [LOC2, '02']]) };
  for (const branches of [null, undefined, notPer]) {
    const f = buildOpenFormat(BIZ, SW, docs, { ...at, branches });
    assert.equal(f.bkmv, a.bkmv); assert.equal(f.ini, a.ini);
  }
  assert.equal(col(a.ini.split('\r\n')[0], 420, 420), '0', '1034 = 0');
});

// ---- 3. a business that numbers per location ----------------------------------------------------------------------------------
const BR: BranchInfo = { perLocation: true, businessId: BIZ_ID, codes: new Map([[BIZ_ID, '01'], [LOC2, '02']]) };
test('per location: 1204 / 1257 / 1304 with eight digits; 1034 = 1; 1231 / 1270 / 1274 / 1320 / 1421 = the branch code (positions from horaot-131.pdf)', () => {
  const sold = toDoc(inv({ id: 'S', doc_number: 2_000_003, location_id: LOC2, series_location_id: LOC2 }));
  // a credit after the switch is of the location that issues it (01); its base is 02's
  const credit = toDoc(inv({ id: 'K', doc_type: 330, doc_number: 1_000_001, location_id: null, series_location_id: BIZ_ID, base_doc_type: 320, base_doc_number: 2_000_003, payments: [] }));
  // an invoice of before the switch (the business's series), and a credit of it after
  const old = toDoc(inv({ id: 'O', doc_number: 40, location_id: LOC2 }));
  const credit2 = toDoc(inv({ id: 'K2', doc_type: 330, doc_number: 1_000_002, series_location_id: BIZ_ID, base_doc_type: 320, base_doc_number: 40, payments: [] }));
  const at = { from: '2026-11-01', to: '2026-11-30', startedAt: '2026-11-26T08:00:00Z', id: '123456789012345', branches: BR };
  const f = buildOpenFormat(BIZ, SW, [sold, credit, old, credit2], at);
  const recs = f.bkmv.split('\r\n').filter(Boolean);
  const LEN: Record<string, number> = { A100: 95, B110: 376, C100: 444, D110: 339, D120: 222, Z900: 110 };
  for (const r of recs) assert.equal(r.length, LEN[r.slice(0, 4)], r.slice(0, 4));
  assert.equal(col(f.ini.split('\r\n')[0], 420, 420), '1', '1034 = 1');
  assert.equal(f.ini.split('\r\n')[0].length, 466);
  const c100 = (n: string) => recs.find((r) => r.startsWith('C100') && col(r, 26, 45).trim() === n)!;
  assert.equal(col(c100('02000003'), 26, 45), '02000003'.padEnd(20, ' '), '1204');
  assert.equal(col(c100('02000003'), 409, 415), '02     ', '1231');
  assert.equal(col(c100('01000001'), 409, 415), '01     ', '1231 of the credit — the location that issued it');
  assert.equal(col(c100('40'), 409, 415), '02     ', '1231 of a document of before the switch — its location');
  const d110 = (n: string) => recs.find((r) => r.startsWith('D110') && col(r, 26, 45).trim() === n)!;
  assert.equal(col(d110('01000001'), 50, 52), '320'); assert.equal(col(d110('01000001'), 53, 72), '02000003'.padEnd(20, ' '), '1257');
  assert.equal(col(d110('01000001'), 290, 296), '01     ', '1270');
  assert.equal(col(d110('01000001'), 297, 304), '20261126', '1272 stays the document date');
  assert.equal(col(d110('01000001'), 312, 318), '02     ', "1274 — the base document's branch");
  assert.equal(col(d110('01000002'), 312, 318), '02     ', '1274 — a base of before the switch, found in the file');
  const d120 = recs.find((r) => r.startsWith('D120') && col(r, 26, 45).trim() === '02000003')!;
  assert.equal(col(d120, 141, 147), '02     ', '1320');
  const b110 = recs.filter((r) => r.startsWith('B110'));
  assert.ok(b110.length >= 1);
  assert.equal(col(b110[0], 336, 342), '02     ', '1421 — the branch of the account\'s first document in the file');
});

test('the base document\'s branch: from the file, from the lookup, else from its number (a series number carries its code)', () => {
  const k = toDoc(inv({ doc_type: 330, doc_number: 1_000_001, base_doc_type: 320, base_doc_number: 7, payments: [] }));
  assert.equal(baseBranchOf(BR, k), '', 'unknown base of the business series — never made up');
  assert.equal(baseBranchOf({ ...BR, baseLocations: new Map([['320:7', LOC2]]) }, k), '02');
  assert.equal(baseBranchOf({ ...BR, baseLocations: new Map([['320:7', null]]) }, k), '01', 'no location = the main one');
  assert.equal(baseBranchOf(BR, { baseDocType: 320, baseDocNumber: 2_000_009 }), '02');
  assert.equal(baseBranchOf(null, { baseDocType: 320, baseDocNumber: 2_000_009 }), '');
  assert.equal(branchOf(BR, null), '01'); assert.equal(branchOf(BR, LOC2), '02'); assert.equal(branchOf(BR, 'unknown'), '');
});

// ---- 4. the bank deposit, 420 -------------------------------------------------------------------------------------------------
const deposit = (o: Record<string, unknown> = {}) => toDoc({ ...base, id: 'P', doc_type: 420, doc_number: 5, customer_name: '', customer_phone: '', issuer,
  // issued at 00:30 Israel on 1.12 (22:30 UTC on 30.11) — the deposit is of 30.11 (its payments' date)
  issued_at: '2026-11-30T22:30:00Z', doc_date: '2026-12-01', deposit_id: 'dep-1', lines: [], vat_rate: 0,
  payments: [{ method: 1, m: 'cash', amount: 300, date: '2026-11-30' },
    { method: 2, m: 'cheque', amount: 200, date: '2026-11-30', cheque: { number: '1001', bank: '12', branch: '345', account: '678', dueDate: '2026-12-15' } }],
  before_discount: 500, discount: 0, after_discount: 500, vat_amount: 0, total: 500, ...o });
test('420 in the file: C100 (1203 = 420, 1216 = the deposit\'s day, 1219 = 1221 = 1223 = the amount, 1222 = 0, 1228), a D120 per payment, no D110', () => {
  const b = { dealerNumber: BIZ.dealerNumber, companyNumber: '', name: BIZ.name };
  const d = deposit();
  assert.ok(isDepositDoc(d)); assert.equal(d.depositId, 'dep-1'); assert.ok(NO_D110.has(420));
  const c = C100(2, b, d);
  assert.equal(c.length, 444);
  assert.equal(col(c, 23, 25), '420');
  assert.equal(col(c, 46, 53), '20261201', '1205 — the issue day in Israel (00:30, a new month)');
  assert.equal(col(c, 54, 57), '0030', '1206');
  assert.equal(col(c, 262, 269), '20261130', '1216 — the day of the deposit');
  assert.equal(col(c, 401, 408), '20261201', '1230 — the document date');
  assert.equal(col(c, 288, 302), '+00000000050000', '1219'); assert.equal(col(c, 303, 317), '+00000000000000', '1220');
  assert.equal(col(c, 318, 332), '+00000000050000', '1221'); assert.equal(col(c, 333, 347), '+00000000000000', '1222');
  assert.equal(col(c, 348, 362), '+00000000050000', '1223');
  assert.equal(col(c, 400, 400), ' ', '1228 — not cancelled');
  assert.equal(col(C100(2, b, { ...d, cancelled: true }), 400, 400), '1', '1228 — cancelled with its deposit');
  assert.equal(col(c, 375, 389), 'BANK'.padEnd(15, ' '), '1225 — the bank\'s account');
  const at = { from: '2026-11-01', to: '2026-12-31', startedAt: '2026-12-01T08:00:00Z', id: '123456789012345' };
  const f = buildOpenFormat(BIZ, SW, [d], at);
  const recs = f.bkmv.split('\r\n').filter(Boolean);
  assert.equal(recs.filter((r) => r.startsWith('D110')).length, 0);
  const d120 = recs.filter((r) => r.startsWith('D120'));
  assert.equal(d120.length, 2);
  assert.equal(col(d120[0], 50, 50), '1'); assert.equal(col(d120[0], 104, 118), '+00000000030000'); assert.equal(col(d120[0], 96, 103), '00000000', '1311 — cash: none');
  assert.equal(col(d120[1], 50, 50), '2'); assert.equal(col(d120[1], 51, 60), '0000000012'); assert.equal(col(d120[1], 61, 70), '0000000345');
  assert.equal(col(d120[1], 71, 85), '000000000000678'); assert.equal(col(d120[1], 86, 95), '0000001001'); assert.equal(col(d120[1], 96, 103), '20261215', '1311 — the cheque\'s due date');
  assert.equal(col(d120[1], 104, 118), '+00000000020000', '1312'); assert.equal(col(d120[1], 148, 155), '20261201', '1322');
  const b110 = recs.filter((r) => r.startsWith('B110'));
  assert.equal(b110.length, 1);
  assert.equal(col(b110[0], 23, 37), 'BANK'.padEnd(15, ' ')); assert.equal(col(b110[0], 88, 102), 'BANK'.padEnd(15, ' '), '1405 — its own code');
  assert.equal(col(b110[0], 293, 307), '+00000000000000', 'no debit'); assert.equal(col(b110[0], 308, 322), '+00000000000000', 'no credit');
  assert.deepEqual(accountsOf([d]).map((a) => [a.key.trim(), a.debitA, a.creditA, a.bank]), [['BANK', 0, 0, true]]);
  assert.equal(docTypeReport([d], at.from, at.to).find((x) => x.code === 420)!.count, 1);
  // a deposit next to a customer's documents: the customer's account is as without it
  const sale = toDoc(inv({ issued_at: '2026-11-26T07:30:00Z' }));
  assert.deepEqual(accountsOf([sale, d]).filter((a) => !a.bank), accountsOf([sale]));
  assert.equal(B110(1, b, accountsOf([sale])[0]), B110(1, b, accountsOf([sale, d])[0]));
});

test('420 on the screen: no customer and no lines — what was deposited', async () => {
  const { docBody } = await import('../src/features/documents/DocumentsTab');
  const html = docBody(deposit({ doc_number: 1_000_004, series_location_id: BIZ_ID }), BIZ, 'מסמך פנימי');
  assert.ok(html.includes('הפקדת בנק מס׳ 01000004'));
  assert.ok(html.includes('הפקדה לבנק'));
  assert.ok(!html.includes('לכבוד'));
  assert.ok(!html.includes('מסמך פנימי') && !html.includes('class="mark">'), 'a deposit is never delivered: no original / copy mark');
  assert.ok(html.includes('סה״כ הופקד'));
  assert.ok(html.includes('צ׳ק 1001'));
});

// ---- 5. the numbering's ranges, the summary, the deposit's document ----------------------------------------------------------
test('the numbering runs per series: a location\'s series and the business\'s are never one range (export holes, the day\'s report)', () => {
  const d = (t: number, n: number) => ({ docType: t, docNumber: n });
  const r = numberRanges([d(320, 40), d(320, 41), d(320, 1_000_001), d(320, 1_000_002), d(320, 2_000_001), d(400, 3)]);
  assert.deepEqual(r, [{ docType: 320, min: 40, max: 41, count: 2 }, { docType: 320, min: 1_000_001, max: 1_000_002, count: 2 },
    { docType: 320, min: 2_000_001, max: 2_000_001, count: 1 }, { docType: 400, min: 3, max: 3, count: 1 }]);
  assert.deepEqual(holesOf(r), []);
  assert.deepEqual(holesOf(numberRanges([d(320, 1_000_001), d(320, 1_000_003)])), [{ docType: 320, min: 1_000_001, max: 1_000_003, count: 2 }]);
  const day = '2026-11-26', at = '2026-11-26T08:00:00Z';
  assert.deepEqual(docRanges([{ docType: 320, docNumber: 41, issuedAt: at }, { docType: 320, docNumber: 1_000_001, issuedAt: at }, { docType: 320, docNumber: 1_000_002, issuedAt: at }], day),
    [{ docType: 320, from: 41, to: 41, count: 1 }, { docType: 320, from: 1_000_001, to: 1_000_002, count: 2 }]);
});

test('finance_summary: the deposits\' documents (420) are out of "documents"; every other type as the database answers', () => {
  const s = toSummary({ revenue: {}, expenses: {}, cash: {}, receivables: {}, pending: {}, posWithoutDocument: {},
    documents: { 320: { count: 2, total: 236, cancelled: 0 }, 420: { count: 1, total: 500, cancelled: 0 } } });
  assert.deepEqual(Object.keys(s.documents), ['320']);
  assert.deepEqual(toSummary({ revenue: {}, expenses: {}, cash: {}, receivables: {}, pending: {}, posWithoutDocument: {} }).documents, {});
});

test('the deposit\'s document from bank_deposit_create / deposit_book — the key only when it is there', () => {
  assert.deepEqual(toDepositDoc({ id: 'x', number: 1_000_004 }), { id: 'x', number: 1_000_004 });
  assert.equal(toDepositDoc(null), undefined); assert.equal(toDepositDoc({ id: '', number: 3 }), undefined);
  const [a, b] = toDeposits([{ id: 'a', number: 1, date: '2026-11-26', cash: 10, cheques: 0, total: 10, items: [], document: { id: 'd', number: 7 } },
    { id: 'b', number: 2, date: '2026-11-26', cash: 10, cheques: 0, total: 10, items: [] }]);
  assert.deepEqual(a.document, { id: 'd', number: 7 }); assert.ok(!('document' in b));
  assert.equal(depositDoneLabel(3, { id: 'd', number: 1_000_004 }), 'הפקדה 3 נרשמה · הופקה הפקדת בנק מס׳ 01000004');
  assert.equal(depositDoneLabel(3), 'הפקדה 3 נרשמה');
});

// ---- 6. the settings: the state, the codes, the refusals ----------------------------------------------------------------------
test('numbering settings: the state, who sees the card, the switch once, the branch codes', () => {
  assert.equal(toNumberingState(null), null); assert.equal(toNumberingState({}), null);
  const st = toNumberingState({ perLocation: false, since: null, activeLocations: 2, business: { 320: 41 },
    locations: [{ id: BIZ_ID, name: 'ראשי', active: true, branchCode: null, codeFixed: false, series: [] },
      { id: LOC2, name: 'סניף דמו', active: true, branchCode: '02', codeFixed: true, series: [{ docType: 320, count: 3, last: '02000003', next: '02000004' }] }] })!;
  assert.equal(st.business['320'], 41); assert.equal(st.locations[1].series[0].next, '02000004');
  assert.ok(showNumbering({ owner: true, multi: true, state: st }));
  assert.ok(!showNumbering({ owner: false, multi: true, state: st }), 'only the owner');
  assert.ok(!showNumbering({ owner: true, multi: false, state: st }), 'one active location: nothing');
  assert.ok(!showNumbering({ owner: true, multi: true, state: null }), 'before 7000: nothing');
  assert.ok(canSwitch(st)); assert.ok(!canSwitch({ ...st, perLocation: true }), 'one-way');
  assert.equal(SWITCH_CONFIRM, 'פעם אחת, אין דרך חזרה');
  assert.equal(normalizeCode('1'), '01'); assert.equal(normalizeCode(' 12 '), '12');
  assert.equal(branchCodeProblem('1', ['02']), ''); assert.equal(branchCodeProblem('00', []), NUMBERING_HE.branch_code_format);
  assert.equal(branchCodeProblem('100', []), NUMBERING_HE.branch_code_format); assert.equal(branchCodeProblem('02', ['02']), NUMBERING_HE.branch_code_taken);
  assert.equal(branchInfoOf(st, BIZ_ID), null, 'not switched — the file as before');
  const info = branchInfoOf({ ...st, perLocation: true }, BIZ_ID)!;
  assert.deepEqual([...info.codes], [[LOC2, '02']]);
});

test('the database\'s refusals of 7000 — in Hebrew, through financeError (no internal detail)', () => {
  const raw: Record<string, string> = {
    numbering_one_location: 'numbering_one_location: מספור לפי סניף — לעסק עם יותר מסניף פעיל אחד',
    numbering_long_series: 'numbering_long_series: לעסק כבר יש מספר מסמך של 7 ספרות',
    branch_code_format: 'branch_code_format: קוד סניף — שתי ספרות, 01 עד 99',
    branch_code_taken: 'branch_code_taken: הקוד הזה כבר של סניף אחר',
    branch_code_fixed: 'branch_code_fixed: קוד הסניף נקבע',
    branch_code_missing: 'branch_code_missing: לסניף אין קוד סניף (01–99)',
    series_full: 'series_full: הסדרה של הסניף הגיעה ל-999,999',
    deposit_document_only: 'deposit_document_only: מסמך הפקדה (420) מופק רק יחד עם ההפקדה',
    cancel_deposit_document: 'cancel_deposit_document: מסמך הפקדה מבוטל רק יחד עם ההפקדה',
  };
  for (const [code, message] of Object.entries(raw)) {
    assert.equal(financeError({ message, code: '23514' }), (NUMBERING_HE as Record<string, string>)[code], code);
    assert.equal(numberingError(message), (NUMBERING_HE as Record<string, string>)[code]);
  }
  assert.equal(numberingError('totals: a deposit document is the deposit\'s total'), null);
  assert.equal(numberingError('branch_code_location: a location of the business'), null);
});

test('A000: 1034 only from the switch (positions 420 of 466)', () => {
  const o = { id: '123456789012345', totalRecords: 9, path: 'X', from: '2026-01-01', to: '2026-12-31', startedAt: '2026-11-26T10:00:00Z' };
  const b = { dealerNumber: '000000109', name: 'עסק דמו', companyNumber: '' };
  assert.equal(A000(b, SW, o), A000(b, SW, { ...o, perLocation: false }));
  const a = A000(b, SW, { ...o, perLocation: true });
  assert.equal(a.length, 466); assert.equal(col(a, 420, 420), '1');
  assert.equal(a.slice(0, 419) + a.slice(420), A000(b, SW, o).slice(0, 419) + A000(b, SW, o).slice(420), 'nothing else changes');
});
