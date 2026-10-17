/**
 * "ייבוא מוצרים מקובץ" (2.102, features/catalog/import.ts): the table is read the way Excel saves it ("CSV UTF-8"), every row
 * passes the editor's own rules, a product already in the catalog (its SKU) is left as it is, and a picture is matched by its
 * file name in the ZIP. Only adds — never updates or deletes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PICTURE_RETRY_MS, fileName, headerMap, parseCsv, pictureOnce, planImport } from '../src/features/catalog/import';
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

/**
 * A picture of an imported product (2.102.2): one more try when it fails — but a try whose answer was lost may have landed
 * (FollowMe's import, 17.10.2026: a phone that locked, five products with their picture twice). A fake server: `landed` says
 * which tries store the picture, `answered` which of them say so.
 */
function server(landed: boolean[], answered: boolean[], counted: (number | null)[] | null = null) {
  const s = { pictures: 0, uploads: 0, counts: 0, waits: [] as number[] };
  const upload = async () => {
    const n = s.uploads++;
    if (landed[n]) s.pictures++;
    return answered[n] ? { ok: true as const } : { ok: false as const, error: 'אין חיבור לשרת — בדקו את האינטרנט ונסו שוב.' };
  };
  const count = async () => (counted ? counted[s.counts++] ?? null : (s.counts++, s.pictures));
  const wait = async (ms: number) => { s.waits.push(ms); };
  return { s, run: () => pictureOnce(upload, count, wait) };
}

test('a picture: the first try — no count, no wait', async () => {
  const { s, run } = server([true], [true]);
  assert.deepEqual(await run(), { ok: true });
  assert.deepEqual([s.pictures, s.uploads, s.counts, s.waits.length], [1, 1, 0, 0]);
});

test('a picture whose answer was lost is never sent again: the product\'s pictures are counted first', async () => {
  const { s, run } = server([true], [false]);
  assert.deepEqual(await run(), { ok: true });
  assert.deepEqual([s.pictures, s.uploads, s.counts], [1, 1, 1], 'one picture — no second try');
  assert.deepEqual(s.waits, [PICTURE_RETRY_MS]);
});

test('a picture that did not land: one more try, after the pause', async () => {
  const { s, run } = server([false, true], [false, true]);
  assert.deepEqual(await run(), { ok: true });
  assert.deepEqual([s.pictures, s.uploads], [1, 2]);
});

test('the second answer lost as well: what is there says (no third try)', async () => {
  const landed = server([false, true], [false, false]);
  assert.deepEqual(await landed.run(), { ok: true });
  assert.deepEqual([landed.s.pictures, landed.s.uploads, landed.s.counts], [1, 2, 2]);
  const not = server([false, false], [false, false]);
  const r = await not.run();
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.message, /^נוסף בלי תמונה: אין חיבור לשרת/);
  assert.equal(not.s.uploads, 2);
});

test('pictures that cannot be counted: no second try, and the message says to look at the product', async () => {
  const { s, run } = server([false, false], [false, false], [null]);
  const r = await run();
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.message, /לא ברור אם התמונה נשמרה .* בדקו במוצר/);
  assert.equal(s.uploads, 1, 'never a blind second try');
  const after = server([false, false], [false, false], [0, null]);
  const r2 = await after.run();
  assert.match(r2.ok ? '' : r2.message, /לא ברור/);
  assert.equal(after.s.uploads, 2);
});
