/** "יומן ולידים" (2.109): which screens a limited member opens, and a new customer only with a phone. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessOf, limitedAllows, limitedTarget } from '../src/components/shell/limited-access';
import { accessOf as serverAccessOf } from '../src/lib/server/business';
import { customerProblem, matchLead } from '../src/features/booking/new-customer';
import { passwordProblem } from '../src/features/admin/business-state';

test('the screens of each access', () => {
  for (const v of ['full', 'register', 'calendar', 'x', null, undefined]) assert.equal(accessOf(v), serverAccessOf(v), 'the app and the server read it alike');
  assert.equal(accessOf('kiosk'), 'full');
  for (const p of ['/appointments', '/leads', '/leads/departments']) assert.equal(limitedTarget('calendar', p), null, `${p} is hers`);
  for (const p of ['/dashboard', '/finance', '/register', '/attendance', '/settings', '/admin', '/calendar', '/leadsx', '/create', '/store/products'])
    assert.equal(limitedTarget('calendar', p), '/appointments', `${p} → the calendar`);
  assert.equal(limitedTarget('register', '/appointments'), '/register', 'a cashier as before');
  assert.equal(limitedTarget('register', '/register'), null);
  assert.equal(limitedTarget('full', '/finance'), null);
  assert.ok(limitedAllows('full', '/anything'));
});

test('a new customer: only with a phone for a calendar member; everyone else as before', () => {
  const leads = [{ id: 'a', name: 'מרים', phone: '050-1234567' }, { id: 'b', name: 'מפייסבוק', phone: '' }];
  assert.equal(matchLead(leads, { name: 'x', phone: '0501234567' })?.id, 'a', 'the same phone');
  assert.equal(matchLead(leads, { name: 'מפייסבוק', phone: '' })?.id, 'b', 'no phone typed — the same name');
  assert.equal(matchLead(leads, { name: 'מרים', phone: '0529999999' }), undefined, 'a phone typed decides');

  assert.equal(customerProblem(leads, { name: 'חדשה', phone: '' }, true), 'לקוח/ה חדש/ה נשמר/ת רק עם מספר טלפון.');
  assert.equal(customerProblem(leads, { name: 'חדשה', phone: '050' }, true), 'מספר הטלפון לא שלם.');
  assert.equal(customerProblem(leads, { name: 'חדשה', phone: '052-7654321' }, true), null);
  assert.equal(customerProblem(leads, { name: 'מפייסבוק', phone: '' }, true), null, 'an existing customer with no phone is still booked');
  assert.equal(customerProblem(leads, { name: '  ', phone: '0527654321' }, true), 'חסר שם הלקוח/ה.');
  assert.equal(customerProblem(leads, { name: 'חדשה', phone: '' }, false), null, 'the owner — as before');
  assert.equal(customerProblem(leads, { name: 'חדשה', phone: '050' }, false), null);
});

test('a password the super admin chooses', () => {
  assert.match(passwordProblem('Ab1')!, /8 תווים/);
  assert.match(passwordProblem('12345678')!, /אותיות וגם מספרים/);
  assert.match(passwordProblem('abcdefgh')!, /אותיות וגם מספרים/);
  assert.match(passwordProblem('a1'.repeat(37))!, /72/);
  assert.equal(passwordProblem('Karin2026'), null);
  assert.equal(passwordProblem('גל-שחר-2026'), null);
});
