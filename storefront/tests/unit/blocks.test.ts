/**
 * The free section (2.67): its columns and blocks pass resolveTheme only through cleanColumns — a width from the list, at
 * most 4 columns of 12 blocks, known types, a link of the store / https, a picture https; anything else is dropped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme } from '../../src/lib/theme';
import { cleanColumns, MAX_BLOCKS, MAX_COLUMNS } from '../../src/lib/builder-registry';

test('a free section in a theme: its columns, checked; another section type carries none', () => {
  const t = resolveTheme('kit', { sections: [
    { id: 'free', type: 'custom', settings: {}, columns: [
      { id: 'c1', span: 6, blocks: [{ id: 'b1', type: 'heading', settings: { text: '  שלום   לכולם ', size: 'xl' } }, { id: 'b2', type: 'button', settings: { label: 'לקנייה', href: 'javascript:alert(1)' } }] },
      { id: 'c2', span: 7, blocks: [{ id: 'b3', type: 'image', settings: { image: 'http://x.test/a.jpg', alt: 'a' } }, { id: 'b4', type: 'script', settings: {} }] },
    ] },
    { id: 'hero', type: 'hero', settings: {}, columns: [{ id: 'c9', span: 6, blocks: [] }] },
  ] });
  const free = t.sections.find((s) => s.id === 'free')!;
  assert.deepEqual(free.columns, [
    { id: 'c1', span: 6, blocks: [{ id: 'b1', type: 'heading', settings: { text: 'שלום לכולם', size: 'xl' } }, { id: 'b2', type: 'button', settings: { label: 'לקנייה', href: '/collections/all', style: 'primary' } }] },
    { id: 'c2', span: 12, blocks: [{ id: 'b3', type: 'image', settings: { image: '', alt: 'a' } }] },
  ]);
  assert.equal(t.sections.find((s) => s.id === 'hero')!.columns, undefined);
});

test('cleanColumns: limits, ids, repeats', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, span: 3, blocks: Array.from({ length: 20 }, (__, j) => ({ id: `b${i}-${j}`, type: 'spacer', settings: { size: 'l' } })) }));
  const out = cleanColumns(many);
  assert.equal(out.length, MAX_COLUMNS);
  assert.ok(out.every((c) => c.blocks.length === MAX_BLOCKS));
  assert.deepEqual(cleanColumns([{ id: 'A', blocks: [] }, { id: 'x"><', blocks: [] }, { id: 'ok', blocks: [{ id: 'ok', type: 'badge', settings: {} }] }, { id: 'ok', blocks: [] }]),
    [{ id: 'ok', span: 12, blocks: [] }], 'a block may not take the id of a column, and a repeated column is dropped');
  assert.deepEqual(cleanColumns('nope'), []);
  assert.deepEqual(cleanColumns([{ id: 'c', span: 4, blocks: [{ id: 'p', type: 'paragraph', settings: { text: 'א'.repeat(2000) } }, { id: 'h', type: 'heading', settings: { size: 'huge' } }] }])[0].blocks.map((b) => [b.settings.text?.length, b.settings.size]),
    [[1200, undefined], [5, 'l']]);
});

test('the library (2.69): every kind\'s starting words pass the storefront\'s theme as they are', async () => {
  const { LIBRARY } = await import('../../src/lib/builder-registry');
  const t = resolveTheme('kit', { sections: LIBRARY.map((x) => ({ id: `t-${x.type.toLowerCase()}`, type: x.type, settings: x.starter, ...(x.columns ? { columns: x.columns } : {}) })) });
  assert.deepEqual(t.sections.map((s) => s.type), LIBRARY.map((x) => x.type));
  for (const x of LIBRARY) {
    const s = t.sections.find((y) => y.type === x.type)!;
    for (const [k, v] of Object.entries(x.starter)) if (typeof v === 'string') assert.equal(s.settings[k], v, `${x.type}.${k}`);
    if (x.columns) assert.deepEqual(s.columns, x.columns);
  }
});

test('columns per screen (2.70): every width class has its rule — a phone, a tablet, a computer', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { columnClasses, SPANS } = await import('../../src/lib/builder-registry');
  const css = readFileSync(join(__dirname, '../../src/app/globals.css'), 'utf8');
  for (const n of SPANS) for (const c of columnClasses({ id: 'x', span: n, spanBase: n, spanLg: n, blocks: [] })) assert.ok(css.includes(`.${c} {`), c);
  const t = resolveTheme('kit', { sections: [{ id: 'f', type: 'custom', settings: {}, columns: [{ id: 'a', span: 8, spanBase: 6, spanLg: 9, blocks: [] }] }] });
  assert.deepEqual(t.sections[0].columns, [{ id: 'a', span: 8, spanBase: 6, spanLg: 9, blocks: [] }]);
});
