/**
 * A kit applied in one transaction (2.73, migration 3900): the plan as one call — the same writes as the steps of 2.58
 * (only the pages and menus the owner chose to replace; the draft; the first publish) — and the fallback to those steps
 * while the database has no store_apply_kit; a failure names the step and says that nothing was written. The function
 * itself is tested on a real Postgres: tests/sql/store-apply-kit.check.sql.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { kitById, kitPayload, planKit, type KitContext, type KitState } from '../src/features/store/kits';
import { applyKitError, applyKitMissing } from '../src/features/store/data';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ctx: KitContext = { name: 'FollowMe', booking: '', business: { name: 'FollowMe' } };
const EMPTY: KitState = { versions: [], pages: [], menus: { main: [], footer: [] }, collections: [] };

test('a new store: everything the plan creates, the first publish — and not one product', () => {
  const kit = kitById('fashion')!;
  const plan = planKit(kit, EMPTY, ctx, 'full');
  const p = kitPayload(plan, { replacePages: [], replaceMenus: [], replaceDraft: false });
  assert.equal(p.collections.length, kit.collections.length);
  assert.equal(p.pages.length, plan.pages.length);
  assert.deepEqual(p.replace, []);
  assert.deepEqual(p.menus.map((m) => m.kind), ['main', 'footer'], 'both menus were empty: created');
  assert.deepEqual([p.draft.id, p.draft.template, p.draft.note, p.publish], [null, 'kit', 'ערכה: אופנה', true]);
  assert.ok(!JSON.stringify(p).includes('catalog_items'));
});

test('a store with its own pages and menus: only what the owner chose is replaced; a design switch writes the look only', () => {
  const kit = kitById('beauty')!;
  const about = kit.pages[0];
  const state: KitState = {
    versions: [{ id: 'v1', storeId: 's', version: 1, status: 'published', template: 'kit', settings: { kit: 'fashion' }, note: '', createdAt: '', publishedAt: '' } as any,
      { id: 'v2', storeId: 's', version: 2, status: 'draft', template: 'kit', settings: { kit: 'fashion' }, note: '', createdAt: '', publishedAt: null } as any],
    pages: [{ id: 'p1', kind: 'page', policy: null, slug: about.slug, title: 'שלנו', body: 'טקסט של העסק' }],
    menus: { main: [{ label: 'בית', href: '/' }], footer: [{ label: 'בית', href: '/' }] }, collections: [],
  };
  const full = planKit(kit, state, ctx, 'full');
  assert.equal(full.pageConflicts.length, 1);
  const kept = kitPayload(full, { replacePages: [], replaceMenus: [], replaceDraft: true });
  assert.deepEqual([kept.replace, kept.menus], [[], []], 'nothing of the business replaced without its say');
  assert.deepEqual([kept.draft.id, kept.publish], ['v2', false], 'the one draft; the site keeps its published version');
  const chosen = kitPayload(full, { replacePages: ['p1'], replaceMenus: ['footer'], replaceDraft: true });
  assert.deepEqual(chosen.replace.map((r) => r.id), ['p1']);
  assert.deepEqual(chosen.menus.map((m) => m.kind), ['footer']);
  const design = kitPayload(planKit(kit, state, ctx, 'design'), { replacePages: ['p1'], replaceMenus: ['main'], replaceDraft: true });
  assert.deepEqual([design.collections, design.pages, design.replace, design.menus], [[], [], [], []], 'design only: the look, nothing else');
  assert.equal(design.draft.note, 'עיצוב: ביוטי וקליניקה');
});

test('the database\'s function reads exactly these keys (the payload and migration 3900 agree)', () => {
  const sql = readFileSync(`${ROOT}supabase/migrations/20261008003900_store_apply_kit.sql`, 'utf8');
  for (const k of ['collections', 'pages', 'replace', 'menus', 'draft', 'publish']) assert.match(sql, new RegExp(`p_plan->>?'${k}'`), k);
  for (const k of ['title', 'slug', 'description', 'image_url', 'kind', 'rules', 'sort', 'publish_online', 'seo_title', 'seo_description']) assert.match(sql, new RegExp(`c->>?'${k}'`), `collection.${k}`);
  for (const k of ['kind', 'policy', 'slug', 'title', 'body', 'seo_title', 'seo_description', 'published']) assert.match(sql, new RegExp(`p->>'${k}'`), `page.${k}`);
  assert.doesNotMatch(sql, /\bdrop\b|\bdelete\b/i, 'the MCP can apply it whole (no drop, no delete)');
  assert.doesNotMatch(sql, /security definer/i, 'as the caller: its row-level security');
});

test('before migration 3900: the steps of 2.58; a failure: its step, in Hebrew, and that nothing was written', () => {
  assert.equal(applyKitMissing({ code: 'PGRST202', message: 'Could not find the function public.store_apply_kit(p_plan, p_store) in the schema cache' }), true);
  assert.equal(applyKitMissing({ code: '42883', message: 'function public.store_apply_kit(uuid, jsonb) does not exist' }), true);
  assert.equal(applyKitMissing({ code: '23505', message: 'הקולקציה "חדש" — duplicate key value violates unique constraint "catalog_collections_slug_uq"' }), false, 'a failure inside it is not "missing"');
  assert.equal(applyKitError({ code: '23505', message: 'הקולקציה "חדש" — duplicate key value violates unique constraint "catalog_collections_slug_uq"' }),
    'הקולקציה "חדש": הכתובת הזו כבר בשימוש. בחרו כתובת אחרת. שום דבר מהערכה לא נכתב — אפשר לתקן ולנסות שוב.');
  assert.match(applyKitError({ code: '42501', message: 'החנות — store not found' }), /^החנות: אין הרשאה/);
  assert.match(applyKitError({ code: 'XX000', message: 'something else' }), /^לא נשמר\. שום דבר מהערכה לא נכתב/);
});
