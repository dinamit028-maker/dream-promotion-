/**
 * Dream Builder PR-3b (2.66): a section hidden on some screens (a phone, a tablet, a computer) — saved, opened again and read
 * by the storefront the same; the classes the editor shows at once are the storefront's own (liveClasses = themeClasses);
 * the hero's choice of the kit's second wide picture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { draftOf, fieldError, hiddenOnOf, SECTION_DEFS, settingsOf } from '../src/features/store/theme-fields';
import { kitById, kitPictureShown, kitSettings } from '../src/features/store/kits';
import { liveClasses, withOverride, withSectionVariant } from '../src/features/store/StoreVariants';

const STOREFRONT = fileURLToPath(new URL('../../storefront/', import.meta.url));
function inStorefront(code: string, input: string): any {
  const tsx = `${STOREFRONT}node_modules/.bin/tsx`;
  assert.ok(existsSync(tsx), 'storefront/node_modules is missing — run `npm ci` in storefront/ first');
  const r = spawnSync(tsx, ['-e', code], { cwd: STOREFRONT, input, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const ctx = { name: 'FollowMe', booking: '', business: { name: 'FollowMe' } };

test('hidden on some screens: known ones only, in order, never all three; saved only when there are some', () => {
  assert.deepEqual(hiddenOnOf(['lg', 'base', 'x', 'lg']), ['base', 'lg']);
  assert.deepEqual(hiddenOnOf(['base', 'md', 'lg']), [], 'all three is "hidden" — not this');
  assert.deepEqual(hiddenOnOf('base'), []);
  const d = draftOf('kit', { sections: [{ id: 'hero', type: 'hero', hiddenOn: ['base'], settings: {} }, { id: 'a', type: 'text', hiddenOn: [], settings: {} }] });
  assert.deepEqual(d.sections[0].hiddenOn, ['base']);
  assert.equal(d.sections[1].hiddenOn, undefined);
  const saved = settingsOf(d) as any;
  assert.deepEqual(saved.sections[0].hiddenOn, ['base']);
  assert.ok(!('hiddenOn' in saved.sections[1]));
});

test('the storefront reads the same: hidden on a phone stays hidden on a phone; an unknown screen is dropped', () => {
  const d = draftOf('kit', { kit: 'beauty', sections: [{ id: 'hero', type: 'hero', hiddenOn: ['md'], settings: {} }, { id: 'faq', type: 'faq', hiddenOn: ['lg', 'tv'], settings: {} }] });
  const back = inStorefront(`import { resolveTheme } from './src/lib/theme.ts'; import { readFileSync } from 'node:fs';
    console.log(JSON.stringify(resolveTheme('kit', JSON.parse(readFileSync(0, 'utf8'))).sections.map((s) => s.hiddenOn ?? null)));`, JSON.stringify(settingsOf(d)));
  assert.deepEqual(back, [['md'], ['lg']]);
});

test('the classes the editor shows at once are the storefront\'s own — every kit, with and without the business\'s choices', () => {
  const drafts = ['fashion', 'beauty', 'retail', 'general', 'bags'].flatMap((id) => {
    const base = draftOf('kit', kitSettings(kitById(id)!, ctx));
    const own = withSectionVariant(withOverride(withOverride(base, 'chrome', 'header', 'compact'), 'design', 'spacing', 'airy'), 'hero', 'split');
    return [base, own];
  });
  drafts.push(draftOf('bags', {}));
  const theirs = inStorefront(`import { resolveTheme, themeClasses } from './src/lib/theme.ts'; import { readFileSync } from 'node:fs';
    const list = JSON.parse(readFileSync(0, 'utf8'));
    console.log(JSON.stringify(list.map(([t, s]) => themeClasses(resolveTheme(t, s)))));`, JSON.stringify(drafts.map((d, i) => [i === drafts.length - 1 ? 'bags' : 'kit', settingsOf(d)])));
  assert.deepEqual(drafts.map(liveClasses), theirs);
});

test('the kit\'s second wide picture: a choice only on a hero with a kit, and 1 or 2', () => {
  assert.ok(SECTION_DEFS.hero.fields.some((f) => f.key === 'kitImage' && f.kind === 'kitpick'));
  assert.equal(kitPictureShown('fashion', 'hero', 'kitImage'), true);
  assert.equal(kitPictureShown('', 'hero', 'kitImage'), false);
  assert.equal(kitPictureShown('fashion', 'imageText', 'kitImage'), false);
  const f = SECTION_DEFS.hero.fields.find((x) => x.key === 'kitImage')!;
  for (const ok of [undefined, '', 1, 2]) assert.equal(fieldError(f, ok), null);
  for (const bad of [3, 0, '2', 'x']) assert.ok(fieldError(f, bad));
});
