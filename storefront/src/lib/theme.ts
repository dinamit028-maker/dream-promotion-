import { BAGS } from '@/templates/bags';
import { KIT } from '@/templates/kit';
import { kitImageCss } from './kit-images';
import { cleanColumns, type Column } from './builder-registry';
import { contrast, tokenVars } from './theme-tokens';
import KIT_DESIGNS from './kit-designs.json';
import { bodyClasses, CHROME, COMMERCE, DESIGN, layered, sectionVariant, type Chrome, type Commerce, type Design } from './variants';

/**
 * A template is settings only (JSON), never code: colours, font, corners, the announcement bar, and the home page's sections
 * in order. The dashboard saves only what the business changed (store_theme_versions.settings); here every value is checked
 * against the schema below and anything that does not fit falls back to the template's own value — so a draft can never
 * break the storefront or inject anything (texts are text, links are a path of the store or https, pictures are https).
 * 2.58 (starter kits): the template "kit" is open — a kit's own sections come with their type in the settings (each one
 * checked against the schema of its type), so a new kit is data in the dashboard and never code here.
 */
export type SectionType = 'hero' | 'collections' | 'products' | 'imageText' | 'steps' | 'faq' | 'contact' | 'text' | 'gallery' | 'newsletter' | 'custom';
export type Radius = 'none' | 'small' | 'medium' | 'large';
export type Font = 'heebo' | 'rubik' | 'assistant' | 'frank';
/** the drawing shown where the business has no picture yet: the template's bag, or a plain shape */
export type Art = 'bag' | 'plain';
export const FONTS: readonly Font[] = ['heebo', 'rubik', 'assistant', 'frank'];
export interface Colors { background: string; surface: string; text: string; muted: string; primary: string; accent: string; accentSoft: string; border: string }
/** variant (2.63): the section's layout — the business's, else the kit's, else the type's first (lib/variants.ts) */
export interface Section { id: string; type: SectionType; hidden: boolean; settings: Record<string, unknown>; variant?: string; hiddenOn?: Device[]; columns?: Column[] }
/** 2.66: a screen — a phone (base, up to 699px), a tablet (md, 700–1023px), a computer (lg, from 1024px) */
export type Device = 'base' | 'md' | 'lg';
export const DEVICES: readonly Device[] = ['base', 'md', 'lg'];
/** the devices a section is hidden on: known ones, once each, in order — never all three (that is "hidden") */
export function hiddenOnOf(v: unknown): Device[] {
  const on = Array.isArray(v) ? DEVICES.filter((d) => v.includes(d)) : [];
  return on.length === DEVICES.length ? [] : on;
}
export interface Theme {
  template: string;
  /** the starter kit applied (2.58), its default pictures shown where the business has none (2.62); null = none */
  kit: string | null;
  colors: Colors;
  font: Font;
  art: Art;
  radius: Radius;
  announcement: { enabled: boolean; text: string; href: string };
  product: { related: boolean; whatsapp: boolean };
  sections: Section[];
  /** 2.63: spacing, headings, buttons, width, cards — and the header, the footer, the cards and the product page */
  design: Design;
  chrome: Chrome;
  commerce: Commerce;
}
/** open: the sections are the settings' own (a kit's), not only the template's by id */
export interface Template extends Omit<Theme, 'template' | 'kit' | 'design' | 'chrome' | 'commerce'> { id: string; name: string; open?: boolean }

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
  // kitImage (2.66): which of the kit's two wide pictures the hero shows while the business has none (CORRECTIONS_HE.md §4)
  hero: { eyebrow: T(60), title: T(90), subtitle: L(300), primaryLabel: T(30), primaryHref: { kind: 'href' }, secondaryLabel: T(30), secondaryHref: { kind: 'href' }, image: { kind: 'image' }, kitImage: { kind: 'int', min: 1, max: 2 } },
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
  // 2.67: a free section — columns and blocks (builder-registry.ts, checked by cleanColumns), no fields of its own
  custom: {},
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

/** a kit's design defaults (generated from the dashboard's kits/ by scripts/kits.mjs — data only, checked like the rest) */
interface KitDesign { design: unknown; chrome: unknown; commerce: unknown; sections: Record<string, string> }
const kitDesign = (kit: string | null): KitDesign | null => (kit && Object.hasOwn(KIT_DESIGNS, kit) ? (KIT_DESIGNS as Record<string, KitDesign>)[kit] : null);

/** the template's sections, the business's order and visibility, every setting checked */
function mergeSections(base: Section[], raw: unknown, open = false, kit: KitDesign | null = null): Section[] {
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
    const hiddenOn = hiddenOnOf(r.hiddenOn);
    const columns = def.type === 'custom' ? cleanColumns(r.columns) : undefined;
    out.push({ ...def, hidden: typeof r.hidden === 'boolean' ? r.hidden : def.hidden, settings, variant: sectionVariant(def.type, r.variant, kit?.sections[def.id]), ...(hiddenOn.length ? { hiddenOn } : {}), ...(columns ? { columns } : {}) });
  }
  // an open template with sections of its own shows exactly those; otherwise the template's missing ones are added
  if (!(open && out.length)) for (const s of base) if (!seen.has(s.id)) out.push({ ...s, variant: sectionVariant(s.type, undefined, kit?.sections[s.id]) });
  return out;
}

export { contrast, onColor } from './theme-tokens';

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
  const kit = typeof o.kit === 'string' && /^[a-z][a-z0-9-]{1,30}$/.test(o.kit) ? o.kit : null;
  const kd = kitDesign(kit);
  return {
    template: t.id,
    kit,
    design: layered(DESIGN, o.design, kd?.design),
    chrome: layered(CHROME, o.chrome, kd?.chrome),
    commerce: layered(COMMERCE, o.commerce, kd?.commerce),
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
    sections: mergeSections(t.sections, o.sections, t.open, kd),
  };
}

/** the <body>'s classes: one per design choice (lib/variants.ts) */
export const themeClasses = (t: Theme) => bodyClasses(t.design, t.chrome, t.commerce);

/** the theme as CSS variables (every value checked above: hex colours, fixed sizes, a font from a fixed list) */
export function themeCss(t: Theme): string {
  const vars = tokenVars(t.colors, t.font, t.radius) ?? [];
  return `:root{${vars.map(([k, v]) => `${k}:${v}`).join(';')}}`
    + (t.art === 'bag' ? '.plain-art{display:none}' : '.bag-art{display:none}') + kitImageCss(t.kit);
}
