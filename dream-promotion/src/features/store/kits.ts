/**
 * Starter kits — "ערכות הקמה" (Dream Commerce 2.58): a whole site per field of business, applied in one click, like a ready
 * theme. A kit is one JSON file in kits/ (scripts/kits.mjs gathers them into kits.generated.ts): the template's colours,
 * font and home page, the two menus, collections (empty, or automatic by tag), pages and additions to the policies.
 * Pure functions, tested directly (tests/store-kits.test.ts); the writes are in data.ts (applyKit), through the existing
 * tables and their row-level security.
 *
 * The rules: a kit never adds a product (the catalog is the register's and finance's too); it never replaces anything the
 * business wrote without asking — it creates only what is missing, and lists what it would replace; policies are a starting
 * text with "[…]" (NEEDS_LEGAL_VERIFICATION), created as drafts and never replaced; nothing is published by applying a kit,
 * except the theme of a store that has never published one (its site is still closed).
 */
import { isSlug } from '@/features/catalog/catalog';
import { KIT_FILES } from './kits.generated';
import {
  POLICY_LABEL, policyDraft, policySlug, STORE_LIMITS, linkOk,
  type CollectionRow, type MenuLink, type PageRow, type PolicyKind, type StoreRow, type ThemeVersion,
} from './store';
import { contrast, fieldError, FONTS, SECTION_DEFS, type Art, type Colors, type Font, type Radius, type Section, type SectionType } from './theme-fields';

export interface KitCollection { slug: string; title: string; description: string; tags: string[] }
export interface KitPage { slug: string; title: string; body: string }
export interface KitTheme {
  colors: Colors; font: Font; art: Art; radius: Radius;
  announcement: { enabled: boolean; text: string; href: string };
  product: { related: boolean; whatsapp: boolean };
  sections: Section[];
}
export interface Kit {
  id: string; name: string; description: string; order: number; keywords: string[]; seoDescription: string;
  theme: KitTheme; menus: { main: MenuLink[]; footer: MenuLink[] };
  collections: KitCollection[]; pages: KitPage[]; policies: Partial<Record<PolicyKind, { append: string }>>;
}

export const POLICY_KINDS: readonly PolicyKind[] = ['returns', 'privacy', 'accessibility', 'terms', 'shipping'];
/** a link to the booking page (the existing appointments system): resolved when the kit is applied */
export const BOOKING = 'booking';
export const DEFAULT_KIT = 'general';
const KIT_ID = /^[a-z][a-z0-9-]{1,30}$/;
const SECTION_ID = /^[a-z][a-z0-9-]{0,30}$/;
const HEX = /^#[0-9a-f]{6}$/;
const COLOR_KEYS: (keyof Colors)[] = ['background', 'surface', 'text', 'muted', 'primary', 'accent', 'accentSoft', 'border'];
const SAMPLE_NAME = 'שם העסק לדוגמה עם עשרים';

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** {{name}} → the store's name */
export const fill = (text: string, name: string) => text.split('{{name}}').join(name);

// ---- checking a kit ---------------------------------------------------------------------------------------------------------
/**
 * Where a link of a kit may lead: an address the kit itself creates (its collections, pages, the policies, a section of its
 * home page), the store's own fixed addresses, https://, the booking page — and in the theme also WhatsApp and the contact
 * section. A link to anything else would be broken on a new store.
 */
export function kitLinkOk(href: string, kit: Pick<Kit, 'collections' | 'pages' | 'theme'>, where: 'menu' | 'theme'): boolean {
  if (href === BOOKING) return true;
  if (where === 'theme' && (href === '' || href === 'whatsapp' || href === '#contact')) return true;
  if (['/', '/collections', '/collections/all', '/search'].includes(href)) return true;
  let m = href.match(/^\/collections\/([^/?#]+)$/);
  if (m) return kit.collections.some((c) => c.slug === m![1]);
  m = href.match(/^\/pages\/([^/?#]+)$/);
  if (m) return kit.pages.some((p) => p.slug === m![1]);
  m = href.match(/^\/policies\/([a-z]+)$/);
  if (m) return POLICY_KINDS.includes(m[1] as PolicyKind);
  m = href.match(/^\/#([a-z][a-z0-9-]*)$/);
  if (m) return kit.theme.sections.some((s) => s.id === m![1]);
  return /^https:\/\/[^\s<>"'\\]+$/.test(href) && href.length <= STORE_LIMITS.href;
}

/** a kit file → the kit, or every problem in it (the test fails on any; the dashboard leaves a bad file out) */
export function validateKit(raw: unknown): { ok: true; kit: Kit } | { ok: false; errors: string[] } {
  const e: string[] = [];
  const r = obj(raw);
  const id = str(r.id);
  if (!KIT_ID.test(id)) e.push('id: lower-case letters, digits and hyphens (2–31)');
  const name = str(r.name).trim();
  if (!name || name.length > 40) e.push('name: 1–40 characters');
  if (str(r.description).length > 200) e.push('description: up to 200 characters');
  if (!Number.isInteger(r.order)) e.push('order: a whole number');
  const keywords = Array.isArray(r.keywords) ? r.keywords : null;
  if (!keywords || keywords.some((k) => typeof k !== 'string' || !k.trim())) e.push('keywords: a list of words');
  if (fill(str(r.seoDescription), SAMPLE_NAME).length > STORE_LIMITS.seoDescription) e.push('seoDescription: too long');

  // the collections and pages first: the links are checked against them
  const collections: KitCollection[] = [];
  for (const [i, c] of (Array.isArray(r.collections) ? r.collections : []).entries()) {
    const o = obj(c);
    const col = { slug: str(o.slug), title: str(o.title).trim(), description: str(o.description), tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : [] };
    if (!isSlug(col.slug) || col.slug === 'all') e.push(`collections[${i}].slug: not a valid address`);
    if (collections.some((x) => x.slug === col.slug)) e.push(`collections[${i}].slug: twice`);
    if (!col.title || col.title.length > STORE_LIMITS.collectionTitle) e.push(`collections[${i}].title: 1–${STORE_LIMITS.collectionTitle}`);
    if (col.description.length > STORE_LIMITS.collectionDescription) e.push(`collections[${i}].description: too long`);
    if (!col.tags.length) e.push(`collections[${i}].tags: at least one tag (an automatic collection)`);
    collections.push(col);
  }
  if (!Array.isArray(r.collections)) e.push('collections: a list');
  const pages: KitPage[] = [];
  for (const [i, p] of (Array.isArray(r.pages) ? r.pages : []).entries()) {
    const o = obj(p);
    const page = { slug: str(o.slug), title: str(o.title).trim(), body: str(o.body) };
    if (!isSlug(page.slug) || page.slug.startsWith('policy-')) e.push(`pages[${i}].slug: not a valid address`);
    if (pages.some((x) => x.slug === page.slug)) e.push(`pages[${i}].slug: twice`);
    if (!page.title || page.title.length > STORE_LIMITS.pageTitle) e.push(`pages[${i}].title: 1–${STORE_LIMITS.pageTitle}`);
    if (!page.body.trim() || fill(page.body, SAMPLE_NAME).length > STORE_LIMITS.pageBody) e.push(`pages[${i}].body: empty or too long`);
    pages.push(page);
  }
  if (!Array.isArray(r.pages)) e.push('pages: a list');
  const policies: Kit['policies'] = {};
  for (const [k, v] of Object.entries(obj(r.policies))) {
    if (!POLICY_KINDS.includes(k as PolicyKind)) { e.push(`policies.${k}: not a policy`); continue; }
    const append = str(obj(v).append);
    if (!append.trim() || append.length > 5000) e.push(`policies.${k}.append: 1–5000 characters`);
    policies[k as PolicyKind] = { append };
  }

  // the theme
  const t = obj(r.theme);
  const c = obj(t.colors);
  const colors = Object.fromEntries(COLOR_KEYS.map((k) => [k, str(c[k]).toLowerCase()])) as unknown as Colors;
  for (const k of COLOR_KEYS) if (!HEX.test(colors[k])) e.push(`theme.colors.${k}: #rrggbb`);
  if (COLOR_KEYS.every((k) => HEX.test(colors[k]))) {
    if (contrast(colors.text, colors.background) < 4.5) e.push('theme.colors: text on background below 4.5:1');
    if (contrast(colors.muted, colors.background) < 4.5) e.push('theme.colors: muted on background below 4.5:1');
  }
  const font = str(t.font) as Font;
  if (!FONTS.some((f) => f.id === font)) e.push('theme.font: one of the fonts');
  const art = str(t.art) as Art;
  if (art !== 'bag' && art !== 'plain') e.push('theme.art: bag or plain');
  const radius = str(t.radius) as Radius;
  if (!['none', 'small', 'medium', 'large'].includes(radius)) e.push('theme.radius: none / small / medium / large');
  const a = obj(t.announcement), pr = obj(t.product);
  const announcement = { enabled: a.enabled === true, text: str(a.text), href: str(a.href) };
  if (fill(announcement.text, SAMPLE_NAME).length > 120) e.push('theme.announcement.text: up to 120 characters');
  const product = { related: pr.related !== false, whatsapp: pr.whatsapp !== false };
  const sections: Section[] = [];
  for (const [i, s] of (Array.isArray(t.sections) ? t.sections : []).entries()) {
    const o = obj(s);
    const sid = str(o.id), type = str(o.type) as SectionType;
    const def = SECTION_DEFS[type];
    if (!SECTION_ID.test(sid)) e.push(`theme.sections[${i}].id: lower-case letters, digits and hyphens`);
    if (sections.some((x) => x.id === sid)) e.push(`theme.sections[${i}].id: twice`);
    if (!def) { e.push(`theme.sections[${i}].type: unknown`); continue; }
    const settings = obj(o.settings);
    const allowed = new Set([...def.fields.map((f) => f.key), ...(def.list ? ['items'] : [])]);
    for (const k of Object.keys(settings)) if (!allowed.has(k)) e.push(`theme.sections[${i}].settings.${k}: not a field of ${type}`);
    for (const f of def.fields) {
      const v = settings[f.key];
      const filled = typeof v === 'string' ? fill(v, SAMPLE_NAME) : v;
      if (f.kind === 'link') { if (!kitLinkOk(str(v), { collections, pages, theme: { sections: (t.sections as Section[]) ?? [] } as KitTheme }, 'theme')) e.push(`theme.sections[${i}].${f.key}: the link leads nowhere in this kit (${str(v)})`); continue; }
      if (f.kind === 'collection') { if (v !== '' && v !== undefined && !collections.some((x) => x.slug === v)) e.push(`theme.sections[${i}].${f.key}: not a collection of this kit`); continue; }
      const err = fieldError(f, filled);
      if (err) e.push(`theme.sections[${i}]: ${err}`);
    }
    if (def.list) {
      const rows = settings.items === undefined ? [] : settings.items;
      if (!Array.isArray(rows) || rows.length > def.list.max) e.push(`theme.sections[${i}].items: a list of up to ${def.list.max}`);
      else for (const row of rows) for (const f of def.list.fields) { const err = fieldError(f, obj(row)[f.key]); if (err) e.push(`theme.sections[${i}].items: ${err}`); }
    }
    sections.push({ id: sid, type, hidden: o.hidden === true, settings });
  }
  if (!sections.length) e.push('theme.sections: at least one');
  const theme: KitTheme = { colors, font, art, radius, announcement, product, sections };
  if (announcement.href && !kitLinkOk(announcement.href, { collections, pages, theme }, 'theme')) e.push(`theme.announcement.href: leads nowhere (${announcement.href})`);

  // the menus
  const m = obj(r.menus);
  const menus = { main: [] as MenuLink[], footer: [] as MenuLink[] };
  for (const kind of ['main', 'footer'] as const) {
    const list = Array.isArray(m[kind]) ? (m[kind] as unknown[]) : null;
    if (!list) { e.push(`menus.${kind}: a list`); continue; }
    if (list.length > STORE_LIMITS.menuItems) e.push(`menus.${kind}: up to ${STORE_LIMITS.menuItems} links`);
    for (const [i, l] of list.entries()) {
      const link = { label: str(obj(l).label), href: str(obj(l).href) };
      const sample = link.href === BOOKING ? 'https://example.com/book/x' : link.href;
      if (!linkOk({ label: link.label, href: sample })) e.push(`menus.${kind}[${i}]: not a valid link`);
      else if (!kitLinkOk(link.href, { collections, pages, theme }, 'menu')) e.push(`menus.${kind}[${i}]: leads nowhere in this kit (${link.href})`);
      menus[kind].push(link);
    }
  }
  if (e.length) return { ok: false, errors: e };
  return { ok: true, kit: { id, name, description: str(r.description), order: r.order as number, keywords: (keywords as string[]).map((k) => k.trim()),
    seoDescription: str(r.seoDescription), theme, menus, collections, pages, policies } };
}

/** every kit file that is valid, in their order (a bad file is left out — the test names it) */
export const KITS: Kit[] = KIT_FILES.flatMap((f) => { const v = validateKit(f); return v.ok ? [v.kit] : []; }).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
export const kitById = (id: string, kits: Kit[] = KITS) => kits.find((k) => k.id === id) ?? null;

/**
 * The kit for a field of business: the business's industry (free text, from its profile) against each kit's keywords —
 * the kit with the most matches; none → "כללי". A store is never left empty.
 */
export function kitFor(industry: string, kits: Kit[] = KITS): Kit {
  const text = industry.toLowerCase();
  let best: Kit | null = null, score = 0;
  for (const k of kits) {
    const n = k.keywords.filter((w) => text.includes(w.toLowerCase())).length;
    if (n > score) { best = k; score = n; }
  }
  return best ?? kitById(DEFAULT_KIT, kits) ?? kits[0];
}

// ---- applying a kit -----------------------------------------------------------------------------------------------------------
export interface KitContext {
  name: string;
  /** the booking page (https://…/book/<slug>) when the business takes appointments online, else '' */
  booking: string;
  business: { name: string; phone?: string; email?: string; address?: string };
}
/** a link of the theme: the booking page, or WhatsApp when there is none */
const themeHref = (href: string, ctx: KitContext) => (href === BOOKING ? ctx.booking || 'whatsapp' : href);
/** a link of a menu: the booking page, or the contact page (a menu cannot hold "whatsapp") */
const menuHref = (href: string, kit: Kit, ctx: KitContext) =>
  href === BOOKING ? ctx.booking || (kit.pages.some((p) => p.slug === 'contact') ? '/pages/contact' : '/') : href;

/** the theme's settings a kit writes into the draft (template "kit"): its name filled in, its links resolved */
export function kitSettings(kit: Kit, ctx: KitContext): Record<string, unknown> {
  const t = kit.theme;
  const sections = t.sections.map((s) => {
    const def = SECTION_DEFS[s.type];
    const settings: Record<string, unknown> = { ...s.settings };
    for (const f of def.fields) {
      const v = settings[f.key];
      if (typeof v !== 'string') continue;
      settings[f.key] = f.kind === 'link' ? themeHref(v, ctx) : f.max ? fill(v, ctx.name).slice(0, f.max) : fill(v, ctx.name);
    }
    if (def.list && Array.isArray(settings.items)) settings.items = (settings.items as Record<string, unknown>[]).map((row) => ({ ...row }));
    return { id: s.id, type: s.type, hidden: s.hidden, settings };
  });
  return {
    kit: kit.id, colors: { ...t.colors }, font: t.font, art: t.art, radius: t.radius,
    announcement: { enabled: t.announcement.enabled, text: fill(t.announcement.text, ctx.name).slice(0, 120), href: themeHref(t.announcement.href, ctx) },
    product: { ...t.product }, sections,
  };
}
export const kitMenu = (kit: Kit, kind: 'main' | 'footer', ctx: KitContext): MenuLink[] =>
  kit.menus[kind].map((l) => ({ label: l.label, href: menuHref(l.href, kit, ctx) }));

/** a policy of a kit: the starting text with the business's details, and the kit's addition — always a draft */
export function kitPolicy(kit: Kit, kind: PolicyKind, ctx: KitContext): { title: string; body: string } {
  const base = policyDraft(kind, ctx.business);
  const extra = kit.policies[kind]?.append;
  return { title: base.title || POLICY_LABEL[kind], body: extra ? `${base.body}\n\n${fill(extra, ctx.name)}` : base.body };
}

/** the rows a plan writes — the same shapes as data.ts's PageInput and CollectionInput */
export interface KitPageRow { kind: 'page' | 'policy'; policy: PolicyKind | null; slug: string; title: string; body: string; seo_title: string; seo_description: string; published: boolean }
export interface KitCollectionRow { title: string; slug: string; description: string; image_url: string; kind: 'auto'; rules: { tags: string[] };
  sort: 'newest'; publish_online: boolean; seo_title: string; seo_description: string; position: number }
export type MenuAction = 'create' | 'same' | 'conflict';
export interface KitPlan {
  kit: Kit;
  settings: Record<string, unknown>;
  /** the one draft of the theme: a new one, or the existing one — "edited" = it holds changes that were never published */
  draft: { id: string | null; edited: boolean };
  /** the store never published a theme: the kit's theme is published too (the site itself stays closed) */
  publishTheme: boolean;
  collections: KitCollectionRow[];
  keptCollections: string[];
  pages: KitPageRow[];
  /** a page the business already has at the same address, with other text: replaced only if the owner says so */
  pageConflicts: { id: string; slug: string; title: string; row: KitPageRow }[];
  keptPolicies: PolicyKind[];
  menus: Record<'main' | 'footer', { items: MenuLink[]; current: MenuLink[]; action: MenuAction }>;
}
export interface KitState {
  versions: ThemeVersion[]; pages: Pick<PageRow, 'id' | 'kind' | 'policy' | 'slug' | 'title' | 'body'>[];
  menus: { main: MenuLink[]; footer: MenuLink[] }; collections: Pick<CollectionRow, 'slug'>[];
}

/** a stable form of a value (keys sorted), to tell whether two settings are the same */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const sameLinks = (a: MenuLink[], b: MenuLink[]) => a.length === b.length && a.every((l, i) => l.label === b[i].label && l.href === b[i].href);

/** what applying a kit to this store would do — nothing is written here */
export function planKit(kit: Kit, state: KitState, ctx: KitContext): KitPlan {
  const draftRow = state.versions.find((v) => v.status === 'draft') ?? null;
  const published = state.versions.find((v) => v.status === 'published') ?? null;
  const edited = Boolean(draftRow && (published ? canonical(draftRow.settings) !== canonical(published.settings) : Object.keys(draftRow.settings).length > 0));

  const haveCollections = new Set(state.collections.map((c) => c.slug));
  const collections = kit.collections.filter((c) => !haveCollections.has(c.slug)).map((c): KitCollectionRow => ({
    title: c.title, slug: c.slug, description: c.description, image_url: '', kind: 'auto', rules: { tags: c.tags }, sort: 'newest',
    publish_online: true, seo_title: '', seo_description: '', position: 0,
  }));

  const pages: KitPageRow[] = [];
  const pageConflicts: KitPlan['pageConflicts'] = [];
  for (const p of kit.pages) {
    const row: KitPageRow = { kind: 'page', policy: null, slug: p.slug, title: p.title, body: fill(p.body, ctx.name), seo_title: '', seo_description: '', published: false };
    const have = state.pages.find((g) => g.kind === 'page' && g.slug === p.slug);
    if (!have) pages.push(row);
    else if (have.title !== row.title || have.body.trim() !== row.body.trim()) pageConflicts.push({ id: have.id, slug: have.slug, title: have.title, row });
  }
  const keptPolicies: PolicyKind[] = [];
  for (const kind of POLICY_KINDS) {
    if (state.pages.some((g) => g.kind === 'policy' && g.policy === kind)) { keptPolicies.push(kind); continue; }
    const t = kitPolicy(kit, kind, ctx);
    pages.push({ kind: 'policy', policy: kind, slug: policySlug(kind), title: t.title, body: t.body, seo_title: '', seo_description: '', published: false });
  }

  const menu = (kind: 'main' | 'footer') => {
    const items = kitMenu(kit, kind, ctx), current = state.menus[kind];
    const action: MenuAction = !current.length ? 'create' : sameLinks(current, items) ? 'same' : 'conflict';
    return { items, current, action };
  };
  return {
    kit, settings: kitSettings(kit, ctx), draft: { id: draftRow?.id ?? null, edited }, publishTheme: !published,
    collections, keptCollections: kit.collections.filter((c) => haveCollections.has(c.slug)).map((c) => c.slug),
    pages, pageConflicts, keptPolicies, menus: { main: menu('main'), footer: menu('footer') },
  };
}

/** the owner's answers to what a plan asks: which pages and menus to replace, and whether an edited draft may go */
export interface KitChoices { replacePages: string[]; replaceMenus: ('main' | 'footer')[]; replaceDraft: boolean }
/** a plan that asks for a decision the owner did not give is not applied (the screen asks first) */
export function planBlocked(plan: KitPlan, c: KitChoices): string | null {
  if (plan.draft.edited && !c.replaceDraft) return 'בטיוטת העיצוב יש שינויים שלא פורסמו. כדי להחיל את הערכה צריך לאשר שהטיוטה תוחלף (הגרסה שבאתר לא משתנה).';
  return null;
}

/**
 * Menu links that lead to something that is not on the site (a page or a policy not published, a collection not on the
 * site): the storefront leaves them out of the menu (migration 3800) — the screen says so, with a way to publish. The slug is
 * compared as written, like sf_menu_visible (no decoding: "/pages/%D7%90" is hidden on the site, so it is named here too).
 */
export interface HiddenLink { menu: 'main' | 'footer'; label: string; href: string; target: { kind: 'page' | 'policy' | 'collection'; id: string; title: string } | null }
export function hiddenLinks(menus: { main: MenuLink[]; footer: MenuLink[] }, pages: Pick<PageRow, 'id' | 'kind' | 'policy' | 'slug' | 'title' | 'published'>[],
  collections: Pick<CollectionRow, 'id' | 'slug' | 'title' | 'publishOnline'>[]): HiddenLink[] {
  const out: HiddenLink[] = [];
  for (const menu of ['main', 'footer'] as const) {
    for (const l of menus[menu]) {
      let m = l.href.match(/^\/pages\/([^/?#]+)$/);
      if (m) {
        const g = pages.find((p) => p.kind === 'page' && p.slug === m![1]);
        if (!g?.published) out.push({ menu, label: l.label, href: l.href, target: g ? { kind: 'page', id: g.id, title: g.title } : null });
        continue;
      }
      m = l.href.match(/^\/policies\/([a-z]+)$/);
      if (m) {
        const g = pages.find((p) => p.kind === 'policy' && p.policy === m![1]);
        if (!g?.published) out.push({ menu, label: l.label, href: l.href, target: g ? { kind: 'policy', id: g.id, title: g.title } : null });
        continue;
      }
      m = l.href.match(/^\/collections\/([^/?#]+)$/);
      if (m && m[1] !== 'all') {
        const c = collections.find((x) => x.slug === m![1]);
        if (!c?.publishOnline) out.push({ menu, label: l.label, href: l.href, target: c ? { kind: 'collection', id: c.id, title: c.title } : null });
      }
    }
  }
  return out;
}
