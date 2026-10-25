/** "Lock to the business's location": each reason the phone gives no location gets its own instruction. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GEO_DENIED, GEO_TIMEOUT, GEO_UNAVAILABLE, geoMessage, retryable } from '../src/features/timeclock/geo';

test('says what to do for each reason — never the generic error', () => {
  for (const code of [null, GEO_DENIED, GEO_UNAVAILABLE, GEO_TIMEOUT]) for (const ios of [true, false]) {
    const m = geoMessage(code, ios);
    assert.doesNotMatch(m, /משהו השתבש/);
    assert.ok(m.length > 20);
  }
  assert.match(geoMessage(GEO_DENIED, true), /שירותי מיקום/);
  assert.match(geoMessage(GEO_DENIED, false), /לאפשר/);
  assert.match(geoMessage(GEO_TIMEOUT, true), /דלוק/);
});

test('retries only when the phone may answer the second time', () => {
  assert.equal(retryable(GEO_DENIED), false);
  assert.equal(retryable(GEO_UNAVAILABLE), true);
  assert.equal(retryable(GEO_TIMEOUT), true);
});
