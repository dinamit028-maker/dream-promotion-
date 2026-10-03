/** Held sales: park a cart on the device, resume it exactly, never more than 10, never crash on bad storage. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HELD, heldKey, holdCart, loadHeld, parseHeld, removeHeld, resumeHeld, saveHeld, type Cart, type HeldSale } from '../src/features/register/held';
import { heldCountLabel } from '../src/features/register/PosView';

const memory = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
const cart = (p: Partial<Cart> = {}): Cart => ({
  lines: [{ name: 'לייזר', price: 250, qty: 1 }, { name: 'קרם', price: 89.9, qty: 2 }],
  customer: { name: 'דנה', phone: '0521234567', leadId: 'L1', appointmentId: 'A1' },
  discount: { kind: 'percent', value: 10 }, note: 'לבדוק מבצע', employeeId: 'E1', ...p,
});
const NOW = new Date('2026-10-05T08:30:00Z');

test('held: hold → save → load → resume gives back the same cart', () => {
  const s = memory();
  const r = holdCart([], cart(), NOW);
  assert.ok(r.ok);
  assert.equal(r.list.length, 1); assert.equal(r.held.heldAt, NOW.toISOString()); assert.ok(r.held.id);
  assert.ok(saveHeld(s, 'biz', r.list));
  assert.ok(s.m.has(heldKey('biz')), 'stored under the business key');
  const loaded = loadHeld(s, 'biz');
  assert.deepEqual(loaded, r.list, 'survives a page reload');
  assert.deepEqual(loadHeld(s, 'other-biz'), [], 'another account on the same device sees nothing');
  const back = resumeHeld(loaded, r.held.id);
  assert.ok(back);
  assert.deepEqual(back.cart, cart(), 'items, customer, discount, note and seller all come back');
  assert.deepEqual(back.list, [], 'a resumed sale leaves the list');
});

test('held: newest first, at most 10, empty cart refused', () => {
  let list: HeldSale[] = [];
  for (let i = 0; i < MAX_HELD; i++) {
    const r = holdCart(list, cart({ note: `#${i}` }), new Date(NOW.getTime() + i * 60000));
    assert.ok(r.ok); list = r.list;
  }
  assert.equal(list.length, 10); assert.equal(list[0].note, '#9', 'newest first');
  assert.deepEqual(holdCart(list, cart()), { ok: false, error: 'full' }, 'the 11th is refused — nothing is dropped silently');
  assert.deepEqual(holdCart([], cart({ lines: [] })), { ok: false, error: 'empty' });
  assert.deepEqual(holdCart([], cart({ lines: [{ name: 'x', price: 5, qty: 0 }] })), { ok: false, error: 'empty' }, 'zero quantities do not count');
});

test('held: resuming while a cart is in progress parks the current one in its place', () => {
  let list: HeldSale[] = [];
  for (let i = 0; i < MAX_HELD; i++) { const r = holdCart(list, cart({ note: `#${i}` })); assert.ok(r.ok); list = r.list; }
  const target = list[3];
  const r = resumeHeld(list, target.id, cart({ note: 'בתהליך', customer: { name: 'יוסי', phone: '', leadId: null, appointmentId: null } }), NOW);
  assert.ok(r);
  assert.equal(r.cart.note, target.note);
  assert.equal(r.list.length, 10, 'swap keeps the count — works even when 10 are held');
  assert.equal(r.list[0].customer.name, 'יוסי'); assert.ok(!r.list.some((h) => h.id === target.id));
  assert.equal(resumeHeld(list, 'missing'), null);
  assert.equal(removeHeld(list, target.id).length, 9);
});

test('held: broken or old storage never crashes the register', () => {
  assert.deepEqual(parseHeld(null), []);
  assert.deepEqual(parseHeld('not json'), []);
  assert.deepEqual(parseHeld('{"a":1}'), []);
  const mixed = JSON.stringify([
    { id: 'ok', heldAt: '2026-10-05T08:00:00Z', lines: [{ name: 'קרם', price: 50, qty: 2 }], customer: { name: 'דנה' }, discount: { kind: 'weird', value: -5 } },
    { id: 'no-lines' }, null, 'x', { id: '', lines: [{ name: 'a', price: 1, qty: 1 }] },
  ]);
  const list = parseHeld(mixed);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].customer, { name: 'דנה', phone: '', leadId: null, appointmentId: null });
  assert.deepEqual(list[0].discount, { kind: 'sum', value: 0 }, 'bad discount normalized');
  assert.equal(parseHeld(JSON.stringify(Array.from({ length: 15 }, (_, i) => ({ id: `h${i}`, lines: [{ name: 'a', price: 1, qty: 1 }] })))).length, 10, 'never more than 10');
  const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(loadHeld(blocked, 'biz'), []);
  assert.equal(saveHeld(blocked, 'biz', []), false, 'reports that the device did not save');
  assert.equal(saveHeld(null, 'biz', []), false);
});

test('held: the banner text', () => {
  assert.equal(heldCountLabel(1), 'עסקה מושהית אחת');
  assert.equal(heldCountLabel(2), '2 עסקאות מושהות');
});
