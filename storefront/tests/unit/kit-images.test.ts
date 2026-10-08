/**
 * Default pictures of the starter kits (2.62): every kit has a manifest, every picture in it is a real WebP file of this
 * app with the size the manifest says, and the storefront picks the kit's picture only where the business has none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KIT_MANIFESTS, kitCollectionImage, kitGallery, kitImage, kitImageCss } from '../../src/lib/kit-images';
import { resolveTheme, themeCss } from '../../src/lib/theme';
// @ts-expect-error — a plain .mjs script, no types
import { normalize, webpSize } from '../../scripts/kit-images.mjs';

const PUBLIC = fileURLToPath(new URL('../../public/kit-images/', import.meta.url));

test('the seven kits each have a manifest, and every picture is a WebP file of the size it says', () => {
  assert.deepEqual(Object.keys(KIT_MANIFESTS).sort(), ['bags', 'beauty', 'fashion', 'furniture', 'general', 'retail', 'services']);
  for (const m of Object.values(KIT_MANIFESTS)) {
    assert.ok(m.images.some((i) => i.slot === 'hero' && i.variant === 'wide' && i.order === 1), `${m.kit}: a wide hero first`);
    for (const i of m.images) {
      const path = `${PUBLIC}${m.kit}/${i.file}`;
      assert.ok(existsSync(path), `${m.kit}/${i.file}: the file is there`);
      assert.deepEqual(webpSize(readFileSync(path)), { width: i.width, height: i.height }, `${m.kit}/${i.file}: its size`);
      assert.match(i.file, /^[a-z0-9-]+\.webp$/);
      assert.ok(i.alt.trim(), `${m.kit}/${i.file}: alt text`);
      assert.ok(i.focal.x >= 0 && i.focal.x <= 1 && i.focal.y >= 0 && i.focal.y <= 1);
      if (i.slot === 'collection') assert.ok(i.collection, `${m.kit}/${i.file}: which collection`);
    }
  }
});

test('the kit\'s picture for each place: the first wide hero, the image-and-text, a collection by its slug', () => {
  assert.deepEqual(kitImage('fashion', 'hero'), { src: '/kit-images/fashion/fashion-hero-wide.webp', width: 1672, height: 941,
    alt: 'מתלה בגדים באדום, שחור ושמנת בבוטיק מואר באור שמש', className: 'kimg-fashion-hero-wide' });
  assert.equal(kitImage('general', 'imageText')?.src, '/kit-images/general/general-image-text.webp');
  assert.equal(kitCollectionImage('furniture', 'living-room')?.src, '/kit-images/furniture/furniture-cat-living-room.webp');
  assert.equal(kitCollectionImage('furniture', 'garden'), null, 'a collection the kit has no picture for: the drawing stays');
  assert.equal(kitImage(null, 'hero'), null, 'a store with no kit: nothing changes');
  assert.equal(kitImage('nope', 'hero'), null);
  assert.deepEqual(kitGallery('beauty').map((p) => p.src.split('/').pop()), ['beauty-gallery-1.webp', 'beauty-gallery-2.webp', 'beauty-gallery-3.webp']);
});

test('the theme carries the kit (a checked name only), and its CSS sets each picture\'s focal point', () => {
  assert.equal(resolveTheme('kit', { kit: 'fashion' }).kit, 'fashion');
  assert.equal(resolveTheme('kit', { kit: 'x}body{color:red' }).kit, null);
  assert.equal(resolveTheme('bags', {}).kit, null);
  const css = themeCss(resolveTheme('kit', { kit: 'fashion' }));
  assert.match(css, /\.kimg-fashion-hero-wide\{object-position:22% 50%\}/);
  assert.equal(kitImageCss(null), '');
  assert.ok(!/kimg/.test(themeCss(resolveTheme('kit', { kit: 'unknown-kit' }))), 'an unknown kit adds no CSS');
});

test('the importer: one shape for every delivered JSON — order within a slot, the real size, nothing invented', () => {
  const sizes = { 'a-hero.webp': { width: 10, height: 5 }, 'a-v.webp': { width: 5, height: 10 }, 'a-cat.webp': { width: 4, height: 4 }, 'a-g.webp': { width: 4, height: 5 } };
  const { manifest, notes } = normalize({ kit: 'a', version: 2, images: [
    { file: 'a-v.webp', slot: 'hero', variant: 'vertical', order: 3, width: 5, height: 10, focal: { x: 0.5, y: 0.4 }, alt: 'אנכי' },
    { file: 'a-hero.webp', slot: 'hero', variant: 'wide', order: 1, width: 10, height: 6, focal: { x: 0.2, y: 0.5 }, alt: 'רחב', textSafe: 'right' },
    { file: 'a-cat.webp', slot: 'collection', variant: 'wide', order: 1, width: 4, height: 4, focal: { x: 2, y: 0.5 }, alt: 'קטגוריה', collection: 'new' },
    { file: 'a-g.webp', slot: 'gallery', width: 4, height: 5, alt: '' },
    { file: 'missing.webp', slot: 'gallery', width: 1, height: 1, alt: 'x' },
    { file: 'a-x.webp', slot: 'video', alt: 'x' },
  ] }, 'a', sizes);
  assert.deepEqual(manifest.images.map((i: { file: string; order: number }) => [i.file, i.order]), [['a-hero.webp', 1], ['a-v.webp', 1], ['a-cat.webp', 1], ['a-g.webp', 1]]);
  assert.equal(manifest.images[0].height, 5, 'the file\'s real size');
  assert.equal(manifest.images[2].variant, undefined, 'a variant only on a hero');
  assert.equal(manifest.images[2].focal.x, 0.5, 'a focal point out of range → the middle');
  assert.equal(manifest.version, 2);
  assert.equal(notes.length, 4, notes.join('\n'));
});
