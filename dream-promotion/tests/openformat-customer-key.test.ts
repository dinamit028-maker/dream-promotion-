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
  assert.equal(glCustomerKey('', '  bank'), 'C-  bank', 'btrim — only for the test; the key keeps its spaces (as the SQL)');
  assert.equal(glCustomerKey('', '1150-12'), 'C-1150-12');
  assert.equal(glCustomerKey('', 'BANKS'), 'BANKS');
  // C100 1225 of such a customer is not the bank's / the account's key any more — never one account with the deposit (420)
  const d: Doc = { docType: 305, docNumber: 1, linkNo: 1, issuedAt: '2026-11-10T09:00:00Z', docDate: '2026-11-10', customerName: 'Bank', customerPhone: '',
    beforeDiscount: 100, discount: 0, afterDiscount: 100, vatAmount: 18, total: 118, lines: [], payments: [] };
  assert.equal(customerKeyField(d), X('C-Bank', 15));
  assert.equal(customerKeyField({ ...d, docType: 420 }), X('BANK', 15), 'the deposit keeps BANK');
  const accounts = accountsOf([d, { ...d, docType: 420, docNumber: 2, customerName: '', payments: [{ method: 1, amount: 50, date: '2026-11-10' }] }]);
  assert.deepEqual(accounts.map((a) => [a.key.trimEnd(), Boolean(a.bank)]), [['C-Bank', false], ['BANK', true]], 'two accounts, not one');
});

test('the key is cut to 15 characters (code points — as Postgres left()), trailing spaces off, an empty one is CASH', () => {
  assert.equal(glCustomerKey('', 'אבגדהוזחטיכלמנסעפ'), 'אבגדהוזחטיכלמנס');
  assert.equal(glCustomerKey('', 'דנה כהן        x'), 'דנה כהן', 'the 15 characters end in spaces → rtrim');
  assert.equal(glCustomerKey('   ', 'דנה'), 'CASH', 'a phone of spaces only: the SQL takes it (nullif only empties ""), then it is empty → CASH');
  assert.equal(glCustomerKey('', '😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀'), '😀'.repeat(15), 'an emoji is one character (not two UTF-16 units)');
  assert.equal(glCustomerKey('', '\u00A0דנה\u00A0'), '\u00A0דנה\u00A0', 'rtrim removes plain spaces only');
});

test('Hebrew names and isoText: the key is the raw text; the file writes X(key, 15) — the same 15 characters in 1225 and in B110 1403', () => {
  const names = ['דנה דמו', 'מס׳ 5 בע״מ', 'שירותי ניקיון ״הכוכב״ — דמו', 'קפה ₪ דמו', 'דנה\u200F כהן', 'נִיקוּד דמו'];
  for (const name of names) {
    const d = { customerName: name, customerPhone: '' };
    assert.equal(customerKeyField(d), X(glCustomerKey('', name), 15), name);
    assert.equal(customerKeyField(d).length, 15);
  }
  // a name of up to 15 characters: byte for byte as before (isoText makes geresh / gershayim / dashes plain, ₪ is ש"ח, marks drop)
  for (const name of ['מס׳ 5 בע״מ', 'קפה ₪ דמו', 'דנה\u200F כהן', 'נִיקוּד דמו', 'דנה — דמו']) {
    assert.equal(customerKeyField({ customerName: name }), before({ customerName: name }), name);
  }
  assert.equal(customerKeyField({ customerName: 'מס׳ 5 בע״מ' }).trimEnd(), "מס' 5 בע\"מ");
  // longer than 15 with a mark that isoText drops inside the first 15 characters: the books' key is cut first (as the SQL does),
  // so the file has one character fewer than before 2.121 — the one case (besides "C-") where 1225 is not as it was
  const marked = 'דנה\u200Fכהןלוימרכזדמו';
  assert.equal(customerKeyField({ customerName: marked }).trimEnd(), isoText(Array.from(marked).slice(0, 15).join('')));
  assert.notEqual(customerKeyField({ customerName: marked }), before({ customerName: marked }));
});

test('a business with no such customer: the whole export is byte for byte as before 2.121', () => {
  const biz = { dealerNumber: '000000109', name: 'עסק דמו' };
  const sw = { regNumber: '00000000', name: 'Dream Promotion', version: '2.121.0', vendorVat: '000000109', vendorName: 'Dream Promotion' };
  const who = [{ name: 'דנה דמו', phone: '050-0000001' }, { name: 'שם ארוך מאוד של לקוחה לדוגמה', phone: '' }, { name: '', phone: '' }, { name: 'מס׳ 5 בע״מ', phone: '' }];
  const docs: Doc[] = who.map((w, i) => ({ docType: 305, docNumber: i + 1, linkNo: i + 1, issuedAt: '2026-11-10T09:00:00Z', docDate: '2026-11-10',
    customerName: w.name, customerPhone: w.phone, beforeDiscount: 100, discount: 0, afterDiscount: 100, vatAmount: 18, total: 118,
    lines: [{ name: 'שורה', qty: 1, unitPriceExVat: 100, discountExVat: 0, totalExVat: 100, vatRate: 18, kind: 1 }], payments: [] }));
  for (const d of docs) assert.equal(customerKeyField(d), before(d));
  const f = buildOpenFormat(biz, sw, docs, { from: '2026-11-01', to: '2026-11-30', startedAt: '2026-11-25T08:00:00Z', id: '123456789012345' });
  assert.equal((f.counts as Record<string, number>).B110, 4);
  for (const d of docs) assert.ok(f.bkmv.includes(before(d)), 'every key of before is in the file');
});
