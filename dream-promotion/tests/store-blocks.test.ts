/**
 * The free section (Dream Builder PR-3c, 2.67): one registry in two identical copies; columns and blocks added, moved
 * (within a column, between columns, into an empty one), removed — each a new array, the same one when nothing changes;
 * the page's "block" message checked; a new free section and its round trip through the draft.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanColumns, MAX_BLOCKS, MAX_COLUMNS, type Column } from '../src/features/store/builder-registry';
import {
  addBlock, addColumn, defaultColumns, duplicateBlock, findBlock, moveBlock, removeBlock, removeColumn, setBlockField, setSpan, stepBlock, stepColumn, withColumns,
} from '../src/features/store/blocks';
import { addSection, ADDABLE, duplicateSection, readMessage } from '../src/features/store/visual-edit';
import { draftOf, settingsOf } from '../src/features/store/theme-fields';

test('the registry: the dashboard\'s and the storefront\'s copies are the same file', () => {
  const a = readFileSync(join(__dirname, '../src/features/store/builder-registry.ts'), 'utf8');
  const b = readFileSync(join(__dirname, '../../storefront/src/lib/builder-registry.ts'), 'utf8');
  assert.equal(a, b);
});

const cols = (): Column[] => [
  { id: 'c1', span: 6, blocks: [{ id: 'b1', type: 'heading', settings: { text: 'א', size: 'l' } }, { id: 'b2', type: 'paragraph', settings: { text: 'ב' } }, { id: 'b3', type: 'button', settings: { label: 'ג', href: '/', style: 'primary' } }] },
  { id: 'c2', span: 6, blocks: [{ id: 'b4', type: 'image', settings: { image: '', alt: '' } }] },
  { id: 'c3', span: 4, blocks: [] },
];
const shape = (c: Column[]) => c.map((x) => `${x.id}:${x.blocks.map((b) => b.id).join(',')}`);

test('moveBlock: within a column, to another, into an empty one; a full column, an unknown one, the same place — nothing', () => {
  const c = cols();
  assert.deepEqual(shape(moveBlock(c, 'b1', 'c1', 2)), ['c1:b2,b3,b1', 'c2:b4', 'c3:']);
  assert.deepEqual(shape(moveBlock(c, 'b3', 'c1', 0)), ['c1:b3,b1,b2', 'c2:b4', 'c3:']);
  assert.deepEqual(shape(moveBlock(c, 'b2', 'c2', 0)), ['c1:b1,b3', 'c2:b2,b4', 'c3:']);
  assert.deepEqual(shape(moveBlock(c, 'b2', 'c3', 0)), ['c1:b1,b3', 'c2:b4', 'c3:b2'], 'into an empty column');
  assert.deepEqual(shape(moveBlock(c, 'b4', 'c1', 99)), ['c1:b1,b2,b3,b4', 'c2:', 'c3:'], 'past the end: the end');
  assert.equal(moveBlock(c, 'b1', 'c1', 0), c);
  assert.equal(moveBlock(c, 'nope', 'c1', 0), c);
  assert.equal(moveBlock(c, 'b1', 'nope', 0), c);
  assert.equal(moveBlock(c, 'b1', 'c2', -1), c);
  const full = cols(); full[1] = { ...full[1], blocks: Array.from({ length: MAX_BLOCKS }, (_, i) => ({ id: `f${i}`, type: 'spacer' as const, settings: { size: 'm' } })) };
  assert.equal(moveBlock(full, 'b1', 'c2', 0), full, 'a full column takes no more');
  assert.equal(c[0].blocks.length, 3, 'never changed in place');
  assert.deepEqual(shape(stepBlock(c, 'b2', -1)), ['c1:b2,b1,b3', 'c2:b4', 'c3:']);
  assert.deepEqual(shape(stepBlock(c, 'b2', 1)), ['c1:b1,b3,b2', 'c2:b4', 'c3:']);
  assert.equal(stepBlock(c, 'b1', -1), c);
});

test('columns and blocks: added within the limits, with free ids; removed; a width only from the list', () => {
  let c = cols();
  c = addColumn(c);
  assert.equal(c.length, 4);
  assert.equal(addColumn(c), c, `at most ${MAX_COLUMNS}`);
  assert.equal(c[3].id, 'c4');
  const r = addBlock(c, 'c3', 'badge')!;
  assert.equal(r.id, 'b5');
  assert.deepEqual(findBlock(r.columns, 'b5')!.block.settings, { text: 'חדש' });
  assert.equal(addBlock(c, 'nope', 'badge'), null);
  assert.equal(addBlock(c, 'c3', 'script' as never), null);
  const d = duplicateBlock(cols(), 'b1')!;
  assert.deepEqual(shape(d.columns)[0], `c1:b1,${d.id},b2,b3`);
  assert.deepEqual(shape(removeBlock(cols(), 'b2')), ['c1:b1,b3', 'c2:b4', 'c3:']);
  assert.deepEqual(shape(removeColumn(cols(), 'c1')), ['c2:b4', 'c3:']);
  assert.equal(setSpan(cols(), 'c1', 9)[0].span, 9);
  const same = cols();
  assert.equal(setSpan(same, 'c1', 7)[0], same[0], 'a width not on the list');
  assert.deepEqual(shape(stepColumn(cols(), 'c2', -1)), ['c2:b4', 'c1:b1,b2,b3', 'c3:']);
});

test('a block\'s field: a choice from its list, a picture https; a text and a link as typed — and the storefront\'s check decides', () => {
  const c = cols();
  assert.equal(findBlock(setBlockField(c, 'b1', 'size', 'xl'), 'b1')!.block.settings.size, 'xl');
  assert.equal(setBlockField(c, 'b1', 'size', 'huge'), c);
  assert.equal(setBlockField(c, 'b1', 'nope', 'x'), c);
  assert.equal(setBlockField(c, 'b4', 'image', 'http://x.test/a.jpg'), c);
  assert.equal(findBlock(setBlockField(c, 'b4', 'image', 'https://x.test/a.jpg'), 'b4')!.block.settings.image, 'https://x.test/a.jpg');
  const typing = setBlockField(c, 'b3', 'href', 'javascript:alert(1)');
  assert.equal(findBlock(typing, 'b3')!.block.settings.href, 'javascript:alert(1)', 'kept while typing (the panel warns)');
  assert.equal(findBlock(cleanColumns(typing), 'b3')!.block.settings.href, '/collections/all', 'never saved or shown as is');
  assert.equal(findBlock(setBlockField(c, 'b1', 'text', 'x'.repeat(500)), 'b1')!.block.settings.text.length, 120);
});

test('a free section: added with words beside a picture; duplicated with its columns; through the draft and back', () => {
  assert.ok(ADDABLE.includes('custom'));
  const d0 = draftOf('kit', { sections: [{ id: 'hero', type: 'hero', settings: {} }] });
  const r = addSection(d0, 'custom')!;
  const s = r.draft.sections.find((x) => x.id === r.id)!;
  assert.equal(s.type, 'custom');
  assert.deepEqual(s.columns, defaultColumns());
  assert.deepEqual(cleanColumns(s.columns), s.columns, 'the default passes the storefront\'s check as is');
  const dup = duplicateSection(r.draft, r.id)!;
  const copy = dup.draft.sections.find((x) => x.id === dup.id)!;
  assert.deepEqual(copy.columns, s.columns);
  assert.notEqual(copy.columns, s.columns, 'a copy, not the same columns');
  const moved = withColumns(r.draft, r.id, moveBlock(s.columns!, 'b4', 'c1', 0));
  const back = draftOf('kit', settingsOf(moved));
  assert.deepEqual(shape(back.sections.find((x) => x.id === r.id)!.columns!), ['c1:b4,b1,b2,b3', 'c2:']);
  assert.equal(withColumns(r.draft, 'hero', []), r.draft, 'only a free section has columns');
  assert.equal(back.sections.find((x) => x.id === 'hero')!.columns, undefined);
});

test('the page\'s "block" is checked like every message', () => {
  assert.deepEqual(readMessage({ type: 'block', section: 'custom-2', id: 'b3' }), { type: 'block', section: 'custom-2', id: 'b3' });
  for (const bad of [{ type: 'block', section: 'custom-2', id: 'B3' }, { type: 'block', section: 'custom-2' }, { type: 'block', id: 'b1' },
    { type: 'block', section: 'x'.repeat(41), id: 'b1' }, { type: 'block', section: 's', id: 'b"]' }]) assert.equal(readMessage(bad), null, JSON.stringify(bad));
});
