/**
 * Variants (Dream Builder phase 1, 2.63): the dashboard's lists are the storefront's; a kit names only values from them;
 * its defaults reach the storefront as a generated copy; the business's own choice is the only thing saved, always wins, and
 * "חזרה לברירת המחדל של הערכה" removes it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KIT_FILES } from '../src/features/store/kits.generated';
import { kitById, kitSettings, validateKit } from '../src/features/store/kits';
import { draftOf, settingsOf } from '../src/features/store/theme-fields';
import { withOverride, withSectionVariant } from '../src/features/store/StoreVariants';
import { CHROME_OPTIONS, COMMERCE_OPTIONS, DESIGN_OPTIONS, effective, SECTION_VARIANT_OPTIONS } from '../src/features/store/variants';
// @ts-expect-error — a plain .mjs script, no types
import { STOREFRONT_DESIGNS, storefrontDesigns } from '../scripts/kits.mjs';

const STOREFRONT = fileURLToPath(new URL('../../storefront/', import.meta.url));
const ids = (g: Record<string, { options: { id: string }[] }>) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.options.map((o) => o.id)]));
const ctx = { name: 'FollowMe', booking: '', business: { name: 'FollowMe' } };

test('the dashboard\'s lists are the storefront\'s — the same values, in the same order (the first is the look of 2.61)', async () => {
  const sf = await import(`${STOREFRONT}src/lib/variants.ts`);
  assert.deepEqual(ids(DESIGN_OPTIONS), sf.DESIGN);
  assert.deepEqual(ids(CHROME_OPTIONS), sf.CHROME);
  assert.deepEqual(ids(COMMERCE_OPTIONS), sf.COMMERCE);
  assert.deepEqual(Object.fromEntries(Object.entries(SECTION_VARIANT_OPTIONS).map(([k, v]) => [k, v.map((o) => o.id)])), sf.SECTION_VARIANTS);
});

test('the kits\' defaults reach the storefront as a generated copy, equal to kits/', () => {
  assert.equal(readFileSync(STOREFRONT_DESIGNS, 'utf8'), storefrontDesigns(), 'storefront/src/lib/kit-designs.json differs from kits/ — run `npm run kits`');
});

test('the kits\' defaults follow the design matrix, every one from the lists', () => {
  const fashion = kitById('fashion')!, beauty = kitById('beauty')!;
  assert.deepEqual(fashion.variants.chrome, { header: 'transparent-overlay', footer: 'minimal' });
  assert.deepEqual(fashion.variants.commerce, { productCard: 'editorial', collectionCard: 'editorial', productPage: 'gallery-left' });
  assert.equal(fashion.variants.sections.hero, 'full-image');
  assert.equal(fashion.variants.design.buttonStyle, 'underline');
  assert.deepEqual(beauty.variants.chrome, { header: 'centered-logo', footer: 'centered' });
  assert.equal(beauty.variants.sections.treatments, 'overlap');
  assert.equal(beauty.variants.commerce.collectionCard, 'circles');
  // PHASE1_DESIGN_MATRIX.md: header, hero, product card, collections, footer, spacing, buttons — and no two kits alike
  const matrix: Record<string, string[]> = {
    fashion: ['transparent-overlay', 'full-image', 'editorial', 'editorial', 'minimal', 'airy', 'underline'],
    furniture: ['minimal', 'editorial', 'minimal', 'editorial', 'multi-column', 'airy', 'outline'],
    beauty: ['centered-logo', 'editorial', 'minimal', 'circles', 'centered', 'airy', 'soft'],
    bags: ['commerce-wide', 'split', 'classic', 'grid', 'multi-column', 'normal', 'solid'],
    services: ['centered-logo', 'split', 'horizontal', 'grid', 'multi-column', 'airy', 'solid'],
    retail: ['search-heavy', 'slider', 'compact', 'carousel', 'dark', 'compact', 'solid'],
    general: ['compact', 'centered', 'classic', 'grid', 'minimal', 'normal', 'solid'],
  };
  const row = (id: string) => { const v = kitById(id)!.variants; return [v.chrome.header, v.sections.hero, v.commerce.productCard, v.commerce.collectionCard, v.chrome.footer, v.design.spacing, v.design.buttonStyle]; };
  for (const [id, want] of Object.entries(matrix)) assert.deepEqual(row(id), want, id);
  assert.equal(new Set(Object.keys(matrix).map((id) => JSON.stringify(row(id)))).size, 7, 'seven different sites');
});

test('a kit that names a layout the renderer does not draw is refused, with the reason', () => {
  const raw = structuredClone(KIT_FILES.find((f: any) => f.id === 'fashion')) as any;
  raw.theme.sections[0].variant = 'parallax';
  raw.theme.chrome.headerVariant = 'mega-menu';
  raw.theme.design.spacing = '59px';
  raw.theme.design.shadowColor = '#000000';
  const v = validateKit(raw);
  assert.equal(v.ok, false);
  const errors = (v as { errors: string[] }).errors.join('\n');
  for (const bit of ['variant: not a layout of hero (parallax)', 'theme.chrome.headerVariant: not one of', 'theme.design.spacing: not one of', 'theme.design.shadowColor: unknown']) assert.ok(errors.includes(bit), bit);
});

test('applying a kit copies its texts, not its design: the design stays the kit\'s until the business picks', () => {
  const settings = kitSettings(kitById('fashion')!, ctx) as any;
  assert.equal(settings.design, undefined); assert.equal(settings.chrome, undefined); assert.equal(settings.commerce, undefined);
  assert.ok(settings.sections.every((s: any) => s.variant === undefined), 'no section layout written');
  const d = draftOf('kit', settings);
  assert.deepEqual(d.overrides, { design: {}, chrome: {}, commerce: {} });
});

test('the business\'s choice is the only thing saved, always wins, and "חזרה לברירת המחדל" removes it', () => {
  const kit = kitById('fashion')!;
  let d = draftOf('kit', kitSettings(kit, ctx));
  d = withOverride(d, 'chrome', 'header', 'centered-logo');
  d = withSectionVariant(d, 'hero', 'split');
  let saved = settingsOf(d) as any;
  assert.deepEqual(saved.chrome, { header: 'centered-logo' }, 'only the header — the footer stays the kit\'s');
  assert.equal(saved.sections.find((s: any) => s.id === 'hero').variant, 'split');
  assert.equal(effective(CHROME_OPTIONS.header.options, d.overrides.chrome.header, kit.variants.chrome.header), 'centered-logo', 'the business wins');
  assert.equal(effective(CHROME_OPTIONS.footer.options, d.overrides.chrome.footer, kit.variants.chrome.footer), 'minimal', 'the kit\'s where it did not pick');
  // saved and opened again: the same
  assert.deepEqual(draftOf('kit', saved).overrides, d.overrides);
  // back to the kit's
  d = withOverride(withSectionVariant(d, 'hero', undefined), 'chrome', 'header', undefined);
  saved = settingsOf(d) as any;
  assert.equal(saved.chrome, undefined);
  assert.equal(saved.sections.find((s: any) => s.id === 'hero').variant, undefined);
});

test('a saved value that is not on the list is dropped when the editor opens it (as the storefront does)', () => {
  const d = draftOf('kit', { kit: 'fashion', chrome: { header: '<script>', footer: 'centered' }, design: { spacing: 'airy', x: 'y' },
    sections: [{ id: 'hero', type: 'hero', variant: 'parallax', settings: {} }, { id: 'story', type: 'imageText', variant: 'overlap', settings: {} }] });
  assert.deepEqual(d.overrides.chrome, { footer: 'centered' });
  assert.deepEqual(d.overrides.design, { spacing: 'airy' });
  assert.equal(d.sections[0].variant, undefined);
  assert.equal(d.sections[1].variant, 'overlap');
});
