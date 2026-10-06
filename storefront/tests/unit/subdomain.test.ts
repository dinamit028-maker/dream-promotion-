/**
 * Every store's own address (2.57.1): <slug>.<STORE_ROOT_DOMAIN> picks the store; the root and www are the platform's; the
 * password's cookie opens one store, with one password — another store, another password, a forged value: nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPlatformHost, isRootHost, rootDomain, subdomainOf } from '../../src/lib/host';
import { accessCookie, hasAccess } from '../../src/lib/access';

test('the subdomain of a host under the root — and nothing else', () => {
  const root = 'mystores.co.il';
  assert.equal(rootDomain(' MyStores.co.il. '), root);
  assert.equal(subdomainOf('flowers.mystores.co.il', root), 'flowers');
  assert.equal(subdomainOf('flowers-tlv.mystores.co.il', root), 'flowers-tlv');
  assert.equal(subdomainOf('mystores.co.il', root), null, 'the root itself');
  assert.equal(subdomainOf('www.mystores.co.il', root), null, 'www');
  assert.equal(subdomainOf('a.b.mystores.co.il', root), null, 'deeper is nobody\'s');
  assert.equal(subdomainOf('ab.mystores.co.il', root), null, 'shorter than an address');
  assert.equal(subdomainOf('flowers.mystores.co.il.evil.test', root), null, 'the root must be the end');
  assert.equal(subdomainOf('evilmystores.co.il', root), null, 'a name that only ends like it');
  assert.equal(subdomainOf('flowers.mystores.co.il', ''), null, 'no root set: no subdomains at all');
  assert.equal(isRootHost('mystores.co.il', root) && isRootHost('www.mystores.co.il', root), true);
  assert.equal(isRootHost('flowers.mystores.co.il', root), false);
});

test('the root is the platform\'s own address (only a preview lives there)', () => {
  const before = process.env.STORE_ROOT_DOMAIN;
  process.env.STORE_ROOT_DOMAIN = 'mystores.co.il';
  try {
    assert.equal(isPlatformHost('mystores.co.il'), true);
    assert.equal(isPlatformHost('www.mystores.co.il'), true);
    assert.equal(isPlatformHost('flowers.mystores.co.il'), false);
  } finally { if (before === undefined) delete process.env.STORE_ROOT_DOMAIN; else process.env.STORE_ROOT_DOMAIN = before; }
});

test('the password\'s cookie: this store and this password only', () => {
  const secret = 'access-secret-0123456789abcdef', key = 'a'.repeat(64), other = 'b'.repeat(64);
  const S1 = '00000000-0000-4000-8000-000000000001', S2 = '00000000-0000-4000-8000-000000000002';
  const c = accessCookie(S1, key, secret)!;
  assert.ok(c && c.length >= 40);
  assert.equal(hasAccess(c, S1, key, secret), true);
  assert.equal(hasAccess(c, S2, key, secret), false, 'another store');
  assert.equal(hasAccess(c, S1, other, secret), false, 'a new password signs everyone out');
  assert.equal(hasAccess(c, S1, key, `${secret}x`), false, 'another secret');
  assert.equal(hasAccess(`${c.slice(0, -1)}A`, S1, key, secret), false, 'forged');
  assert.equal(hasAccess(c, S1, null, secret), false, 'no password (closed, or public)');
  assert.equal(accessCookie(S1, key, 'short'), null, 'no real secret, no cookie');
  assert.equal(accessCookie(S1, 'not-a-key', secret), null);
});
