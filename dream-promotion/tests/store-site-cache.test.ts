/**
 * The storefront's shared cache (2.74): after every write the shoppers see, the dashboard asks the storefront to drop what
 * it keeps of the store — a request signed for that store, with the preview's secret but another purpose (one vector,
 * checked by both apps: storefront/tests/unit/site-cache.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makePreviewToken, makeRevalidateToken } from '../src/features/store/preview-token';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the refresh token: the shared vector; never the same as a preview token', () => {
  const store = '00000000-0000-4000-8000-000000000001', secret = 'k'.repeat(32);
  const t = makeRevalidateToken(store, secret, 2_000_000_000);
  assert.equal(t, `${store}.2000000000.uuNMt-m_NxehBuqPH--mx-uzv0HFeKNqoXdv9Ro3Ca8`, 'storefront/tests/unit/site-cache.test.ts verifies this same token');
  assert.notEqual(t, makePreviewToken(store, secret, 2_000_000_000), 'another purpose: a preview token never refreshes, this never previews');
});

test('every write the shoppers see asks for the refresh: the store, the published theme, pages, menus, collections, a kit', () => {
  const src = readFileSync(`${ROOT}src/features/store/data.ts`, 'utf8');
  const body = (name: string) => {
    const i = src.indexOf(`export async function ${name}(`);
    assert.ok(i >= 0, name);
    return src.slice(i, src.indexOf('\n}\n', i));
  };
  for (const fn of ['updateStore', 'publishVersion', 'savePage', 'deletePage', 'saveMenu', 'saveCollection', 'orderCollections', 'deleteCollection', 'applyKit', 'applyKitSteps']) {
    assert.match(fn === 'applyKitSteps' ? src.slice(src.indexOf('async function applyKitSteps(')) : body(fn), /refreshed\(/, `${fn} refreshes the storefront`);
  }
  assert.doesNotMatch(body('saveDraft'), /refreshed\(/, 'a draft is not on the site: nothing to refresh');
});
