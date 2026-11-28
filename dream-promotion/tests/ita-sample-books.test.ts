/**
 * 2.124 (stage 4ה) — the sample of a unified file FROM THE BOOKS (docs/ita-registration/sample-books/, made by
 * scripts/ita-sample.mjs after scripts/ita-sample-books.sql, from the fictitious licensed demo business of tests/sql/ita-demo.seed.sql,
 * books from 1.6.2026). The files as they are on disk — a missing file FAILS (no skip). What the Tax Authority's simulator checks
 * that can be checked here: the bytes (ISO-8859-8, CRLF), every record's fixed length (B100 317, B110 376 — spec p. 8), the
 * running record number, INI's summaries = the real counts, A000 1002 = Z900's total, 1013 = 2 / 1014 = 1, every entry balanced
 * (1014 = 1: per 1353), every 1364 / 1225 / 1413 an account of the file and 1403 once, and each B110's 1415 / 1416 = Σ its B100.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname, '..', 'docs', 'ita-registration', 'sample-books');
const t = (name: string, fn: () => void) => test(name, () => {
  for (const f of ['INI.TXT', 'BKMVDATA.TXT']) assert.ok(existsSync(join(dir, f)), `missing ${join(dir, f)} — run scripts/ita-sample-books.sql, then ITA_FROM=2026-06-01 npx -y tsx scripts/ita-sample.mjs docs/ita-registration/sample-books`);
  fn();
});
const read = (f: string) => readFileSync(join(dir, f));
const lines = (b: Buffer) => { const s = b.toString('latin1'); assert.ok(s.endsWith('\r\n')); return s.slice(0, -2).split('\r\n'); };
const col = (s: string, from: number, to: number) => s.slice(from - 1, to);
const LEN: Record<string, number> = { A100: 95, B100: 317, B110: 376, C100: 444, D110: 339, D120: 222, Z900: 110 };

t('bytes: ISO-8859-8 only (ASCII printable, Hebrew E0–FA), CRLF after every record', () => {
  for (const f of ['INI.TXT', 'BKMVDATA.TXT']) {
    const b = read(f);
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      const ok = c === 0x0d ? b[i + 1] === 0x0a : c === 0x0a ? b[i - 1] === 0x0d : (c >= 0x20 && c <= 0x7e) || (c >= 0xe0 && c <= 0xfa);
      assert.ok(ok, `${f}: bad byte 0x${c.toString(16)} at ${i}`);
    }
  }
});

t('lengths, running numbers, INI summaries, 1002 = Z900 total, 1013 = 2 / 1014 = 1', () => {
  const bk = lines(read('BKMVDATA.TXT')), ini = lines(read('INI.TXT'));
  const counts: Record<string, number> = {};
  bk.forEach((l, i) => {
    const k = l.slice(0, 4);
    assert.equal(l.length, LEN[k], `record ${i + 1} ${k}`);
    assert.equal(Number(col(l, 5, 13)), i + 1);
    counts[k] = (counts[k] ?? 0) + 1;
  });
  assert.ok(counts.B100 > 1000 && counts.B110 > 10, 'a real sample: more than 1,000 movements');
  assert.equal(ini[0].length, 466); assert.equal(col(ini[0], 185, 186), '21');
  assert.equal(Number(col(ini[0], 10, 24)), bk.length); assert.equal(Number(col(bk.at(-1)!, 46, 60)), bk.length);
  const sums = Object.fromEntries(ini.slice(1).map((l) => { assert.equal(l.length, 19); return [l.slice(0, 4), Number(l.slice(4))]; }));
  for (const k of ['B100', 'B110', 'C100', 'D110', 'D120']) assert.equal(sums[k], counts[k], `INI ${k}`);
  assert.equal(Object.keys(sums).length, 5);
});

t('the books tie: entries balance, every key is an account (once), each account\'s 1415 / 1416 = Σ its movements', () => {
  const bk = lines(read('BKMVDATA.TXT'));
  const keys = bk.filter((l) => l.startsWith('B110')).map((l) => col(l, 23, 37));
  assert.equal(new Set(keys).size, keys.length, '1403 once');
  const tx = new Map<string, number>(), per = new Map<string, [number, number]>();
  const from = col(lines(read('INI.TXT'))[0], 367, 374), to = col(lines(read('INI.TXT'))[0], 375, 382);
  for (const l of bk.filter((x) => x.startsWith('B100'))) {
    const a = Number(col(l, 208, 221)), side = col(l, 203, 203), k = col(l, 173, 187);
    assert.ok(side === '1' || side === '2'); assert.equal(col(l, 207, 207), '+'); assert.ok(a > 0);
    assert.ok(keys.includes(k), `1364 ${k.trim()} has no B110`);
    assert.ok(col(l, 157, 164) >= from && col(l, 157, 164) <= to, '1362 in the period');
    tx.set(col(l, 23, 32), (tx.get(col(l, 23, 32)) ?? 0) + (side === '1' ? a : -a));
    const s = per.get(k) ?? [0, 0]; s[side === '1' ? 0 : 1] += a; per.set(k, s);
  }
  for (const [n, v] of tx) assert.equal(v, 0, `entry ${Number(n)} balances`);
  for (const l of bk.filter((x) => x.startsWith('B110'))) {
    const k = col(l, 23, 37);
    assert.deepEqual([Number(col(l, 294, 307)), Number(col(l, 309, 322))], per.get(k) ?? [0, 0], `B110 ${k.trim()}`);
    assert.equal(col(l, 278, 292), '+00000000000000', '1414: the period starts on the books\' start — 0');
    const p = col(l, 263, 277); if (p.trim()) assert.ok(keys.includes(p), `1413 ${p.trim()}`);
  }
  for (const l of bk.filter((x) => x.startsWith('C100'))) assert.ok(keys.includes(col(l, 375, 389)), `1225 ${col(l, 375, 389).trim()}`);
});
