/**
 * Columns per screen and the frame that fits (Dream Builder PR-3f, 2.70): a phone stacks unless chosen, a computer takes
 * the tablet's unless chosen; only widths of the list; old columns (2.67) read as before; the classes the storefront
 * draws; the editor's frame at a screen's width, scaled down to fit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanColumns, columnClasses, type Column } from '../src/features/store/builder-registry';
import { setSpan, spanShown } from '../src/features/store/blocks';
import { frameFit } from '../src/features/store/visual-edit';

const cols = (): Column[] => [{ id: 'c1', span: 8, blocks: [] }, { id: 'c2', span: 4, blocks: [] }];

test('a width per screen: a phone 12 unless chosen, a computer the tablet\'s unless chosen; what is there anyway is not kept', () => {
  let c = cols();
  assert.deepEqual(['base', 'md', 'lg'].map((d) => spanShown(c[0], d as 'base')), [12, 8, 8]);
  c = setSpan(c, 'c1', 6, 'base');
  c = setSpan(c, 'c2', 6, 'base');
  assert.deepEqual(c.map((x) => x.spanBase), [6, 6], 'two side by side on a phone');
  c = setSpan(c, 'c1', 9, 'lg');
  c = setSpan(c, 'c2', 3, 'lg');
  assert.deepEqual(c.map((x) => [spanShown(x, 'base'), spanShown(x, 'md'), spanShown(x, 'lg')]), [[6, 8, 9], [6, 4, 3]]);
  assert.deepEqual(columnClasses(c[0]), ['blk-b-6', 'blk-span-8', 'blk-l-9']);
  assert.equal(setSpan(c, 'c1', 8, 'lg')[0].spanLg, undefined, 'a computer back to the tablet\'s: not kept');
  assert.equal(setSpan(c, 'c1', 12, 'base')[0].spanBase, undefined, 'a phone back to one under the other: not kept');
  assert.equal(setSpan(c, 'c1', 9, 'md')[0].spanLg, undefined, 'the tablet now has the computer\'s width: one value');
  assert.equal(setSpan(c, 'c1', 7, 'base'), c, 'a width off the list');
  assert.equal(setSpan(c, 'c1', 6, 'base'), c, 'the same width');
});

test('cleanColumns: widths per screen only from the list; 2.67\'s columns read as before', () => {
  assert.deepEqual(cleanColumns([{ id: 'a', span: 6, spanBase: 6, spanLg: 3, blocks: [] }, { id: 'b', span: 6, spanBase: 5, spanLg: 6, blocks: [] }, { id: 'c', span: 4, spanBase: 12, blocks: [] }]),
    [{ id: 'a', span: 6, spanBase: 6, spanLg: 3, blocks: [] }, { id: 'b', span: 6, blocks: [] }, { id: 'c', span: 4, blocks: [] }]);
  assert.deepEqual(columnClasses({ id: 'x', span: 6, blocks: [] }), ['blk-b-12', 'blk-span-6'], 'an old column: stacked on a phone, as before');
});

test('the frame: a phone sees a tablet\'s and a computer\'s page whole, smaller; a wide space never scales up', () => {
  assert.deepEqual(frameFit({ width: 358, height: 600 }, 820), { scale: 358 / 820, width: 820, height: Math.round(600 / (358 / 820)), left: 0 });
  assert.equal(frameFit({ width: 358, height: 600 }, 1280).scale, 358 / 1280);
  assert.deepEqual(frameFit({ width: 1000, height: 700 }, 390), { scale: 1, width: 390, height: 700, left: 305 }, 'centred, real size');
  assert.equal(frameFit({ width: 0, height: 700 }, 820).scale, 1, 'not measured yet');
});
