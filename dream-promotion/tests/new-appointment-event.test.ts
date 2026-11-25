import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plusAction } from '../src/features/booking/new-appointment-event';

test('the + opens a new appointment on the appointments screen, and /create everywhere else', () => {
  assert.equal(plusAction('/appointments'), 'appointment');
  assert.equal(plusAction('/appointments/settings'), 'appointment');
  for (const p of ['/create', '/dashboard', '/leads', '/appointmentsx', '/', '', null, undefined]) assert.equal(plusAction(p), 'create', String(p));
});
