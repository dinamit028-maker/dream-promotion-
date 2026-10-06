/**
 * "לחץ לעריכה" (2.61): what a message from the framed page may change in the draft — only a text field of that section,
 * within its length; sections are added, duplicated and removed only on the open template ("kit"); everything the page
 * names that is edited elsewhere opens its own editor. A message of any other shape changes nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftOf, KIT, BAGS } from '../src/features/store/theme-fields';
import {
  addSection, applyText, canGrow, duplicateSection, editFrameUrl, editRoute, moveSection, readMessage, removeSection,
} from '../src/features/store/visual-edit';

const kit = () => draftOf('kit', { sections: KIT.sections });
const bags = () => draftOf('bags', {});

test('a message from the page: only known shapes, every field checked', () => {
  assert.deepEqual(readMessage({ type: 'text', section: 'hero', field: 'title', value: 'שלום' }), { type: 'text', section: 'hero', field: 'title', value: 'שלום' });
  assert.deepEqual(readMessage({ type: 'navigate', path: '/collections/all' }), { type: 'navigate', path: '/collections/all' });
  assert.equal(readMessage({ type: 'navigate', path: 'https://evil.example' }), null, 'a path of the store only');
  assert.equal(readMessage({ type: 'text', section: 'hero', field: 'title', value: 'x'.repeat(3000) }), null);
  assert.equal(readMessage({ type: 'eval', code: '1' }), null);
  assert.equal(readMessage('text'), null);
  assert.equal(readMessage({ type: 'section', id: 5 }), null);
});

test('a text edited in place: a text field of that section, within its length — else nothing changes', () => {
  const d = bags();
  const next = applyText(d, { section: 'hero', field: 'title', value: '  הלוגו   שלכם  ' })!;
  assert.equal(next.sections.find((s) => s.id === 'hero')!.settings.title, 'הלוגו שלכם');
  assert.equal(d.sections.find((s) => s.id === 'hero')!.settings.title, BAGS.sections[0].settings.title, 'the draft before is untouched');
  assert.equal(applyText(d, { section: 'hero', field: 'image', value: 'https://x' }), null, 'a picture is not a text');
  assert.equal(applyText(d, { section: 'hero', field: 'primaryHref', value: '/x' }), null, 'nor a link');
  assert.equal(applyText(d, { section: 'hero', field: 'title', value: 'א'.repeat(91) }), null, 'too long for the field');
  assert.equal(applyText(d, { section: 'nope', field: 'title', value: 'x' }), null);
  assert.equal(applyText(d, { section: 'hero', field: 'title', value: String(BAGS.sections[0].settings.title) }), null, 'the same text: nothing to save');
});

test('sections: added, duplicated, removed on the open template only; moved on any', () => {
  assert.equal(canGrow('kit'), true); assert.equal(canGrow('bags'), false);
  const d = kit();
  const added = addSection(d, 'imageText', 'hero')!;
  assert.equal(added.id, 'imagetext-2');
  assert.equal(added.draft.sections[1].id, 'imagetext-2', 'right after the one chosen');
  assert.equal(added.draft.sections[1].settings.title, 'תמונה וטקסט');
  assert.equal(addSection(d, 'newsletter'), null, 'the newsletter waits for stage 5');
  const dup = duplicateSection(added.draft, 'hero')!;
  assert.equal(dup.draft.sections[1].id, 'hero-2');
  assert.deepEqual(dup.draft.sections[1].settings, dup.draft.sections[0].settings);
  assert.notEqual(dup.draft.sections[1].settings, dup.draft.sections[0].settings, 'a copy, not the same object');
  assert.ok(!removeSection(dup.draft, 'hero-2').sections.some((s) => s.id === 'hero-2'));
  const moved = moveSection(d, 'hero', 1);
  assert.equal(moved.sections[1].id, 'hero');
  assert.equal(moveSection(d, 'hero', -1), d, 'the first one does not move up');
  let many = d; for (let i = 0; i < 30; i++) { const r = addSection(many, 'text'); if (!r) break; many = r.draft; }
  assert.equal(many.sections.length, 20, 'at most 20 sections');
});

test('what the page names opens its own editor', () => {
  const ctx = { pages: [{ id: 'p1', kind: 'page', slug: 'about' }], collections: [{ id: 'c1', slug: 'paper' }], productId: (s: string) => (s === 'bag' ? 'i1' : null) };
  assert.equal(editRoute('menus:main', ctx), '/store/navigation');
  assert.equal(editRoute('menus:footer', ctx), '/store/navigation');
  assert.equal(editRoute('settings', ctx), '/store/settings#details');
  assert.equal(editRoute('announcement', ctx), 'announcement');
  assert.equal(editRoute('page:policy:returns', ctx), '/store/pages?policy=returns');
  assert.equal(editRoute('page:page:about', ctx), '/store/pages?page=p1');
  assert.equal(editRoute('page:page:nope', ctx), null);
  assert.equal(editRoute('collection:paper', ctx), '/store/collections?edit=c1');
  assert.equal(editRoute('product:bag', ctx), '/store/products/i1');
  assert.equal(editRoute('product:gone', ctx), null);
  assert.equal(editRoute('page:policy:../x', ctx), null);
  assert.equal(editRoute('javascript:alert(1)', ctx), null);
});

test('the frame\'s address: the store\'s base, a path of the store, the token', () => {
  assert.equal(editFrameUrl('https://followme.co.il', '/collections/all', 'tok.1.sig'), 'https://followme.co.il/collections/all?edit=tok.1.sig');
  assert.equal(editFrameUrl('https://followme.co.il/', 'https://evil.example/x', 't'), 'https://followme.co.il/?edit=t', 'never another site');
});
