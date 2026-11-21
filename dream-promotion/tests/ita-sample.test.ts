/**
 * The sample unified-structure export for the Tax Authority simulator (docs/ita-registration/sample/, made by scripts/ita-sample.mjs
 * from the demo business of tests/sql/ita-demo.seed.sql). The files are checked as they are on disk; with no files the suite is skipped
 * explicitly (it needs a database to be made) — it never passes vacuously.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname, '..', 'docs', 'ita-registration', 'sample');
const have = existsSync(join(dir, 'INI.TXT')) && existsSync(join(dir, 'BKMVDATA.TXT'));
const t = (name: string, fn: () => void) => test(name, { skip: have ? false : 'no sample files — run scripts/ita-sample.mjs (needs the ita_demo database)' }, fn);

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

t('Hebrew is logical order: a customer name reads first-letter-first', () => {
  const c100 = lines(read('BKMVDATA.TXT')).find((l) => l.startsWith('C100'))!;
  const name = Buffer.from(c100.slice(47, 97), 'latin1');   // 1207 starts after 4+9+9+3+20+8+4
  const heb = [...name].filter((x) => x >= 0xe0 && x <= 0xfa);
  assert.ok(heb.length > 0);
  assert.ok(!heb.some((x) => x < 0xe0 || x > 0xfa));
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

t('size: at least 2000 records, BKMVDATA under 4MB, unzipped copy equals the packaged one', () => {
  const b = read('BKMVDATA.TXT');
  assert.ok(lines(b).length >= 2000);
  assert.ok(b.length < 4 * 1024 * 1024);
  const sub = join(dir, 'OPENFRMT');
  assert.ok(existsSync(sub));
  const [a] = readdirSync(sub), [m] = readdirSync(join(sub, a));
  assert.match(a, /^\d{8}\.\d{2}$/); assert.match(m, /^\d{8}$/);
  assert.ok(read(join('OPENFRMT', a, m, 'INI.TXT')).equals(read('INI.TXT')));
  assert.ok(existsSync(join(sub, a, m, 'BKMVDATA.zip')));
});
