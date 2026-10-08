/**
 * Starter kits (Dream Commerce 2.58). Every file in kits/ is a valid kit and is in the generated module; a field of business
 * finds its kit (and nothing is left without one); applying a kit to an empty store creates the site and no product; on a
 * store the business already worked on it creates only what is missing and asks before replacing; every link of every kit
 * leads to something the kit creates; what a kit writes comes back from the storefront's own resolveTheme as it was.
 * The database's side (menus that hide what is not on the site, the preview, isolation) is tests/sql/store-kits.check.sql.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KIT_FILES } from '../src/features/store/kits.generated';
import {
  BOOKING, canonical, DEFAULT_KIT, hiddenLinks, kitById, kitFor, kitLinkOk, kitMenu, kitSettings, KITS, planBlocked, planKit, validateKit,
  type Kit, type KitContext, type KitState,
} from '../src/features/store/kits';
import { linkOk, menuProblem, pageProblem, policyAckProblem, type PageRow, type ThemeVersion } from '../src/features/store/store';
import { draftErrors, draftOf, settingsOf } from '../src/features/store/theme-fields';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STOREFRONT = fileURLToPath(new URL('../../storefront/', import.meta.url));
const ctx = (booking = ''): KitContext => ({ name: 'FollowMe', booking, business: { name: 'FollowMe', phone: '050-1234567', email: 'a@b.co' } });
const EMPTY: KitState = { versions: [], pages: [], menus: { main: [], footer: [] }, collections: [] };
const raw = (id: string) => structuredClone(KIT_FILES.find((f: any) => f.id === id)) as any;

function inStorefront(code: string, input = ''): any {
  const tsx = `${STOREFRONT}node_modules/.bin/tsx`;
  assert.ok(existsSync(tsx), 'storefront/node_modules is missing — run `npm ci` in storefront/ first');
  const r = spawnSync(tsx, ['-e', code], { cwd: STOREFRONT, input, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('every file in kits/ is a valid kit, named by its id, and the generated module is up to date ("npm run kits")', async () => {
  const files = readdirSync(`${ROOT}kits`).filter((f) => f.endsWith('.json')).sort();
  const { generated } = await import(`${ROOT}scripts/kits.mjs`);
  assert.equal(readFileSync(`${ROOT}src/features/store/kits.generated.ts`, 'utf8'), generated(), 'kits.generated.ts differs from kits/ — run `npm run kits`');
  assert.equal(KIT_FILES.length, files.length);
  for (const f of files) {
    const v = validateKit(JSON.parse(readFileSync(`${ROOT}kits/${f}`, 'utf8')));
    assert.ok(v.ok, `kits/${f}: ${v.ok ? '' : v.errors.join('; ')}`);
    assert.equal(`${v.kit.id}.json`, f, 'the file is named by the kit\'s id');
  }
  assert.equal(KITS.length, files.length, 'no kit was left out');
  assert.equal(new Set(KITS.map((k) => k.id)).size, KITS.length, 'ids are unique');
  for (const id of ['general', 'bags', 'fashion', 'furniture', 'beauty', 'services', 'retail']) assert.ok(kitById(id), id);
  assert.equal(kitById(DEFAULT_KIT)!.keywords.length, 0, 'the default kit is chosen by no word — it is what is left');
});

test('a bad kit is refused, with the reason', () => {
  const broken = (patch: (k: any) => void) => { const k = raw('fashion'); patch(k); return validateKit(k); };
  const reason = (r: ReturnType<typeof validateKit>) => (r.ok ? '' : r.errors.join('; '));
  assert.match(reason(broken((k) => { k.menus.main[0].href = '/collections/nope'; })), /leads nowhere/, 'a menu link to a collection the kit does not create');
  assert.match(reason(broken((k) => { k.menus.footer.push({ label: 'x', href: 'javascript:alert(1)' }); })), /not a valid link/);
  assert.match(reason(broken((k) => { k.theme.sections[0].settings.primaryHref = '/pages/nope'; })), /leads nowhere/, 'a button to a page the kit does not create');
  assert.match(reason(broken((k) => { k.theme.sections[0].type = 'video'; })), /unknown/);
  assert.match(reason(broken((k) => { k.theme.sections[0].settings.onclick = 'x'; })), /not a field/);
  assert.match(reason(broken((k) => { k.theme.colors.text = '#eeeeee'; })), /below 4.5/, 'text that cannot be read');
  assert.match(reason(broken((k) => { k.theme.colors.muted = '#dddddd'; })), /muted/);
  assert.match(reason(broken((k) => { k.collections.push({ ...k.collections[0] }); })), /twice/);
  assert.match(reason(broken((k) => { k.collections[0].slug = 'all'; })), /slug/);
  assert.match(reason(broken((k) => { k.collections[0].tags = []; })), /tag/);
  assert.match(reason(broken((k) => { k.pages[0].slug = 'policy-returns'; })), /slug/, 'a page cannot take a policy\'s address');
  assert.match(reason(broken((k) => { k.policies.cookies = { append: 'x' }; })), /not a policy/);
  assert.match(reason(broken((k) => { k.theme.sections[0].settings.title = 'x'.repeat(91); })), /90/);
  assert.match(reason(broken((k) => { k.theme.font = 'comic'; })), /font/);
  assert.equal(validateKit(null).ok, false);
});

test('the field of business finds its kit; anything else gets "כללי" — a store is never empty', () => {
  assert.equal(kitFor('הקליניקה מתמחה בשני תחומים עיקריים: טיפולי לייזר וטיפולי יופי, ובמיוחד עיצוב גבות.').id, 'beauty', 'SaGabot\'s profile');
  assert.equal(kitFor('מכירת אי סים במחירם בלי תחורת').id, 'general', 'FollowMe\'s profile (eSIM): no kit of its own yet');
  assert.equal(kitFor('חנות בגדים לנשים').id, 'fashion');
  assert.equal(kitFor('אופנה').id, 'fashion');
  assert.equal(kitFor('רהיטים ועיצוב לבית').id, 'furniture');
  assert.equal(kitFor('שקיות ממותגות לעסקים').id, 'bags');
  assert.equal(kitFor('ייעוץ עסקי ואימון').id, 'services');
  assert.equal(kitFor('').id, 'general');
  assert.equal(kitFor('ספא וטיפוח לנשים, גם בגדי ים').id, 'beauty', 'the most matches wins');
});

test('applied to an empty store: the whole site as drafts — and not one product', () => {
  for (const kit of KITS) {
    const plan = planKit(kit, EMPTY, ctx());
    assert.equal(plan.collections.length, kit.collections.length, `${kit.id}: every collection`);
    assert.ok(plan.collections.every((c) => c.kind === 'auto' && c.rules.tags.length > 0 && c.publish_online), `${kit.id}: automatic by tag, on the site (empty)`);
    assert.equal(plan.pages.filter((p) => p.kind === 'page').length, kit.pages.length, `${kit.id}: every page`);
    assert.deepEqual(plan.pages.filter((p) => p.kind === 'policy').map((p) => p.policy).sort(), ['accessibility', 'privacy', 'returns', 'shipping', 'terms'], `${kit.id}: all five policies`);
    assert.ok(plan.pages.every((p) => p.published === false), `${kit.id}: nothing is published by applying a kit`);
    assert.ok(plan.pages.every((p) => !p.body.includes('{{')), `${kit.id}: the name is filled in`);
    assert.equal(plan.menus.main.action, 'create'); assert.equal(plan.menus.footer.action, 'create');
    assert.deepEqual(plan.pageConflicts, []); assert.equal(plan.draft.id, null); assert.equal(plan.draft.edited, false);
    assert.equal(plan.publishTheme, true, `${kit.id}: a store that never published a theme gets the kit's as its first (the site stays closed)`);
    assert.ok(!('products' in plan) && !JSON.stringify(plan).includes('catalog_items'), 'a kit writes no product');
    assert.equal(planBlocked(plan, { replacePages: [], replaceMenus: [], replaceDraft: false }), null);
    // the policies are a starting text: never published with "[…]"
    for (const p of plan.pages.filter((x) => x.kind === 'policy')) assert.ok(pageProblem({ ...p, seoTitle: '', seoDescription: '', published: true }, []), `${kit.id}/${p.policy}: has brackets to fill`);
  }
});

test('every link of every kit leads to something applying it creates (menus, buttons, the bar at the top)', () => {
  for (const kit of KITS) {
    for (const booking of ['', 'https://dream.example/book/clinic']) {
      const c = ctx(booking);
      const plan = planKit(kit, EMPTY, c);
      // as if everything the kit created were published: no link is left hidden
      const pages = plan.pages.map((p, i) => ({ id: `p${i}`, kind: p.kind, policy: p.policy, slug: p.slug, title: p.title, published: true }));
      const collections = plan.collections.map((x, i) => ({ id: `c${i}`, slug: x.slug, title: x.title, publishOnline: true }));
      const menus = { main: plan.menus.main.items, footer: plan.menus.footer.items };
      assert.deepEqual(hiddenLinks(menus, pages, collections), [], `${kit.id}: every menu link resolves`);
      assert.equal(menuProblem(menus.main), null, `${kit.id}: the main menu is valid for the database`);
      assert.equal(menuProblem(menus.footer), null, `${kit.id}: the footer is valid for the database`);
      assert.ok([...menus.main, ...menus.footer].every((l) => l.href !== BOOKING && linkOk(l)), `${kit.id}: "booking" is resolved`);
      if (kit.menus.main.some((l) => l.href === BOOKING)) assert.ok(menus.main.some((l) => l.href === (booking || '/pages/contact')), `${kit.id}: booking → ${booking || 'the contact page'}`);
      const d = draftOf('kit', plan.settings);
      assert.deepEqual(draftErrors(d), [], `${kit.id}: the editor accepts what the kit wrote`);
      for (const s of d.sections) for (const v of Object.values(s.settings)) if (typeof v === 'string') assert.ok(!v.includes('{{') && v !== BOOKING, `${kit.id}/${s.id}: ${v}`);
    }
    for (const s of kit.theme.sections) for (const [k, v] of Object.entries(s.settings)) {
      if (/href/i.test(k) && typeof v === 'string') assert.ok(kitLinkOk(v, kit, 'theme'), `${kit.id}/${s.id}.${k}`);
    }
  }
});

test('on a store the business already worked on: only what is missing, the rest is asked (FollowMe as it is)', () => {
  const kit = kitById('bags')!;
  const published: ThemeVersion = { id: 'v5', version: 5, status: 'published', template: 'bags', settings: { colors: { primary: '#111111' } }, createdAt: '', publishedAt: '', note: '' };
  const page = (p: Partial<PageRow> & Pick<PageRow, 'kind' | 'slug'>): PageRow => ({ id: p.slug, policy: null, title: 't', body: 'b', seoTitle: '', seoDescription: '', published: false, updatedAt: '', ...p });
  const state: KitState = {
    versions: [published],
    pages: [
      ...(['accessibility', 'privacy', 'returns', 'shipping', 'terms'] as const).map((k) => page({ kind: 'policy', policy: k, slug: `policy-${k}`, title: k, body: 'נוסח של העסק' })),
      page({ kind: 'page', slug: 'about', title: 'אודות', body: 'הטקסט שהעסק כתב' }),
    ],
    menus: { main: [], footer: [{ href: '/policies/terms', label: 'תנאי שימוש' }, { href: '/policies/returns', label: 'ביטולים והחזרות' }] },
    collections: [{ slug: 'paper' }],
  };
  const plan = planKit(kit, state, ctx());
  assert.deepEqual(plan.keptPolicies.sort(), ['accessibility', 'privacy', 'returns', 'shipping', 'terms'], 'the policies the business has are never replaced');
  assert.equal(plan.pages.filter((p) => p.kind === 'policy').length, 0);
  assert.deepEqual(plan.keptCollections, ['paper'], 'an existing collection is kept as it is');
  assert.ok(!plan.collections.some((c) => c.slug === 'paper'));
  assert.deepEqual(plan.pageConflicts.map((c) => c.slug), ['about'], 'a page of its own at the same address: asked, not replaced');
  assert.ok(!plan.pages.some((p) => p.slug === 'about'));
  assert.equal(plan.menus.main.action, 'create', 'an empty menu is filled');
  assert.equal(plan.menus.footer.action, 'conflict', 'a menu the business made is replaced only if the owner ticks it');
  assert.equal(plan.draft.id, null, 'no draft yet: a new draft, the published version stays');
  assert.equal(plan.publishTheme, false, 'a store with a published theme: the kit stays a draft');
  // a draft with changes that were never published: replacing it needs a yes
  const edited = planKit(kit, { ...state, versions: [published, { ...published, id: 'v6', version: 6, status: 'draft', settings: { colors: { primary: '#222222' } } }] }, ctx());
  assert.deepEqual(edited.draft, { id: 'v6', edited: true });
  assert.ok(planBlocked(edited, { replacePages: [], replaceMenus: [], replaceDraft: false }));
  assert.equal(planBlocked(edited, { replacePages: [], replaceMenus: [], replaceDraft: true }), null);
  const same = planKit(kit, { ...state, versions: [published, { ...published, id: 'v6', version: 6, status: 'draft' }] }, ctx());
  assert.equal(same.draft.edited, false, 'a draft equal to what is published holds nothing to lose');
  // applied again: nothing new
  const again = planKit(kit, {
    versions: [published], menus: { main: plan.menus.main.items, footer: plan.menus.footer.items }, collections: kit.collections.map((c) => ({ slug: c.slug })),
    pages: [...state.pages, ...plan.pages.map((p, i) => ({ ...page({ kind: p.kind, slug: p.slug }), id: `n${i}`, policy: p.policy, title: p.title, body: p.body }))],
  }, ctx());
  assert.deepEqual([again.collections.length, again.pages.length, again.menus.main.action, again.menus.footer.action], [0, 0, 'same', 'same'], 'a second run creates nothing');
  assert.deepEqual(again.pageConflicts.map((c) => c.slug), ['about'], 'still only the business\'s own page');
});

test('what a kit writes comes back from the storefront\'s resolveTheme as it was (the open template "kit")', () => {
  for (const kit of KITS) {
    const settings = kitSettings(kit, ctx('https://dream.example/book/x'));
    const back = inStorefront(`import { resolveTheme } from './src/lib/theme.ts'; import { readFileSync } from 'node:fs';
      console.log(JSON.stringify(resolveTheme('kit', JSON.parse(readFileSync(0, 'utf8')))));`, JSON.stringify(settings));
    const s = settings as any;
    assert.deepEqual(back.sections.map((x: any) => [x.id, x.type, x.hidden]), s.sections.map((x: any) => [x.id, x.type, x.hidden]), `${kit.id}: the kit's sections, in order`);
    for (const x of s.sections) assert.deepEqual(back.sections.find((y: any) => y.id === x.id).settings, x.settings, `${kit.id}/${x.id}`);
    assert.deepEqual(back.colors, s.colors, `${kit.id}: colours`);
    assert.equal(back.font, s.font); assert.equal(back.art, s.art); assert.equal(back.radius, s.radius);
    assert.deepEqual(back.announcement, s.announcement);
    assert.equal(back.kit, kit.id, `${kit.id}: the storefront knows the kit (its default pictures, 2.62)`);
    // and the dashboard's editor opens and saves it unchanged
    assert.equal(canonical(settingsOf(draftOf('kit', settings))), canonical(settings), `${kit.id}: the editor round trip`);
  }
});

test('every kit has its default pictures in the storefront, and each collection picture is a collection of the kit (2.62)', () => {
  const dir = `${STOREFRONT}src/lib/kit-images/`;
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(), KITS.map((k) => k.id).sort(), 'a manifest for every kit, no more');
  for (const kit of KITS) {
    const m = JSON.parse(readFileSync(`${dir}${kit.id}.json`, 'utf8'));
    assert.equal(m.kit, kit.id);
    const pictured = m.images.filter((i: any) => i.slot === 'collection').map((i: any) => i.collection).sort();
    assert.deepEqual(pictured, kit.collections.map((c) => c.slug).sort(), `${kit.id}: a picture for each collection, and none for a collection the kit does not create`);
  }
});

test('the storefront\'s template "kit" is the dashboard\'s copy', async () => {
  const theirs = (await import(`${STOREFRONT}src/templates/kit.ts`)).KIT;
  const { KIT } = await import('../src/features/store/theme-fields');
  assert.deepEqual(KIT, theirs);
});

test('a link in a menu to something not on the site is named, with what to do', () => {
  const pages = [
    { id: '1', kind: 'page' as const, policy: null, slug: 'about', title: 'אודות', published: false },
    { id: '2', kind: 'page' as const, policy: null, slug: 'faq', title: 'שאלות', published: true },
    { id: '3', kind: 'policy' as const, policy: 'returns' as const, slug: 'policy-returns', title: 'החזרות', published: false },
  ];
  const collections = [{ id: 'c', slug: 'sale', title: 'מבצעים', publishOnline: false }, { id: 'd', slug: 'new', title: 'חדש', publishOnline: true }];
  const menus = { main: [{ label: 'אודות', href: '/pages/about' }, { label: 'שאלות', href: '/pages/faq' }, { label: 'מבצעים', href: '/collections/sale' },
    { label: 'חדש', href: '/collections/new' }, { label: 'הכל', href: '/collections/all' }, { label: 'בית', href: '/' }, { label: 'אינסטגרם', href: 'https://instagram.com/x' }],
    footer: [{ label: 'החזרות', href: '/policies/returns' }, { label: 'אין כזה', href: '/pages/nope' }, { label: 'שבור', href: '/pages/%E0%A4%A' }, { label: 'מקודד', href: '/pages/fa%71' }] };
  const h = hiddenLinks(menus, pages, collections);
  assert.deepEqual(h.map((l) => [l.menu, l.label, l.target?.kind ?? null]),
    [['main', 'אודות', 'page'], ['main', 'מבצעים', 'collection'], ['footer', 'החזרות', 'policy'], ['footer', 'אין כזה', null], ['footer', 'שבור', null], ['footer', 'מקודד', null]],
    'compared as written, like sf_menu_visible: a malformed or encoded link is named, not a crash');
});

test('a policy is published only after "קראתי ואני מאשר/ת"', () => {
  const policy = { kind: 'policy' as const, published: true };
  assert.match(policyAckProblem(policy, false, false)!, /קראתי ואני מאשר/);
  assert.equal(policyAckProblem(policy, false, true), null);
  assert.equal(policyAckProblem(policy, true, false), null, 'a policy already on the site is saved without asking again');
  assert.equal(policyAckProblem({ ...policy, published: false }, false, false), null, 'a draft is saved freely');
  assert.equal(policyAckProblem({ kind: 'page', published: true }, false, false), null, 'a page of the business is not a policy');
});

test('kitMenu: the booking page when there is one, else the contact page (a menu cannot hold "whatsapp")', () => {
  const kit = kitById('beauty') as Kit;
  assert.ok(kitMenu(kit, 'main', ctx('https://d.example/book/c')).some((l) => l.href === 'https://d.example/book/c'));
  assert.ok(kitMenu(kit, 'main', ctx()).some((l) => l.label === 'קביעת תור' && l.href === '/pages/contact'));
  const s = kitSettings(kit, ctx()) as any;
  assert.equal(s.sections.find((x: any) => x.id === 'hero').settings.primaryHref, 'whatsapp', 'a button without a booking page → WhatsApp');
  assert.equal(s.announcement.href, 'whatsapp');
  assert.equal(s.sections.find((x: any) => x.id === 'hero').settings.eyebrow, 'FollowMe', '{{name}} is the store\'s name');
});
