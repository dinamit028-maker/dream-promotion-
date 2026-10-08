/**
 * "לחץ לעריכה" (2.61, stage 6): the dashboard's side of the visual editor. The store's page is framed with ?edit=<signed
 * preview token> (the storefront's EditBridge marks every element and names each click); these are the pure rules for what
 * a message may change in the draft, and where something edited elsewhere opens. Every change is a draft: the shoppers see
 * nothing until "פרסום באתר" (the theme's versions, as in the classic editor).
 */
import { defaultColumns } from './blocks';
import { LIBRARY } from './builder-registry';
import { kitById, kitSettings } from './kits';
import { SECTION_DEFS, type Draft, type Section, type SectionType } from './theme-fields';

/** what the storefront's page sends (storefront/src/lib/edit.ts — the same shapes; anything else is ignored) */
export type EditMessage =
  | { type: 'ready'; path: string }
  | { type: 'section'; id: string }
  | { type: 'text'; section: string; field: string; value: string }
  | { type: 'field'; section: string; field: string }
  | { type: 'image'; section: string; field: string }
  | { type: 'open'; target: string }
  | { type: 'navigate'; path: string }
  /** 2.65: a section dragged on the page to a place (its index among the sections shown) — the dashboard decides */
  | { type: 'drop'; id: string; to: number }
  /** 2.67: a block of a free section clicked — it opens in the panel */
  | { type: 'block'; section: string; id: string }
  /** 2.69: "+ חלק חדש כאן" on a section — the library opens, to add after it */
  | { type: 'add'; after: string };

const str = (v: unknown, max = 300): v is string => typeof v === 'string' && v.length <= max;
/** a message from the frame, checked field by field — or null */
export function readMessage(raw: unknown): EditMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready': case 'navigate': return str(m.path) && m.path.startsWith('/') ? { type: m.type, path: m.path } : null;
    case 'section': return str(m.id, 40) ? { type: 'section', id: m.id } : null;
    case 'text': return str(m.section, 40) && str(m.field, 40) && str(m.value, 2000) ? { type: 'text', section: m.section, field: m.field, value: m.value } : null;
    case 'field': case 'image': return str(m.section, 40) && str(m.field, 40) ? { type: m.type, section: m.section, field: m.field } : null;
    case 'open': return str(m.target, 200) ? { type: 'open', target: m.target } : null;
    case 'drop': return str(m.id, 40) && Number.isInteger(m.to) && (m.to as number) >= 0 && (m.to as number) < 100 ? { type: 'drop', id: m.id, to: m.to as number } : null;
    case 'add': return str(m.after, 40) ? { type: 'add', after: m.after } : null;
    case 'block': return str(m.section, 40) && typeof m.id === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(m.id) ? { type: 'block', section: m.section, id: m.id } : null;
    default: return null;
  }
}

/**
 * A text edited in place: only a field of that section's kind that is text, within its length — the value as typed
 * (spaces folded). Null: nothing changes (an unknown section or field, a text too long, the same text).
 */
export function applyText(d: Draft, m: { section: string; field: string; value: string }): Draft | null {
  const s = d.sections.find((x) => x.id === m.section);
  const f = s && SECTION_DEFS[s.type].fields.find((x) => x.key === m.field);
  if (!s || !f || (f.kind !== 'text' && f.kind !== 'longtext')) return null;
  const value = m.value.replace(/\s+/g, ' ').trim();
  if (f.max && value.length > f.max) return null;
  if (s.settings[m.field] === value) return null;
  return { ...d, sections: d.sections.map((x) => (x.id === s.id ? { ...x, settings: { ...x.settings, [m.field]: value } } : x)) };
}

/** a template whose sections the owner may add, duplicate and remove: only the open one ("kit"); a closed one keeps its own */
export const canGrow = (template: string) => template === 'kit';
/** the kinds of section one may add (the newsletter waits for stage 5's consent) */
export const ADDABLE: SectionType[] = ['hero', 'text', 'imageText', 'gallery', 'products', 'collections', 'steps', 'faq', 'contact', 'custom'];

function freeId(d: Draft, type: SectionType): string {
  const base = type.toLowerCase();
  for (let n = 2; n < 100; n++) { const id = `${base}-${n}`; if (!d.sections.some((s) => s.id === id)) return id; }
  return `${base}-${Date.now() % 100000}`;
}
const MAX_SECTIONS = 20;

/**
 * 2.69: what a new section starts with — the words of the site's kit when it has a section of that kind (the store's
 * name in them, a booking link → WhatsApp), else the library's (builder-registry.ts). Every field of the kind is there.
 */
export function starterSettings(d: Draft, type: SectionType, name = ''): Record<string, unknown> {
  const def = SECTION_DEFS[type];
  const empty: Record<string, unknown> = Object.fromEntries(def.fields.map((f) => [f.key, f.kind === 'number' ? 8 : f.kind === 'side' ? 'start' : '']));
  if (def.list) empty.items = [];
  const kit = kitById(d.kit);
  const fromKit = kit && kit.theme.sections.some((s) => s.type === type)
    ? (kitSettings(kit, { name, booking: '', business: { name } }).sections as { type: string; settings: Record<string, unknown> }[]).find((s) => s.type === type)!.settings
    : null;
  const from = fromKit ?? LIBRARY.find((x) => x.type === type)?.starter ?? {};
  const own = Object.fromEntries(Object.entries(from).filter(([k]) => k in empty || (k === 'items' && def.list)));
  return JSON.parse(JSON.stringify({ ...empty, ...own }));
}

/** a new section of a kind, after `after` (or at the end), with its starting words (starterSettings) */
export function addSection(d: Draft, type: SectionType, after: string | null = null, name = ''): { draft: Draft; id: string } | null {
  if (d.sections.length >= MAX_SECTIONS || !ADDABLE.includes(type)) return null;
  const settings = starterSettings(d, type, name);
  const s: Section = { id: freeId(d, type), type, hidden: false, settings, ...(type === 'custom' ? { columns: defaultColumns() } : {}) };
  const at = after ? d.sections.findIndex((x) => x.id === after) + 1 : d.sections.length;
  const sections = d.sections.slice(); sections.splice(at > 0 ? at : sections.length, 0, s);
  return { draft: { ...d, sections }, id: s.id };
}
/** a copy of a section, right after it */
export function duplicateSection(d: Draft, id: string): { draft: Draft; id: string } | null {
  const i = d.sections.findIndex((x) => x.id === id);
  if (i < 0 || d.sections.length >= MAX_SECTIONS) return null;
  const src = d.sections[i];
  const copy: Section = { ...src, id: freeId(d, src.type), settings: JSON.parse(JSON.stringify(src.settings)),
    ...(src.columns ? { columns: JSON.parse(JSON.stringify(src.columns)) } : {}) };
  const sections = d.sections.slice(); sections.splice(i + 1, 0, copy);
  return { draft: { ...d, sections }, id: copy.id };
}
export const removeSection = (d: Draft, id: string): Draft => ({ ...d, sections: d.sections.filter((x) => x.id !== id) });
/**
 * 2.65: a section to a place — `to` counts the sections shown on the page (the hidden ones are not there), as a drag on the
 * page sees them; the hidden ones keep their place among the others. The same draft when nothing moves.
 */
export function moveSectionTo(d: Draft, id: string, to: number): Draft {
  const from = d.sections.findIndex((x) => x.id === id);
  if (from < 0 || d.sections[from].hidden) return d;
  const shown = d.sections.filter((s) => !s.hidden && s.id !== id);
  const at = Math.max(0, Math.min(to, shown.length));
  const rest = d.sections.filter((s) => s.id !== id);
  const index = at < shown.length ? rest.indexOf(shown[at]) : rest.length;
  const sections = [...rest.slice(0, index), d.sections[from], ...rest.slice(index)];
  return sections.every((s, i) => s === d.sections[i]) ? d : { ...d, sections };
}
/** the place of a section among those shown on the page (-1: hidden or unknown) */
export const shownIndex = (d: Draft, id: string) => d.sections.filter((s) => !s.hidden).findIndex((s) => s.id === id);
/** a section moved from one place to another in the full list (the panel's list shows the hidden ones too) */
export function moveSectionAt(d: Draft, from: number, to: number): Draft {
  if (from === to || from < 0 || to < 0 || from >= d.sections.length || to >= d.sections.length) return d;
  const sections = d.sections.slice();
  const [s] = sections.splice(from, 1);
  sections.splice(to, 0, s);
  return { ...d, sections };
}
export function moveSection(d: Draft, id: string, by: -1 | 1): Draft {
  const i = d.sections.findIndex((x) => x.id === id), j = i + by;
  if (i < 0 || j < 0 || j >= d.sections.length) return d;
  const sections = d.sections.slice(); [sections[i], sections[j]] = [sections[j], sections[i]];
  return { ...d, sections };
}

/**
 * Where something the page names is edited: the menus, the store's details, a page or a policy, a product, a collection —
 * or "announcement" (this panel). Null: nothing to open (a page that is not the store's).
 */
export function editRoute(target: string, ctx: { pages: { id: string; kind: string; slug: string }[]; collections: { id: string; slug: string } []; productId?: (slug: string) => string | null }): string | null {
  if (target === 'announcement') return 'announcement';
  if (target === 'menus:main' || target === 'menus:footer') return '/store/navigation';
  if (target === 'settings') return '/store/settings#details';
  const [kind, a, b] = target.split(':');
  if (kind === 'page' && a === 'policy' && /^[a-z]+$/.test(b ?? '')) return `/store/pages?policy=${b}`;
  if (kind === 'page' && a === 'page') { const g = ctx.pages.find((x) => x.kind === 'page' && x.slug === target.slice('page:page:'.length)); return g ? `/store/pages?page=${encodeURIComponent(g.id)}` : null; }
  if (kind === 'collection') { const c = ctx.collections.find((x) => x.slug === target.slice('collection:'.length)); return c ? `/store/collections?edit=${encodeURIComponent(c.id)}` : null; }
  if (kind === 'product') { const id = ctx.productId?.(target.slice('product:'.length)); return id ? `/store/products/${encodeURIComponent(id)}` : null; }
  return null;
}

/** the frame's address: the store's base (its domain, or the storefront's own address), a path of the store, the token */
export function editFrameUrl(base: string, path: string, token: string): string {
  const u = new URL(path.startsWith('/') ? path : '/', base.endsWith('/') ? base : `${base}/`);
  u.searchParams.set('edit', token);
  return u.toString();
}

/**
 * 2.70: the frame at a screen's real width, in the space the dashboard has: scaled down (never up) to fit its width,
 * as tall as the space when scaled, centred. A phone sees a tablet's or a computer's page whole, only smaller.
 */
export function frameFit(space: { width: number; height: number }, frameWidth: number): { scale: number; width: number; height: number; left: number } {
  const scale = space.width > 0 ? Math.min(1, space.width / frameWidth) : 1;
  return { scale, width: frameWidth, height: Math.round(space.height / scale), left: Math.max(0, Math.round((space.width - frameWidth * scale) / 2)) };
}
