/**
 * 2.124 (stage 4ה) — the unified file from the double-entry books: B100 (§4.6, p. 15), B110 from the books (§4.7, p. 16), A000
 * 1013 = 2 / 1014 = 1 (p. 10), the INI summaries and Z900 with B100, 1225 of C100 = 1403 of B110, a period across the books'
 * start refused, the books read from the database's answers (report_journal / report_trial_balance / gl_accounts). Every column
 * below is the spec's (horaot-131.pdf, pdftotext, checked 28.11.2026). And a file of a period BEFORE the books is byte for byte
 * the file of 2.123 (sha256 computed with the code of main at 9183fb0). Demo data only (fictitious numbers, no real business).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  A000, B100, B100_KIND, B110, BOOKS_FILE_BROKEN, BOOKS_PERIOD_SPLIT, booksAccountsOf, booksFileProblems, booksPeriod, buildOpenFormat, customerKeyField, toIso88598,
  type BookTx, type BooksFile,
} from '../src/features/documents/openformat';
import { glCustomerKey } from '../src/features/documents/customer-key';
import { booksFileOf } from '../src/features/documents/openformat-books';
import { biz, branches, dana, doc, firm, novemberDocs, sw } from './openformat-books.fixture';

const col = (s: string, from: number, to: number) => s.slice(from - 1, to);
const recs = (s: string) => s.split('\r\n').filter(Boolean);
const sha = (f: { ini: string; bkmv: string }) => createHash('sha256').update(toIso88598(f.ini)).update(toIso88598(f.bkmv)).digest('hex');
const START = '2026-12-01';
const DANA = glCustomerKey(dana.phone, dana.name), FIRM = glCustomerKey(firm.phone, firm.name);

// ---- the books of a fictitious December, as the database answers (report_journal's entries; amounts as JSON numbers) ----
const entries = [
  { id: 't1', number: 1, date: '2026-12-01', valueDate: '2026-12-01', enteredOn: '2026-12-01', sourceKind: 'opening', details: 'יתרות פתיחה', locationId: 'biz-demo',
    ref1Type: null, ref1Number: null, ref2Type: null, ref2Number: null,
    lines: [{ lineNo: 1, account: 'BANK', side: 'D', amount: 5000, valueDate: '2026-12-01' }, { lineNo: 2, account: DANA, side: 'D', amount: 120.5, valueDate: '2026-12-01' },
            { lineNo: 3, account: '3100', side: 'C', amount: 5120.5, valueDate: '2026-12-01' }] },
  // a 320 issued at 00:30 Israel time on the 1st (2026-11-30T22:30Z): the database's dates are Israel's — 1.12.2026
  { id: 't2', number: 2, date: '2026-12-01', valueDate: '2026-12-01', enteredOn: '2026-12-01', sourceKind: 'document', details: 'חשבונית מס / קבלה 1', locationId: 'loc-2',
    ref1Type: 320, ref1Number: '02000001', ref2Type: null, ref2Number: null,
    lines: [{ lineNo: 1, account: '1100-2', side: 'D', amount: 236, valueDate: '2026-12-01' }, { lineNo: 2, account: '4100', side: 'C', amount: 200, valueDate: '2026-12-01' },
            { lineNo: 3, account: '2200', side: 'C', amount: 36, valueDate: '2026-12-01' }] },
  { id: 't3', number: 3, date: '2026-12-02', valueDate: '2026-12-02', enteredOn: '2026-12-02', sourceKind: 'document', details: 'חשבונית מס 2', locationId: 'biz-demo',
    ref1Type: 305, ref1Number: '2', ref2Type: null, ref2Number: null,
    lines: [{ lineNo: 1, account: FIRM, side: 'D', amount: 1180, valueDate: '2026-12-02', match1: 'D305-2' }, { lineNo: 2, account: '4100', side: 'C', amount: 1000, valueDate: '2026-12-02' },
            { lineNo: 3, account: '2200', side: 'C', amount: 180, valueDate: '2026-12-02' }] },
  // a receipt paid by card in 2 installments (answer 8): a line per installment with its own value date
  { id: 't4', number: 4, date: '2026-12-31', valueDate: '2026-12-31', enteredOn: '2027-01-01', sourceKind: 'document', details: 'קבלה 3', locationId: 'biz-demo',
    ref1Type: 400, ref1Number: '3', ref2Type: 305, ref2Number: '2',
    lines: [{ lineNo: 1, account: '1250', side: 'D', amount: 590, valueDate: '2026-12-31' }, { lineNo: 2, account: '1250', side: 'D', amount: 590, valueDate: '2027-01-31' },
            { lineNo: 3, account: FIRM, side: 'C', amount: 1180, valueDate: '2026-12-31', match1: 'D305-2', match2: 'BANK-7' }] },
];
const journal = (es = entries) => ({ from: START, to: '2026-12-31', count: es.length, entries: es });
/** the trial balance the database computes (report_trial_balance) — here from the same entries, by their date */
function trialBalance(es: typeof entries, from: string, to: string) {
  const m = new Map<string, { key: string; opening: number; debit: number; credit: number }>();
  for (const e of es) {
    if (e.date > to) continue;
    for (const l of e.lines) {
      const a = m.get(l.account) ?? { key: l.account, opening: 0, debit: 0, credit: 0 };
      const v = Math.round(l.amount * 100);
      if (e.date < from) a.opening += l.side === 'D' ? v : -v; else if (l.side === 'D') a.debit += v; else a.credit += v;
      m.set(l.account, a);
    }
  }
  return { from, to, accounts: [...m.values()].map((a) => ({ key: a.key, name: '', opening: a.opening / 100, debit: a.debit / 100, credit: a.credit / 100 })) };
}
const acc = (key: string, name: string, tb_code: string, tb_name: string, more: Record<string, unknown> = {}) =>
  ({ key, name, tb_code, tb_name, parent_key: null, role: null, dealer_number: null, street: '', city: '', location_id: null, ...more });
const accounts = [
  acc('BANK', 'בנק', 'BANK', 'בנק', { role: 'bank' }), acc('1100-2', 'קופת מזומן — סניף דמו 2', '1100', 'קופות מזומן', { location_id: 'loc-2', role: 'cash:loc-2' }),
  acc('1250', 'חברות כרטיסי אשראי (סליקה)', '1250', 'חברות כרטיסי אשראי'), acc('1300', 'לקוחות', 'CUSTOMERS', 'לקוחות', { role: 'customers' }),
  acc('2200', 'מע״מ עסקאות', '2200', 'מע״מ עסקאות'), acc('3100', 'יתרות פתיחה', '3100', 'יתרות פתיחה'), acc('4100', 'הכנסות משירותים', '4000', 'הכנסות'),
  acc(DANA, dana.name, 'CUSTOMERS', 'לקוחות', { parent_key: '1300', role: `customer:${DANA}`, street: dana.street, city: dana.city }),
  acc(FIRM, firm.name, 'CUSTOMERS', 'לקוחות', { parent_key: '1300', role: `customer:${FIRM}`, dealer_number: firm.dealer }),
  acc('6117', 'אחר', '6100', 'הוצאות'),   // no movement — not in the file
];
const users = [{ id: 't2', user_id: 'u-demo-1' }, { id: 't3', user_id: 'u-demo-1' }];
const books = (from = START, to = '2026-12-31', es = entries): BooksFile => {
  const r = booksFileOf({ start: START, journal: journal(es.filter((e) => e.date >= from && e.date <= to)), trialBalance: trialBalance(es, from, to), accounts, users });
  assert.ok(r.ok, 'the answers make books');
  return r.books;
};
const decDocs = () => {
  const d = novemberDocs().map((x) => ({ ...x }));
  const dec = [
    { ...doc(320, '2026-12-01', dana, 200), issuedAt: '2026-11-30T22:30:00Z', locationId: 'loc-2' },
    doc(305, '2026-12-02', firm, 1000), doc(200, '2026-12-03', { name: 'לקוח הזמנה בלבד', phone: '050-0000009' }, 70, { payments: [] }),
  ];
  return [...d, ...dec];
};
const at = { from: START, to: '2026-12-31', startedAt: '2026-11-30T22:30:00Z', id: '123456789012345' };

test('a period before the books: the file is byte for byte the file of 2.123 (sha256 from main 9183fb0) — also with books given none', () => {
  const nov = { from: '2026-11-01', to: '2026-11-30', startedAt: '2026-11-30T22:30:00Z', id: '123456789012345' };
  const docs = novemberDocs();
  assert.equal(sha(buildOpenFormat(biz, sw, docs, nov)), '20d87d82764845fdb364964c735361a99b0d8e6d3825fbddc8bf80b96d05700d');
  assert.equal(sha(buildOpenFormat(biz, sw, docs, { ...nov, booksStart: START, books: null })), '20d87d82764845fdb364964c735361a99b0d8e6d3825fbddc8bf80b96d05700d');
  assert.equal(sha(buildOpenFormat(biz, sw, docs, { ...nov, booksStart: START, branches, codes: new Map([['u-demo-1', 'U01']]) })),
    '2951250bbaf4328f6e2cedd7d464b05f9938680194628c0da74a49e3dbf7714d');
  const f = buildOpenFormat(biz, sw, docs, nov);
  assert.equal(col(f.ini, 185, 185), '0'); assert.equal(col(f.ini, 186, 186), '0');
  assert.ok(!recs(f.bkmv).some((l) => l.startsWith('B100')));
  assert.deepEqual(Object.keys(f.counts), ['A100', 'B110', 'C100', 'D110', 'D120', 'Z900'], 'no B100 count at all');
});

test('booksPeriod: before / from the start / across it; the message asks to split the period, with both dates', () => {
  assert.equal(booksPeriod('2026-11-01', '2026-11-30', START), 'single');
  assert.equal(booksPeriod('2026-11-01', '2026-11-30', null), 'single');
  assert.equal(booksPeriod('2026-12-01', '2026-12-01', START), 'books');
  assert.equal(booksPeriod('2027-01-01', '2027-12-31', START), 'books');
  assert.equal(booksPeriod('2026-11-30', '2026-12-01', START), 'straddle');
  assert.equal(booksPeriod('2026-01-01', '2026-12-31', START), 'straddle');
  const m = BOOKS_PERIOD_SPLIT(START);
  assert.ok(m.includes('01.12.2026') && m.includes('30.11.2026') && /שני קבצים/.test(m), m);
  assert.ok(BOOKS_PERIOD_SPLIT('2027-03-01').includes('28.02.2027'), 'the day before the 1st of March 2027');
  // books given for a period across the start (or before it) — never written
  assert.throws(() => buildOpenFormat(biz, sw, decDocs(), { ...at, from: '2026-11-15', books: books() }), { message: BOOKS_FILE_BROKEN });
});

test('B100 — 317 long, every field in the spec\'s columns (§4.6, p. 15)', () => {
  const t: BookTx = { number: 4, date: '2026-12-31', enteredOn: '2027-01-01', sourceKind: 'document', details: 'קבלה 3', ref1Type: 400, ref1Number: '3', ref2Type: 305, ref2Number: '01000002',
    locationId: 'loc-2', userId: 'u-demo-1', lines: [] };
  const r = B100(17, biz, t, { lineNo: 2, account: '1250', side: 'D', amountA: 59050, valueDate: '2027-01-31', match1: 'D305-2', match2: 'BANK-7' }, '02', 'U01');
  assert.equal(r.length, 317);
  const want: [number, number, string][] = [
    [1, 4, 'B100'], [5, 13, '000000017'], [14, 22, '000000109'], [23, 32, '0000000004'], [33, 37, '00002'], [38, 45, '00000000'],
    [46, 60, 'מסמך'.padEnd(15)], [61, 80, '3'.padEnd(20)], [81, 83, '400'], [84, 103, '01000002'.padEnd(20)], [104, 106, '305'],
    [107, 156, 'קבלה 3'.padEnd(50)], [157, 164, '20261231'], [165, 172, '20270131'], [173, 187, '1250'.padEnd(15)], [188, 202, ' '.repeat(15)],
    [203, 203, '1'], [204, 206, '   '], [207, 221, '+00000000059050'], [222, 236, '+00000000000000'], [237, 248, '+00000000000'],
    [249, 258, 'D305-2    '], [259, 268, 'BANK-7    '], [269, 275, '02     '], [276, 283, '20270101'], [284, 292, 'U01      '], [293, 317, ' '.repeat(25)],
  ];
  for (const [a, z, v] of want) assert.equal(col(r, a, z), v, `B100 ${a}–${z}`);
  // a credit line: 1366 = 2, the amount still positive (§2.4יא); no reference — 1357–1360 empty / 0
  const c = B100(1, biz, { ...t, ref1Number: null, ref2Number: null }, { lineNo: 1, account: '4100', side: 'C', amountA: 1, valueDate: '' });
  assert.equal(col(c, 203, 203), '2'); assert.equal(col(c, 207, 221), '+00000000000001');
  assert.equal(col(c, 61, 106), ' '.repeat(20) + '000' + ' '.repeat(20) + '000');
  assert.equal(col(c, 165, 172), '20261231', 'no value date of its own — the entry\'s date');
  assert.equal(col(c, 269, 275) + col(c, 284, 292), ' '.repeat(16), 'no branch (1034 = 0), no code');
  for (const k of Object.values(B100_KIND)) assert.ok(k.length <= 15, k);
});

test('B110 from the books — 376 long, the spec\'s columns (§4.7, p. 16): code, name, trial balance, address, IL, parent, 1414 signed, 1419, branch', () => {
  const later = books('2027-01-01', '2027-01-31');                 // January: the December entries are the opening balance
  const as = booksAccountsOf(later, [], branches);
  const firmA = as.find((a) => a.key.trimEnd() === FIRM)!, ob = as.find((a) => a.key.trimEnd() === '3100')!;
  const r = B110(2, biz, firmA);
  assert.equal(r.length, 376);
  const want: [number, number, string][] = [
    [1, 4, 'B110'], [5, 13, '000000002'], [14, 22, '000000109'], [23, 37, FIRM.padEnd(15)], [38, 87, firm.name.padEnd(50)],
    [88, 102, 'CUSTOMERS'.padEnd(15)], [103, 132, 'לקוחות'.padEnd(30)], [133, 182, ' '.repeat(50)], [183, 192, ' '.repeat(10)],
    [223, 230, ' '.repeat(8)], [231, 260, ' '.repeat(30)], [261, 262, 'IL'], [263, 277, '1300'.padEnd(15)],
    [278, 292, '+00000000000000'], [293, 307, '+00000000000000'], [308, 322, '+00000000000000'], [323, 326, '0000'], [327, 335, firm.dealer],
    [336, 342, '01     '], [343, 357, '+00000000000000'], [358, 360, '   '], [361, 376, ' '.repeat(16)],
  ];
  for (const [a, z, v] of want) assert.equal(col(r, a, z), v, `B110 ${a}–${z}`);
  // 3100 has a credit balance from December: 1414 negative (§2.4יא); a system account: no 1412, no 1419; trial-balance code its own
  const o = B110(3, biz, ob);
  assert.equal(col(o, 278, 292), '-00000000512050');
  assert.equal(col(o, 261, 262), '  '); assert.equal(col(o, 327, 335), '000000000'); assert.equal(col(o, 88, 102), '3100'.padEnd(15));
  // a location's cash account: its own branch (1421); December's: 1414 = 0 is "+", the period's movements in 1415 / 1416
  const dec = booksAccountsOf(books(), [], branches);
  const cash = B110(4, biz, dec.find((a) => a.key.trimEnd() === '1100-2')!);
  assert.equal(col(cash, 336, 342), '02     '); assert.equal(col(cash, 278, 292), '+00000000000000'); assert.equal(col(cash, 293, 307), '+00000000023600');
  const d = B110(5, biz, dec.find((a) => a.key.trimEnd() === DANA)!);
  assert.equal(col(d, 133, 182), dana.street.padEnd(50)); assert.equal(col(d, 193, 222), dana.city.padEnd(30));
  assert.equal(col(d, 327, 335), '000000000', 'a private customer — 1419 = 0 (answer 10)');
});

test('the whole file from the books: A000 1013 = 2 / 1014 = 1; B110, B100, then the documents; INI and Z900 count B100; every key ties', () => {
  const f = buildOpenFormat(biz, sw, decDocs(), { ...at, books: books(), codes: new Map([['u-demo-1', 'U01']]), branches });
  const ini = recs(f.ini), bk = recs(f.bkmv);
  assert.equal(ini[0].length, 466); assert.equal(col(ini[0], 185, 185), '2'); assert.equal(col(ini[0], 186, 186), '1');
  assert.equal(col(ini[0], 420, 420), '1', '1034 as before');
  assert.equal(col(ini[0], 383, 390), '20261201', '1026: 00:30 Israel time on 1.12 is 1.12 (not 30.11 UTC)');
  const LEN: Record<string, number> = { A100: 95, B100: 317, B110: 376, C100: 444, D110: 339, D120: 222, Z900: 110 };
  bk.forEach((l, i) => { assert.equal(l.length, LEN[l.slice(0, 4)], l.slice(0, 13)); assert.equal(Number(col(l, 5, 13)), i + 1); });
  const kinds = bk.map((l) => l.slice(0, 4));
  assert.deepEqual([...new Set(kinds)], ['A100', 'B110', 'B100', 'C100', 'D110', 'D120', 'Z900'].filter((k) => kinds.includes(k)));
  assert.ok(kinds.lastIndexOf('B110') < kinds.indexOf('B100') && kinds.lastIndexOf('B100') < kinds.indexOf('C100'));
  const n = (k: string) => kinds.filter((x) => x === k).length;
  assert.equal(n('B100'), 12, 'one B100 per line of the four entries');
  assert.equal(f.counts.B100, 12); assert.equal(f.counts.B110, n('B110'));
  for (const k of ['B100', 'B110', 'C100', 'D110', 'D120']) assert.ok(ini.includes(k + String(n(k)).padStart(15, '0')), `INI ${k}`);
  assert.equal(Number(col(bk.at(-1)!, 46, 60)), bk.length, 'Z900 total'); assert.equal(Number(col(ini[0], 10, 24)), bk.length, 'A000 1002');
  // 1403 unique; every 1364 and every 1225 an account of the file; 1413 too
  const b110 = bk.filter((l) => l.startsWith('B110')).map((l) => col(l, 23, 37));
  assert.equal(new Set(b110).size, b110.length);
  for (const l of bk.filter((x) => x.startsWith('B100'))) assert.ok(b110.includes(col(l, 173, 187)), `1364 ${col(l, 173, 187)}`);
  const c1225 = bk.filter((x) => x.startsWith('C100')).map((l) => col(l, 375, 389));
  for (const k of c1225) assert.ok(b110.includes(k), `1225 ${k}`);
  assert.ok(c1225.includes(DANA.padEnd(15)) && c1225.includes(FIRM.padEnd(15)), 'the books\' customer key (answer 20)');
  for (const l of bk.filter((x) => x.startsWith('B110'))) { const p = col(l, 263, 277); if (p.trim()) assert.ok(b110.includes(p), `1413 ${p}`); }
  // the customer of a delivery note only (no entry): a card of its own, CUSTOMERS under 1300, no movements
  const only = bk.find((l) => l.startsWith('B110') && col(l, 38, 87).startsWith('לקוח הזמנה בלבד'))!;
  assert.equal(col(only, 88, 102), 'CUSTOMERS'.padEnd(15)); assert.equal(col(only, 263, 277), '1300'.padEnd(15)); assert.equal(col(only, 278, 322), '+00000000000000'.repeat(3));
  // the account without a movement (6117) is not written; the deposit's key BANK is the books' own BANK account
  assert.ok(!b110.includes('6117'.padEnd(15)));
  assert.equal(b110.filter((k) => k === 'BANK'.padEnd(15)).length, 1);
  // B100: Σ debit = Σ credit, and per account = its B110's 1415 / 1416
  const per = new Map<string, { d: number; c: number }>();
  for (const l of bk.filter((x) => x.startsWith('B100'))) {
    const s = per.get(col(l, 173, 187)) ?? { d: 0, c: 0 };
    if (col(l, 203, 203) === '1') s.d += Number(col(l, 208, 221)); else s.c += Number(col(l, 208, 221));
    per.set(col(l, 173, 187), s);
  }
  for (const l of bk.filter((x) => x.startsWith('B110'))) {
    const s = per.get(col(l, 23, 37)) ?? { d: 0, c: 0 };
    assert.deepEqual([Number(col(l, 294, 307)), Number(col(l, 309, 322))], [s.d, s.c], `sums of ${col(l, 23, 37)}`);
  }
  // the entry of the 320 at 00:30 on the 1st: 1362 / 1375 the Israel day; its location 02; 1376 the person's code; the installments' value dates
  const t2 = bk.filter((l) => l.startsWith('B100') && col(l, 23, 32) === '0000000002');
  assert.ok(t2.every((l) => col(l, 157, 164) === '20261201' && col(l, 276, 283) === '20261201' && col(l, 269, 275) === '02     ' && col(l, 284, 292) === 'U01      '));
  assert.equal(col(t2[0], 61, 83), '02000001'.padEnd(20) + '320');
  const t4 = bk.filter((l) => l.startsWith('B100') && col(l, 23, 32) === '0000000004');
  assert.deepEqual(t4.map((l) => col(l, 165, 172)), ['20261231', '20270131', '20261231']);
  assert.equal(col(t4[2], 276, 283), '20270101', '1375: written on 1.1.2027 (month and year change) — the entry stays in December');
  assert.deepEqual(t4.map((l) => col(l, 249, 268).trimEnd()), ['', '', 'D305-2    BANK-7']);
  assert.equal(col(t4[0], 284, 292), ' '.repeat(9), 'no person for the entry — empty');
});

test('never a file from books that are not whole: an unbalanced entry, an account missing, sums that are not the lines\'', () => {
  const ok = books();
  assert.deepEqual(booksFileProblems(ok), []);
  const unbalanced = structuredClone(ok); unbalanced.transactions[1].lines[1].amountA += 1;
  assert.ok(booksFileProblems(unbalanced).includes('tx_balance'));
  const missing = structuredClone(ok); missing.accounts = missing.accounts.filter((a) => a.key !== '2200');
  assert.ok(booksFileProblems(missing).includes('line_account'));
  const sums = structuredClone(ok); sums.accounts[0].debitA += 100;
  assert.ok(booksFileProblems(sums).includes('account_sums'));
  const twice = structuredClone(ok); twice.accounts.push({ ...twice.accounts[0] });
  assert.ok(booksFileProblems(twice).includes('account_key_twice'));
  for (const b of [unbalanced, missing, sums, twice]) {
    assert.throws(() => buildOpenFormat(biz, sw, decDocs(), { ...at, books: b }), (e: Error) => e.message === BOOKS_FILE_BROKEN && !/\d{3}/.test(e.message));
  }
});

test('booksFileOf: the database\'s answers → the books; parents in; "?" (an account of a hidden location) and an unknown key refused', () => {
  const b = books();
  assert.deepEqual(b.accounts.map((a) => a.key), [...b.accounts.map((a) => a.key)].sort());
  assert.ok(b.accounts.some((a) => a.key === '1300'), '1300 — the customers\' parent (1413) — though it has no movement');
  assert.ok(!b.accounts.some((a) => a.key === '6117'));
  assert.equal(b.accounts.find((a) => a.key === DANA)!.openingA, 0);
  assert.equal(b.accounts.find((a) => a.key === DANA)!.debitA, 12050, '120.50 → agorot');
  assert.equal(b.transactions[1].userId, 'u-demo-1'); assert.equal(b.transactions[0].userId, null);
  assert.equal(b.transactions[3].lines[2].match2, 'BANK-7');
  const hidden = structuredClone(entries); hidden[1].lines[0].account = '?';
  assert.deepEqual(booksFileOf({ start: START, journal: journal(hidden), trialBalance: trialBalance(hidden, START, '2026-12-31'), accounts }), { ok: false, problem: 'hidden_account' });
  assert.deepEqual(booksFileOf({ start: START, journal: journal(), trialBalance: trialBalance(entries, START, '2026-12-31'), accounts: accounts.filter((a) => a.key !== '4100') }),
    { ok: false, problem: 'account_missing' });
  assert.deepEqual(booksFileOf({ start: START, journal: null, trialBalance: {}, accounts }), { ok: false, problem: 'bad_answer' });
  // a period that does not start on the books' start: the balance before it in 1414, only its own entries in B100
  const jan = books('2027-01-01', '2027-01-31');
  assert.equal(jan.transactions.length, 0);
  assert.equal(jan.accounts.find((a) => a.key === 'BANK')!.openingA, 500000);
  assert.equal(jan.accounts.find((a) => a.key === '1250')!.openingA, 118000);
});

test('1225 of a document from the books\' start = its customer\'s account key in the books (gl_customer_key) — 1403 of the same B110', () => {
  const d = decDocs().find((x) => x.docType === 305 && x.docDate >= START)!;
  assert.equal(customerKeyField(d, START), FIRM.padEnd(15));
  const f = buildOpenFormat(biz, sw, decDocs(), { ...at, books: books() });
  const c = recs(f.bkmv).find((l) => l.startsWith('C100') && col(l, 23, 25) === '305')!;
  const a = recs(f.bkmv).find((l) => l.startsWith('B110') && col(l, 23, 37) === col(c, 375, 389))!;
  assert.equal(col(a, 293, 307), '+00000000118000', 'the account the books charged');
  // A000 without books, the same arguments otherwise: 0 / 0
  const plain = A000(biz, sw, { id: '1', totalRecords: 1, path: 'x', from: START, to: START, startedAt: at.startedAt });
  assert.equal(col(plain, 185, 186), '00');
  assert.equal(col(A000(biz, sw, { id: '1', totalRecords: 1, path: 'x', from: START, to: START, startedAt: at.startedAt, books: true }), 185, 186), '21');
});
