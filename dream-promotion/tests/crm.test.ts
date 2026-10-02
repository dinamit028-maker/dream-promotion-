import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followupState, matches, parseTags, phoneDigits, waLink } from '../src/features/crm/crm';
import type { Lead } from '../src/types';

test('CRM phones: Israeli formats to WhatsApp links', () => {
  assert.equal(phoneDigits('050-123-4567'), '972501234567');
  assert.equal(phoneDigits('+972 50 123 4567'), '972501234567');
  assert.equal(phoneDigits('00972501234567'), '972501234567');
  assert.equal(waLink('054 7654321', 'היי'), 'https://wa.me/972547654321?text=%D7%94%D7%99%D7%99');
  assert.equal(waLink('12'), '', 'too short — no link');
});

test('CRM follow-ups: overdue / today / upcoming in Israel time', () => {
  const now = new Date('2026-10-05T09:00:00Z').getTime(); // 12:00 in Israel
  assert.equal(followupState({ nextFollowup: '2026-10-04T15:00:00Z' }, now), 'overdue');
  assert.equal(followupState({ nextFollowup: '2026-10-05T07:00:00Z' }, now), 'overdue', 'earlier today');
  assert.equal(followupState({ nextFollowup: '2026-10-05T14:00:00Z' }, now), 'today');
  assert.equal(followupState({ nextFollowup: '2026-10-07T08:00:00Z' }, now), 'upcoming');
  assert.equal(followupState({ nextFollowup: null }, now), null);
});

test('CRM search and tags', () => {
  const l = { id: '1', name: 'דנה כהן', phone: '052-1112233', source: 'אינסטגרם', date: '2026-10-01', status: 'חדש', email: 'dana@x.com', tags: ['לייזר', 'VIP'] } as Lead;
  assert.ok(matches(l, 'דנה'));
  assert.ok(matches(l, '0521112'), 'phone in local format');
  assert.ok(matches(l, 'vip'));
  assert.ok(!matches(l, 'יוסי'));
  assert.deepEqual(parseTags('לייזר, VIP ,לייזר,'), ['לייזר', 'VIP']);
});
