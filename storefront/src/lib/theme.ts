import { BAGS } from '@/templates/bags';
import { KIT } from '@/templates/kit';

/**
 * A template is settings only (JSON), never code: colours, font, corners, the announcement bar, and the home page's sections
 * in order. The dashboard saves only what the business changed (store_theme_versions.settings); here every value is checked
 * against the schema below and anything that does not fit falls back to the template's own value — so a draft can never
 * break the storefront or inject anything (texts are text, links are a path of the store or https, pictures are https).
 * 2.58 (starter kits): the template "kit" is open — a kit's own sections come with their type in the settings (each one
 * checked against the schema of its type), so a new kit is data in the dashboard and never code here.
 */
export type SectionType = 'hero' | 'collections' | 'products' | 'imageText' | 'steps' | 'faq' | 'contact' | 'text' | 'gallery' | 'newsletter';
export type Radius = 'none' | 'small' | 'medium' | 'large';
export type Font = 'heebo' | 'rubik' | 'assistant' | 'frank';
/** the drawing shown where the business has no picture yet: the template's bag, or a plain shape */
export type Art = 'bag' | 'plain';
export const FONTS: readonly Font[] = ['heebo', 'rubik', 'assistant', 'frank'];
export interface Colors { background: string; surface: string; text: string; muted: string; primary: string; accent: string; accentSoft: string; border: string }
export interface Section { id: string; type: SectionType; hidden: boolean; settings: Record<string, unknown> }
export interface Theme {
  template: string;
  colors: Colors;
  font: Font;
  art: Art;
  radius: Radius;
  announcement: { enabled: boolean; text: string; href: string };
  product: { related: boolean; whatsapp: boolean };
  sections: Section[];
}
/** open: the sections are the settings' own (a kit's), not only the template's by id */
export interface Template extends Omit<Theme, 'template'> { id: string; name: string; open?: boolean }

type Field =
  | { kind: 'text'; max: number }
  | { kind: 'longtext'; max: number }
  | { kind: 'href' }
  | { kind: 'image' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'choice'; values: readonly string[] }
  | { kind: 'slug' }
  | { kind: 'list'; max: number; item: Record<string, Field> };

const T = (max: number): Field => ({ kind: 'text', max });
const L = (max: number): Field => ({ kind: 'longtext', max });
export const SCHEMA: Record<SectionType, Record<string, Field>> = {
  hero: { eyebrow: T(60), title: T(90), subtitle: L(300), primaryLabel: T(30), primaryHref: { kind: 'href' }, secondaryLabel: T(30), secondaryHref: { kind: 'href' }, image: { kind: 'image' } },
  collections: { title: T(80), subtitle: L(200) },
  products: { title: T(80), collection: { kind: 'slug' }, limit: { kind: 'int', min: 2, max: 12 }, buttonLabel: T(30) },
  imageText: { title: T(90), text: L(800), image: { kind: 'image' }, buttonLabel: T(30), buttonHref: { kind: 'href' }, imageSide: { kind: 'choice', values: ['start', 'end'] } },
  steps: { title: T(80), items: { kind: 'list', max: 6, item: { title: T(60), text: L(240) } } },
  faq: { title: T(80), items: { kind: 'list', max: 12, item: { q: T(160), a: L(1200) } } },
  contact: { title: T(80), text: L(400) },
  text: { title: T(90), text: L(2000) },
  // 2.58: pictures with a caption (before / after, Instagram, a lookbook) and a button; the newsletter only shows from stage 5
  gallery: { title: T(80), text: L(300), items: { kind: 'list', max: 8, item: { image: { kind: 'image' }, caption: T(80) } }, buttonLabel: T(30), buttonHref: { kind: 'href' } },
  newsletter: { title: T(80), text: L(300) },
};

export const TEMPLATES: Record<string, Template> = { bags: BAGS, kit: KIT };

const HEX = /^#[0-9a-fA-F]{6}$/;
const SLUG = /^[a-z0-9א-ת]+(-[a-z0-9א-ת]+)*$/;
/** a link the storefront may render: a path of the store, an https address, or one of the store's contact actions */
export function safeHref(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === 'whatsapp' || s === '#contact') return s;
  if (s.length > 300 || /[\s<>"'\\]/.test(s)) return null;
  if (/^\/(?!\/)/.test(s) || s === '/') return s;
  if (/^https:\/\/[^/]/.test(s)) { try { return new URL(s).protocol === 'https:' ? s : null; } catch { return null; } }
  return null;
}
export const safeImage = (v: unknown): string | null =>
  typeof v === 'string' && /^https:\/\/[^\s<>"'\\]+$/.test(v.trim()) && v.trim().length <= 500 ? v.trim() : null;

function clean(field: Field, v: unknown): unknown {
  switch (field.kind) {
    case 'text': return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, field.max) : undefined;
    case 'longtext': return typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, field.max) : undefined;
    case 'href': return v === '' ? '' : safeHref(v) ?? undefined;
    case 'image': return v === '' ? '' : safeImage(v) ?? undefined;
    case 'int': return typeof v === 'number' && Number.isInteger(v) && v >= field.min && v <= field.max ? v : undefined;
    case 'choice': return typeof v === 'string' && field.values.includes(v) ? v : undefined;
    case 'slug': return v === '' || (typeof v === 'string' && SLUG.test(v) && v.length <= 80) ? v : undefined;
    case 'list': {
      if (!Array.isArray(v)) return undefined;
      return v.slice(0, field.max).flatMap((row) => {
        if (!row || typeof row !== 'object') return [];
        const out: Record<string, unknown> = {};
        for (const [k, f] of Object.entries(field.item)) { const c = clean(f, (row as Record<string, unknown>)[k]); out[k] = c ?? ''; }
        return Object.values(out).some((x) => x !== '') ? [out] : [];
      });
    }
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const SECTION_ID = /^[a-z][a-z0-9-]{0,30}$/;
/** a section the settings bring (an open template): its type must be known, its values start empty */
function ownSection(r: Record<string, unknown>): Section | undefined {
  if (typeof r.id !== 'string' || !SECTION_ID.test(r.id) || typeof r.type !== 'string' || !(r.type in SCHEMA)) return undefined;
  const type = r.type as SectionType;
  const settings: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(SCHEMA[type])) settings[k] = f.kind === 'list' ? [] : '';
  return { id: r.id, type, hidden: false, settings };
}

/** the template's sections, the business's order and visibility, every setting checked */
function mergeSections(base: Section[], raw: unknown, open = false): Section[] {
  const byId = new Map(base.map((s) => [s.id, s]));
  const out: Section[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(raw) ? raw.slice(0, 30) : [];
  for (const o of list) {
    const r = obj(o);
    const known = typeof r.id === 'string' ? byId.get(r.id) : undefined;
    // an open template: a section of the settings with its own type (a known id keeps its type — the type is not changed)
    const def = known && (!open || r.type === undefined || r.type === known.type) ? known : open && !known ? ownSection(r) : undefined;
    if (!def || seen.has(def.id)) continue;
    seen.add(def.id);
    const settings = { ...def.settings };
    for (const [k, v] of Object.entries(obj(r.settings))) {
      const f = SCHEMA[def.type][k];
      if (!f) continue;
      const c = clean(f, v);
      if (c !== undefined) settings[k] = c;
    }
    out.push({ ...def, hidden: typeof r.hidden === 'boolean' ? r.hidden : def.hidden, settings });
  }
  // an open template with sections of its own shows exactly those; otherwise the template's missing ones are added
  if (!(open && out.length)) for (const s of base) if (!seen.has(s.id)) out.push(s);
  return out;
}

/** relative luminance and contrast (WCAG 2) */
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** the text colour on a button of this colour: whichever of white / ink reads better */
export const onColor = (hex: string) => (contrast(hex, '#ffffff') >= contrast(hex, '#14110e') ? '#ffffff' : '#14110e');

export function resolveTheme(templateId: string, raw: unknown): Theme {
  const t = TEMPLATES[templateId] ?? TEMPLATES.bags;
  const o = obj(raw);
  const colors: Colors = { ...t.colors };
  for (const [k, v] of Object.entries(obj(o.colors))) if (k in colors && typeof v === 'string' && HEX.test(v)) (colors as unknown as Record<string, string>)[k] = v.toLowerCase();
  // never unreadable: text on the background below 4.5:1 → the template's pair
  if (contrast(colors.text, colors.background) < 4.5) { colors.text = t.colors.text; colors.background = t.colors.background; }
  if (contrast(colors.muted, colors.background) < 4.5) colors.muted = contrast(t.colors.muted, colors.background) >= 4.5 ? t.colors.muted : colors.text;
  const a = obj(o.announcement);
  const p = obj(o.product);
  return {
    template: t.id,
    colors,
    font: FONTS.includes(o.font as Font) ? (o.font as Font) : t.font,
    art: o.art === 'bag' || o.art === 'plain' ? o.art : t.art,
    radius: (['none', 'small', 'medium', 'large'] as const).includes(o.radius as Radius) ? (o.radius as Radius) : t.radius,
    announcement: {
      enabled: typeof a.enabled === 'boolean' ? a.enabled : t.announcement.enabled,
      text: (clean(T(120), a.text) as string | undefined) ?? t.announcement.text,
      href: (clean({ kind: 'href' }, a.href) as string | undefined) ?? t.announcement.href,
    },
    product: {
      related: typeof p.related === 'boolean' ? p.related : t.product.related,
      whatsapp: typeof p.whatsapp === 'boolean' ? p.whatsapp : t.product.whatsapp,
    },
    sections: mergeSections(t.sections, o.sections, t.open),
  };
}

const RADIUS: Record<Radius, [string, string]> = { none: ['0', '0'], small: ['6px', '8px'], medium: ['12px', '999px'], large: ['20px', '999px'] };
const FAMILY: Record<Font, string> = {
  heebo: "'Heebo Variable','Heebo'", rubik: "'Rubik Variable','Rubik'", assistant: "'Assistant Variable','Assistant'",
  frank: "'Frank Ruhl Libre Variable','Frank Ruhl Libre'",
};
/** the theme as CSS variables (every value checked above: hex colours, fixed sizes, a font from a fixed list) */
export function themeCss(t: Theme): string {
  const c = t.colors;
  const [card, button] = RADIUS[t.radius];
  return `:root{--c-bg:${c.background};--c-surface:${c.surface};--c-text:${c.text};--c-muted:${c.muted};--c-primary:${c.primary};`
    + `--c-on-primary:${onColor(c.primary)};--c-accent:${c.accent};--c-accent-soft:${c.accentSoft};--c-border:${c.border};`
    + `--radius:${card};--radius-btn:${button};--font:${FAMILY[t.font]},system-ui,-apple-system,'Segoe UI',Arial,sans-serif}`
    + (t.art === 'bag' ? '.plain-art{display:none}' : '.bag-art{display:none}');
}
