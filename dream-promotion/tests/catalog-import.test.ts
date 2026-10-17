/**
 * "ייבוא מוצרים מקובץ" (2.102, features/catalog/import.ts): the table is read the way Excel saves it ("CSV UTF-8"), every row
 * passes the editor's own rules, a product already in the catalog (its SKU) is left as it is, and a picture is matched by its
 * file name in the ZIP. Only adds — never updates or deletes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileName, headerMap, parseCsv, planImport } from '../src/features/catalog/import';
import { itemColumns } from '../src/features/catalog/catalog';

test('CSV as Excel saves it: a BOM, \\r\\n, quotes, a comma and a line break inside quotes', () => {
  const text = '﻿sku,name,description\r\nbag-001,"שקית ""יוקרה"", שחורה","שורה ראשונה\nשורה שנייה"\r\n\r\nbag-002,קופסה,\r\n';
  assert.deepEqual(parseCsv(text), [
    ['sku', 'name', 'description'],
    ['bag-001', 'שקית "יוקרה", שחורה', 'שורה ראשונה\nשורה שנייה'],
    ['bag-002', 'קופסה', ''],
  ]);
});

test('the columns by their English key or their Hebrew name', () => {
  assert.deepEqual(headerMap(['מק״ט', 'שם', 'החל מ-', 'Quote_Currency', 'עמודה אחרת']), { sku: 0, name: 1, quote_from: 2, quote_currency: 3 });
});

const TABLE = [
  ['sku', 'name', 'description', 'tags', 'publish', 'quote', 'quote_from', 'quote_currency', 'quote_min_qty', 'image'],
  ['bag-001', 'שקית נייר שחורה עם חבל – דגם 001', 'נייר שחור מט.\\nהעיצוב בתמונה להמחשה.', 'חבל וסרט', 'כן', 'כן', '3.50', 'USD', '', 'images/bag-001.webp'],
  ['bag-031', 'קופסה שחורה עם סרט – דגם 031', '', 'קופסאות', 'yes', 'yes', '$6', '$', '300', 'bag-031.webp'],
  ['tote', 'שקית קיימת', '', '', '', '', '', '', '', ''],
  ['bag-099', 'בלי תמונה', '', '', '1', '1', '', '', '', 'bag-099.webp'],
  ['bag-100', 'מטבע מוזר', '', '', '1', '1', '2', 'GBP', '', ''],
  ['bag-001', 'כפול', '', '', '', '', '', '', '', ''],
];

test('the plan: what is added, what is already there (left as it is), what is wrong — by line', () => {
  const plan = planImport(TABLE, { takenSkus: ['TOTE', 'shirt-s'], takenSlugs: ['שקית-נייר-שחורה-עם-חבל-דגם-001'], images: ['images/bag-001.webp', 'bag-031.webp'] });
  assert.deepEqual(plan.add.map((r) => r.draft.sku), ['bag-001', 'bag-031', 'bag-099']);
  assert.deepEqual(plan.skip, [{ line: 4, sku: 'tote', name: 'שקית קיימת' }], 'the same SKU in any case: left as it is');
  assert.deepEqual(plan.errors.map((e) => e.line), [6, 7]);
  assert.match(plan.errors[0].message, /המטבע/);
  assert.match(plan.errors[1].message, /יותר מפעם אחת/);
  assert.deepEqual(plan.missingImages, ['bag-099.webp']);
  const [a, b, c] = plan.add;
  assert.equal(a.image, 'bag-001.webp', 'a picture by its file name, in any folder');
  assert.equal(c.image, '', 'a picture that is not in the ZIP: the product without one');
  assert.equal(a.draft.description, 'נייר שחור מט.\nהעיצוב בתמונה להמחשה.');
  assert.notEqual(a.draft.slug, 'שקית-נייר-שחורה-עם-חבל-דגם-001', 'an address that is taken gets another');
  assert.equal(new Set(plan.add.map((r) => r.draft.slug)).size, 3);
  const cols = itemColumns(b.draft, [], { quote: true });
  assert.deepEqual([cols.quote_mode, cols.quote_from, cols.quote_currency, cols.quote_min_qty, cols.publish_online, cols.price, cols.kind],
    [true, 6, 'USD', 300, true, 0, 'product'], '"$6" and "$" read as 6 USD; the register\'s price 0');
  assert.deepEqual(cols.tags, ['קופסאות']);
});

test('a file without names, too big, or empty says so', () => {
  assert.match(planImport([['sku'], ['a']], { takenSkus: [], takenSlugs: [] }).errors[0].message, /name/);
  assert.match(planImport([], { takenSkus: [], takenSlugs: [] }).errors[0].message, /ריק/);
  const many = [['name'], ...Array.from({ length: 501 }, (_, i) => [`מוצר ${i}`])];
  assert.match(planImport(many, { takenSkus: [], takenSlugs: [] }).errors[0].message, /500/);
});

test('a picture\'s name: its file, lower case, from any folder', () => {
  assert.equal(fileName('Images\\Bag-001.WEBP'), 'bag-001.webp');
  assert.equal(fileName(' bag-002.webp '), 'bag-002.webp');
});
