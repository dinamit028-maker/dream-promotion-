/**
 * The sample unified-structure export for the Tax Authority simulator (docs/ita-registration/sample/, made by scripts/ita-sample.mjs
 * from the demo business of tests/sql/ita-demo.seed.sql). The files are checked as they are on disk; a missing file FAILS (no skip):
 * the sample is committed, regenerate it with scripts/ita-sample.mjs (needs the ita_demo database).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { toIso88598 } from '../src/features/documents/openformat';

const dir = join(__dirname, '..', 'docs', 'ita-registration', 'sample');
const t = (name: string, fn: () => void | Promise<void>) => test(name, async () => {
  for (const f of ['INI.TXT', 'BKMVDATA.TXT']) assert.ok(existsSync(join(dir, f)), `missing ${join(dir, f)} — run: npx -y tsx scripts/ita-sample.mjs (needs the ita_demo database)`);
  await fn();
});

const read = (f: string) => readFileSync(join(dir, f));
const lines = (b: Buffer) => { const s = b.toString('latin1'); assert.ok(s.endsWith('\r\n')); return s.slice(0, -2).split('\r\n'); };
const LEN: Record<string, number> = { A100: 95, C100: 444, D110: 339, D120: 222, Z900: 110 };

t('ISO-8859-8: only valid bytes (ASCII printable, Hebrew letters E0-FA), CRLF after every line', () => {
  for (const f of ['INI.TXT', 'BKMVDATA.TXT']) {
    const b = read(f);
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      const ok = c === 0x0d ? b[i + 1] === 0x0a : c === 0x0a ? b[i - 1] === 0x0d : (c >= 0x20 && c <= 0x7e) || (c >= 0xe0 && c <= 0xfa);
      assert.ok(ok, `${f}: bad byte 0x${c.toString(16)} at ${i}`);
    }
    assert.ok(b.subarray(-2).equals(Buffer.from('\r\n')), `${f} ends with CRLF`);
    assert.ok(!b.includes(Buffer.from('\n\n')) && !b.includes(Buffer.from('\r\r')));
  }
});

t('Hebrew is logical order: a known seed name is in BKMVDATA exactly as toIso88598 writes it (and not reversed)', () => {
  const seed = readFileSync(join(__dirname, 'sql', 'ita-demo.seed.sql'), 'utf8');
  const name = 'קליניקה גליל';
  assert.ok(seed.includes(name), 'the seed no longer has the name used here');
  const want = Buffer.from(toIso88598(name));
  const rev = Buffer.from(toIso88598([...name].reverse().join('')));
  assert.notDeepEqual(want, rev);
  const bk = read('BKMVDATA.TXT');
  assert.ok(bk.includes(want), 'name not found as written');
  assert.ok(!bk.includes(rev), 'name found reversed');
  const c100 = lines(bk).find((l) => l.startsWith('C100') && Buffer.from(l.slice(57, 107), 'latin1').subarray(0, want.length).equals(want));   // 1207 starts at 4+9+9+3+20+8+4 = 57
  assert.ok(c100, 'no C100 has the name at the start of field 1207');
});

t('fixed record lengths: A100 95, C100 444, D110 339, D120 222, Z900 110; nothing else in BKMVDATA', () => {
  for (const l of lines(read('BKMVDATA.TXT'))) { assert.ok(LEN[l.slice(0, 4)], `unknown record ${l.slice(0, 4)}`); assert.equal(l.length, LEN[l.slice(0, 4)], l.slice(0, 14)); }
});

t('INI: A000 is 466, each summary line 19; summaries equal the real counts; 1002 = lines = Z900 total', () => {
  const ini = lines(read('INI.TXT')), bk = lines(read('BKMVDATA.TXT'));
  assert.equal(ini[0].slice(0, 4), 'A000'); assert.equal(ini[0].length, 466);
  const counts: Record<string, number> = {};
  for (const l of bk) counts[l.slice(0, 4)] = (counts[l.slice(0, 4)] ?? 0) + 1;
  const sums = ini.slice(1);
  assert.ok(sums.length > 0);
  for (const s of sums) { assert.equal(s.length, 19); assert.equal(Number(s.slice(4)), counts[s.slice(0, 4).trim()], s); }
  assert.deepEqual(sums.map((s) => s.slice(0, 4)).sort(), ['C100', 'D110', 'D120']);
  const total = Number(ini[0].slice(9, 24));                        // 1002
  assert.equal(total, bk.length);
  assert.equal(Number(bk[bk.length - 1].slice(45, 60)), bk.length); // Z900 total (after 4+9+9+15+8 = 45)
  assert.equal(counts.A100, 1); assert.equal(counts.Z900, 1); assert.equal(bk[0].slice(0, 4), 'A100');
});

t('the primary id (1004 / 1103 / 1153) and the dealer number match across A000, A100, Z900; record numbers run 1..n', () => {
  const ini = lines(read('INI.TXT')), bk = lines(read('BKMVDATA.TXT'));
  const idA000 = ini[0].slice(33, 48), idA100 = bk[0].slice(22, 37), idZ900 = bk[bk.length - 1].slice(22, 37);
  assert.match(idA000, /^[1-9]\d{14}$/);
  assert.equal(idA100, idA000); assert.equal(idZ900, idA000);
  assert.equal(bk[0].slice(13, 22), ini[0].slice(24, 33));
  assert.ok(ini[0].includes('&OF1.31&') && bk[0].includes('&OF1.31&'));
  bk.forEach((l, i) => assert.equal(Number(l.slice(4, 13)), i + 1));
  for (const l of bk) assert.equal(l.slice(13, 22), bk[0].slice(13, 22));
});

t('size: at least 2000 records, BKMVDATA under 4MB, unzipped copy equals the packaged one byte for byte', async () => {
  const b = read('BKMVDATA.TXT');
  assert.ok(lines(b).length >= 2000);
  assert.ok(b.length < 4 * 1024 * 1024);
  const sub = join(dir, 'OPENFRMT');
  assert.ok(existsSync(sub));
  const [a] = readdirSync(sub), [m] = readdirSync(join(sub, a));
  assert.match(a, /^\d{8}\.\d{2}$/); assert.match(m, /^\d{8}$/);
  assert.ok(read(join('OPENFRMT', a, m, 'INI.TXT')).equals(read('INI.TXT')));
  const zip = await JSZip.loadAsync(read(join('OPENFRMT', a, m, 'BKMVDATA.zip')));
  assert.deepEqual(Object.keys(zip.files), ['BKMVDATA.TXT']);
  assert.ok(Buffer.from(await zip.file('BKMVDATA.TXT')!.async('uint8array')).equals(b));
});

t('no real identifiers: none of the old demo numbers as a whole field, nor as text, in any produced file', () => {
  const old = ['301911202', '58000001', '55000006', '517000055', '311111116', '1234501'];
  const files = ['INI.TXT', 'BKMVDATA.TXT', 'דוח-מסמכים-לפי-סוג.html', 'סיכום-הפקה-ממשק-פתוח.html'];
  for (const f of files) { const s = read(f).toString('latin1'); for (const n of old) assert.ok(!s.includes(n), `${f} has ${n}`); }
  // positive check of every identifying field: the issuer is the fictitious 000000109 everywhere; customers' ids and phones are the fictitious shapes
  const ini = lines(read('INI.TXT')), bk = lines(read('BKMVDATA.TXT'));
  assert.equal(ini[0].slice(24, 33), '000000109', '1003');
  for (const l of bk) assert.equal(l.slice(13, 22), '000000109', `${l.slice(0, 4)} ${l.slice(4, 13)}: 1103/1153/1203/1253/1303`);
  for (const l of bk.filter((x) => x.startsWith('C100'))) {
    const dealer = l.slice(252, 261), phone = l.slice(237, 252);   // 1215 (after 1214), 1214
    assert.ok(dealer === '000000000' || /^0{6}\d{3}$/.test(dealer), `1215 ${dealer}`);
    assert.ok(phone.trim() === '' || /^0[35]0?-0{5}\d\d\s*$/.test(phone), `1214 ${phone}`);
  }
  assert.ok(!read('INI.TXT').toString('latin1').includes('5550000'));
});
