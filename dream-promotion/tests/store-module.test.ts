/**
 * "חנות" as an app of its own (Dream Commerce 2.54, stage 1): its addresses, its menu (every screen once), its "+",
 * and the shell's rule that decides which module a page belongs to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORE_SECTIONS, isStorePath, productHref, storeHref } from '../src/features/store/routes';
import { STORE_MODULE } from '../src/features/store/module';
import { FINANCE_MODULE } from '../src/features/finance/module';
import { isFinancePath } from '../src/features/finance/routes';
import { groupOfPath } from '../src/components/shell/module-nav';

test('the store\'s addresses: the products, one product, a new one; the site\'s screens (2.55)', () => {
  assert.deepEqual(STORE_SECTIONS.map((s) => s.path), ['/store/products', '/store/collections', '/store/design', '/store/pages', '/store/navigation', '/store/settings']);
  assert.equal(storeHref('products'), '/store/products');
  assert.equal(storeHref('pages', { policy: 'returns' }), '/store/pages?policy=returns');
  assert.equal(storeHref('collections', { new: '1' }), '/store/collections?new=1');
  assert.equal(storeHref('products', { new: '1' }), '/store/products?new=1');
  assert.equal(productHref('abc'), '/store/products/abc');
  assert.equal(productHref('new'), '/store/products/new');
  for (const p of ['/store', '/store/', '/store/products', '/store/products/abc']) assert.ok(isStorePath(p), p);
  for (const p of ['/stores', '/register', '/finance', '/', '/storefront']) assert.ok(!isStorePath(p), p);
});

test('the store\'s menu: every screen once; "+" opens a new product, collection or page; its own color', () => {
  const links = STORE_MODULE.groups.flatMap((g) => g.links.map((l) => l.href));
  assert.deepEqual([...links].sort(), STORE_SECTIONS.map((s) => s.path).sort());
  assert.equal(STORE_MODULE.home, '/store/products');
  assert.equal(STORE_MODULE.theme, 'module-store');
  assert.notEqual(STORE_MODULE.theme, FINANCE_MODULE.theme);
  assert.deepEqual(STORE_MODULE.actions.map((a) => [a.label, a.href]), [
    ['מוצר חדש', '/store/products?new=1'], ['קולקציה חדשה', '/store/collections?new=1'], ['עמוד חדש', '/store/pages?new=1']]);
  assert.equal(groupOfPath(STORE_MODULE.groups, '/store/products'), 'catalog');
  assert.equal(groupOfPath(STORE_MODULE.groups, '/store/design'), 'site');
  assert.equal(groupOfPath(STORE_MODULE.groups, '/store/settings'), 'settings');
  for (const t of STORE_MODULE.tabs) assert.ok(STORE_SECTIONS.some((s) => s.path === t.href), `tab ${t.href}`);
  assert.ok(STORE_MODULE.tabs.length <= 5, 'the phone\'s bottom bar');
});

test('a page belongs to one module at most (the shell opens finance or the store, never both)', () => {
  for (const p of ['/finance', '/finance/documents', '/store/products', '/store/products/x', '/register', '/dashboard']) {
    assert.ok(!(isFinancePath(p) && isStorePath(p)), p);
  }
});
