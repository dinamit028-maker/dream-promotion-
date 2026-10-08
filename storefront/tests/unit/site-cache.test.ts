/**
 * The shared cache (2.74): the refresh is accepted only signed for that store, with this purpose, for at most five
 * minutes (the dashboard's copy signs the same vector: dream-promotion/tests/store-site-cache.test.ts). What is kept and
 * what never is: shared-cache.ts reads through `data` with preview false only; products, stock, the cart and the payment
 * are not in it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePreviewToken, makeRevalidateToken, verifyRevalidateToken } from '../../src/lib/preview';

const store = '00000000-0000-4000-8000-000000000001', secret = 'k'.repeat(32);

test('a refresh: signed for its store and purpose, five minutes at most', () => {
  const vector = `${store}.2000000000.uuNMt-m_NxehBuqPH--mx-uzv0HFeKNqoXdv9Ro3Ca8`;
  assert.equal(makeRevalidateToken(store, secret, 2_000_000_000), vector);
  assert.equal(verifyRevalidateToken(vector, secret, 2_000_000_000 - 60), store);
  assert.equal(verifyRevalidateToken(vector, secret, 2_000_000_000 - 301), null, 'more than five minutes ahead');
  assert.equal(verifyRevalidateToken(vector, secret, 2_000_000_001), null, 'expired');
  assert.equal(verifyRevalidateToken(vector, 'x'.repeat(32), 2_000_000_000 - 60), null, 'another secret');
  assert.equal(verifyRevalidateToken(makePreviewToken(store, secret, 2_000_000_000), secret, 2_000_000_000 - 60), null, 'a preview token is not a refresh');
  assert.equal(verifyRevalidateToken(vector.replace(store, '00000000-0000-4000-8000-000000000002'), secret, 2_000_000_000 - 60), null, 'another store');
  assert.equal(verifyRevalidateToken(vector, 'short', 2_000_000_000 - 60), null);
});

test('what is kept: the store, collections, pages, sitemap — for shoppers; never a product, stock, the cart or the payment', () => {
  const src = readFileSync(join(__dirname, '../../src/lib/shared-cache.ts'), 'utf8');
  assert.doesNotMatch(src, /data\.(products?|cart|checkout|order|resolveHost|resolveSlug)\b/);
  assert.doesNotMatch(src, /keep\([^)]*true\)/, 'a kept read is never a preview');
  for (const f of ['store', 'collections', 'page', 'sitemap']) assert.match(src, new RegExp(`keep\\('${f}'`));
});
