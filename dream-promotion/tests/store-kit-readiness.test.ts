/**
 * 20 kits and more (the spec's step 14, 2.71): an eighth kit is a JSON file and its pictures — no line of engine code.
 * A test kit made of existing sections and variants (and the general kit's pictures, as its own) goes through everything a
 * kit goes through: the check, the gallery's list, a preview, "החלפת עיצוב" and "ערכה מלאה" in the dashboard; the generated
 * files; and on a copy of the storefront with those files — its look, its preview, its pictures. Nothing in the repo is
 * written; the copy is removed. And no engine file names a kit: a kit is data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_FILES } from '../src/features/store/kits.generated';
import { kitById, kitSettings, KITS, planBlocked, planKit, validateKit, type KitContext, type KitState } from '../src/features/store/kits';
// @ts-expect-error — a plain .mjs script, no types
import { manifestFiles, STOREFRONT_MANIFESTS, storefrontDesigns, storefrontManifests, storefrontThemes } from '../scripts/kits.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STOREFRONT = fileURLToPath(new URL('../../storefront/', import.meta.url));
const ctx: KitContext = { name: 'FollowMe', booking: '', business: { name: 'FollowMe' } };
const EMPTY: KitState = { versions: [], pages: [], menus: { main: [], footer: [] }, collections: [] };

/** the test kit: the general kit's content, another look — every value from the existing lists */
function testKit(): any {
  const k = structuredClone(KIT_FILES.find((f: any) => f.id === 'general')) as any;
  k.id = 'test-kit'; k.name = 'ערכת בדיקה'; k.order = 99; k.keywords = ['בדיקת-ערכה'];
  k.theme.chrome = { headerVariant: 'centered-logo', footerVariant: 'dark' };
  k.theme.commerceDesign = { productCardVariant: 'editorial', collectionCardVariant: 'circles', productPageVariant: 'classic' };
  k.theme.design = { ...k.theme.design, spacing: 'airy', buttonStyle: 'outline' };
  k.theme.sections = k.theme.sections.map((s: any) => (s.type === 'hero' ? { ...s, variant: 'editorial' } : s));
  return k;
}

test('a new kit in the dashboard: valid, in the gallery\'s list, a preview, "החלפת עיצוב" and "ערכה מלאה" — no code', () => {
  const v = validateKit(testKit());
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
  const kit = v.kit;
  const list = [...KITS, kit];
  assert.equal(kitById('test-kit', list), kit, 'found among the kits (the gallery lists them all)');
  const design = planKit(kit, EMPTY, ctx, 'design');
  assert.equal(design.mode, 'design');
  assert.deepEqual([design.pages.length, design.collections.length], [0, 0], 'design only: no page, no collection');
  assert.equal((design.settings as { kit: string }).kit, 'test-kit');
  const full = planKit(kit, EMPTY, ctx, 'full');
  assert.ok(full.pages.length > 0 && full.collections.length > 0);
  assert.equal(planBlocked(full, { replacePages: [], replaceMenus: [], replaceDraft: false }), null);
  assert.equal((kitSettings(kit, ctx).sections as unknown[]).length, kit.theme.sections.length);
});

test('a new kit on the storefront: its look, its preview and its pictures — from the generated files only', () => {
  const kits = [...(KIT_FILES as any[]), testKit()];
  const manifests = manifestFiles();
  const general = manifests.general;
  const dir = mkdtempSync(join(tmpdir(), 'kit-readiness-'));
  try {
    // a copy of the storefront's code (no node_modules: linked), with the files `npm run kits` would write
    cpSync(join(STOREFRONT, 'src'), join(dir, 'src'), { recursive: true });
    for (const f of ['tsconfig.json', 'package.json']) cpSync(join(STOREFRONT, f), join(dir, f));
    symlinkSync(join(STOREFRONT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'src/lib/kit-designs.json'), storefrontDesigns(kits));
    writeFileSync(join(dir, 'src/lib/kit-themes.json'), storefrontThemes(kits));
    writeFileSync(join(dir, 'src/lib/kit-manifests.json'), storefrontManifests({ ...manifests, 'test-kit': { ...general, kit: 'test-kit' } }));
    // its pictures: files of the storefront, as scripts/kit-images.mjs puts them
    cpSync(join(STOREFRONT, 'public/kit-images/general'), join(dir, 'public/kit-images/test-kit'), { recursive: true });
    writeFileSync(join(dir, 'check.ts'), `
      import { resolveTheme, themeClasses } from './src/lib/theme';
      import { previewTheme, readKitChoice, KIT_IDS } from './src/lib/kit-preview';
      import { kitImage, kitCollectionPictures } from './src/lib/kit-images';
      const t = resolveTheme('kit', { kit: 'test-kit', sections: [{ id: 'hero', type: 'hero', settings: {} }] });
      const choice = readKitChoice('test-kit:full');
      const p = previewTheme('kit', {}, choice!, 'FollowMe');
      console.log(JSON.stringify({ classes: themeClasses(t), hero: t.sections[0].variant, ids: KIT_IDS, name: choice?.name,
        preview: p.sections.map((s) => s.type), pclasses: themeClasses(p), pic: kitImage('test-kit', 'hero'), tiles: kitCollectionPictures('test-kit').length }));`);
    const r = spawnSync(join(STOREFRONT, 'node_modules/.bin/tsx'), ['check.ts'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!);
    assert.match(out.classes, /\bv-h-centered-logo\b/); assert.match(out.classes, /\bv-f-dark\b/);
    assert.match(out.classes, /\bv-pc-editorial\b/); assert.match(out.classes, /\bv-cc-circles\b/);
    assert.match(out.classes, /\bv-sp-airy\b/); assert.match(out.classes, /\bv-btn-outline\b/);
    assert.equal(out.hero, 'editorial', 'the kit\'s layout for its hero');
    assert.ok(out.ids.includes('test-kit') && out.name === 'ערכת בדיקה', 'a preview of it may be asked for');
    assert.deepEqual(out.preview, testKit().theme.sections.map((s: any) => s.type), 'its full preview: its home page');
    assert.equal(out.pclasses, out.classes.replace(/\s+/g, ' '), 'the preview looks like the kit');
    assert.match(out.pic.src, /^\/kit-images\/test-kit\/[a-z0-9-]+\.webp$/);
    assert.ok(existsSync(join(dir, 'public', out.pic.src)), 'its picture is a file of the storefront');
    assert.ok(out.tiles > 0, 'its collections\' pictures');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no engine file names a kit: the kits are data (kits/, the manifests and the generated files)', () => {
  const ids = readdirSync(join(ROOT, 'kits')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  const literal = new RegExp(`['"\`](${ids.join('|')})['"\`]`);
  // the legacy "bags" template is a template, not a kit; "general" is the kit a store gets when no field matches
  const allowed = [/id: 'bags',/, /template \?\? 'bags'/, /DEFAULT_KIT = 'general'/];
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const files = [...walk(join(ROOT, 'src/features/store')), ...walk(join(STOREFRONT, 'src'))].filter((f) => /\.tsx?$/.test(f) && !f.includes('.generated.'));
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (literal.test(line) && !allowed.some((a) => a.test(line))) assert.fail(`${f}:${i + 1} names a kit: ${line.trim()}`);
    });
  }
});

test('the storefront\'s one file of manifests is up to date ("npm run kits"), and every kit has one', () => {
  assert.equal(readFileSync(STOREFRONT_MANIFESTS, 'utf8'), storefrontManifests(), 'storefront/src/lib/kit-manifests.json differs — run `npm run kits`');
  const m = manifestFiles();
  for (const k of KITS) assert.ok(m[k.id], `${k.id}: a manifest (scripts/kit-images.mjs)`);
});
