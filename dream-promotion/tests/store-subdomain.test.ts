/**
 * Every store's own address and password (2.57.1) in the dashboard: the reserved names are the database's (one list, compared
 * here with migration 3700), the address the owner types, where the store lives now, what a visitor sees, what is copied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkPassword, checkSlug, cleanRoot, newPassword, RESERVED_SLUGS, shareText, slugReserved, storeAddress, storeVisibility, VISIBILITY,
} from '@/features/store/store';

const migration = fileURLToPath(new URL('../supabase/migrations/20261006003700_store_subdomain.sql', import.meta.url));

test('reserved names: the dashboard\'s list = the database\'s (store_slug_reserved)', () => {
  const block = readFileSync(migration, 'utf8').split('-- reserved slugs: begin')[1]?.split('-- reserved slugs: end')[0] ?? '';
  const sql = [...block.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(sql.length > 40, 'the list was found in the migration');
  assert.deepEqual([...sql].sort(), [...RESERVED_SLUGS].sort());
  for (const n of ['www', 'app', 'admin', 'api', 'mail', 'shop', 'store']) assert.equal(slugReserved(n), true, n);
  assert.equal(slugReserved('xn--4dbrk0ce'), true, 'punycode');
  assert.equal(slugReserved('flowers'), false);
});

test('the address the owner types', () => {
  assert.deepEqual(checkSlug(' Flowers-TLV '), { ok: true, slug: 'flowers-tlv' });
  assert.equal(checkSlug('ab').ok, false);
  assert.equal(checkSlug('x'.repeat(41)).ok, false);
  assert.equal(checkSlug('two words').ok, false);
  assert.equal(checkSlug('a--b').ok, false);
  assert.equal(checkSlug('-ab').ok, false);
  assert.equal(checkSlug('פרחים').ok, false, 'English letters only (an address of the DNS)');
  assert.deepEqual(checkSlug('admin'), { ok: false, error: 'השם הזה שמור למערכת. בחרו שם אחר.' });
  assert.deepEqual(checkPassword('  secret1 '), { ok: true, password: 'secret1' });
  assert.deepEqual(checkPassword(''), { ok: true, password: '' }, 'empty = closed');
  assert.equal(checkPassword('abc').ok, false);
  const p = newPassword();
  assert.match(p, /^[a-km-np-z2-9]{10}$/, 'no look-alikes');
});

test('where the store lives: its own working domain, else its subdomain, else nowhere yet', () => {
  const store = { slug: 'flowers' };
  assert.equal(cleanRoot(' https://MyStores.co.il/ '), 'mystores.co.il');
  assert.equal(cleanRoot('not a domain'), '');
  assert.deepEqual(storeAddress(store, [], 'mystores.co.il'), { url: 'https://flowers.mystores.co.il', kind: 'subdomain' });
  assert.deepEqual(storeAddress(store, [{ domain: 'flowers.com', isPrimary: true, status: 'verifying' }], 'mystores.co.il'),
    { url: 'https://flowers.mystores.co.il', kind: 'subdomain' }, 'a domain not yet working is not the address');
  assert.deepEqual(storeAddress(store, [{ domain: 'flowers.com', isPrimary: true, status: 'active' }], 'mystores.co.il'), { url: 'https://flowers.com', kind: 'domain' });
  assert.equal(storeAddress(store, [], ''), null, 'no root and no storefront address');
  // 2.57.2: no domain at all — the storefront's own address + /s/<slug>
  assert.deepEqual(storeAddress(store, [], '', 'https://dream-storefront.vercel.app/'), { url: 'https://dream-storefront.vercel.app/s/flowers', kind: 'platform' });
  assert.deepEqual(storeAddress(store, [], 'mystores.co.il', 'https://dream-storefront.vercel.app'), { url: 'https://flowers.mystores.co.il', kind: 'subdomain' }, 'a root wins');
  assert.equal(storeAddress(store, [], '', 'not a url'), null);
});

test('what a visitor sees: the database\'s store_access(), in words', () => {
  assert.equal(storeVisibility({ status: 'published', storefrontPassword: 'x1y2', passwordLock: false }), 'live');
  assert.equal(storeVisibility({ status: 'published', storefrontPassword: 'x1y2', passwordLock: true }), 'password');
  assert.equal(storeVisibility({ status: 'draft', storefrontPassword: 'x1y2', passwordLock: false }), 'password');
  assert.equal(storeVisibility({ status: 'draft', storefrontPassword: '', passwordLock: false }), 'draft');
  assert.equal(storeVisibility({ status: 'paused', storefrontPassword: '', passwordLock: false }), 'paused');
  assert.deepEqual([VISIBILITY.draft.label, VISIBILITY.password.label, VISIBILITY.live.label], ['טיוטה', 'מוגן בסיסמה', 'באוויר']);
  assert.equal(shareText('https://flowers.mystores.co.il', 'x1y2z3w4', 'פרחים'), 'פרחים\nhttps://flowers.mystores.co.il\nסיסמה: x1y2z3w4');
  assert.equal(shareText('https://flowers.com', '', 'פרחים'), 'פרחים\nhttps://flowers.com');
});
