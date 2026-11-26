/**
 * 2.120 — the sample for the Tax Authority simulator (docs/ita-registration/sample/, scripts/ita-sample.mjs on the demo business of
 * tests/sql/ita-demo.seed.sql) after the business switched to numbering per location (migration 20261127007000; the accountant's
 * answers 5 and 18): two locations, branch codes 01 / 02, documents of each location's series, a credit at 01 on an invoice of 02,
 * and two bank deposits (420) — one cancelled. Positive checks of the new records only, as the files are on disk (a missing file
 * FAILS — regenerate with scripts/ita-sample.mjs; needs the ita_demo database). Field positions: horaot-131.pdf (checked 26.11.2026).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toIso88598 } from '../src/features/documents/openformat';

const dir = join(__dirname, '..', 'docs', 'ita-registration', 'sample');
const read = (f: string) => { assert.ok(existsSync(join(dir, f)), `missing ${join(dir, f)} — run: npx -y tsx scripts/ita-sample.mjs`); return readFileSync(join(dir, f)); };
const lines = (b: Buffer) => b.toString('latin1').slice(0, -2).split('\r\n');
const col = (s: string, from: number, to: number) => s.slice(from - 1, to);   // 1-based, inclusive
const bk = () => lines(read('BKMVDATA.TXT'));
const num = (r: string) => col(r, 26, 45).trimEnd();                           // 1204 / 1304 (C100 / D110 / D120 — the same columns)
const type = (r: string) => col(r, 23, 25);
const amt = (s: string) => (s[0] === '-' ? -1 : 1) * Number(s.slice(1));
const SERIES = ['01000001', '01000002', '02000001', '02000002'];

test('1034 = 1 — the business numbers per location (A000, column 420)', () => {
  const a000 = lines(read('INI.TXT'))[0];
  assert.equal(a000.length, 466);
  assert.equal(col(a000, 420, 420), '1');
});

test('the document number is written the same way everywhere: a location\'s series with eight digits, the business\'s as before', () => {
  const recs = bk().filter((r) => /^(C100|D110|D120)$/.test(r.slice(0, 4)));
  const nums = new Set(recs.map(num));
  for (const n of SERIES) assert.ok(nums.has(n), `${n} is in the file`);
  for (const r of recs) {
    const n = num(r);
    assert.match(n, /^(0[1-9]\d{6}|[1-9]\d{0,5})$/, `${r.slice(0, 13)} 1204/1304: ${n}`);   // 8 digits with the code, or the old series without zeros
  }
  // every D110 / D120 belongs to a C100 of the same type and number (as written)
  const heads = new Set(recs.filter((r) => r.startsWith('C100')).map((r) => `${type(r)}:${num(r)}`));
  for (const r of recs.filter((x) => !x.startsWith('C100'))) assert.ok(heads.has(`${type(r)}:${num(r)}`), `${r.slice(0, 13)} has its C100`);
  // 1257 (a base number) — the same form: the credit 01000001 names 02000001
  const credit = recs.filter((r) => r.startsWith('D110') && type(r) === '330' && num(r) === '01000001');
  assert.ok(credit.length >= 1);
  for (const r of credit) { assert.equal(col(r, 50, 52), '320', '1256'); assert.equal(col(r, 53, 72), '02000001'.padEnd(20, ' '), '1257'); }
  for (const r of recs.filter((x) => x.startsWith('D110') && col(x, 53, 72).trim())) assert.match(col(r, 53, 72).trim(), /^(0[1-9]\d{6}|[1-9]\d{0,5})$/, '1257');
});

test('the branch fields: 01 / 02 by the document\'s location (1231, 1270, 1320), the base\'s (1274), every account (1421)', () => {
  const recs = bk();
  const branchOf = (n: string) => (n.startsWith('02') && n.length === 8 ? '02     ' : '01     ');
  for (const r of recs.filter((x) => x.startsWith('C100'))) assert.equal(col(r, 409, 415), branchOf(num(r)), `C100 ${type(r)} ${num(r)} 1231`);
  for (const r of recs.filter((x) => x.startsWith('D110'))) {
    assert.equal(col(r, 290, 296), branchOf(num(r)), `D110 ${type(r)} ${num(r)} 1270`);
    assert.match(col(r, 297, 304), /^2026\d{4}$/, '1272 stays the document date');
    const baseNo = col(r, 53, 72).trim();
    assert.equal(col(r, 312, 318), baseNo ? branchOf(baseNo) : '       ', `D110 ${type(r)} ${num(r)} 1274`);
  }
  assert.equal(col(recs.find((x) => x.startsWith('D110') && type(x) === '330' && num(x) === '01000001')!, 312, 318), '02     ', "1274 — the credit's base is of 02");
  for (const r of recs.filter((x) => x.startsWith('D120'))) assert.equal(col(r, 141, 147), branchOf(num(r)), `D120 ${type(r)} ${num(r)} 1320`);
  for (const r of recs.filter((x) => x.startsWith('B110'))) assert.match(col(r, 336, 342), /^0[12] {5}$/, `B110 ${col(r, 23, 37).trim()} 1421`);
});

test('the bank deposits (420): C100 as designed, a D120 per payment adding up to 1223, no D110; the bank\'s account', () => {
  const recs = bk();
  const heads = recs.filter((r) => r.startsWith('C100') && type(r) === '420');
  assert.deepEqual(heads.map(num), ['01000001', '02000001']);
  assert.equal(recs.filter((r) => r.startsWith('D110') && type(r) === '420').length, 0, 'no D110 for a deposit');
  for (const c of heads) {
    const total = amt(col(c, 348, 362));
    assert.ok(total > 0);
    assert.equal(amt(col(c, 288, 302)), total, '1219'); assert.equal(amt(col(c, 318, 332)), total, '1221');
    assert.equal(amt(col(c, 303, 317)), 0, '1220'); assert.equal(amt(col(c, 333, 347)), 0, '1222');
    assert.equal(amt(col(c, 363, 374)), 0, '1224');
    assert.ok(Buffer.from(col(c, 58, 107), 'latin1').subarray(0, 3).equals(Buffer.from(toIso88598('בנק'))), '1207 — the bank');
    assert.equal(col(c, 375, 389), 'BANK'.padEnd(15, ' '), '1225');
    assert.match(col(c, 262, 269), /^2026\d{4}$/, '1216 — the day of the deposit');
    const pays = recs.filter((r) => r.startsWith('D120') && type(r) === '420' && num(r) === num(c));
    assert.ok(pays.length >= 1);
    assert.equal(pays.reduce((a, r) => a + amt(col(r, 104, 118)), 0), total, 'the D120 lines add up to 1223');
    for (const r of pays) {
      assert.match(col(r, 50, 50), /^[12]$/, '1306 — cash or a cheque');
      if (col(r, 50, 50) === '2') {
        assert.match(col(r, 61, 70), /^0{7}[1-9]\d{2}$/, '1308 — a bank branch');
        assert.match(col(r, 86, 95), /^0*[1-9]\d*$/, '1310 — the cheque number');
        assert.match(col(r, 96, 103), /^2026\d{4}$/, '1311 — its due date');
      } else assert.equal(col(r, 96, 103), '00000000', '1311 — none for cash');
      assert.equal(col(r, 148, 155), col(c, 401, 408), '1322 = 1230');
    }
  }
  assert.equal(col(heads[0], 400, 400), ' ', '1228 — 01000001 is not cancelled');
  assert.equal(col(heads[1], 400, 400), '1', '1228 — 02000001 was cancelled with its deposit');
  const bank = recs.filter((r) => r.startsWith('B110') && col(r, 23, 37) === 'BANK'.padEnd(15, ' '));
  assert.equal(bank.length, 1);
  assert.equal(col(bank[0], 88, 102), 'BANK'.padEnd(15, ' '), '1405');
  assert.equal(amt(col(bank[0], 293, 307)), 0, '1415'); assert.equal(amt(col(bank[0], 308, 322)), 0, '1416');
});

test('the printout of 2.6(ב) counts the deposits (420) with the file', () => {
  const html = read('דוח-מסמכים-לפי-סוג.html').toString('utf8');
  assert.match(html, /<td>420<\/td><td>הפקדת בנק<\/td><td>2<\/td>/);
});
