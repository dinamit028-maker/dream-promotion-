/**
 * The visual editor without reloads (Dream Builder PR-3a, 2.65): undo / redo of drafts (typing is one step, at most 50,
 * a change clears redo); a section dragged on the page to a place among those shown (the hidden ones keep their place);
 * the page's "drop" checked like every message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyHistory, HISTORY_LIMIT, MERGE_MS, record, redo, undo } from '../src/features/store/history';
import { moveSectionAt, moveSectionTo, readMessage, shownIndex } from '../src/features/store/visual-edit';
import { draftOf } from '../src/features/store/theme-fields';

test('undo and redo: each change one step; typing in one field within 800ms is one step; a new change clears redo', () => {
  let h = emptyHistory<string>();
  h = record(h, 'a', null, 1000);
  h = record(h, 'b', 'text:hero:title', 2000);
  h = record(h, 'b1', 'text:hero:title', 2000 + MERGE_MS - 1);   // still typing: the same step
  assert.deepEqual(h.past, ['a', 'b']);
  h = record(h, 'c', 'text:hero:title', 2000 + 3 * MERGE_MS);   // a pause: a new step
  assert.deepEqual(h.past, ['a', 'b', 'c']);
  const u = undo(h, 'd')!;
  assert.equal(u.value, 'c');
  assert.deepEqual(u.history.future, ['d']);
  const r = redo(u.history, 'c')!;
  assert.equal(r.value, 'd');
  assert.deepEqual(r.history.past, ['a', 'b', 'c']);
  assert.deepEqual(record(u.history, 'c', null).future, [], 'a new change: nothing to redo');
  assert.equal(undo(emptyHistory<string>(), 'x'), null);
  assert.equal(redo(emptyHistory<string>(), 'x'), null);
  let long = emptyHistory<number>();
  for (let i = 0; i < 80; i++) long = record(long, i, null, i * 10_000);
  assert.equal(long.past.length, HISTORY_LIMIT, 'at most 50 steps');
  assert.equal(long.past[0], 30, 'the oldest go first');
});

const draft = () => draftOf('kit', { sections: [
  { id: 'hero', type: 'hero', settings: {} }, { id: 'a', type: 'text', settings: {} }, { id: 'h', type: 'text', hidden: true, settings: {} },
  { id: 'b', type: 'text', settings: {} }, { id: 'c', type: 'text', settings: {} },
] });
const ids = (d: ReturnType<typeof draft>) => d.sections.map((s) => s.id);

test('a section dropped on the page: its place among those shown; a hidden one keeps its place; nothing moves → the same draft', () => {
  const d = draft();
  assert.deepEqual(ids(moveSectionTo(d, 'c', 0)), ['c', 'hero', 'a', 'h', 'b']);
  assert.deepEqual(ids(moveSectionTo(d, 'hero', 3)), ['a', 'h', 'b', 'c', 'hero'], 'to the end');
  assert.deepEqual(ids(moveSectionTo(d, 'hero', 2)), ['a', 'h', 'b', 'hero', 'c']);
  assert.deepEqual(ids(moveSectionTo(d, 'a', 99)), ['hero', 'h', 'b', 'c', 'a'], 'past the end: the end');
  assert.equal(moveSectionTo(d, 'hero', 0), d, 'the same place');
  assert.equal(moveSectionTo(d, 'h', 0), d, 'a hidden section is not on the page');
  assert.equal(moveSectionTo(d, 'nope', 0), d);
  assert.deepEqual([shownIndex(d, 'b'), shownIndex(d, 'h'), shownIndex(d, 'nope')], [2, -1, -1]);
});

test('the panel\'s list: from one place to another in the full list (with the hidden ones)', () => {
  const d = draft();
  assert.deepEqual(ids(moveSectionAt(d, 4, 1)), ['hero', 'c', 'a', 'h', 'b']);
  assert.deepEqual(ids(moveSectionAt(d, 2, 0)), ['h', 'hero', 'a', 'b', 'c']);
  assert.equal(moveSectionAt(d, 1, 1), d);
  assert.equal(moveSectionAt(d, 1, 9), d);
});

test('the page\'s "drop" is checked like every message', () => {
  assert.deepEqual(readMessage({ type: 'drop', id: 'hero', to: 2 }), { type: 'drop', id: 'hero', to: 2 });
  for (const bad of [{ type: 'drop', id: 'hero', to: -1 }, { type: 'drop', id: 'hero', to: 1.5 }, { type: 'drop', id: 'hero', to: '2' },
    { type: 'drop', id: 'x'.repeat(41), to: 1 }, { type: 'drop', to: 1 }, { type: 'move', id: 'hero', to: 1 }]) assert.equal(readMessage(bad), null, JSON.stringify(bad));
});
