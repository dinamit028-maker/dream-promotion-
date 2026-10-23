import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agorotOf, canManage, inviteLink, inviteText, isAdmin, seesPrivate, shekels, toEmployee, trackDayMinutes, trackDayText, trackSummary, validIsraeliId } from '../src/features/attendance/people';

test('attendance people: the Israeli ID check digit', () => {
  assert.equal(validIsraeliId('123456782'), true);
  assert.equal(validIsraeliId('123456789'), false);
  assert.equal(validIsraeliId('000000018'), true);
  assert.equal(validIsraeliId('18'), true, 'shorter = padded with zeros');
  assert.equal(validIsraeliId('000000000'), false);
  assert.equal(validIsraeliId('1234567890'), false);
  assert.equal(validIsraeliId(''), false);
});

test('attendance people: pay in whole agorot', () => {
  assert.equal(agorotOf('45.5'), 4550); assert.equal(agorotOf('45,50'), 4550); assert.equal(agorotOf('₪ 32.17'), 3217); assert.equal(agorotOf('8000'), 800000);
  assert.equal(agorotOf(''), null); assert.equal(agorotOf('abc'), undefined); assert.equal(agorotOf('1.234'), undefined); assert.equal(agorotOf('-5'), undefined);
  assert.equal(shekels(4550), '45.50'); assert.equal(shekels(800000), '8000'); assert.equal(shekels(null), '');
});

test('attendance people: the invitation — the personal link in a WhatsApp message, nothing of Dream', () => {
  const t = inviteText('דנה כהן', 'מסעדת הים', 'https://x.test/clock/tok');
  assert.match(t, /^שלום דנה,/); assert.match(t, /https:\/\/x\.test\/clock\/tok/); assert.ok(!/Dream/i.test(t));
  const l = inviteLink({ name: 'דנה', phone: '050-1234567' }, 'ים', 'https://x.test/clock/tok');
  assert.ok(l.startsWith('https://wa.me/972501234567?text='));
  assert.equal(inviteLink({ name: 'דנה', phone: '' }, 'ים', 'u'), '');
});

test('attendance people: a track\'s day as typed, and the track in one line', () => {
  assert.equal(trackDayMinutes('8.6'), 516); assert.equal(trackDayMinutes('9'), 540); assert.equal(trackDayMinutes('8:36'), 516);
  assert.equal(trackDayMinutes(''), 0); assert.equal(trackDayMinutes('25'), undefined); assert.equal(trackDayMinutes('x'), undefined);
  assert.equal(trackDayText(516), '8.6'); assert.equal(trackDayText(540), '9'); assert.equal(trackDayText(0), '');
  assert.equal(trackSummary({ dayMinutes: [516, 516, 516, 516, 516, 0, 0] }), 'א׳–ה׳ 8.6 ש׳');
  assert.equal(trackSummary({ dayMinutes: [540, 540, 540, 540, 480, 300, 0] }), 'א׳–ד׳ 9 ש׳, ה׳ 8 ש׳, ו׳ 5 ש׳');
  assert.equal(trackSummary({ dayMinutes: [0, 0, 0, 0, 0, 0, 0] }), 'בלי ימי עבודה');
});

test('attendance people: rows and who may do what on the screens (as att_role in the database)', () => {
  const e = toEmployee({ id: 'e', name: 'דנה', token: 't', created_at: 'c' });
  assert.equal(e.code, ''); assert.equal(e.active, true); assert.equal(e.departmentId, null);
  assert.ok(canManage('admin') && canManage('approver') && !canManage('payroll') && !canManage('viewer'));
  assert.ok(isAdmin('admin') && !isAdmin('approver'));
  assert.ok(seesPrivate('admin') && seesPrivate('payroll') && !seesPrivate('approver') && !seesPrivate('viewer'));
});
