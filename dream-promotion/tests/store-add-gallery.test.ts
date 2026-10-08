/**
 * "+ הוספה" (Dream Builder PR-3e, 2.69): a library item and a picture for every kind one may add; a new section starts
 * with words — the site's kit's when it has that kind (the store's name in them), else the library's — only of its own
 * fields; added after the section the page named; the page's "add" checked like every message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LIBRARY, LIBRARY_CATEGORIES } from '../src/features/store/builder-registry';
import { ADDABLE, addSection, readMessage, starterSettings } from '../src/features/store/visual-edit';
import { draftOf, SECTION_DEFS, settingsOf } from '../src/features/store/theme-fields';

test('every kind one may add: in the library (a category, a line), with its picture from the renderer', () => {
  for (const type of ADDABLE) {
    const x = LIBRARY.find((i) => i.type === type);
    assert.ok(x, type);
    assert.ok(LIBRARY_CATEGORIES.includes(x.category) && x.about.length > 10, type);
    assert.ok(existsSync(join(__dirname, `../public/section-previews/${type}.jpg`)), `${type}.jpg — npm run kit-shots`);
  }
});

test('the starting words: never lorem ipsum, only the kind\'s own fields', () => {
  const d = draftOf('kit', { sections: [{ id: 'hero', type: 'hero', settings: {} }] });
  for (const type of ADDABLE) {
    const s = starterSettings(d, type);
    const keys = SECTION_DEFS[type].fields.map((f) => f.key);
    for (const k of Object.keys(s)) assert.ok(keys.includes(k) || (k === 'items' && SECTION_DEFS[type].list), `${type}.${k}`);
    assert.doesNotMatch(JSON.stringify(s), /lorem|ipsum/i);
    for (const f of SECTION_DEFS[type].fields) {
      const v = s[f.key];
      if (typeof v === 'string' && f.max) assert.ok(v.length <= f.max, `${type}.${f.key} within its length`);
    }
  }
  assert.equal(starterSettings(d, 'faq').title, 'שאלות נפוצות');
  assert.equal((starterSettings(d, 'steps').items as unknown[]).length, 3);
});

test('a site on a kit: a kind the kit has starts with the kit\'s words (the store\'s name in them); another with the library\'s', () => {
  const d = draftOf('kit', { kit: 'beauty', sections: [{ id: 'hero', type: 'hero', settings: {} }] });
  const steps = starterSettings(d, 'steps', 'סטודיו נועה');
  assert.equal(steps.title, 'איך מגיעים לטיפול', 'the kit\'s words');
  assert.ok(Array.isArray(steps.items) && (steps.items as unknown[]).length > 0);
  assert.doesNotMatch(JSON.stringify(steps), /\{\{name\}\}/);
  assert.equal(starterSettings(d, 'text').title, 'קצת עלינו', 'the beauty kit has no text section: the library\'s');
  const a = starterSettings(d, 'steps', 'x'); (a.items as { title: string }[])[0].title = 'שונה';
  assert.notEqual((starterSettings(d, 'steps', 'x').items as { title: string }[])[0].title, 'שונה', 'a copy every time');
});

test('added where the page asked, and through the draft as it is', () => {
  const d = draftOf('kit', { sections: [{ id: 'hero', type: 'hero', settings: {} }, { id: 'a', type: 'text', settings: {} }] });
  const r = addSection(d, 'faq', 'hero')!;
  assert.deepEqual(r.draft.sections.map((s) => s.id), ['hero', 'faq-2', 'a']);
  const back = draftOf('kit', settingsOf(r.draft)).sections.find((s) => s.id === 'faq-2')!;
  assert.equal((back.settings.items as unknown[]).length, 3);
  assert.deepEqual(readMessage({ type: 'add', after: 'hero' }), { type: 'add', after: 'hero' });
  for (const bad of [{ type: 'add' }, { type: 'add', after: 3 }, { type: 'add', after: 'x'.repeat(41) }]) assert.equal(readMessage(bad), null);
});
