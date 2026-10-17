/**
 * Who runs the site (2.103, migration 5500): the line at the bottom of every page and the Organization search engines read show
 * the store's own company when it has one — an American company's EIN with its own label, its country — else the business's
 * details as before (and before the migration, when there is no country, the store's).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalNumberLabel } from '../../src/lib/format';
import { orgJsonLd } from '../../src/lib/seo';

test('the label of the number: ח.פ., ע.מ., EIN', () => {
  assert.equal(legalNumberLabel('company'), 'ח.פ.');
  assert.equal(legalNumberLabel('dealer'), 'ע.מ.');
  assert.equal(legalNumberLabel('ein'), 'EIN');
});

const site = (legal: Record<string, unknown>) => ({
  origin: 'https://shop.test',
  store: { name: 'FollowMe', logo_url: '', country: 'IL', lang: 'he', contact: { phone: '', whatsapp: '', email: '', address: '' }, legal },
}) as any;
const org = (s: any) => orgJsonLd(s)['@graph'][0] as any;

test('the Organization: the company that runs the site, in its own country', () => {
  const o = org(site({ name: 'Good Luck Forever Inc.', number: '', number_kind: '', address: '221 Rutgers St, Maplewood, NJ 07040', country: 'US' }));
  assert.equal(o.name, 'Good Luck Forever Inc.');
  assert.deepEqual(o.address, { '@type': 'PostalAddress', streetAddress: '221 Rutgers St, Maplewood, NJ 07040', addressCountry: 'US' });
});

test('the Organization before the migration (no country): the store\'s country, as before', () => {
  const o = org(site({ name: 'החנות בע"מ', number: '512345678', number_kind: 'dealer', address: 'המגנים 56, גן יבנה' }));
  assert.equal(o.name, 'החנות בע"מ');
  assert.equal(o.address.addressCountry, 'IL');
});
