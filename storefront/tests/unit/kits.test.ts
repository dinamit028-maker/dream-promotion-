/**
 * Starter kits on the storefront (2.58): the open template "kit" takes a kit's own sections from the saved settings — each
 * of a known type, each value checked against its type's schema — while a closed template ("bags") still takes only its
 * own sections by id. Font and art come from fixed lists; anything else falls back to the template's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, themeCss } from '../../src/lib/theme';

test('the open template takes the kit\'s sections — known types only, every value checked', () => {
  const t = resolveTheme('kit', {
    font: 'rubik', art: 'plain', colors: { accent: '#9c5f6b' },
    sections: [
      { id: 'hero', type: 'hero', settings: { title: 'הזמן שלך', primaryHref: 'https://d.example/book/x', image: 'http://insecure/a.png' } },
      { id: 'before-after', type: 'gallery', settings: { title: 'לפני ואחרי', items: [{ image: 'https://cdn.test/1.webp', caption: 'גבות' }, { image: 'javascript:x', caption: '' }], buttonHref: 'whatsapp' } },
      { id: 'news', type: 'newsletter', hidden: true, settings: { title: 'הראשונים לדעת' } },
      { id: 'video', type: 'video', settings: {} },
      { id: 'Bad Id', type: 'text', settings: {} },
      { id: 'before-after', type: 'text', settings: {} },
      { id: 'onclick', type: 'text', settings: { title: 'x', script: '<script>' } },
    ],
  });
  assert.deepEqual(t.sections.map((s) => [s.id, s.type, s.hidden]), [['hero', 'hero', false], ['before-after', 'gallery', false], ['news', 'newsletter', true], ['onclick', 'text', false]],
    'unknown types, bad ids and repeats are dropped; the kit\'s order is kept; the template\'s own sections are not added');
  const hero = t.sections[0].settings;
  assert.equal(hero.title, 'הזמן שלך'); assert.equal(hero.primaryHref, 'https://d.example/book/x');
  assert.equal(hero.image, '', 'a picture that is not https is not taken (the template\'s value: empty)');
  assert.deepEqual(t.sections[1].settings.items, [{ image: 'https://cdn.test/1.webp', caption: 'גבות' }], 'a row whose picture is not https is dropped');
  assert.equal(t.sections[1].settings.buttonHref, 'whatsapp');
  assert.ok(!('script' in t.sections[3].settings), 'a setting the type does not have is not taken');
  assert.equal(t.font, 'rubik'); assert.equal(t.art, 'plain'); assert.equal(t.colors.accent, '#9c5f6b');
});

test('the open template with no sections of its own shows its base; a closed template keeps its own sections', () => {
  assert.deepEqual(resolveTheme('kit', {}).sections.map((s) => s.id), ['hero', 'featured', 'collections', 'contact']);
  assert.deepEqual(resolveTheme('kit', { sections: [{ id: 'x', type: 'nope' }] }).sections.map((s) => s.id), ['hero', 'featured', 'collections', 'contact'],
    'nothing valid in the settings → the base');
  const bags = resolveTheme('bags', { sections: [{ id: 'instagram', type: 'gallery', settings: { title: 'x' } }, { id: 'faq', hidden: false }] });
  assert.ok(!bags.sections.some((s) => s.id === 'instagram'), 'a closed template takes no section it does not have');
  assert.equal(bags.sections[0].id, 'faq');
  assert.equal(bags.art, 'bag'); assert.equal(bags.font, 'heebo');
});

test('font and art: from a fixed list, else the template\'s; the CSS sets the font and hides the art not used', () => {
  const odd = resolveTheme('kit', { font: "x'}body{background:url(//evil)", art: 'video' });
  assert.equal(odd.font, 'heebo'); assert.equal(odd.art, 'plain');
  const css = themeCss(resolveTheme('kit', { font: 'frank' }));
  assert.match(css, /--font:'Frank Ruhl Libre Variable'/);
  assert.match(css, /\.bag-art\{display:none\}/);
  assert.match(themeCss(resolveTheme('bags', {})), /\.plain-art\{display:none\}/);
  assert.ok(!/evil|url\(/.test(themeCss(odd)), 'nothing from the settings reaches the CSS but checked values');
});
