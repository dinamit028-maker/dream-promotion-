/**
 * A kit's preview and "החלפת עיצוב" (Dream Builder PR-2, 2.64): the storefront gets the kits' themes as a generated copy;
 * "design" changes the look only — no page, menu, collection or policy — through the same plan and the same draft
 * protection as "full"; and what it saves is exactly what the preview showed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { designSwitch, kitById, planBlocked, planKit, type KitContext, type KitState } from '../src/features/store/kits';
import { withKit } from '../src/features/store/StoreSettings';
import type { ThemeVersion } from '../src/features/store/store';
// @ts-expect-error — a plain .mjs script, no types
import { STOREFRONT_THEMES, storefrontThemes } from '../scripts/kits.mjs';

const STOREFRONT = fileURLToPath(new URL('../../storefront/', import.meta.url));
const ctx: KitContext = { name: 'FollowMe', booking: '', business: { name: 'FollowMe' } };
const followme = { colors: { primary: '#0a3d62' }, chrome: { header: 'centered-logo' },
  sections: [{ id: 'hero', settings: { title: 'שקיות FollowMe' } }, { id: 'faq', hidden: false, settings: { items: [{ q: 'יש מינימום?', a: 'כן.' }] } }] };
const version = (status: ThemeVersion['status'], settings: Record<string, unknown>, id = status): ThemeVersion =>
  ({ id, version: status === 'draft' ? 2 : 1, status, template: 'bags', settings, createdAt: '', publishedAt: null, note: '' });
const state = (versions: ThemeVersion[]): KitState => ({
  versions, pages: [{ id: 'p1', kind: 'page', policy: null, slug: 'about', title: 'אודות', body: 'שלנו' }],
  menus: { main: [{ label: 'כל השקיות', href: '/collections/all' }], footer: [] }, collections: [{ slug: 'paper' }],
});

test('the storefront\'s copy of the kits\' themes is kits/ (generated)', () => {
  assert.equal(readFileSync(STOREFRONT_THEMES, 'utf8'), storefrontThemes(), 'storefront/src/lib/kit-themes.json differs from kits/ — run `npm run kits`');
});

test('"החלפת עיצוב": the look only — no page, menu, collection or policy; the store\'s home page and texts stay', () => {
  const kit = kitById('fashion')!;
  const plan = planKit(kit, state([version('published', followme)]), ctx, 'design');
  assert.equal(plan.mode, 'design');
  assert.deepEqual([plan.collections, plan.pages, plan.pageConflicts], [[], [], []], 'nothing created or replaced');
  assert.deepEqual([plan.menus.main.action, plan.menus.footer.action], ['same', 'same'], 'the menus are not written');
  const s = plan.settings as any;
  assert.equal(s.kit, 'fashion');
  assert.deepEqual(s.colors, kit.theme.colors, 'the kit\'s colours');
  assert.equal(s.font, kit.theme.font);
  assert.equal(s.sections.find((x: any) => x.id === 'hero').settings.title, 'שקיות FollowMe', 'the store\'s own text');
  assert.ok(s.sections.some((x: any) => x.id === 'steps'), 'every section of the store\'s template');
  assert.equal(s.chrome, undefined, 'the business\'s old design choice goes — the kit\'s header now');
  assert.ok(s.sections.every((x: any) => x.variant === undefined));
  assert.equal(plan.publishTheme, false, 'the store has a published theme: a draft only');
});

test('"החלפת עיצוב" keeps the draft protection: a draft with changes is replaced only with a yes', () => {
  const kit = kitById('beauty')!;
  const edited = planKit(kit, state([version('published', followme), version('draft', { ...followme, colors: { primary: '#222222' } })]), ctx, 'design');
  assert.deepEqual(edited.draft, { id: 'draft', edited: true });
  assert.ok(planBlocked(edited, { replacePages: [], replaceMenus: [], replaceDraft: false }));
  assert.equal((edited.settings as any).sections.find((x: any) => x.id === 'hero').settings.title, 'שקיות FollowMe', 'the draft is the base');
});

function inStorefront(code: string, input: string): any {
  const tsx = `${STOREFRONT}node_modules/.bin/tsx`;
  assert.ok(existsSync(tsx), 'storefront/node_modules is missing — run `npm ci` in storefront/ first');
  const r = spawnSync(tsx, ['-e', code], { cwd: STOREFRONT, input, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('what "החלפת עיצוב" saves is exactly what the preview showed (the storefront\'s own rule)', () => {
  const ids = ['fashion', 'beauty', 'retail', 'general'];
  const input = JSON.stringify({ followme, saved: Object.fromEntries(ids.map((id) => [id, designSwitch(kitById(id)!, 'bags', followme)])) });
  const out = inStorefront(`import { previewTheme } from './src/lib/kit-preview.ts'; import { resolveTheme } from './src/lib/theme.ts'; import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
    const { followme, saved } = JSON.parse(readFileSync(0, 'utf8'));
    console.log(JSON.stringify(Object.fromEntries(Object.entries(saved).map(([id, s]) => [id, {
      saved: resolveTheme('kit', s), shown: previewTheme('bags', followme, { kit: id, mode: 'design', name: '' }, 'FollowMe') }]))));`, input);
  for (const id of ids) assert.deepEqual(out[id].saved, out[id].shown, id);
});

test('the preview link carries the kit and the mode next to the token', () => {
  assert.equal(withKit('https://shop.example/?preview=abc.def', { id: 'beauty', mode: 'full' }), 'https://shop.example/?preview=abc.def&kit=beauty&kitmode=full');
});
