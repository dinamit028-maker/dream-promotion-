/**
 * What the dashboard's "עיצוב" screen edits of a template (2.55) — and the template's own values, to start from.
 * The template lives in the storefront (storefront/src/templates/bags.ts) and the storefront checks every value it is
 * given; this file is the editor's side of the same contract: the sections, their fields (with Hebrew labels), and a copy
 * of the template's defaults — tests/store-theme.test.ts fails if the copy and the storefront's template drift apart.
 * The dashboard never imports the storefront and the storefront never imports this.
 * 2.58 (starter kits): the template "kit" is open — a kit's sections, with their types, are in the saved settings; the
 * editor works on them the same way. Gallery and newsletter are new kinds of sections; font and art are new settings.
 */
export type FieldKind = 'text' | 'longtext' | 'link' | 'image' | 'number' | 'side' | 'collection';
export interface FieldDef { key: string; label: string; kind: FieldKind; max?: number; hint?: string }
export interface ListDef { key: 'items'; label: string; max: number; fields: FieldDef[]; add: string }
import { CHROME_OPTIONS, cleanGroup, COMMERCE_OPTIONS, DESIGN_OPTIONS, sectionVariantOk, type Overrides } from './variants';

export type SectionType = 'hero' | 'collections' | 'products' | 'imageText' | 'steps' | 'faq' | 'contact' | 'text' | 'gallery' | 'newsletter';
/** soon: the storefront does not show it yet (the newsletter waits for the consent to marketing of stage 5) */
export interface SectionDef { type: SectionType; label: string; fields: FieldDef[]; list?: ListDef; soon?: string }
/** variant (2.63): the layout the business picked for this section — absent = the kit's (variants.ts) */
export interface Section { id: string; type: SectionType; hidden: boolean; settings: Record<string, unknown>; variant?: string }
export interface Colors { background: string; surface: string; text: string; muted: string; primary: string; accent: string; accentSoft: string; border: string }
export type Radius = 'none' | 'small' | 'medium' | 'large';
export type Font = 'heebo' | 'rubik' | 'assistant' | 'frank';
export type Art = 'bag' | 'plain';
export const FONTS: { id: Font; label: string }[] = [
  { id: 'heebo', label: 'Heebo — נקי ומודרני' }, { id: 'rubik', label: 'Rubik — עגול וידידותי' },
  { id: 'assistant', label: 'Assistant — דק ואלגנטי' }, { id: 'frank', label: 'Frank Ruhl — קלאסי, עם סריפים' },
];
export interface Template {
  id: string; name: string; colors: Colors; font: Font; art: Art; radius: Radius; open?: boolean;
  announcement: { enabled: boolean; text: string; href: string };
  product: { related: boolean; whatsapp: boolean };
  sections: Section[];
}

const LINK_HINT = 'כתובת באתר (למשל /collections/all), קישור https, או whatsapp';
export const SECTION_DEFS: Record<SectionType, SectionDef> = {
  hero: { type: 'hero', label: 'פתיח', fields: [
    { key: 'eyebrow', label: 'שורה קטנה מעל הכותרת', kind: 'text', max: 60 },
    { key: 'title', label: 'כותרת', kind: 'text', max: 90 },
    { key: 'subtitle', label: 'טקסט', kind: 'longtext', max: 300 },
    { key: 'primaryLabel', label: 'כפתור ראשי', kind: 'text', max: 30 },
    { key: 'primaryHref', label: 'לאן הכפתור הראשי מוביל', kind: 'link', hint: LINK_HINT },
    { key: 'secondaryLabel', label: 'כפתור שני', kind: 'text', max: 30 },
    { key: 'secondaryHref', label: 'לאן הכפתור השני מוביל', kind: 'link', hint: LINK_HINT },
    { key: 'image', label: 'תמונה (בלי תמונה מוצגת התמונה של הערכה, או ציור)', kind: 'image' },
  ] },
  collections: { type: 'collections', label: 'סוגי מוצרים (קולקציות)', fields: [
    { key: 'title', label: 'כותרת', kind: 'text', max: 80 },
    { key: 'subtitle', label: 'טקסט', kind: 'longtext', max: 200 },
  ] },
  products: { type: 'products', label: 'מוצרים נבחרים', fields: [
    { key: 'title', label: 'כותרת', kind: 'text', max: 80 },
    { key: 'collection', label: 'מאיזו קולקציה (ריק = החדשים באתר)', kind: 'collection' },
    { key: 'limit', label: 'כמה מוצרים', kind: 'number' },
    { key: 'buttonLabel', label: 'כפתור "לכל המוצרים"', kind: 'text', max: 30 },
  ] },
  imageText: { type: 'imageText', label: 'תמונה וטקסט', fields: [
    { key: 'title', label: 'כותרת', kind: 'text', max: 90 },
    { key: 'text', label: 'טקסט', kind: 'longtext', max: 800 },
    { key: 'image', label: 'תמונה', kind: 'image' },
    { key: 'buttonLabel', label: 'כפתור', kind: 'text', max: 30 },
    { key: 'buttonHref', label: 'לאן הכפתור מוביל', kind: 'link', hint: LINK_HINT },
    { key: 'imageSide', label: 'צד התמונה', kind: 'side' },
  ] },
  steps: { type: 'steps', label: 'איך זה עובד', fields: [{ key: 'title', label: 'כותרת', kind: 'text', max: 80 }],
    list: { key: 'items', label: 'שלבים', max: 6, add: '+ שלב', fields: [{ key: 'title', label: 'שלב', kind: 'text', max: 60 }, { key: 'text', label: 'הסבר', kind: 'longtext', max: 240 }] } },
  faq: { type: 'faq', label: 'שאלות נפוצות', fields: [{ key: 'title', label: 'כותרת', kind: 'text', max: 80 }],
    list: { key: 'items', label: 'שאלות', max: 12, add: '+ שאלה', fields: [{ key: 'q', label: 'שאלה', kind: 'text', max: 160 }, { key: 'a', label: 'תשובה', kind: 'longtext', max: 1200 }] } },
  contact: { type: 'contact', label: 'יצירת קשר', fields: [
    { key: 'title', label: 'כותרת', kind: 'text', max: 80 },
    { key: 'text', label: 'טקסט', kind: 'longtext', max: 400 },
  ] },
  text: { type: 'text', label: 'טקסט', fields: [{ key: 'title', label: 'כותרת', kind: 'text', max: 90 }, { key: 'text', label: 'טקסט', kind: 'longtext', max: 2000 }] },
  gallery: { type: 'gallery', label: 'גלריה (לפני ואחרי, אינסטגרם)', fields: [
    { key: 'title', label: 'כותרת', kind: 'text', max: 80 },
    { key: 'text', label: 'טקסט', kind: 'longtext', max: 300 },
    { key: 'buttonLabel', label: 'כפתור', kind: 'text', max: 30 },
    { key: 'buttonHref', label: 'לאן הכפתור מוביל (למשל הקישור לאינסטגרם)', kind: 'link', hint: LINK_HINT },
  ], list: { key: 'items', label: 'תמונות', max: 8, add: '+ תמונה', fields: [{ key: 'image', label: 'תמונה', kind: 'image' }, { key: 'caption', label: 'כיתוב', kind: 'text', max: 80 }] } },
  newsletter: { type: 'newsletter', label: 'הרשמה לדיוור', soon: 'יוצג באתר רק כשההרשמה לדיוור תיבנה, עם הסכמה לקבלת דיוור (שלב 5).', fields: [
    { key: 'title', label: 'כותרת', kind: 'text', max: 80 },
    { key: 'text', label: 'טקסט', kind: 'longtext', max: 300 },
  ] },
};

/** "שקיות ממותגות" — a copy of storefront/src/templates/bags.ts (the test keeps them equal) */
export const BAGS: Template = {
  id: 'bags',
  name: 'שקיות ממותגות',
  colors: {
    background: '#fbf8f3', surface: '#ffffff', text: '#1f1b16', muted: '#5f574e', primary: '#1f1b16',
    accent: '#8a5a2b', accentSoft: '#f1e6d6', border: '#e7ddcf',
  },
  font: 'heebo',
  art: 'bag',
  radius: 'medium',
  announcement: { enabled: true, text: 'שקיות ממותגות לעסקים — עם הלוגו שלכם', href: '/collections/all' },
  product: { related: true, whatsapp: true },
  sections: [
    { id: 'hero', type: 'hero', hidden: false, settings: {
      eyebrow: 'שקיות ממותגות',
      title: 'הלוגו שלכם, על כל שקית',
      subtitle: 'שקיות לעסקים בהדפסה לפי המידה שלכם. בוחרים דגם, שולחים לוגו — ומקבלים שקיות מוכנות.',
      primaryLabel: 'לכל השקיות', primaryHref: '/collections/all',
      secondaryLabel: 'שאלה בוואטסאפ', secondaryHref: 'whatsapp',
      image: '',
    } },
    { id: 'collections', type: 'collections', hidden: false, settings: { title: 'סוגי שקיות', subtitle: '' } },
    { id: 'featured', type: 'products', hidden: false, settings: { title: 'הכי מבוקשות', collection: '', limit: 8, buttonLabel: 'לכל השקיות' } },
    { id: 'about', type: 'imageText', hidden: false, settings: {
      title: 'למה שקית ממותגת?',
      text: 'שקית עם הלוגו ממשיכה ללכת עם הלקוח גם אחרי הקנייה. היא חלק מהחוויה, והיא מזכירה את העסק בכל מקום שהיא מגיעה אליו.',
      image: '', buttonLabel: 'לקטלוג', buttonHref: '/collections/all', imageSide: 'start',
    } },
    { id: 'steps', type: 'steps', hidden: false, settings: {
      title: 'איך זה עובד',
      items: [
        { title: 'בוחרים שקית', text: 'דגם, מידה וצבע מהקטלוג.' },
        { title: 'שולחים לוגו', text: 'קובץ של הלוגו, ואם יש — גם הנחיות להדפסה.' },
        { title: 'מאשרים', text: 'מקבלים את כל הפרטים ומאשרים לפני ההדפסה.' },
        { title: 'מקבלים', text: 'השקיות מגיעות מודפסות ומוכנות.' },
      ],
    } },
    { id: 'faq', type: 'faq', hidden: true, settings: { title: 'שאלות נפוצות', items: [] } },
    { id: 'contact', type: 'contact', hidden: false, settings: { title: 'נדבר?', text: 'שאלה על דגם, כמויות או הדפסה — כתבו לנו ונחזור אליכם.' } },
  ],
};
/** "kit" — a copy of storefront/src/templates/kit.ts (the test keeps them equal): what an open template shows before settings */
export const KIT: Template = {
  id: 'kit',
  name: 'ערכת הקמה',
  open: true,
  colors: {
    background: '#fafafa', surface: '#ffffff', text: '#1a1a1a', muted: '#595959', primary: '#1a1a1a',
    accent: '#2f5d8a', accentSoft: '#e8eef5', border: '#e2e2e2',
  },
  font: 'heebo',
  art: 'plain',
  radius: 'medium',
  announcement: { enabled: false, text: '', href: '' },
  product: { related: true, whatsapp: true },
  sections: [
    { id: 'hero', type: 'hero', hidden: false, settings: {
      eyebrow: '', title: '', subtitle: '', primaryLabel: 'לכל המוצרים', primaryHref: '/collections/all',
      secondaryLabel: 'שאלה בוואטסאפ', secondaryHref: 'whatsapp', image: '',
    } },
    { id: 'featured', type: 'products', hidden: false, settings: { title: 'חדש באתר', collection: '', limit: 8, buttonLabel: 'לכל המוצרים' } },
    { id: 'collections', type: 'collections', hidden: false, settings: { title: 'קטגוריות', subtitle: '' } },
    { id: 'contact', type: 'contact', hidden: false, settings: { title: 'יצירת קשר', text: '' } },
  ],
};
export const TEMPLATES: Record<string, Template> = { bags: BAGS, kit: KIT };

/** the editor's state: the template's values with what the business saved over them (only known keys) */
export interface Draft {
  colors: Colors;
  font: Font;
  art: Art;
  /** the starter kit applied (2.58) — the texts "חזרה לטקסט של הערכה" go back to; '' = none */
  kit: string;
  radius: Radius;
  announcement: { enabled: boolean; text: string; href: string };
  product: { related: boolean; whatsapp: boolean };
  sections: Section[];
  /** 2.63: the business's own design choices — only what it picked (the rest comes from the kit) */
  overrides: Overrides;
}
const HEX = /^#[0-9a-fA-F]{6}$/;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const SECTION_ID = /^[a-z][a-z0-9-]{0,30}$/;
/** a section the settings bring (an open template): a known type, its fields empty until the settings fill them */
function ownSection(r: Record<string, unknown>): Section | undefined {
  if (typeof r.id !== 'string' || !SECTION_ID.test(r.id) || typeof r.type !== 'string' || !(r.type in SECTION_DEFS)) return undefined;
  const def = SECTION_DEFS[r.type as SectionType];
  const settings: Record<string, unknown> = Object.fromEntries(def.fields.map((f) => [f.key, '']));
  if (def.list) settings.items = [];
  return { id: r.id, type: def.type, hidden: false, settings };
}

export function draftOf(templateId: string, saved: unknown): Draft {
  const t = TEMPLATES[templateId] ?? BAGS;
  const o = obj(saved);
  const c = obj(o.colors), a = obj(o.announcement), p = obj(o.product);
  const pick = (k: keyof Colors) => (typeof c[k] === 'string' && HEX.test(c[k] as string) ? (c[k] as string).toLowerCase() : t.colors[k]);
  const byId = new Map(t.sections.map((s) => [s.id, s]));
  const sections: Section[] = [];
  for (const raw of Array.isArray(o.sections) ? o.sections.slice(0, 30) : []) {
    const r = obj(raw); const known = typeof r.id === 'string' ? byId.get(r.id) : undefined;
    // the same rule as the storefront: an open template takes a section of the settings with its own type
    const def = known && (!t.open || r.type === undefined || r.type === known.type) ? known : t.open && !known ? ownSection(r) : undefined;
    if (!def || sections.some((s) => s.id === def.id)) continue;
    const own: Section = { ...def, hidden: typeof r.hidden === 'boolean' ? r.hidden : def.hidden, settings: { ...def.settings, ...obj(r.settings) } };
    delete own.variant;
    if (sectionVariantOk(def.type, r.variant)) own.variant = r.variant;
    sections.push(own);
  }
  if (!(t.open && sections.length)) for (const s of t.sections) if (!sections.some((x) => x.id === s.id)) sections.push({ ...s, settings: { ...s.settings } });
  return {
    colors: {
      background: pick('background'), surface: pick('surface'), text: pick('text'), muted: pick('muted'), primary: pick('primary'),
      accent: pick('accent'), accentSoft: pick('accentSoft'), border: pick('border'),
    },
    font: FONTS.some((f) => f.id === o.font) ? (o.font as Font) : t.font,
    art: o.art === 'bag' || o.art === 'plain' ? o.art : t.art,
    kit: typeof o.kit === 'string' && /^[a-z][a-z0-9-]{1,30}$/.test(o.kit) ? o.kit : '',
    radius: (['none', 'small', 'medium', 'large'] as const).includes(o.radius as Radius) ? (o.radius as Radius) : t.radius,
    announcement: {
      enabled: typeof a.enabled === 'boolean' ? a.enabled : t.announcement.enabled,
      text: typeof a.text === 'string' ? a.text : t.announcement.text,
      href: typeof a.href === 'string' ? a.href : t.announcement.href,
    },
    product: { related: typeof p.related === 'boolean' ? p.related : t.product.related, whatsapp: typeof p.whatsapp === 'boolean' ? p.whatsapp : t.product.whatsapp },
    sections,
    overrides: { design: cleanGroup(DESIGN_OPTIONS, o.design), chrome: cleanGroup(CHROME_OPTIONS, o.chrome), commerce: cleanGroup(COMMERCE_OPTIONS, o.commerce) },
  };
}

/** what is saved in store_theme_versions.settings: the whole state (the storefront checks it again) */
export const settingsOf = (d: Draft) => ({
  ...(d.kit ? { kit: d.kit } : {}),
  colors: d.colors, font: d.font, art: d.art, radius: d.radius, announcement: d.announcement, product: d.product,
  sections: d.sections.map((s) => ({ id: s.id, type: s.type, hidden: s.hidden, settings: s.settings, ...(s.variant ? { variant: s.variant } : {}) })),
  // only what the business picked: a choice that is not here is the kit's
  ...(Object.keys(d.overrides.design).length ? { design: d.overrides.design } : {}),
  ...(Object.keys(d.overrides.chrome).length ? { chrome: d.overrides.chrome } : {}),
  ...(Object.keys(d.overrides.commerce).length ? { commerce: d.overrides.commerce } : {}),
});

/** WCAG contrast of two colours (the editor warns below 4.5:1 — the storefront then falls back to the template's pair) */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** a field's value as the storefront will accept it — else a sentence for the owner */
export function fieldError(f: FieldDef, v: unknown): string | null {
  if (f.kind === 'link') {
    const s = String(v ?? '').trim();
    if (!s || s === 'whatsapp' || s === '#contact') return null;
    if (s.length <= 300 && (/^\/(?!\/)[^\s<>"'\\]*$/.test(s) || /^https:\/\/[^\s<>"'\\]+$/.test(s))) return null;
    return `"${f.label}": כתובת באתר שמתחילה ב-/, קישור https, או whatsapp.`;
  }
  if (f.kind === 'image') { const s = String(v ?? '').trim(); return !s || /^https:\/\/[^\s<>"'\\]+$/.test(s) ? null : `"${f.label}": תמונה צריכה להיות קישור https.`; }
  if (f.kind === 'number') { const n = Number(v); return Number.isInteger(n) && n >= 2 && n <= 12 ? null : `"${f.label}": מספר בין 2 ל-12.`; }
  if ((f.kind === 'text' || f.kind === 'longtext') && f.max && String(v ?? '').length > f.max) return `"${f.label}": עד ${f.max} תווים.`;
  return null;
}
export function draftErrors(d: Draft): string[] {
  const out: string[] = [];
  for (const s of d.sections) {
    const def = SECTION_DEFS[s.type];
    for (const f of def.fields) { const e = fieldError(f, s.settings[f.key]); if (e) out.push(`${def.label} — ${e}`); }
    if (def.list) for (const row of (Array.isArray(s.settings.items) ? s.settings.items : []) as Record<string, unknown>[]) {
      for (const f of def.list.fields) { const e = fieldError(f, row[f.key]); if (e) out.push(`${def.label} — ${e}`); }
    }
  }
  const ann = fieldError({ key: 'href', label: 'קישור ההודעה העליונה', kind: 'link' }, d.announcement.href);
  if (ann) out.push(ann);
  if (contrast(d.colors.text, d.colors.background) < 4.5) out.push('הטקסט והרקע קרובים מדי בצבע — קשה לקרוא. בחרו זוג צבעים עם יותר ניגוד.');
  return out;
}
