/**
 * 2.118 — the second sample for the Tax Authority simulator: the exempt dealer of tests/sql/ita-demo.seed.sql (business
 * d3e00000-0000-4000-8000-000000000003, the fictitious dealer number 000000117), made by
 *   ITA_BUSINESS=d3e00000-0000-4000-8000-000000000003 npx -y tsx scripts/ita-sample.mjs docs/ita-registration/sample-exempt
 * The same structural checks as tests/ita-sample.test.ts, and what is new: receipts only (400 — no 305 / 320 / 330, no D110), and
 * the refund receipts (the accountant's answer 15) written with their own sign — C100 1219 / 1221 / 1223 and D120 1312 below
 * zero, 1220 / 1222 zero, a card refund with its kind (1315); in B110 the money given back is a debit. A missing file FAILS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';

const dir = join(__dirname, '..', 'docs', 'ita-registration', 'sample-exempt');
const ISSUER = '000000117';
const t = (name: string, fn: () => void | Promise<void>) => test(name, async () => {
  for (const f of ['INI.TXT', 'BKMVDATA.TXT']) assert.ok(existsSync(join(dir, f)), `missing ${join(dir, f)} — run: ITA_BUSINESS=d3e00000-0000-4000-8000-000000000003 npx -y tsx scripts/ita-sample.mjs docs/ita-registration/sample-exempt`);
  await fn();
});
const read = (f: string) => readFileSync(join(dir, f));
const lines = (b: Buffer) => { const s = b.toString('latin1'); assert.ok(s.endsWith('\r\n')); return s.slice(0, -2).split('\r\n'); };
const LEN: Record<string, number> = { A100: 95, B110: 376, C100: 444, D120: 222, Z900: 110 };
/** a signed amount X9(12)v99 → agorot */
const amt = (s: string) => { assert.match(s, /^[+-]\d{14}$/); return (s[0] === '-' ? -1 : 1) * Number(s.slice(1)); };
/** C100 1219–1223 start after 4+9+9+3+20+8+4+50+50+10+30+8+30+2+15+9+8+15+3 = 287, 15 each */
const c100Amounts = (l: string) => [0, 1, 2, 3, 4].map((i) => amt(l.slice(287 + 15 * i, 302 + 15 * i)));

t('ISO-8859-8: only valid bytes, CRLF after every line', () => {
  for (const f of ['INI.TXT', 'BKMVDATA.TXT']) {
    const b = read(f);
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      const ok = c === 0x0d ? b[i + 1] === 0x0a : c === 0x0a ? b[i - 1] === 0x0d : (c >= 0x20 && c <= 0x7e) || (c >= 0xe0 && c <= 0xfa);
      assert.ok(ok, `${f}: bad byte 0x${c.toString(16)} at ${i}`);
    }
    assert.ok(b.subarray(-2).equals(Buffer.from('\r\n')));
  }
});

t('fixed record lengths (A100 95, B110 376, C100 444, D120 222, Z900 110) — and no D110 at all', () => {
  for (const l of lines(read('BKMVDATA.TXT'))) { assert.ok(LEN[l.slice(0, 4)], `unexpected record ${l.slice(0, 4)}`); assert.equal(l.length, LEN[l.slice(0, 4)], l.slice(0, 14)); }
});

t('INI: A000 466, summaries 19 each and equal to the real counts; 1002 = lines = Z900 total; ids and the issuer match; numbers run 1..n', () => {
  const ini = lines(read('INI.TXT')), bk = lines(read('BKMVDATA.TXT'));
  assert.equal(ini[0].slice(0, 4), 'A000'); assert.equal(ini[0].length, 466);
  const counts: Record<string, number> = {};
  for (const l of bk) counts[l.slice(0, 4)] = (counts[l.slice(0, 4)] ?? 0) + 1;
  const sums = ini.slice(1);
  for (const s of sums) { assert.equal(s.length, 19); assert.equal(Number(s.slice(4)), counts[s.slice(0, 4).trim()], s); }
  assert.deepEqual(sums.map((s) => s.slice(0, 4)).sort(), ['B110', 'C100', 'D120']);
  assert.equal(Number(ini[0].slice(9, 24)), bk.length);
  assert.equal(Number(bk[bk.length - 1].slice(45, 60)), bk.length);
  const id = ini[0].slice(33, 48);
  assert.match(id, /^[1-9]\d{14}$/);
  assert.equal(bk[0].slice(22, 37), id); assert.equal(bk[bk.length - 1].slice(22, 37), id);
  assert.equal(ini[0].slice(24, 33), ISSUER, '1003');
  bk.forEach((l, i) => { assert.equal(Number(l.slice(4, 13)), i + 1); assert.equal(l.slice(13, 22), ISSUER); });
});

t('the packaged copy equals the unzipped one; the summaries name only the fictitious dealer number', async () => {
  const b = read('BKMVDATA.TXT');
  const sub = join(dir, 'OPENFRMT');
  const [a] = readdirSync(sub), [m] = readdirSync(join(sub, a));
  assert.match(a, /^\d{8}\.\d{2}$/); assert.match(m, /^\d{8}$/);
  assert.ok(read(join('OPENFRMT', a, m, 'INI.TXT')).equals(read('INI.TXT')));
  const zip = await JSZip.loadAsync(read(join('OPENFRMT', a, m, 'BKMVDATA.zip')));
  assert.deepEqual(Object.keys(zip.files), ['BKMVDATA.TXT']);
  assert.ok(Buffer.from(await zip.file('BKMVDATA.TXT')!.async('uint8array')).equals(b));
  for (const f of ['דוח-מסמכים-לפי-סוג.html', 'סיכום-הפקה-ממשק-פתוח.html']) {
    const s = read(f).toString('utf8');
    assert.ok(s.includes(ISSUER), f);
    assert.deepEqual([...new Set(s.match(/\d{9,}/g) ?? [])].filter((r) => r !== ISSUER), [], f);
  }
});

t('no real identifiers: customers\' numbers and phones are fictitious; 1015 / 1016 zero or fictitious', () => {
  const ini = lines(read('INI.TXT')), bk = lines(read('BKMVDATA.TXT'));
  for (const l of bk.filter((x) => x.startsWith('C100'))) {
    const dealer = l.slice(252, 261), phone = l.slice(237, 252);
    assert.ok(dealer === '000000000' || /^0{6}\d{3}$/.test(dealer), `1215 ${dealer}`);
    assert.ok(phone.trim() === '' || /^0[35]0?-?0{5}\d\d\s*$/.test(phone), `1214 ${phone}`);
    const fictitious = (s: string) => (s.match(/\d{7,}/g) ?? []).every((r) => (r.length === 7 ? /^0{5}/ : /^0{6}/).test(r));
    for (const s of [l.slice(57, 237), l.slice(374, 389), l.slice(415, 424)]) assert.ok(fictitious(s), `${l.slice(0, 13)}: ${s.trim()}`);
  }
  assert.match(ini[0].slice(186, 204), /^(0{9}|0{6}\d{3}){2}$/, '1015/1016');
});

t('an exempt dealer: receipts only — every C100 / D120 is a 400; no 305, 320, 330', () => {
  const bk = lines(read('BKMVDATA.TXT'));
  const types = new Set(bk.filter((l) => l.startsWith('C100') || l.startsWith('D120')).map((l) => l.slice(22, 25)));
  assert.deepEqual([...types], ['400']);
});

t('refund receipts (answer 15): C100 1219 / 1221 / 1223 below zero, 1220 / 1222 zero; their D120 1312 below zero and add up to 1223; a card one names its kind', () => {
  const bk = lines(read('BKMVDATA.TXT'));
  const c100 = bk.filter((l) => l.startsWith('C100'));
  const d120 = bk.filter((l) => l.startsWith('D120'));
  const neg = c100.filter((l) => c100Amounts(l)[4] < 0);
  assert.ok(neg.length >= 2, 'the seed has two refund receipts');
  for (const l of neg) {
    const [before, discount, after, vat, total] = c100Amounts(l);
    assert.deepEqual([discount, vat], [0, 0]);
    assert.ok(before < 0 && before === after && after === total);
    const no = l.slice(25, 45);
    const pays = d120.filter((p) => p.slice(25, 45) === no);
    assert.ok(pays.length > 0, `D120 of refund receipt ${no.trim()}`);
    assert.equal(pays.reduce((a, p) => a + amt(p.slice(103, 118)), 0), total, 'the payments add up to 1223');
    for (const p of pays) {
      assert.ok(amt(p.slice(103, 118)) < 0, '1312 below zero');
      if (p[49] === '3') assert.match(p[139], /^[1-5]$/, '1315 of a card refund'); else assert.equal(p[139], '0');
    }
  }
  // the receipts above zero stay above zero
  for (const l of c100.filter((x) => c100Amounts(x)[4] > 0)) assert.ok(c100Amounts(l).every((v, i) => (i === 1 || i === 3 ? v === 0 : v > 0)));
  // the refunds: one partial to a card, one whole in cash (the seed)
  const methods = neg.map((l) => d120.filter((p) => p.slice(25, 45) === l.slice(25, 45)).map((p) => p[49]).join());
  assert.ok(methods.includes('3') && methods.includes('1'), methods.join(' | '));
});

t('B110: every customer key of the C100s has one account; credit = its receipts, debit = the money given back (positive movements)', () => {
  const bk = lines(read('BKMVDATA.TXT'));
  const acc = new Map<string, { d: number; c: number }>();
  for (const l of bk.filter((x) => x.startsWith('C100'))) {
    const key = l.slice(374, 389), total = c100Amounts(l)[4], cancelled = l[399] === '1';
    const a = acc.get(key) ?? { d: 0, c: 0 }; acc.set(key, a);
    if (cancelled) continue;
    if (total < 0) a.d += -total; else a.c += total + Number(l.slice(362, 374).replace(/^\+/, ''));   // 1223 + 1224
  }
  const b110 = bk.filter((x) => x.startsWith('B110'));
  assert.equal(b110.length, acc.size);
  for (const l of b110) {
    const a = acc.get(l.slice(22, 37));
    assert.ok(a, `B110 ${l.slice(22, 37)} has no C100`);
    const open = l.slice(277, 292), debit = l.slice(292, 307), credit = l.slice(307, 322);   // 1414, 1415, 1416 (after 4+9+9+15+50+15+30+50+10+30+8+30+2+15 = 277)
    assert.equal(amt(open), 0);
    assert.ok(amt(debit) >= 0 && amt(credit) >= 0);
    assert.deepEqual([amt(debit), amt(credit)], [a!.d, a!.c], l.slice(22, 37));
  }
  assert.ok([...acc.values()].some((a) => a.d > 0), 'a customer was given money back');
});
