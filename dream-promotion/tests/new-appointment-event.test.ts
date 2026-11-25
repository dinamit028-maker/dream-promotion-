import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEW_APPOINTMENT_HREF, plusAction } from '../src/features/booking/new-appointment-event';

test('the + opens a new appointment on the appointments screen, and /create everywhere else', () => {
  assert.equal(plusAction('/appointments'), 'appointment');
  assert.equal(plusAction('/appointments/settings'), 'appointment');
  for (const p of ['/create', '/dashboard', '/leads', '/appointmentsx', '/', '', null, undefined]) assert.equal(plusAction(p), 'create', String(p));
});

test('a calendar member: on the appointments screen — a new appointment; elsewhere — to it, opening one', () => {
  assert.equal(plusAction('/appointments', true), 'appointment');
  for (const p of ['/leads', '/appointmentsx', '/', null]) assert.equal(plusAction(p, true), 'appointment-link', String(p));
  assert.equal(NEW_APPOINTMENT_HREF, '/appointments?new=1');
});
