/**
 * Dream Commerce stage 1 (2.54): the one catalog's rules, as every screen uses them — the register, finance and the store.
 * Prices of a variant, names on lines, the register's cart, scanning a code, variants from options, stock per variant,
 * the address in the store, what is missing before publishing, the editor's checks, and the database's refusals in words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VARIANTS, MIGRATION_3300, applyVariantStock, cartKey, catalogError, changedColumns, cleanCustomFields, cleanProductCopy, copyBrief, draftError, draftOf, emptyDraft, findByCode,
  isSlug, itemColumns, itemColumnsOf, level, lineName, newFieldKey, onlinePriceOf, optionCombos, parseTags, planVariants, posPrice, publishGaps, slugify,
  splitList, toCatalogItem, toMedia, toVariant, unassignedUnits, uniqueSlug, variantColumns, variantLabel, variantLevel, type CatalogVariant,
} from '../src/features/catalog/catalog';

const row = { id: 'i1', name: 'חולצה', price: '100', kind: 'product', active: true, favorite: false, fav_order: 0, sort: 0, image_url: '', track_stock: true, stock_qty: 10, low_stock: 2 };
const v = (id: string, o1: string, o2 = '', extra: Partial<CatalogVariant> = {}): CatalogVariant => ({
  id, itemId: 'i1', option1: o1, option2: o2, option3: '', sku: '', barcode: '', price: null, onlinePrice: null, compareAtPrice: null,
  stockQty: 0, lowStock: null, mediaId: null, active: true, position: 0, ...extra,
});

test('a row from before 2.54 (no new columns) is a plain item: not published, no variants, nothing invented', () => {
  const i = toCatalogItem(row);
  assert.equal(i.price, 100);
  assert.equal(i.publishOnline, false);
  assert.equal(i.hasVariants, false);
  assert.equal(i.slug, null);
  assert.equal(i.onlinePrice, null);
  assert.deepEqual(i.tags, []);
  assert.deepEqual(i.customFields, {});
  assert.equal(toCatalogItem({ ...row, kind: 'weird', low_stock: null }).kind, 'other');
  assert.equal(toCatalogItem({ ...row, low_stock: null }).lowStock, 2, 'the alert level of 2.50');
  assert.deepEqual(toCatalogItem({ ...row, custom_fields: { washing: '30°', bad: 5 } }).customFields, { washing: '30°' }, 'only text values');
  const m = toMedia({ id: 'm', item_id: 'i1', url: 'https://x/a.webp', sizes: { 400: 'https://x/400.webp', junk: 3 }, position: '2' });
  assert.deepEqual(m.sizes, { 400: 'https://x/400.webp' });
  assert.equal(m.position, 2);
  assert.equal(toVariant({ id: 'v', item_id: 'i1', option1: 'S', price: null, low_stock: '' }).price, null);
});

test('names and prices of a variant: the register, the store', () => {
  assert.equal(variantLabel(v('a', 'M', 'שחור')), 'M / שחור');
  assert.equal(lineName('חולצה', v('a', 'M', 'שחור')), 'חולצה · M / שחור');
  assert.equal(lineName('חולצה', null), 'חולצה', 'an item without a variant keeps its name');
  const item = { price: 100, onlinePrice: null as number | null };
  assert.equal(posPrice(item, v('a', 'S')), 100, 'no price of its own: the item\'s');
  assert.equal(posPrice(item, v('a', 'L', '', { price: 110 })), 110);
  assert.equal(onlinePriceOf(item), 100, 'no online price: the register\'s price');
  assert.equal(onlinePriceOf({ price: 100, onlinePrice: 90 }), 90);
  assert.equal(onlinePriceOf({ price: 100, onlinePrice: 90 }, v('a', 'L', '', { price: 110 })), 90, 'the item\'s online price covers its variants');
  assert.equal(onlinePriceOf({ price: 100, onlinePrice: null }, v('a', 'L', '', { price: 110 })), 110, 'then the variant\'s register price');
  assert.equal(onlinePriceOf({ price: 100, onlinePrice: 90 }, v('a', 'L', '', { price: 110, onlinePrice: 105 })), 105, 'a variant\'s own online price first');
});

test('variants from options: every combination in order, what to create, what stays, what no option describes', () => {
  const options = [{ position: 2, choices: ['שחור', 'לבן'] }, { position: 1, choices: ['S', ' M ', 's', ''] }];
  assert.deepEqual(optionCombos(options), [['S', 'שחור'], ['S', 'לבן'], ['M', 'שחור'], ['M', 'לבן']], 'size first (position 1), doubles and empties dropped');
  assert.deepEqual(optionCombos([]), []);
  const existing = [v('a', 'S', 'שחור'), v('b', 'XL', 'שחור')];
  const p = planVariants(options, existing);
  assert.ok(p.ok);
  if (p.ok) {
    assert.deepEqual(p.create, [['S', 'לבן'], ['M', 'שחור'], ['M', 'לבן']]);
    assert.deepEqual(p.keep.map((x) => x.id), ['a']);
    assert.deepEqual(p.orphan.map((x) => x.id), ['b'], 'XL is not deleted by itself — it may hold stock');
  }
  const many = planVariants([{ position: 1, choices: Array.from({ length: 11 }, (_, k) => `a${k}`) }, { position: 2, choices: Array.from({ length: 10 }, (_, k) => `b${k}`) }], []);
  assert.equal(many.ok, false, `more than ${MAX_VARIANTS} variants`);
  assert.deepEqual(splitList('S, M,L\nXL, , M'), ['S', 'M', 'L', 'XL']);
  assert.equal(parseTags(Array.from({ length: 40 }, (_, k) => `t${k}`).join(',')).length, 30, 'up to 30 tags');
});

test('stock per variant: levels, units not assigned to a variant, the screen after a sale', () => {
  assert.equal(level(0, 2), 'out');
  assert.equal(level(2, 2), 'low');
  assert.equal(level(3, 2), 'ok');
  const item = { id: 'i1', trackStock: true, hasVariants: true, stockQty: 10, lowStock: 2 };
  assert.equal(variantLevel(item, { stockQty: 1, lowStock: null }), 'low', 'the item\'s alert level');
  assert.equal(variantLevel(item, { stockQty: 1, lowStock: 0 }), 'ok', 'its own alert level');
  assert.equal(variantLevel({ ...item, trackStock: false }, { stockQty: 0, lowStock: null }), null, 'not tracked: no level');
  const vs = [v('a', 'S', '', { stockQty: 4 }), v('b', 'M', '', { stockQty: 6 }), { ...v('c', 'X'), itemId: 'other', stockQty: 50 }];
  assert.equal(unassignedUnits(item, vs), 0, '10 = 4 + 6');
  assert.equal(unassignedUnits({ ...item, stockQty: 8 }, vs), -2, 'two sold without a variant');
  assert.equal(unassignedUnits({ ...item, hasVariants: false }, vs), 0);
  const after = applyVariantStock(vs, [{ itemId: 'i1', variantId: 'a', qty: 2 }, { itemId: 'i1', qty: 1 }, { itemId: 'other', variantId: 'a', qty: 5 }]);
  assert.deepEqual(after.map((x) => x.stockQty), [2, 6, 50], 'only S of this item moves; a line without a variant moves no variant');
  assert.deepEqual(applyVariantStock(after, [{ itemId: 'i1', variantId: 'a', qty: 2 }], -1).map((x) => x.stockQty), [4, 6, 50], 'a return puts it back');
});

test('the register\'s cart: one line per product and variant; a free amount by its name and price, as before', () => {
  const s = { name: 'חולצה · S', price: 100, itemId: 'i1', variantId: 'a' };
  assert.equal(cartKey(s), cartKey({ ...s }));
  assert.notEqual(cartKey(s), cartKey({ ...s, variantId: 'b', name: 'חולצה · M' }), 'another size is another line');
  assert.notEqual(cartKey(s), cartKey({ ...s, variantId: undefined, name: 'חולצה' }));
  assert.equal(cartKey({ name: 'סכום חופשי', price: 20 }), cartKey({ name: 'סכום חופשי', price: 20 }));
  assert.notEqual(cartKey({ name: 'סכום חופשי', price: 20 }), cartKey({ name: 'סכום חופשי', price: 30 }));
});

test('a scanned or typed code: a variant first, a SKU in any case, never a hidden product', () => {
  const items = [{ id: 'i1', sku: 'SH', barcode: '7290000000004', active: true }, { id: 'i2', sku: 'HAT', barcode: '', active: false }];
  const vs = [v('a', 'S', '', { sku: 'SH-S', barcode: '7290000000011' }), v('b', 'M', '', { sku: 'SH-M', active: false })];
  assert.equal(findByCode(' 7290000000011 ', items, vs)?.variant?.id, 'a');
  assert.equal(findByCode('sh-s', items, vs)?.variant?.id, 'a', 'a SKU in any case');
  assert.equal(findByCode('7290000000004', items, vs)?.variant, null, 'the item\'s own barcode');
  assert.equal(findByCode('7290000000004', items, vs)?.item.id, 'i1');
  assert.equal(findByCode('SH-M', items, vs)?.variant ?? null, null, 'a hidden variant is not sold by its code…');
  assert.equal(findByCode('hat', items, vs), null, '…nor a hidden product');
  assert.equal(findByCode('', items, vs), null);
});

test('the address in the store: Hebrew and English, words joined by "-", always valid', () => {
  const niqqud = 'שָׁלוֹם'.normalize('NFC');
  assert.equal(slugify('חולצת כותנה — לבנה!'), 'חולצת-כותנה-לבנה');
  assert.equal(slugify('T-Shirt Basic 2026'), 't-shirt-basic-2026');
  assert.equal(slugify(niqqud), 'שלום', 'niqqud dropped');
  assert.equal(slugify('ג׳ינס'), 'גינס', 'a geresh joins');
  assert.equal(slugify('תל' + String.fromCharCode(0x05be) + 'אביב'), 'תל-אביב', 'a maqaf separates');
  assert.equal(slugify('Café crème'), 'cafe-creme');
  assert.equal(slugify('!!!'), '');
  const long = slugify('מילה '.repeat(40));
  assert.ok(long.length <= 80 && isSlug(long), 'cut to 80, still valid');
  for (const t of ['חולצת כותנה', 'T-Shirt', 'a--b', ' x ', '100%']) { const s = slugify(t); assert.ok(s === '' || isSlug(s), `${t} → ${s}`); }
  assert.equal(isSlug('Bad Slug'), false);
  assert.equal(isSlug('a--b'), false);
  assert.equal(uniqueSlug('חולצה', ['חולצה', 'חולצה-2']), 'חולצה-3');
  assert.equal(uniqueSlug('חולצה', []), 'חולצה');
  assert.equal(uniqueSlug('', []), 'מוצר');
  assert.ok(uniqueSlug('a'.repeat(80), ['a'.repeat(80)]).length <= 80);
});

test('before publishing: a picture and a description are suggested, never required', () => {
  assert.deepEqual(publishGaps({ imageUrl: '', description: '' }), ['image', 'description']);
  assert.deepEqual(publishGaps({ imageUrl: 'https://x/a.webp', description: '  ' }), ['description']);
  assert.deepEqual(publishGaps({ imageUrl: '', description: 'כותנה' }, 2), [], 'two pictures in the editor count');
});

test('the business\'s own fields: only defined ones, trimmed; new keys never collide', () => {
  assert.deepEqual(cleanCustomFields([{ key: 'washing' }, { key: 'size_chart' }], { washing: ' 30° ', size_chart: '', old: 'x' }), { washing: '30°' });
  assert.equal(newFieldKey(['field_1', 'field_3']), 'field_2');
  assert.match(newFieldKey([]), /^[a-z][a-z0-9_]{1,30}$/, 'the database\'s rule for a key');
});

test('the editor\'s checks, in Hebrew', () => {
  const ok = emptyDraft({ name: 'חולצה', price: '100' });
  assert.equal(draftError(ok), null);
  assert.match(draftError({ ...ok, name: ' ' })!, /חסר שם/);
  assert.match(draftError({ ...ok, name: 'א'.repeat(81) })!, /עד 80/);
  assert.match(draftError({ ...ok, price: '' })!, /המחיר/);
  assert.match(draftError({ ...ok, price: '-1' })!, /המחיר/);
  assert.match(draftError({ ...ok, price: '10.005' })!, /2 ספרות/);
  assert.equal(draftError({ ...ok, price: '₪1,200' }), null, 'a price with ₪ and a thousands comma');
  assert.match(draftError({ ...ok, onlinePrice: 'abc' })!, /באתר/);
  assert.match(draftError({ ...ok, compareAtPrice: '90' })!, /לפני הנחה/, 'not above the price: no discount to show');
  assert.equal(draftError({ ...ok, onlinePrice: '80', compareAtPrice: '90' }), null);
  assert.match(draftError({ ...ok, slug: 'Bad Slug' })!, /הכתובת/);
  assert.match(draftError({ ...ok, barcode: '12' })!, /ברקוד/);
  assert.match(draftError({ ...ok, barcode: '729 000' })!, /ברקוד/);
});

test('saving writes only what changed — a price changed in the register is never undone by an old editor', () => {
  const item = toCatalogItem({ ...row, tags: ['קיץ', 'כותנה'], custom_fields: { b: '2', a: '1' }, description: 'כותנה', slug: 'חולצה' });
  const defs = [{ key: 'a' }, { key: 'b' }];
  const same = itemColumns(draftOf(item), defs);
  assert.deepEqual(changedColumns(same, itemColumnsOf(item)), {}, 'nothing changed — nothing is written (fields in another order are the same)');
  const d = { ...draftOf(item), description: 'כותנה סרוקה', onlinePrice: '95' };
  assert.deepEqual(changedColumns(itemColumns(d, defs), itemColumnsOf(item)), { description: 'כותנה סרוקה', online_price: 95 });
  const cols = itemColumns(emptyDraft({ name: ' חולצה ', price: '100', slug: '', tags: 'קיץ, קיץ' }), []);
  assert.equal(cols.name, 'חולצה');
  assert.equal(cols.slug, null, 'no address yet');
  assert.deepEqual(cols.tags, ['קיץ']);
  assert.equal(cols.publish_online, false, 'off unless switched on');
});

test('a variant\'s fields: empty = the item\'s value', () => {
  const r = variantColumns({ price: '', onlinePrice: '95', sku: ' SH-S ', barcode: '', lowStock: '', active: true });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.cols, { price: null, online_price: 95, sku: 'SH-S', barcode: '', low_stock: null, active: true });
  assert.equal(variantColumns({ price: '-5', onlinePrice: '', sku: '', barcode: '', lowStock: '', active: true }).ok, false);
  assert.equal(variantColumns({ price: '', onlinePrice: '', sku: '', barcode: '', lowStock: '1.5', active: true }).ok, false);
});

test('the database\'s refusals, in words; a missing migration is named', () => {
  assert.equal(catalogError({ message: 'Could not find the table \'public.catalog_variants\' in the schema cache', code: 'PGRST205' }), MIGRATION_3300);
  assert.equal(catalogError({ message: 'Could not find the \'slug\' column of \'catalog_items\' in the schema cache', code: 'PGRST204' }), MIGRATION_3300);
  assert.equal(catalogError({ message: 'Could not find the function public.adjust_variant_stock', code: 'PGRST202' }), MIGRATION_3300);
  assert.match(catalogError({ message: 'code_taken: the barcode is already used by another product' })!, /הברקוד/);
  assert.match(catalogError({ message: 'code_taken: the SKU is already used by another product' })!, /המק״ט/);
  assert.match(catalogError({ message: 'duplicate key value violates unique constraint "catalog_items_slug_uq"' })!, /הכתובת/);
  assert.match(catalogError({ message: 'variant_required: an item with variants is counted per variant' })!, /לכל וריאנט/);
  assert.match(catalogError({ message: 'new row violates row-level security policy', code: '42501' })!, /אין הרשאה/);
  assert.equal(catalogError({ message: 'fetch failed' }), null, 'not ours: the caller\'s general message');
});

test('✨ the AI\'s text: plain text within the limits — and the AI never sees a price, stock or sales', () => {
  const c = cleanProductCopy({ description: '<b>חולצה</b> **רכה**\n\n\n\nמכותנה', seoTitle: 'חולצה\nלבנה', seoDescription: 'x'.repeat(400) });
  assert.deepEqual(c, { description: 'חולצה רכה\n\nמכותנה', seoTitle: 'חולצה לבנה', seoDescription: 'x'.repeat(320) });
  assert.equal(cleanProductCopy({ description: '  ', seoTitle: 'x' }), null, 'no description: nothing to offer');
  assert.equal(cleanProductCopy('nope'), null);
  assert.equal(cleanProductCopy({ description: 'טקסט', seoTitle: 5 })?.seoTitle, '', 'a field that is not text is empty');
  const brief = copyBrief(emptyDraft({ name: 'חולצה', price: '149.90', onlinePrice: '129', tags: 'קיץ', customFields: { washing: '30°', gone: 'x' } }),
    [{ name: 'מידה', choices: ['S', 'M'] }, { name: '', choices: [] }], [{ key: 'washing', label: 'כביסה' }]);
  assert.deepEqual(brief.options, [{ name: 'מידה', choices: ['S', 'M'] }]);
  assert.deepEqual(brief.fields, [{ label: 'כביסה', value: '30°' }], 'only the business\'s defined fields');
  assert.ok(!/149|129/.test(JSON.stringify(brief)), 'no price in what the AI sees');
});
