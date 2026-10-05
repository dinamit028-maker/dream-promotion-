/**
 * Dream Commerce stage 1 (2.54): a size / colour travels with every line that moves stock — the register's sale, a held
 * sale, a refund back to stock, a direct document, a credit back to stock, an expense — and the picks of finance offer
 * every variant (never the item alone, whose stock would move "not assigned"). An item without variants: as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPicks, toCatalogItem, toVariant } from '../src/features/catalog/catalog';
import { holdCart, parseHeld, resumeHeld } from '../src/features/register/held';
import { planRefund, returnedQty } from '../src/features/register/refunds';
import { applyStock } from '../src/features/register/stock';
import { composeCredit, computeLines } from '../src/features/finance/compose';
import type { Sale } from '../src/features/register/money';
import type { Doc } from '../src/features/documents/openformat';

const SHIRT = 'i-shirt', HAT = 'i-hat', S = 'v-s', M = 'v-m';
const items = [
  toCatalogItem({ id: SHIRT, name: 'חולצה', price: 100, kind: 'product', active: true, has_variants: true, track_stock: true, stock_qty: 10 }),
  toCatalogItem({ id: HAT, name: 'כובע', price: 50, kind: 'product', active: true, track_stock: true, stock_qty: 5 }),
  toCatalogItem({ id: 'i-old', name: 'מוסתר', price: 1, kind: 'product', active: false }),
];
const variants = [
  toVariant({ id: S, item_id: SHIRT, option1: 'S', position: 1 }),
  toVariant({ id: M, item_id: SHIRT, option1: 'M', price: 110, position: 2 }),
  toVariant({ id: 'v-x', item_id: SHIRT, option1: 'XL', active: false, position: 3 }),
];

test('finance picks: every active variant (its own name and price), never the item alone; an item without variants as before', () => {
  assert.deepEqual(catalogPicks(items, variants), [
    { id: SHIRT, variantId: S, name: 'חולצה · S', price: 100, kind: 'product' },
    { id: SHIRT, variantId: M, name: 'חולצה · M', price: 110, kind: 'product' },
    { id: HAT, name: 'כובע', price: 50, kind: 'product' },
  ]);
  const noneActive = catalogPicks(items, variants.map((v) => ({ ...v, active: false })));
  assert.deepEqual(noneActive.filter((p) => p.id === SHIRT), [{ id: SHIRT, name: 'חולצה', price: 100, kind: 'product' }], 'no active variant: the item itself');
});

test('a held sale keeps the size / colour of each line', () => {
  const cart = { lines: [{ name: 'חולצה · M', price: 110, qty: 2, itemId: SHIRT, variantId: M, kind: 'product' as const }, { name: 'סכום חופשי', price: 20, qty: 1, variantId: 'junk' }],
    customer: { name: '', phone: '', leadId: null, appointmentId: null }, discount: { kind: 'sum' as const, value: 0 }, note: '', employeeId: '' };
  const h = holdCart([], cart);
  assert.ok(h.ok);
  const stored = parseHeld(JSON.stringify(h.ok ? h.list : []));
  assert.equal(stored[0].lines[0].variantId, M, 'the variant survives the device\'s storage');
  assert.equal(stored[0].lines[1].variantId, undefined, 'a variant without an item is dropped');
  const back = resumeHeld(stored, stored[0].id);
  assert.equal(back?.cart.lines[0].variantId, M);
});

test('a refund back to stock gives back the variant that was sold; two variants are two lines', () => {
  const sale: Sale = {
    id: 's1', leadId: null, appointmentId: null, customerName: '', customerPhone: '', subtotal: 320, discount: 0, total: 320, vatRate: 18, vatAmount: 48.81,
    method: 'cash', status: 'paid', note: '', paidAt: '2026-10-05T08:00:00Z', createdAt: '2026-10-05T08:00:00Z', employeeId: null, employeeName: '',
    items: [{ name: 'חולצה', price: 100, qty: 1, itemId: SHIRT, variantId: S, kind: 'product' }, { name: 'חולצה', price: 110, qty: 2, itemId: SHIRT, variantId: M, kind: 'product' }],
  };
  const r = planRefund(sale, [], { mode: 'items', qty: [0, 1] }, { method: 'cash', restock: true });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.refund.items.map((l) => [l.variantId, l.qty]), [[M, 1]]);
  assert.equal(r.refund.restock, true);
  const prior = [{ ...r.refund, id: 'r1', createdAt: '2026-10-05T09:00:00Z' }];
  assert.deepEqual(returnedQty(sale, prior), [0, 1], 'the M that came back is not counted against S');
  // the screen's item sum follows the database (the variant's own count: applyVariantStock, tests/catalog.test.ts)
  const after = applyStock([{ id: SHIRT, name: 'חולצה', trackStock: true, stockQty: 7, lowStock: 2 }], r.refund.items, -1);
  assert.equal(after[0].stockQty, 8);
});

test('a document line and a credit back to stock carry the variant (the database moves that variant)', () => {
  const c = computeLines([{ name: 'חולצה · M', qty: 2, unitPrice: 110, itemId: SHIRT, variantId: M }, { name: 'שירות', qty: 1, unitPrice: 50, variantId: 'junk' }],
    { pricesIncludeVat: true, rate: 18 });
  assert.equal(c.lines[0].itemId, SHIRT);
  assert.equal(c.lines[0].variantId, M);
  assert.equal(c.lines[1].variantId, undefined, 'a line without an item has no variant');
  const base: Doc = {
    docType: 320, docNumber: 7, linkNo: 1, issuedAt: '2026-10-05T08:00:00Z', docDate: '2026-10-05', customerName: 'לקוחה',
    beforeDiscount: c.totals.beforeDiscount, discount: 0, afterDiscount: c.totals.afterDiscount, vatAmount: c.totals.vatAmount, total: c.totals.total,
    lines: c.lines, payments: [],
  } as unknown as Doc;
  const cr = composeCredit(base, { kind: 'lines', qty: [1, 0], restock: true }, 0, '2026-10-05', { today: '2026-10-05' });
  assert.ok(cr.ok);
  if (cr.ok) {
    assert.equal(cr.doc.lines.length, 1);
    assert.deepEqual([cr.doc.lines[0].itemId, cr.doc.lines[0].variantId, cr.doc.lines[0].restock], [SHIRT, M, true]);
  }
});
