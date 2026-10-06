/**
 * The Google Merchant feed (2.60): one item per variant (grouped), the price a shopper pays (a sale as sale_price), the stock,
 * the pictures; a GTIN only when it is one; no services, nothing without a picture; and the XML escapes everything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedItems, feedXml, isGtin } from '../../src/lib/feed';
import type { Product } from '../../src/lib/types';

const pic = (id: string) => ({ id, url: `https://cdn.test/${id}.webp`, sizes: {}, alt: '' });
const base: Product = {
  id: 'p1', slug: 'שקית-על-בד', name: 'שקית על בד', kind: 'product', description: '## בד\n\nשקית <b>חזקה</b> & יפה', seo_title: '', seo_description: '',
  price: 3, price_max: 3, compare_at: null, in_stock: true, stock: null, sku: 'BAG-1', barcode: '', tags: [], manufacturer: '', country_of_origin: '',
  updated_at: '', images: [pic('m1'), pic('m2')], options: [{ name: 'צבע', position: 1, values: ['שחור', 'לבן'] }],
  variants: [
    { id: 'v1', options: ['שחור', '', ''], price: 3, compare_at: 4, in_stock: true, stock: 5, sku: 'BAG-1-B', barcode: '7290000000008', image: 'm2' },
    { id: 'v2', options: ['לבן', '', ''], price: 3, compare_at: null, in_stock: false, stock: 0, sku: 'BAG-1-W', barcode: '123', image: null },
  ],
  fields: [], collection: null, related: [], can_buy: true,
};
const o = { origin: 'https://followme.co.il', currency: 'ILS', storeName: 'FollowMe' };

test('a GTIN only with a valid check digit', () => {
  assert.equal(isGtin('7290000000008'), true);
  assert.equal(isGtin('7290000000001'), false);
  assert.equal(isGtin('123'), false);
  assert.equal(isGtin('96385074'), true);
});

test('variants: one item each, grouped, linked to the variant — the sale price, the stock, the colour, the picture', () => {
  const [b, w] = feedItems(base, o);
  assert.equal(b.id, 'v1'); assert.equal(b.groupId, 'p1'); assert.equal(b.title, 'שקית על בד — שחור');
  assert.equal(b.link, 'https://followme.co.il/products/%D7%A9%D7%A7%D7%99%D7%AA-%D7%A2%D7%9C-%D7%91%D7%93?variant=v1');
  assert.equal(b.price, '4.00 ILS'); assert.equal(b.salePrice, '3.00 ILS', 'a sale: the compare-at is the price, what is paid is the sale price');
  assert.equal(b.image, 'https://cdn.test/m2.webp', 'the variant\'s own picture'); assert.deepEqual(b.images, ['https://cdn.test/m1.webp']);
  assert.equal(b.gtin, '7290000000008'); assert.equal(b.color, 'שחור'); assert.equal(b.availability, 'in_stock');
  assert.equal(b.description, 'בד שקית חזקה & יפה', 'plain text');
  assert.equal(w.availability, 'out_of_stock'); assert.equal(w.gtin, null); assert.equal(w.salePrice, null); assert.equal(w.image, 'https://cdn.test/m1.webp');
  assert.equal(b.brand, 'FollowMe', 'no manufacturer: the store\'s name');
});

test('left out: a service, and a product with no picture (or only one that is not https)', () => {
  assert.deepEqual(feedItems({ ...base, kind: 'service' }, o), []);
  assert.deepEqual(feedItems({ ...base, variants: [], images: [] }, o), []);
  assert.deepEqual(feedItems({ ...base, variants: [], images: [{ ...pic('x'), url: 'http://insecure/x.png' }] }, o), []);
  const single = feedItems({ ...base, variants: [] }, o);
  assert.equal(single.length, 1); assert.equal(single[0].id, 'p1'); assert.equal(single[0].groupId, null); assert.equal(single[0].price, '3.00 ILS');
});

test('the XML: RSS 2.0 with the g: namespace, every value escaped, a missing GTIN said so', () => {
  const xml = feedXml(feedItems(base, o), { ...o, description: 'שקיות "ממותגות" <לעסקים>' });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<rss version="2.0" xmlns:g="http:\/\/base.google.com\/ns\/1.0">/);
  assert.equal((xml.match(/<item>/g) ?? []).length, 2);
  assert.match(xml, /<g:sale_price>3.00 ILS<\/g:sale_price>/);
  assert.match(xml, /<g:identifier_exists>no<\/g:identifier_exists>/);
  assert.match(xml, /<description>שקיות &quot;ממותגות&quot; &lt;לעסקים&gt;<\/description>/);
  assert.match(xml, /חזקה &amp; יפה/);
  assert.match(xml, /\?variant=v1<\/g:link>/);
  assert.doesNotMatch(xml, /<b>/);
});
