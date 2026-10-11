import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIGRATION_4800, SERIAL_EVENT_HE, SERIAL_STATUS_HE, addSerialToLines, historyLine, parseSerials, refundSerials, removeSerialFromLines, sameSerial,
  serialError, serialsHere, toSerial, toSerialEvent, unnumbered, withSerials, type Serial,
} from '../src/features/catalog/serials';
import {
  catalogError, listPriceInput, listsFor, nextSkuPreview, posPrice, priceFor, priceListDraftError, priceListError, skuCode, skuPrefix, skuSeriesError,
  toCatalogItem, toListPrice, toPriceList, toSkuSeries, type ListPrice, type PriceList,
} from '../src/features/catalog/catalog';
import { compareCsv, compareTotals, leader, shareOf, toComparison } from '../src/features/finance/compare';
import { countList, receiptError, receiptGaps, receiptPayload, stockErrorHe, toTransfer, transferError, transferNoteHtml } from '../src/features/stock/stock-locations';

// ---- serial numbers ------------------------------------------------------------------------------------------------------------
test('a list of numbers as typed or scanned: one a line or with commas, trimmed, each once (any case)', () => {
  assert.deepEqual(parseSerials(' A-1\nA-2 ,A-3;\tA-4\r\n\n'), { ok: true, serials: ['A-1', 'A-2', 'A-3', 'A-4'] });
  assert.deepEqual(parseSerials('SN 100'), { ok: true, serials: ['SN 100'] }, 'a space inside a number stays (only lines and commas separate)');
  const twice = parseSerials('ab-1\nAB-1');
  assert.equal(twice.ok, false);
  assert.match(!twice.ok ? twice.error : '', /פעמיים/);
  assert.equal(parseSerials(' \n ,').ok, false, 'no number');
  assert.equal(parseSerials('x'.repeat(65)).ok, false, 'longer than 64');
  assert.equal(parseSerials(Array.from({ length: 201 }, (_, k) => `N${k}`).join('\n')).ok, false, 'more than 200');
  assert.equal(parseSerials(Array.from({ length: 200 }, (_, k) => `N${k}`).join('\n')).ok, true, '200 at once');
  assert.ok(sameSerial(' ab-1', 'AB-1 ') && !sameSerial('AB-1', 'AB-10'));
});

test('the rows of the database → the screens\' (lenient)', () => {
  const s = toSerial({ id: 's1', item_id: 'i1', variant_id: null, serial: 'P-1', status: 'sold', location_id: 'l1', sale_id: 'x1', received_at: 't', updated_at: 'u' });
  assert.deepEqual(s, { id: 's1', itemId: 'i1', variantId: null, serial: 'P-1', status: 'sold', locationId: 'l1', saleId: 'x1', receivedAt: 't', updatedAt: 'u' });
  assert.equal(toSerial({ status: 'weird' }).status, 'removed', 'an unknown status is never "in stock"');
  const e = toSerialEvent({ id: '7', serial_id: 's1', kind: 'transfer_missing', location_id: 'l2', transfer_id: 't1', note: 'נאבד', at: 'a' });
  assert.equal(e.id, 7); assert.equal(e.kind, 'transfer_missing'); assert.equal(e.transferId, 't1');
  assert.equal(historyLine(e, 'סניף דיזנגוף'), 'לא הגיע בהעברה · סניף דיזנגוף · נאבד');
  for (const k of ['in_stock', 'in_transit', 'sold', 'returned', 'removed'] as const) assert.ok(SERIAL_STATUS_HE[k]);
  assert.equal(Object.keys(SERIAL_EVENT_HE).length, 10, 'every kind of the database has its words');
});

const sn = (serial: string, p: Partial<Serial> = {}): Serial => ({ id: serial, itemId: 'phone', variantId: null, serial, status: 'in_stock', locationId: 'main',
  saleId: null, receivedAt: '', updatedAt: '', ...p });
test('the numbers in stock at a location, of a variant; units with no number', () => {
  const list = [sn('P-10'), sn('P-9'), sn('P-2', { status: 'sold' }), sn('P-3', { locationId: 'branch' }), sn('P-4', { status: 'in_transit' }),
    sn('G-1', { itemId: 'ring', variantId: 'gold' }), sn('S-1', { itemId: 'ring', variantId: 'silver' })];
  assert.deepEqual(serialsHere(list, 'phone', 'main').map((s) => s.serial), ['P-9', 'P-10'], 'in stock here only, in the order people read numbers');
  assert.deepEqual(serialsHere(list, 'ring', 'main', 'gold').map((s) => s.serial), ['G-1']);
  assert.deepEqual(serialsHere(list, 'ring', 'main').map((s) => s.serial), ['G-1', 'S-1'], 'no variant asked: every variant');
  assert.equal(unnumbered(5, list, 'phone', 'main', null), 3, 'five units at the main location, two of them numbered');
  assert.equal(unnumbered(1, list, 'phone', 'main', null), 0, 'never below zero');
});

test('the cart: a number goes on its line (the quantity = its numbers); never twice; taken off one by one', () => {
  type L = { name: string; price: number; qty: number; itemId?: string; variantId?: string; serials?: string[] };
  const make = (): L => ({ name: 'טלפון', price: 1000, qty: 1, itemId: 'phone' });
  const match = (l: L) => l.itemId === 'phone' && !l.variantId;
  let r = addSerialToLines<L>([], make, match, 'P-1');
  assert.ok(r.ok);
  r = addSerialToLines(r.ok ? r.lines : [], make, match, 'P-2');
  assert.ok(r.ok);
  const lines = r.ok ? r.lines : [];
  assert.deepEqual(lines, [{ name: 'טלפון', price: 1000, qty: 2, itemId: 'phone', serials: ['P-1', 'P-2'] }]);
  const again = addSerialToLines(lines, make, match, 'p-1');
  assert.equal(again.ok, false, 'the same number again (any case) — refused here first');
  assert.deepEqual(removeSerialFromLines(lines, 'p-2'), [{ name: 'טלפון', price: 1000, qty: 1, itemId: 'phone', serials: ['P-1'] }]);
  assert.deepEqual(removeSerialFromLines(removeSerialFromLines(lines, 'P-1'), 'P-2'), [], 'the line goes with its last number');
  const other: L = { name: 'קרם', price: 50, qty: 3 };
  assert.deepEqual(removeSerialFromLines([other], 'P-1'), [other], 'a line without numbers is untouched');
  assert.deepEqual(refundSerials(['P-1', 'P-2', 'P-3'], ['p-3', 'P-1', 'X']), ['P-1', 'P-3'], 'a refund: the sold numbers ticked, as the sale has them');
});

test('a document line with its numbers', () => {
  assert.equal(withSerials('טלפון', ['A1', 'A2']), 'טלפון · מס׳ סידורי: A1, A2');
  assert.equal(withSerials('קרם', []), 'קרם');
  assert.equal(withSerials('קרם'), 'קרם');
  const many = Array.from({ length: 40 }, (_, k) => `SERIAL-${1000 + k}`);
  const long = withSerials('טלפון', many);
  assert.ok(long.length <= 300, 'a document line holds 300 characters');
  assert.match(long, /^טלפון · מס׳ סידורי: SERIAL-1000, SERIAL-1001, .* ועוד \d+$/);
});

test('refusals of the database about numbers, in Hebrew', () => {
  assert.match(serialError({ message: 'serial_sold: P-001', code: '23514' })!, /P-001 כבר נמכר — מספר סידורי לא נמכר פעמיים/);
  assert.match(serialError({ message: 'serial_elsewhere: P-201', code: '23514' })!, /P-201 במלאי בסניף אחר/);
  assert.match(serialError({ message: 'serial_required: טלפון', code: '22023' })!, /^טלפון: בוחרים מספר סידורי לכל יחידה/);
  assert.match(serialError({ message: 'serial_more_than_stock: 3 units here have no number', code: '23514' })!, /רק 3 יחידות בלי מספר/);
  assert.match(serialError({ message: 'new row for relation "catalog_items" violates check constraint "catalog_items_serials_check"' })!, /לא נמכר באתר/);
  assert.match(serialError({ message: 'serial_item: a product with serial numbers moves with its numbers', code: '22023' })!, /זז רק עם המספרים/);
  assert.match(serialError({ message: 'count_serial: טלפון' })!, /נבדק לפי המספרים/);
  assert.equal(serialError({ message: 'function public.serial_receive(uuid) does not exist', code: '42883' }), MIGRATION_4800);
  assert.equal(serialError({ message: 'duplicate key value violates unique constraint "x"' }), null, 'not one of these');
  // the catalog's own mapping knows them too (the editor shows catalogError)
  assert.match(catalogError({ message: 'serial_not_in_sale: P-3' })!, /לא נמכר בעסקה הזו/);
});

// ---- price lists ---------------------------------------------------------------------------------------------------------------
const lists: PriceList[] = [
  toPriceList({ id: 'loc2', name: 'דיזנגוף', kind: 'location', location_id: 'l2', tag: null, active: true, sort: 1 }),
  toPriceList({ id: 'whole', name: 'סיטונאי', kind: 'group', location_id: null, tag: 'סיטונאי', active: true, sort: 2 }),
  toPriceList({ id: 'club', name: 'מועדון', kind: 'group', location_id: null, tag: 'VIP', active: true, sort: 1 }),
  toPriceList({ id: 'old', name: 'ישן', kind: 'group', location_id: null, tag: 'סיטונאי', active: false, sort: 0 }),
];
const prices: ListPrice[] = [
  toListPrice({ list_id: 'loc2', item_id: 'cream', variant_id: null, price: '45' }),
  toListPrice({ list_id: 'loc2', item_id: 'shirt', variant_id: null, price: 90 }),
  toListPrice({ list_id: 'whole', item_id: 'shirt', variant_id: 'm', price: 70 }),
  toListPrice({ list_id: 'club', item_id: 'shirt', variant_id: null, price: 85 }),
  toListPrice({ list_id: 'old', item_id: 'cream', variant_id: null, price: 1 }),
];
const cream = { id: 'cream', price: 50 }, shirt = { id: 'shirt', price: 100 }, s = { id: 's', price: null }, m = { id: 'm', price: 110 };

test('which lists price a sale: the customer\'s group(s), then the location\'s — active ones only', () => {
  assert.deepEqual(listsFor(lists, { locationId: 'l2', tags: [' סיטונאי ', 'vip'] }).map((l) => l.id), ['club', 'whole', 'loc2'], 'groups by their order, then the location');
  assert.deepEqual(listsFor(lists, { locationId: 'main', tags: [] }).map((l) => l.id), [], 'no list: the base');
  assert.deepEqual(listsFor(lists, { locationId: 'l2' }).map((l) => l.id), ['loc2']);
  assert.ok(!listsFor(lists, { tags: ['סיטונאי'] }).some((l) => l.id === 'old'), 'a closed list prices nothing');
});

test('a price: the first list that names the product (a variant\'s own, else the product\'s) — else the base', () => {
  const at2 = listsFor(lists, { locationId: 'l2', tags: [] });
  assert.deepEqual(priceFor(cream, null, at2, prices), { price: 45, list: lists[0] }, 'the branch\'s list');
  assert.equal(priceFor(cream, null, [], prices).price, 50, 'no list: the catalog\'s price');
  const wholesale = listsFor(lists, { locationId: 'l2', tags: ['סיטונאי'] });
  assert.equal(priceFor(shirt, m, wholesale, prices).price, 70, 'the group\'s price of the variant');
  assert.equal(priceFor(shirt, s, wholesale, prices).price, 90, 'the group does not name S: the location\'s price of the product');
  assert.equal(priceFor(shirt, m, [], prices).price, posPrice(shirt, m), 'the base of a variant: its own price');
  assert.equal(priceFor(shirt, s, [], prices).price, 100, 'the base of a variant without one: the product\'s');
  const club = listsFor(lists, { locationId: 'main', tags: ['VIP'] });
  assert.equal(priceFor(shirt, m, club, prices).price, 85, 'a product\'s price in a list is its variants\' too');
});

test('a list\'s price as typed; a list\'s fields; refusals in Hebrew', () => {
  assert.deepEqual(listPriceInput(' ₪1,234.5 '), { ok: true, price: 1234.5 });
  assert.deepEqual(listPriceInput(''), { ok: true, price: null }, 'empty: the base price again');
  assert.equal(listPriceInput('1.234').ok, false);
  assert.equal(listPriceInput('-1').ok, false);
  assert.equal(listPriceInput('abc').ok, false);
  assert.equal(priceListDraftError({ name: 'סיטונאי', kind: 'group', locationId: null, tag: 'סיטונאי' }), null);
  assert.match(priceListDraftError({ name: ' ', kind: 'group', locationId: null, tag: 'x' })!, /שם למחירון/);
  assert.match(priceListDraftError({ name: 'x', kind: 'group', locationId: null, tag: '' })!, /קבוצת לקוחות/);
  assert.match(priceListDraftError({ name: 'x', kind: 'location', locationId: null, tag: '' })!, /לאיזה סניף/);
  assert.match(priceListError({ message: 'duplicate key value violates unique constraint "price_lists_tag_uq"' })!, /כבר יש מחירון פעיל לקבוצה/);
  assert.match(catalogError({ message: 'duplicate key value violates unique constraint "price_lists_location_uq"' })!, /לסניף הזה/);
  assert.match(catalogError({ message: 'price_list_price: a price of 0 or more' })!, /מחיר: מספר/);
});

// ---- SKU series ----------------------------------------------------------------------------------------------------------------
test('a series\' codes and fields (the database\'s rules)', () => {
  assert.equal(skuCode('JW', 1, 4), 'JW-0001');
  assert.equal(skuCode('X', 999, 3), 'X-999');
  assert.equal(skuPrefix(' j w '), 'JW');
  const k = toSkuSeries({ id: 'k1', name: 'תכשיטים', prefix: 'JW', digits: '4', next_no: 7, active: true });
  assert.equal(nextSkuPreview(k), 'JW-0007');
  assert.equal(skuSeriesError({ name: 'תכשיטים', prefix: 'jw', digits: 4, next: 1 }), null);
  assert.match(skuSeriesError({ name: '', prefix: 'JW', digits: 4, next: 1 })!, /שם לסדרה/);
  assert.match(skuSeriesError({ name: 'x', prefix: 'J-W', digits: 4, next: 1 })!, /קידומת/);
  assert.match(skuSeriesError({ name: 'x', prefix: 'ABCDEFG', digits: 4, next: 1 })!, /קידומת/);
  assert.match(skuSeriesError({ name: 'x', prefix: 'AB', digits: 2, next: 1 })!, /3 עד 6/);
  assert.match(skuSeriesError({ name: 'x', prefix: 'AB', digits: 3, next: 1000 })!, /הגבוה הוא 999/);
  assert.match(catalogError({ message: 'sku_series_full: the series has no number left' })!, /נגמרו המספרים/);
  assert.match(catalogError({ message: 'duplicate key value violates unique constraint "sku_series_prefix_uq"' })!, /קידומת הזו/);
  assert.equal(toCatalogItem({ id: 'p', track_serials: true }).trackSerials, true);
  assert.equal(toCatalogItem({ id: 'p' }).trackSerials, false, 'before migration 4800: no numbers');
});

// ---- comparing locations ---------------------------------------------------------------------------------------------------------
const raw = {
  from: '2026-10-01', to: '2026-10-31', vat: true,
  locations: [
    { id: 'b', name: 'ראשי', active: true, main: true, revenue: { net: 100.1, vat: 18 }, expenses: { net: 100, cost: 100 }, profit: 0.1,
      sales: { count: 2, total: 20, online: 1, refunds: 2, refundCount: 2 }, items: [{ itemId: 'p', name: 'טלפון', qty: 2, total: 20 }], stock: { units: 3, value: 3000 } },
    { id: 'l2', name: 'דיזנגוף', active: false, main: false, revenue: { net: 150.2, vat: 27 }, expenses: { net: 40, cost: 40 }, profit: 110.2,
      sales: { count: 1, total: 10, online: 0, refunds: 0, refundCount: 0 }, items: [], stock: { units: 1, value: 100 } },
  ],
};
test('the comparison: the database\'s answer read as it is, totalled to the agora', () => {
  const c = toComparison(raw)!;
  assert.equal(c.locations.length, 2);
  assert.equal(c.locations[0].items[0].name, 'טלפון');
  assert.equal(toComparison({ from: 'x' }), null, 'not an answer of location_compare');
  const t = compareTotals(c.locations);
  assert.equal(t.revenue, 250.3, '100.1 + 150.2 — not 250.29999…');
  assert.equal(t.profit, 110.3);
  assert.equal(t.sales, 3); assert.equal(t.units, 4); assert.equal(t.value, 3100);
  assert.equal(shareOf(150.2, 250.3), '60%');
  assert.equal(shareOf(1, 0), '');
  assert.equal(leader(c.locations, (r) => r.profit), 'l2');
  assert.equal(leader(c.locations.slice(0, 1), (r) => r.profit), null, 'one location leads nothing');
  assert.equal(leader([c.locations[0], { ...c.locations[0], id: 'x' }], (r) => r.profit), null, 'a tie');
  const file = compareCsv(c);
  assert.ok(file.startsWith('﻿'), 'Excel reads it in Hebrew');
  const lines = file.slice(1).split('\r\n');
  assert.equal(lines.length, 4, 'a head, a row a location, the total');
  assert.match(lines[2], /דיזנגוף \(סגור\)/);
  assert.match(lines[3], /^"סה״כ","01\/10\/2026","31\/10\/2026","250\.30"/);
});

// ---- transfers and counts of a product with serial numbers ------------------------------------------------------------------------

test('a transfer of a product with numbers: a number a unit, none twice; the receipt names the missing ones', () => {
  const items = [{ id: 'phone', name: 'טלפון', trackStock: true, hasVariants: false, trackSerials: true }, { id: 'cream', name: 'קרם', trackStock: true, hasVariants: false }];
  assert.match(transferError('a', 'b', [{ itemId: 'phone', variantId: null, qty: 2, serials: ['P-1'] }], items)!, /מספר סידורי לכל יחידה/);
  assert.equal(transferError('a', 'b', [{ itemId: 'phone', variantId: null, qty: 2, serials: ['P-1', 'P-2'] }, { itemId: 'cream', variantId: null, qty: 3 }], items), null);
  assert.match(transferError('a', 'b', [{ itemId: 'phone', variantId: null, qty: 2, serials: ['P-1', 'p-1'] }], items)!, /פעמיים/);
  const t = toTransfer({ id: 't', number: 4, from_location: 'a', to_location: 'b', status: 'sent', lines: [
    { itemId: 'phone', variantId: null, name: 'טלפון', variant: '', qty: 2, serials: ['P-1', 'P-2'] }, { itemId: 'cream', variantId: null, name: 'קרם', variant: '', qty: 3 }] });
  assert.deepEqual(t.lines[0].serials, ['P-1', 'P-2']);
  const got = { 'phone|': { received: 0, reason: '', missing: ['p-2'] } };
  assert.deepEqual(receiptGaps(t.lines, got).map((g) => [g.gap, g.missing]), [[-1, ['P-2']]], 'one number did not arrive (as the line has it)');
  assert.match(receiptError(t.lines, got)!, /כותבים למה/);
  const ok = { 'phone|': { received: 0, reason: 'נאבד', missing: ['P-2'] }, 'cream|': { received: 2, reason: 'נשבר' } };
  assert.equal(receiptError(t.lines, ok), null);
  assert.deepEqual(receiptPayload(t.lines, ok), [
    { itemId: 'phone', variantId: null, missing: ['P-2'], reason: 'נאבד' }, { itemId: 'cream', variantId: null, received: 2, reason: 'נשבר' }]);
  assert.deepEqual(receiptPayload(t.lines, {}), [], 'everything arrived: nothing to say');
  const note = transferNoteHtml({ ...t, status: 'received', lines: [{ ...t.lines[0], received: 1, missing: ['P-2'], reason: 'נאבד' }] },
    { business: 'עסק', from: 'ראשי', to: 'סניף', sentAt: 'היום' });
  assert.match(note, /מס׳ סידורי: P-1, P-2/);
  assert.match(note, /לא הגיעו: P-2 · נאבד/);
  assert.match(stockErrorHe({ message: 'transfer_serials: טלפון', code: '22023' }), /טלפון: בוחרים מספר סידורי/);
  assert.match(stockErrorHe({ message: 'serial_elsewhere: P-9', code: '23514' }), /במלאי בסניף אחר/);
});

test('a count does not list a product with numbers (it is checked by number)', () => {
  const rows = countList([{ id: 'phone', name: 'טלפון', trackStock: true, lowStock: 1, hasVariants: false, trackSerials: true },
    { id: 'cream', name: 'קרם', trackStock: true, lowStock: 1, hasVariants: false }], [], { lines: [] });
  assert.deepEqual(rows.map((r) => r.itemId), ['cream']);
});
