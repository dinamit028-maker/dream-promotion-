import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNT_STATUS_HE, STOCK_MIGRATION, TRANSFER_STATUS_HE, atLocationStock, countList, countSummary, countsAt, findByCode, levelOf, lowStock,
  moveRows, onTheWay, qtyAt, receiptError, receiptGaps, receiptPayload, registerAtLocation, stockErrorHe, stockKey, toCount, toStockRow,
  toTransfer, totalOf, transferError, transferSummary, type StockRow,
} from '../src/features/stock/stock-locations';

// the main location B, a branch L2, a closed warehouse L3; a cream (no variants), a shirt (S, M), a service
const B = 'b1', L2 = 'l2', L3 = 'l3', CREAM = 'i1', SHIRT = 'i2', SVC = 'i3', S = 'v1', M = 'v2';
const rows: StockRow[] = [
  { locationId: B, itemId: CREAM, variantId: null, qty: 10 }, { locationId: L2, itemId: CREAM, variantId: null, qty: 1 },
  { locationId: L3, itemId: CREAM, variantId: null, qty: 30 },
  { locationId: B, itemId: SHIRT, variantId: null, qty: 4 }, { locationId: B, itemId: SHIRT, variantId: S, qty: 4 }, { locationId: B, itemId: SHIRT, variantId: M, qty: 0 },
  { locationId: L2, itemId: SHIRT, variantId: null, qty: 3 }, { locationId: L2, itemId: SHIRT, variantId: S, qty: 1 }, { locationId: L2, itemId: SHIRT, variantId: M, qty: 2 },
];
const items = [
  { id: CREAM, name: 'קרם', trackStock: true, lowStock: 2, hasVariants: false, sku: 'CR-1', barcode: '7290000000011', kind: 'product' },
  { id: SHIRT, name: 'חולצה', trackStock: true, lowStock: 1, hasVariants: true, sku: 'SH', barcode: '', kind: 'product' },
  { id: SVC, name: 'טיפול', trackStock: false, lowStock: 2, hasVariants: false, kind: 'service' },
];
const variants = [
  { id: S, itemId: SHIRT, label: 'S', lowStock: null, active: true, sku: 'SH-S', barcode: '7290000000028' },
  { id: M, itemId: SHIRT, label: 'M', lowStock: 1, active: true, sku: 'SH-M', barcode: '' },
];
const places = [{ id: B, name: 'ראשי', active: true }, { id: L2, name: 'סניף', active: true }, { id: L3, name: 'מחסן', active: false }];

test('a location\'s count, the total; the database\'s rows → the screens\'', () => {
  assert.deepEqual(toStockRow({ location_id: B, item_id: CREAM, variant_id: null, qty: '7' }), { locationId: B, itemId: CREAM, variantId: null, qty: 7 });
  assert.equal(qtyAt(rows, L2, CREAM), 1);
  assert.equal(qtyAt(rows, L2, SHIRT, M), 2);
  assert.equal(qtyAt(rows, L3, SHIRT, S), 0, 'none there: 0');
  assert.equal(totalOf(rows, CREAM), 41);
  assert.equal(totalOf(rows, SHIRT, S), 5);
  assert.equal(countsAt(rows, L2).get(stockKey(SHIRT, S)), 1);
  assert.deepEqual([levelOf(0, 2), levelOf(-1, 2), levelOf(2, 2), levelOf(3, 2)], ['out', 'out', 'low', 'ok']);
});

test('the register: the stock of its location, and after a sale there', () => {
  // one location: the total, as before (the main location's count is the total anyway)
  assert.equal(registerAtLocation({ multi: false, limited: false, businessId: B }, B), false);
  assert.equal(registerAtLocation({ multi: false, limited: false, businessId: B }, null), false, 'before locations: as before');
  assert.equal(registerAtLocation({ multi: true, limited: false, businessId: B }, B), true);
  assert.equal(registerAtLocation({ multi: false, limited: true, businessId: B }, B), true, 'limited to the main location: only its units');
  assert.equal(registerAtLocation({ multi: false, limited: false, businessId: B }, L2), true, 'a register at a branch');
  const reg = [
    { id: CREAM, trackStock: true, stockQty: 41, name: 'קרם' }, { id: SHIRT, trackStock: true, stockQty: 7, name: 'חולצה' },
    { id: SVC, trackStock: false, stockQty: 0, name: 'טיפול' },
  ];
  const regV = [{ id: S, itemId: SHIRT, stockQty: 5 }, { id: M, itemId: SHIRT, stockQty: 2 }];
  const here = atLocationStock(reg, regV, rows, L2);
  assert.deepEqual(here.items.map((i) => i.stockQty), [1, 3, 0]);
  assert.deepEqual(here.variants.map((v) => v.stockQty), [1, 2]);
  assert.equal(here.items[0].name, 'קרם', 'everything else as it was');
  assert.deepEqual(atLocationStock(reg, regV, rows, L3).items.map((i) => i.stockQty), [30, 0, 0], 'nothing of it there: 0');
  // a sale of 2 creams and an M at the branch: its rows, the item's and the variant's; a service moves nothing
  const after = moveRows(rows, L2, [{ itemId: CREAM, qty: 2 }, { itemId: SHIRT, variantId: M, qty: 1 }, { itemId: SVC, qty: 1 }, { qty: 1 }]);
  assert.deepEqual([qtyAt(after, L2, CREAM), qtyAt(after, L2, SHIRT), qtyAt(after, L2, SHIRT, M), qtyAt(after, B, CREAM)], [-1, 2, 1, 10]);
  assert.ok(!after.some((r) => r.itemId === SVC));
  assert.equal(qtyAt(rows, L2, CREAM), 1, 'the rows it was given stay as they were');
  // units back at a location with no row of the item yet: a new row
  const back = moveRows(rows, L3, [{ itemId: SHIRT, variantId: S, qty: 2 }], -1);
  assert.deepEqual([qtyAt(back, L3, SHIRT), qtyAt(back, L3, SHIRT, S)], [2, 2]);
});

test('low stock at each location, and where to bring it from', () => {
  const low = lowStock(rows, items, variants, places);
  // the closed warehouse is not listed, nor offered (its 30 creams stay where they are)
  assert.ok(!low.some((l) => l.locationId === L3));
  const cream = low.find((l) => l.itemId === CREAM && l.locationId === L2)!;
  assert.deepEqual([cream.qty, cream.low, cream.level, cream.suggest], [1, 2, 'low', { from: B, qty: 2 }], 'the branch: 1 of 2 — bring 2 from the main location (it has 8 to spare)');
  const m = low.find((l) => l.variantId === M && l.locationId === B)!;
  assert.deepEqual([m.name, m.level, m.suggest], ['חולצה · M', 'out', { from: L2, qty: 1 }], 'M is out at the main location: the branch can spare 1 (2 less its level 1)');
  const s = low.find((l) => l.variantId === S && l.locationId === L2)!;
  assert.deepEqual([s.low, s.suggest], [1, { from: B, qty: 1 }], 'a variant with no level of its own: the item\'s');
  assert.equal(low[0].qty, 0, 'emptiest first');
  assert.ok(!low.some((l) => l.itemId === SVC), 'a product whose stock is not counted: never low');
  // nobody to spare: no suggestion
  const lone = lowStock([{ locationId: B, itemId: CREAM, variantId: null, qty: 0 }, { locationId: L2, itemId: CREAM, variantId: null, qty: 2 }], items, variants, places);
  assert.deepEqual(lone.filter((l) => l.itemId === CREAM).map((l) => [l.locationId, l.suggest]), [[B, null], [L2, null]],
    'the main location has none, the branch only its own level: nothing to spare');
});

test('a transfer: the checks before sending, what is on the way', () => {
  assert.equal(transferError(B, L2, [{ itemId: CREAM, variantId: null, qty: 3 }], items), null);
  assert.equal(transferError(B, B, [{ itemId: CREAM, variantId: null, qty: 3 }], items), 'מעבירים מסניף אחד לסניף אחר.');
  assert.equal(transferError(null, L2, [], items), 'בוחרים מאיפה ולאן.');
  assert.equal(transferError(B, L2, [], items), 'מוסיפים לפחות מוצר אחד.');
  assert.equal(transferError(B, L2, [{ itemId: CREAM, variantId: null, qty: 1.5 }], items), 'קרם: כמות ביחידות שלמות, יותר מאפס.');
  assert.equal(transferError(B, L2, [{ itemId: SVC, variantId: null, qty: 1 }], items), 'טיפול: המלאי שלו לא נספר — סופרים אותו קודם.');
  assert.equal(transferError(B, L2, [{ itemId: SHIRT, variantId: null, qty: 1 }], items), 'חולצה: בוחרים מידה / צבע.');
  assert.equal(transferError(B, L2, [{ itemId: CREAM, variantId: null, qty: 1 }, { itemId: CREAM, variantId: null, qty: 2 }], items),
    'אותו מוצר פעמיים — מאחדים לשורה אחת.');
  const t = toTransfer({ id: 't1', number: 4, from_location: B, to_location: L2, status: 'sent', sent_at: '2026-10-11T08:00:00Z', note: '',
    lines: [{ itemId: CREAM, variantId: null, name: 'קרם', variant: '', qty: 3 }, { itemId: SHIRT, variantId: M, name: 'חולצה', variant: 'M', qty: 1 }] });
  assert.equal(transferSummary(t), '2 פריטים · 4 יחידות');
  assert.equal(transferSummary({ lines: [t.lines[1]] }), 'פריט אחד · יחידה אחת');
  assert.equal(onTheWay([t, { ...t, id: 't2', status: 'received' }]).get(stockKey(CREAM)), 3, 'only what was sent and not received');
  assert.equal(TRANSFER_STATUS_HE[t.status], 'בדרך');
});

test('a transfer received: a difference needs its reason; only the differences are sent', () => {
  const lines = [{ itemId: CREAM, variantId: null, name: 'קרם', variant: '', qty: 3 }, { itemId: SHIRT, variantId: M, name: 'חולצה', variant: 'M', qty: 1 }];
  assert.equal(receiptError(lines, {}), null, 'everything arrived as sent');
  assert.deepEqual(receiptPayload(lines, {}), []);
  const got = { [stockKey(CREAM)]: { received: 2, reason: '' } };
  assert.equal(receiptError(lines, got), 'קרם: חסרות 1 — כותבים למה.');
  assert.equal(receiptError(lines, { [stockKey(SHIRT, M)]: { received: 2, reason: '' } }), 'חולצה · M: הגיעו 1 יותר — כותבים למה.');
  assert.equal(receiptError(lines, { [stockKey(CREAM)]: { received: -1, reason: 'x' } }), 'קרם: כמה הגיע — ביחידות שלמות.');
  const ok = { [stockKey(CREAM)]: { received: 2, reason: ' נשבר בדרך ' } };
  assert.equal(receiptError(lines, ok), null);
  assert.deepEqual(receiptGaps(lines, ok), [{ key: stockKey(CREAM), name: 'קרם', gap: -1, reason: 'נשבר בדרך' }]);
  assert.deepEqual(receiptPayload(lines, ok), [{ itemId: CREAM, variantId: null, received: 2, reason: 'נשבר בדרך' }]);
});

test('a count: its list, what was scanned, the summary before approval', () => {
  const c = toCount({ id: 'c1', number: 2, location_id: L2, status: 'open', note: '', created_at: '2026-10-11T08:00:00Z',
    lines: { [`${CREAM}:`]: { itemId: CREAM, variantId: null, counted: 1, at: '2026-10-11T08:01:00Z' } } });
  assert.deepEqual(c.lines, [{ itemId: CREAM, variantId: null, counted: 1, at: '2026-10-11T08:01:00Z' }]);
  assert.equal(COUNT_STATUS_HE[c.status], 'פתוחה');
  const list = countList(items, variants, c);
  assert.deepEqual(list.map((r) => [r.name, r.counted]), [['קרם', 1], ['חולצה · S', null], ['חולצה · M', null]], 'products and each variant; not the service');
  assert.deepEqual(findByCode(' 7290000000028 ', items, variants), { itemId: SHIRT, variantId: S }, 'a variant\'s barcode');
  assert.deepEqual(findByCode('cr-1', items, variants), { itemId: CREAM, variantId: null }, 'an item\'s SKU, any case');
  assert.equal(findByCode('SH', items, variants), null, 'an item with variants is counted per variant — its own code finds nothing');
  assert.equal(findByCode('', items, variants), null);
  const sum = countSummary([{ itemId: CREAM, variantId: null, counted: 1, expected: 1, gap: 0 }, { itemId: SHIRT, variantId: S, counted: 0, expected: 1, gap: -1 },
    { itemId: SHIRT, variantId: M, counted: 4, expected: 2, gap: 2 }], 5);
  assert.deepEqual(sum, { counted: 3, matched: 1, short: 1, over: 1, unitsShort: 1, unitsOver: 2, notCounted: 2 });
});

test('the database\'s refusals in Hebrew', () => {
  assert.equal(stockErrorHe({ message: 'relation "public.stock_by_location" does not exist', code: '42P01' }), STOCK_MIGRATION);
  assert.equal(stockErrorHe({ message: 'reserved_for_online: קרם', code: 'P0001' }), 'קרם: היחידות שמורות להזמנה באתר — אי אפשר להעביר אותן.');
  assert.equal(stockErrorHe({ message: 'transfer_gap_reason: קרם' }), 'קרם: הגיע משהו אחר ממה שנשלח — כותבים למה.');
  assert.equal(stockErrorHe({ message: 'count_open: count 3 of this location is open' }), 'יש כבר ספירה פתוחה בסניף הזה — ממשיכים אותה.');
  assert.equal(stockErrorHe({ message: 'not allowed: the owner approves a count', code: '42501' }), 'רק הבעלים מאשרים ספירה.');
  assert.equal(stockErrorHe({ message: 'not allowed: this location is not yours', code: '42501' }), 'אין הרשאה לפעולה הזו.');
});
