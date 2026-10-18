/**
 * The accessibility of every site (2.104): the automatic statement is one text in two identical copies (the site shows it until
 * the business publishes its own; the dashboard starts the statement's editor with it, and a note that keeps it from being
 * published before someone read it); the store's switch of the button is on unless the owner turned it off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { a11yStatement } from '../src/features/store/a11y-statement';
import { hasPlaceholders, policyDraft, toStore } from '../src/features/store/store';

test('one statement, two identical copies (the dashboard and the site)', () => {
  const here = readFileSync(join(__dirname, '../src/features/store/a11y-statement.ts'), 'utf8');
  const site = readFileSync(join(__dirname, '../../storefront/src/lib/a11y-statement.ts'), 'utf8');
  assert.equal(here, site, 'src/features/store/a11y-statement.ts and storefront/src/lib/a11y-statement.ts must be the same — change both');
});

test('the statement\'s editor starts with the site\'s automatic text, and a note to the owner that blocks publishing it unread', () => {
  const b = { name: 'Follow Me', phone: '0503566969', email: 'followtheshops@gmail.com', address: 'המגנים 56, גן יבנה', whatsapp: '972503566969', widget: true };
  const d = policyDraft('accessibility', b);
  assert.equal(d.title, 'הצהרת נגישות');
  const auto = a11yStatement({ name: b.name, phone: b.phone, whatsapp: b.whatsapp, email: b.email, widget: true });
  assert.ok(d.body.startsWith(auto), 'the same text as the site');
  assert.match(d.body, /טלפון \/ וואטסאפ: \u20660503566969\u2069/);
  assert.ok(hasPlaceholders(d.body), 'a note in brackets: not published before someone deletes it');
  assert.ok(!hasPlaceholders(auto), 'the site\'s own text has none');
  assert.doesNotMatch(d.body.replace(/\[[^\]]*\]/g, ''), /האתר נגיש|עומד בתקן|מונגש|מאושר/, 'outside the note nothing is claimed');
  // the button turned off: the statement says nothing of it
  assert.doesNotMatch(policyDraft('accessibility', { ...b, widget: false }).body, /תפריט הנגישות/);
  // the old callers (a kit, before 5600): the menu is on
  assert.match(policyDraft('accessibility', { name: 'X' }).body, /תפריט הנגישות/);
});

test('the store\'s switch: on unless the owner turned it off — and on before migration 5600 (no column)', () => {
  const row = { id: 's', business_id: 'b', name: 'Follow Me' };
  assert.equal(toStore(row).a11yWidget, true, 'no column yet');
  assert.equal(toStore({ ...row, a11y_widget: true }).a11yWidget, true);
  assert.equal(toStore({ ...row, a11y_widget: false }).a11yWidget, false);
});
