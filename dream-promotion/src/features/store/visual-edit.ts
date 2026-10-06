/**
 * "לחץ לעריכה" (2.61, stage 6): the dashboard's side of the visual editor. The store's page is framed with ?edit=<signed
 * preview token> (the storefront's EditBridge marks every element and names each click); these are the pure rules for what
 * a message may change in the draft, and where something edited elsewhere opens. Every change is a draft: the shoppers see
 * nothing until "פרסום באתר" (the theme's versions, as in the classic editor).
 */
import { SECTION_DEFS, type Draft, type Section, type SectionType } from './theme-fields';

/** what the storefront's page sends (storefront/src/lib/edit.ts — the same shapes; anything else is ignored) */
export type EditMessage =
  | { type: 'ready'; path: string }
  | { type: 'section'; id: string }
  | { type: 'text'; section: string; field: string; value: string }
  | { type: 'field'; section: string; field: string }
  | { type: 'image'; section: string; field: string }
  | { type: 'open'; target: string }
  | { type: 'navigate'; path: string };

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
export const ADDABLE: SectionType[] = ['hero', 'text', 'imageText', 'gallery', 'products', 'collections', 'steps', 'faq', 'contact'];

function freeId(d: Draft, type: SectionType): string {
  const base = type.toLowerCase();
  for (let n = 2; n < 100; n++) { const id = `${base}-${n}`; if (!d.sections.some((s) => s.id === id)) return id; }
  return `${base}-${Date.now() % 100000}`;
}
const MAX_SECTIONS = 20;

/** a new section of a kind, after `after` (or at the end): its fields empty, its title the kind's name */
export function addSection(d: Draft, type: SectionType, after: string | null = null): { draft: Draft; id: string } | null {
  if (d.sections.length >= MAX_SECTIONS || !ADDABLE.includes(type)) return null;
  const def = SECTION_DEFS[type];
  const settings: Record<string, unknown> = Object.fromEntries(def.fields.map((f) => [f.key, f.kind === 'number' ? 8 : f.kind === 'side' ? 'start' : '']));
  if ('title' in settings) settings.title = def.label;
  if (def.list) settings.items = [];
  const s: Section = { id: freeId(d, type), type, hidden: false, settings };
  const at = after ? d.sections.findIndex((x) => x.id === after) + 1 : d.sections.length;
  const sections = d.sections.slice(); sections.splice(at > 0 ? at : sections.length, 0, s);
  return { draft: { ...d, sections }, id: s.id };
}
/** a copy of a section, right after it */
export function duplicateSection(d: Draft, id: string): { draft: Draft; id: string } | null {
  const i = d.sections.findIndex((x) => x.id === id);
  if (i < 0 || d.sections.length >= MAX_SECTIONS) return null;
  const src = d.sections[i];
  const copy: Section = { ...src, id: freeId(d, src.type), settings: JSON.parse(JSON.stringify(src.settings)) };
  const sections = d.sections.slice(); sections.splice(i + 1, 0, copy);
  return { draft: { ...d, sections }, id: copy.id };
}
export const removeSection = (d: Draft, id: string): Draft => ({ ...d, sections: d.sections.filter((x) => x.id !== id) });
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
