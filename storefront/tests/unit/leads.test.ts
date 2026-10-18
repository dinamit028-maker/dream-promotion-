/**
 * A request of the site (2.102, lib/leads.ts): what the form sends is read and checked before it goes to sf_lead_request — the
 * same rules as the database (tests/sql/quote-mode.check.sql), so the form says what to fix at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIELD_ERRORS, LEAD_ERRORS, phoneOk, readLead, topicsOf } from '../../src/lib/leads';
import { quotePrice } from '../../src/lib/format';
import { feedItems } from '../../src/lib/feed';
import type { Product } from '../../src/lib/types';

const REQ = '6f1d2c3b-4a59-4e7f-8a1b-2c3d4e5f6a7b';
const ITEM = '0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e';
const quote = (o: Record<string, unknown> = {}) => ({ kind: 'quote', request: REQ, item: ITEM, name: 'דנה כהן', phone: '050-1234567', ...o });

test('a phone the business can call back — the checkout\'s rule', () => {
  for (const ok of ['050-1234567', '0501234567', '+972 50 123 4567', '972501234567', '03-1234567', '+1 555 010 0123']) assert.ok(phoneOk(ok), ok);
  for (const bad of ['', '123', '05012', 'abc', '+12', '0501234567890']) assert.equal(phoneOk(bad), false, bad);
});

test('a quote request: the product and a request id are required; the rest is cleaned', () => {
  const r = readLead(quote({ name: '  דנה   כהן ', qty: '1,000', notes: ' לוגו בזהב\r\nשתי שורות ', email: 'Dana@Example.com', page: '/products/bag-001' }));
  assert.ok(r.ok);
  assert.deepEqual(r.input, {
    kind: 'quote', request: REQ, item: ITEM, name: 'דנה כהן', phone: '050-1234567', email: 'dana@example.com', qty: '1000',
    topic: '', notes: 'לוגו בזהב\nשתי שורות', model: '', page: '/products/bag-001',
  });
  assert.deepEqual(readLead(quote({ item: '' })), { ok: false, error: 'bad_request' }, 'a quote names its product');
  assert.deepEqual(readLead(quote({ request: 'x' })), { ok: false, error: 'bad_request' }, 'a request id is a uuid');
  assert.deepEqual(readLead(quote({ kind: 'order' })), { ok: false, error: 'bad_request' }, 'only a quote or a contact');
});

test('what to fix comes back by field, in the database\'s order', () => {
  const r = readLead(quote({ name: 'א', phone: '12', email: 'not-an-email', qty: '0', notes: 'x'.repeat(1001) }));
  assert.deepEqual(r, { ok: false, error: 'details', fields: ['name', 'phone', 'email', 'qty', 'notes'] });
  for (const f of ['name', 'phone', 'email', 'qty', 'notes'] as const) assert.ok(FIELD_ERRORS[f]);
  assert.deepEqual(readLead(quote({ qty: '1.5' })), { ok: false, error: 'details', fields: ['qty'] }, 'a whole quantity');
  assert.deepEqual(readLead(quote({ qty: '20000000' })), { ok: false, error: 'details', fields: ['qty'] }, 'up to 10,000,000');
});

test('a contact request: no product; a model from the address is checked; a page that is not a path is dropped', () => {
  const r = readLead({ kind: 'contact', request: REQ, item: ITEM, name: 'רינה', phone: '052-7778888', model: 'bag-032', topic: 'סורסינג', page: 'https://evil.test/x' });
  assert.ok(r.ok);
  assert.equal(r.input.item, null, 'a contact request carries no product');
  assert.equal(r.input.model, 'bag-032');
  assert.equal(r.input.page, '', 'only a path of this site');
  assert.deepEqual(readLead({ kind: 'contact', request: REQ, name: 'רינה', phone: '052-7778888', model: '<script>' }),
    { ok: false, error: 'details', fields: ['model'] });
  assert.equal((readLead(quote({ model: 'bag-099' })) as { input: { model: string } }).input.model, '', 'a quote\'s model comes from its product, not the form');
});

test('the topics a contact form offers: once each, up to six', () => {
  assert.deepEqual(topicsOf('סורסינג ומוצרים, אריזה למותג,  אחר ,אחר'), ['סורסינג ומוצרים', 'אריזה למותג', 'אחר']);
  assert.deepEqual(topicsOf(''), []);
  assert.equal(topicsOf('א,ב,ג,ד,ה,ו,ז,ח').length, 6);
});

test('every refusal has words for the shopper', () => {
  for (const e of ['bad_request', 'bot', 'rate', 'too_many', 'store', 'item', 'details', 'error']) assert.ok(LEAD_ERRORS[e], e);
});

test('a quote\'s "from" price in its own currency, else the store\'s; none without a price', () => {
  assert.match(quotePrice({ from: 3.5, currency: 'USD' }), /3\.50/);
  assert.match(quotePrice({ from: 3.5, currency: 'USD' }), /\$/);
  assert.match(quotePrice({ from: 12, currency: '' }, 'ILS'), /₪/);
  assert.equal(quotePrice({ from: null, currency: 'USD' }), '');
});

test('the product feed leaves out a product sold by a quote (no price a shopper pays)', () => {
  const p = {
    id: ITEM, slug: 'bag-001', name: 'שקית', kind: 'product', description: '', seo_title: '', seo_description: '', price: 0, price_max: 0,
    compare_at: null, in_stock: true, stock: null, sku: 'bag-001', barcode: '', tags: [], manufacturer: '', country_of_origin: '', updated_at: '',
    images: [{ url: 'https://cdn.test/a.webp', sizes: {}, alt: '' }], options: [], variants: [], fields: [], collection: null, related: [], can_buy: false,
  } satisfies Product;
  assert.equal(feedItems(p, { origin: 'https://shop.test', currency: 'ILS', storeName: 'חנות' }).length, 1, 'sold as before: in the feed');
  assert.equal(feedItems({ ...p, quote: { from: 3.5, currency: 'USD', min: null } }, { origin: 'https://shop.test', currency: 'ILS', storeName: 'חנות' }).length, 0);
});
