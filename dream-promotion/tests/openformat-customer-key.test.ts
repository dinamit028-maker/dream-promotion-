/**
 * 2.121 — field 1225 (C100) = the customer's account key in the books (public.gl_customer_key, migration 20261128007100):
 * glCustomerKey (customer-key.ts) does exactly what the SQL does, and customerKeyField writes it through X(…, 15).
 * A document of a customer whose key is not a system key's (four digits, or BANK) is written byte for byte as before 2.121.
 * Demo data only (fictitious names and numbers).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glCustomerKey, glKeyReserved } from '../src/features/documents/customer-key';
import { X, accountsOf, buildOpenFormat, customerKeyField, isoText, type Doc } from '../src/features/documents/openformat';

/** 2.121: a document dated on / after the books start gets the books' key (the plan's note 20) — "after" writes one of the start day */
const START = '2026-12-01';
const kf = (d: Parameters<typeof customerKeyField>[0]) => customerKeyField({ ...d, docDate: START }, START);
/** customerKeyField as it was in 2.120 — the reference for "byte for byte as before" */
const before = (d: Pick<Doc, 'customerPhone' | 'customerName'> & { docType?: number }) =>
  X(d.docType === 420 ? 'BANK' : (d.customerPhone || d.customerName || 'CASH'), 15);

test('the examples of tests/sql/books-core.check.sql — the same answers as public.gl_customer_key', () => {
  assert.equal(glCustomerKey('', ''), 'CASH');
  assert.equal(glCustomerKey(null, undefined), 'CASH');
  assert.equal(glCustomerKey('050-0000071', 'x'), '050-0000071', 'the phone first');
  assert.equal(glCustomerKey('', 'bank'), 'C-bank');
  assert.equal(glCustomerKey('', '1100-1'), 'C-1100-1');
  assert.equal(glCustomerKey('', '1300'), 'C-1300', 'the 320 of inst6: "C-1300"');
  const long = 'שם ארוך מאוד של לקוחה לדוגמה';
  assert.equal(glCustomerKey('', long), Array.from(long).slice(0, 15).join('').replace(/ +$/, ''), 'rtrim(left(name, 15))');
});

test('the "C-" rule: four digits (a location\'s "-n" of one or two digits) or BANK in any case, with spaces around it', () => {
  for (const k of ['1100', '0000', '9100', '1100-1', '1150-12', 'BANK', 'bank', 'Bank', ' BANK', 'bank ']) assert.ok(glKeyReserved(k), k);
  for (const k of ['110', '11000', '1100-', '1100-123', '1100 1', 'BANKS', 'B ANK', 'בנק', '١١٠٠', '1100\n', '\u00A0BANK', 'BANK\u200F', '050-0000001']) {
    assert.ok(!glKeyReserved(k), JSON.stringify(k));
  }
  assert.equal(glCustomerKey('1234', 'דנה'), 'C-1234', 'a phone of four digits');
  assert.equal(glCustomerKey('', '  bank'), 'C-bank', 'the name is trimmed first (step 1), then "C-"');
  assert.equal(glCustomerKey('', '1150-12'), 'C-1150-12');
  assert.equal(glCustomerKey('', 'BANKS'), 'BANKS');
  // C100 1225 of such a customer is not the bank's / the account's key any more — never one account with the deposit (420)
  const d: Doc = { docType: 305, docNumber: 1, linkNo: 1, issuedAt: '2026-11-10T09:00:00Z', docDate: '2026-11-10', customerName: 'Bank', customerPhone: '',
    beforeDiscount: 100, discount: 0, afterDiscount: 100, vatAmount: 18, total: 118, lines: [], payments: [] };
  assert.equal(customerKeyField(d, '2026-11-01'), X('C-Bank', 15), 'after the start');
  assert.equal(customerKeyField(d, '2026-12-01'), X('Bank', 15), 'before the start — as it was');
  assert.equal(customerKeyField(d), X('Bank', 15), 'no books (before 7100) — as it was');
  assert.equal(customerKeyField({ ...d, docType: 420 }, '2026-11-01'), X('BANK', 15), 'the deposit keeps BANK');
  const accounts = accountsOf([d, { ...d, docType: 420, docNumber: 2, customerName: '', payments: [{ method: 1, amount: 50, date: '2026-11-10' }] }], null, '2026-11-01');
  assert.deepEqual(accounts.map((a) => [a.key.trimEnd(), Boolean(a.bank)]), [['C-Bank', false], ['BANK', true]], 'two accounts, not one');
});

test('the key is cut to 15 characters (code points — as Postgres left()), trailing spaces off, an empty one is CASH', () => {
  assert.equal(glCustomerKey('', 'אבגדהוזחטיכלמנסעפ'), 'אבגדהוזחטיכלמנס');
  assert.equal(glCustomerKey('', 'דנה כהן        x'), 'דנה כהן', 'the 15 characters end in spaces → rtrim');
  assert.equal(glCustomerKey('   ', 'דנה'), 'דנה', 'a phone of spaces only is empty after cleaning — the name');
  assert.equal(glCustomerKey('', '😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀'), '😀'.repeat(15), 'an emoji is one character (not two UTF-16 units)');
  assert.equal(glCustomerKey('', '\u00A0דנה\u00A0'), '\u00A0דנה\u00A0', 'rtrim removes plain spaces only');
});

test('Hebrew names and isoText: the key is cleaned as the file writes text, then cut; the file writes X(key, 15) — the same 15 characters in 1225 and in B110 1403', () => {
  const names = ['דנה דמו', 'מס׳ 5 בע״מ', 'שירותי ניקיון ״הכוכב״ — דמו', 'קפה ₪ דמו', 'דנה\u200F כהן', 'נִיקוּד דמו'];
  for (const name of names) {
    const d = { customerName: name, customerPhone: '' };
    assert.equal(kf(d), X(glCustomerKey('', name), 15), name);
    assert.equal(kf(d).length, 15);
  }
  // a name of up to 15 characters: byte for byte as before (isoText makes geresh / gershayim / dashes plain, ₪ is ש"ח, marks drop)
  for (const name of ['מס׳ 5 בע״מ', 'קפה ₪ דמו', 'דנה\u200F כהן', 'נִיקוּד דמו', 'דנה — דמו']) {
    assert.equal(kf({ customerName: name }), before({ customerName: name }), name);
  }
  assert.equal(kf({ customerName: 'מס׳ 5 בע״מ' }).trimEnd(), "מס' 5 בע\"מ");
  // longer than 15 with a mark that isoText drops inside the first 15 characters: cleaned first, then cut (db-agent, 27.11.2026) —
  // the file has the same 15 characters as before 2.121
  const marked = 'דנה\u200Fכהןלוימרכזדמו';
  assert.equal(kf({ customerName: marked }).trimEnd(), isoText(marked).slice(0, 15));
  assert.equal(kf({ customerName: marked }), before({ customerName: marked }));
});

test('the cleaning (step 1) — the cases of the brain\'s list, as public.gl_customer_key answers them (db-agent, 27.11.2026)', () => {
  const RLM = '\u200F', LRM = '\u200E', BOM = '\uFEFF', ZWSP = '\u200B';
  assert.equal(glCustomerKey(`${RLM}050-0000071${LRM}`, 'x'), '050-0000071');
  assert.equal(glCustomerKey(`${LRM}${BOM}`, 'דנה'), 'דנה', 'a phone of marks only is empty — the name');
  assert.equal(glCustomerKey('', 'שָׁלוֹם'), 'שלום', 'the points dropped');
  assert.equal(glCustomerKey('', 'דנה\r\n\nכהן'), 'דנה כהן', 'a run of CR / LF is one space');
  assert.equal(glCustomerKey('', `${ZWSP.repeat(20)}abcdefghijklmnopq`), 'abcdefghijklmno', 'dropped before the cut');
  assert.equal(glCustomerKey('', '   abc  '), 'abc', 'leading spaces trimmed too');
  assert.equal(glCustomerKey('\u2066 \u2069', ''), 'CASH');
  assert.equal(glCustomerKey('', `${LRM}1300`), 'C-1300', 'a mark does not hide a system key');
  assert.equal(glCustomerKey('', 'בית\u05BEקפה'), 'בית\u05BEקפה', 'the maqaf is kept (isoText writes it "-")');
  assert.equal(glCustomerKey('', 'abcdefghijklm\rxyz'), 'abcdefghijklm x');
  assert.equal(glCustomerKey(null, null), 'CASH');
});

test('the dropped characters are exactly isoText\'s: every code point of U+0000–U+FFFF is dropped by both or by neither', () => {
  for (let c = 0; c <= 0xffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const ch = String.fromCharCode(c);
    const byIso = isoText(`a${ch}b`) === 'ab';
    const byKey = glCustomerKey('', `a${ch}b`) === 'ab';
    if (byIso !== byKey) assert.fail(`U+${c.toString(16).padStart(4, '0')}: isoText ${byIso ? 'drops' : 'keeps'} it, the key ${byKey ? 'drops' : 'keeps'} it`);
  }
});

test('a business with no such customer: the whole export is byte for byte as before 2.121', () => {
  const biz = { dealerNumber: '000000109', name: 'עסק דמו' };
  const sw = { regNumber: '00000000', name: 'Dream Promotion', version: '2.121.0', vendorVat: '000000109', vendorName: 'Dream Promotion' };
  const who = [{ name: 'דנה דמו', phone: '050-0000001' }, { name: 'שם ארוך מאוד של לקוחה לדוגמה', phone: '' }, { name: '', phone: '' }, { name: 'מס׳ 5 בע״מ', phone: '' }];
  const docs: Doc[] = who.map((w, i) => ({ docType: 305, docNumber: i + 1, linkNo: i + 1, issuedAt: '2026-11-10T09:00:00Z', docDate: '2026-11-10',
    customerName: w.name, customerPhone: w.phone, beforeDiscount: 100, discount: 0, afterDiscount: 100, vatAmount: 18, total: 118,
    lines: [{ name: 'שורה', qty: 1, unitPriceExVat: 100, discountExVat: 0, totalExVat: 100, vatRate: 18, kind: 1 }], payments: [] }));
  for (const d of docs) { assert.equal(customerKeyField(d), before(d)); assert.equal(customerKeyField(d, '2026-11-01'), before(d), 'after the start too'); }
  const f = buildOpenFormat(biz, sw, docs, { from: '2026-11-01', to: '2026-11-30', startedAt: '2026-11-25T08:00:00Z', id: '123456789012345' });
  assert.equal((f.counts as Record<string, number>).B110, 4);
  for (const d of docs) assert.ok(f.bkmv.includes(before(d)), 'every key of before is in the file');
});

test('note 20: the books\' key only from the books start — an older document (a customer named "1234") exports exactly as before', () => {
  const biz = { dealerNumber: '000000109', name: 'עסק דמו' };
  const sw = { regNumber: '00000000', name: 'Dream Promotion', version: '2.121.0', vendorVat: '000000109', vendorName: 'Dream Promotion' };
  const doc = (n: number, docDate: string, name: string, phone = ''): Doc => ({ docType: 305, docNumber: n, linkNo: n, issuedAt: `${docDate}T09:00:00Z`, docDate,
    customerName: name, customerPhone: phone, beforeDiscount: 100, discount: 0, afterDiscount: 100, vatAmount: 18, total: 118,
    lines: [{ name: 'שורה', qty: 1, unitPriceExVat: 100, discountExVat: 0, totalExVat: 100, vatRate: 18, kind: 1 }], payments: [] });
  const at = { from: '2026-11-01', to: '2026-12-31', startedAt: '2026-12-25T08:00:00Z', id: '123456789012345' };
  const old = [doc(1, '2026-11-20', '1234'), doc(2, '2026-11-30', '  דנה'), doc(3, '2026-11-30', 'bank')];
  // before the start: the file is the file of no books at all, byte for byte (the keys "1234", "  דנה", "bank" as they were)
  const none = buildOpenFormat(biz, sw, old, at);
  const withStart = buildOpenFormat(biz, sw, old, { ...at, booksStart: '2026-12-01' });
  assert.equal(withStart.bkmv, none.bkmv);
  assert.equal(withStart.ini, none.ini);
  assert.ok(none.bkmv.includes(X('1234', 15)) && !none.bkmv.includes('C-1234'));
  // the same customer on the start day and after: "C-1234" — its own B110, next to the old key's
  const both = [...old, doc(4, '2026-12-01', '1234')];
  const f = buildOpenFormat(biz, sw, both, { ...at, booksStart: '2026-12-01' });
  assert.equal(customerKeyField(both[3], '2026-12-01'), X('C-1234', 15));
  assert.equal(customerKeyField(both[0], '2026-12-01'), X('1234', 15), 'a day before the start — as before');
  const b110 = f.bkmv.split('\r\n').filter((r) => r.startsWith('B110')).map((r) => r.slice(22, 37).trimEnd());
  assert.deepEqual(b110.sort(), ['  דנה', '1234', 'C-1234', 'bank'].sort());
  const c100 = f.bkmv.split('\r\n').filter((r) => r.startsWith('C100'));
  // 1225 of each C100 (after 1219–1224: 9 + 5 × 15 + 3 + 15 … — found as the key written X(…, 15)) is one of the B110 keys
  const keys = both.map((d) => customerKeyField(d, '2026-12-01'));
  c100.forEach((r, i) => { assert.ok(r.includes(keys[i]), `C100 ${i + 1} carries its key`); assert.ok(b110.includes(keys[i].trimEnd())); });
});

test('2.122 (7200): a supplier\'s key "S-…" is never a customer\'s — the examples of tests/sql/books-more.check.sql', () => {
  assert.equal(glCustomerKey('', 'S-000000067'), 'C-S-000000067');
  assert.equal(glCustomerKey('', 'S-ספקלדוגמה'), 'C-S-ספקלדוגמה');
  assert.equal(glCustomerKey('S-0000000000001', ''), 'C-S-00000000000', 'the phone first, cut to 15, then "C-" and 15 again');
  assert.equal(Array.from(glCustomerKey('S-0000000000001', '')).length, 15);
  assert.equal(glCustomerKey('', 's-abc'), 's-abc', 'case-sensitive (LIKE \'S-%\')');
  assert.equal(glCustomerKey('', 'S abc'), 'S abc', 'a space is not the dash');
  assert.ok(glKeyReserved('S-x') && glKeyReserved('S-'));
  for (const k of ['S', 'XS-1', ' S-1', 's-1', 'S–1', 'Ｓ-1']) assert.ok(!glKeyReserved(k), JSON.stringify(k));
  assert.equal(glCustomerKey('', '  S-12'), 'C-S-12', 'the name is trimmed first (step 1), then reserved');
  // the file: from the books' start 1225 is the books' key; before it — the legacy key, exactly as before
  const d = { customerName: 'S-000000067', customerPhone: '' };
  assert.equal(customerKeyField({ ...d, docDate: START }, START), X('C-S-000000067', 15), 'from the start');
  assert.equal(customerKeyField({ ...d, docDate: '2026-11-30' }, START), before(d), 'the day before the start — unchanged');
  assert.equal(customerKeyField({ ...d, docDate: '2026-11-30' }, START), X('S-000000067', 15));
  assert.equal(customerKeyField(d), before(d), 'no books (before 7100) — unchanged');
});
