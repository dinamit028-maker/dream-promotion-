/**
 * Variants (2.63): every value from a fixed list; the business's choice, else the kit's, else the look of 2.61; a site
 * that picked nothing gets exactly the classes of the old look; the hero's portrait picture and its free side.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, themeClasses, themeCss } from '../../src/lib/theme';
import { layered, DESIGN, sectionVariant } from '../../src/lib/variants';
import { kitHero, kitImageCss } from '../../src/lib/kit-images';

test('a site that never picked anything: the look of 2.61, one class per choice', () => {
  for (const t of [resolveTheme('bags', {}), resolveTheme('kit', {}), resolveTheme('kit', { kit: 'no-such-kit' })]) {
    assert.equal(themeClasses(t), 'v-sp-normal v-hs-normal v-btn-solid v-ct-normal v-card-border v-h-classic v-f-classic v-pc-classic v-cc-grid v-pp-classic');
    assert.ok(t.sections.every((s) => s.variant === ({ hero: 'split', products: 'grid', collections: 'grid', contact: 'dark', imageText: 'split', steps: 'cards', faq: 'accordion', text: 'plain', gallery: 'grid', newsletter: 'minimal' } as Record<string, string>)[s.type]));
  }
});

test('the kit\'s defaults: fashion and beauty look like themselves without one saved choice', () => {
  const sections = (kit: string) => [{ id: 'hero', type: 'hero', settings: {} }, { id: 'story', type: 'imageText', settings: {} }, { id: 'treatments', type: 'imageText', settings: {} }, { id: 'contact', type: 'contact', settings: {} }];
  const f = resolveTheme('kit', { kit: 'fashion', sections: sections('fashion') });
  assert.match(themeClasses(f), /v-h-transparent-overlay .*/);
  assert.deepEqual([f.chrome, f.commerce.productCard, f.design.buttonStyle], [{ header: 'transparent-overlay', footer: 'minimal' }, 'editorial', 'underline']);
  assert.deepEqual(f.sections.map((s) => s.variant), ['full-image', 'full-bleed', 'split', 'dark'], 'by the section\'s id in the kit; an id the kit does not have → the type\'s first');
  const b = resolveTheme('kit', { kit: 'beauty', sections: sections('beauty') });
  assert.deepEqual(b.sections.map((s) => s.variant), ['editorial', 'split', 'overlap', 'centered']);
  assert.equal(b.commerce.collectionCard, 'circles');
});

test('the business\'s choice wins over the kit\'s; a value off the list is not taken', () => {
  const t = resolveTheme('kit', { kit: 'fashion', chrome: { header: 'centered-logo', footer: 'x}body{' }, design: { spacing: '59px' },
    sections: [{ id: 'hero', type: 'hero', variant: 'split', settings: {} }, { id: 'story', type: 'imageText', variant: 'parallax', settings: {} }] });
  assert.equal(t.chrome.header, 'centered-logo', 'the business\'s');
  assert.equal(t.chrome.footer, 'minimal', 'off the list → the kit\'s');
  assert.equal(t.design.spacing, 'airy', 'off the list → the kit\'s');
  assert.deepEqual(t.sections.map((s) => s.variant), ['split', 'full-bleed']);
  assert.ok(!/[{}<>;:'"]/.test(themeClasses(t)), 'only names from the lists reach the class attribute');
  assert.equal(layered(DESIGN, {}, { spacing: 'nope' }).spacing, 'normal', 'a kit value off the list → the look of 2.61');
  assert.equal(sectionVariant('video', 'x', 'y'), '', 'an unknown type has no layout');
});

test('the hero\'s pictures: the wide one, the portrait one for phones, the free side as a logical one; its CSS keeps both focal points', () => {
  const h = kitHero('fashion')!;
  assert.equal(h.wide.src, '/kit-images/fashion/fashion-hero-wide.webp');
  assert.equal(h.mobile?.src, '/kit-images/fashion/fashion-hero-vertical.webp');
  assert.equal(h.textSafe, 'start', 'the JSON\'s "right" — the start of an RTL page');
  assert.equal(kitHero(null), null);
  const css = kitImageCss('fashion');
  assert.match(css, /@media \(max-width:699px\)\{\.kimg-m-fashion-hero-vertical\{object-position:50% 40%\}\}/);
  assert.ok(themeCss(resolveTheme('kit', { kit: 'fashion' })).includes('.kimg-m-fashion-hero-vertical'));
});
