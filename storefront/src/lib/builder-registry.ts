/**
 * The builder's registry (Dream Builder PR-3c, 2.67) — ONE FILE, TWO IDENTICAL COPIES: dream-promotion/src/features/store/
 * builder-registry.ts and storefront/src/lib/builder-registry.ts (tests/store-blocks.test.ts fails if they differ). No
 * imports, data and pure checks only, so each app keeps its independence (the storefront never imports the dashboard).
 *
 * The free section ("custom"): up to 4 columns, each a width of 12 from a fixed list (on a phone they stack), each up to 12
 * blocks of a known type. Depth is 3 at most — section → column → block; never a column in a block, never pixels. Every
 * value is checked by cleanColumns, in the editor before a save and on the storefront before a render: anything unknown
 * is dropped quietly, a text is cut to its length, a link is a path of the store / https / whatsapp, a picture is https.
 */
export type BlockType = 'heading' | 'paragraph' | 'button' | 'image' | 'badge' | 'spacer';
export type Span = 3 | 4 | 6 | 8 | 9 | 12;
export const SPANS: readonly Span[] = [3, 4, 6, 8, 9, 12];
export interface Block { id: string; type: BlockType; settings: Record<string, string> }
/**
 * A column's width of 12: `span` on a tablet (and a computer, unless `spanLg`); on a phone `spanBase` — 12 when not set,
 * so the columns stack, as before 2.70.
 */
export interface Column { id: string; span: Span; spanBase?: Span; spanLg?: Span; blocks: Block[] }

export type BlockFieldKind = 'text' | 'longtext' | 'link' | 'image' | 'choice';
export interface BlockField { key: string; label: string; kind: BlockFieldKind; max?: number; options?: { value: string; label: string }[] }
export interface BlockDef { type: BlockType; label: string; fields: BlockField[]; defaults: Record<string, string> }

export const BLOCKS: Record<BlockType, BlockDef> = {
  heading: { type: 'heading', label: 'כותרת', defaults: { text: 'כותרת', size: 'l' }, fields: [
    { key: 'text', label: 'הכותרת', kind: 'text', max: 120 },
    { key: 'size', label: 'גודל', kind: 'choice', options: [{ value: 'm', label: 'רגילה' }, { value: 'l', label: 'גדולה' }, { value: 'xl', label: 'גדולה מאוד' }] },
  ] },
  paragraph: { type: 'paragraph', label: 'פסקה', defaults: { text: 'כאן כותבים כמה מילים — מה חשוב שהלקוחות יידעו.' }, fields: [
    { key: 'text', label: 'הטקסט', kind: 'longtext', max: 1200 },
  ] },
  button: { type: 'button', label: 'כפתור', defaults: { label: 'לכל המוצרים', href: '/collections/all', style: 'primary' }, fields: [
    { key: 'label', label: 'מה כתוב עליו', kind: 'text', max: 30 },
    { key: 'href', label: 'לאן הוא מוביל', kind: 'link' },
    { key: 'style', label: 'סגנון', kind: 'choice', options: [{ value: 'primary', label: 'מלא' }, { value: 'ghost', label: 'מסגרת' }] },
  ] },
  image: { type: 'image', label: 'תמונה', defaults: { image: '', alt: '' }, fields: [
    { key: 'image', label: 'התמונה', kind: 'image' },
    { key: 'alt', label: 'מה רואים בתמונה (לקוראי מסך)', kind: 'text', max: 120 },
  ] },
  badge: { type: 'badge', label: 'תגית', defaults: { text: 'חדש' }, fields: [
    { key: 'text', label: 'הטקסט', kind: 'text', max: 30 },
  ] },
  spacer: { type: 'spacer', label: 'רווח', defaults: { size: 'm' }, fields: [
    { key: 'size', label: 'גובה', kind: 'choice', options: [{ value: 's', label: 'קטן' }, { value: 'm', label: 'בינוני' }, { value: 'l', label: 'גדול' }] },
  ] },
};
export const BLOCK_TYPES = Object.keys(BLOCKS) as BlockType[];
export const MAX_COLUMNS = 4;
export const MAX_BLOCKS = 12;
const ID = /^[a-z][a-z0-9-]{0,30}$/;

/** 2.70: a column's classes — a phone (blk-b-N), a tablet and up (blk-span-N), a computer (blk-l-N) */
export const columnClasses = (c: Column): string[] =>
  [`blk-b-${c.spanBase ?? 12}`, `blk-span-${c.span}`, ...(c.spanLg ? [`blk-l-${c.spanLg}`] : [])];

/** a link the storefront may render: a path of the store, an https address, the store's WhatsApp or its contact section */
export function blockLinkOk(v: string): boolean {
  if (v === '' || v === 'whatsapp' || v === '#contact') return true;
  return v.length <= 300 && (/^\/(?!\/)[^\s<>"'\\]*$/.test(v) || /^https:\/\/[^\s<>"'\\]+$/.test(v));
}
export const blockImageOk = (v: string) => v === '' || (v.length <= 500 && /^https:\/\/[^\s<>"'\\]+$/.test(v));

/** one value of a block's field, as it may be saved and shown — else undefined (the default stays) */
export function cleanField(f: BlockField, v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  switch (f.kind) {
    case 'text': return v.replace(/\s+/g, ' ').trim().slice(0, f.max ?? 120);
    case 'longtext': return v.replace(/\r\n/g, '\n').trim().slice(0, f.max ?? 1200);
    case 'link': { const s = v.trim(); return blockLinkOk(s) ? s : undefined; }
    case 'image': { const s = v.trim(); return blockImageOk(s) ? s : undefined; }
    case 'choice': return f.options?.some((o) => o.value === v) ? v : undefined;
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** the columns of a free section, every value checked; unknown types, bad ids, repeats and extra rows dropped */
export function cleanColumns(raw: unknown): Column[] {
  const out: Column[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(raw) ? raw.slice(0, MAX_COLUMNS) : []) {
    const o = obj(c);
    if (typeof o.id !== 'string' || !ID.test(o.id) || seen.has(o.id)) continue;
    seen.add(o.id);
    const span = SPANS.includes(o.span as Span) ? (o.span as Span) : 12;
    const more: Partial<Column> = {};
    if (SPANS.includes(o.spanBase as Span) && o.spanBase !== 12) more.spanBase = o.spanBase as Span;
    if (SPANS.includes(o.spanLg as Span) && o.spanLg !== span) more.spanLg = o.spanLg as Span;
    const blocks: Block[] = [];
    for (const b of Array.isArray(o.blocks) ? o.blocks.slice(0, MAX_BLOCKS) : []) {
      const r = obj(b);
      const def = typeof r.type === 'string' && Object.hasOwn(BLOCKS, r.type) ? BLOCKS[r.type as BlockType] : null;
      if (!def || typeof r.id !== 'string' || !ID.test(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      const s = obj(r.settings);
      const settings: Record<string, string> = { ...def.defaults };
      for (const f of def.fields) { const v = cleanField(f, s[f.key]); if (v !== undefined) settings[f.key] = v; }
      blocks.push({ id: r.id, type: def.type, settings });
    }
    out.push({ id: o.id, span, ...more, blocks });
  }
  return out;
}

/**
 * 2.68 (PR-3d): a section's own design — only steps of fixed scales, never a colour or a pixel (the colours are the
 * theme's tokens). The phone is the base; a tablet takes the phone's unless it has its own, a computer the tablet's.
 * Nothing chosen = the look of the kit, as before. The classes are the same on both sides (styleClasses), and the
 * storefront's CSS has one rule per value — so the editor may set them on the page at once.
 */
export const STYLE_SCALES = {
  padY: [{ value: 'none', label: 'בלי' }, { value: 's', label: 'קטן' }, { value: 'm', label: 'בינוני' }, { value: 'l', label: 'גדול' }, { value: 'xl', label: 'גדול מאוד' }],
  surface: [{ value: 'background', label: 'רקע האתר' }, { value: 'surface', label: 'לבן' }, { value: 'accentSoft', label: 'צבע עדין' }, { value: 'primary', label: 'הצבע הראשי' }, { value: 'dark', label: 'כהה' }],
  align: [{ value: 'start', label: 'לימין' }, { value: 'center', label: 'למרכז' }],
  width: [{ value: 'narrow', label: 'צר' }, { value: 'normal', label: 'רגיל' }, { value: 'wide', label: 'רחב' }, { value: 'full', label: 'כל המסך' }],
} as const;
export type StyleKey = keyof typeof STYLE_SCALES;
export const STYLE_KEYS = Object.keys(STYLE_SCALES) as StyleKey[];
export const STYLE_LABELS: Record<StyleKey, string> = { padY: 'ריווח למעלה ולמטה', surface: 'רקע', align: 'יישור', width: 'רוחב התוכן' };
export type StyleValues = { [K in StyleKey]?: (typeof STYLE_SCALES)[K][number]['value'] };
export type StyleDevice = 'md' | 'lg';
export type Responsive = { [D in StyleDevice]?: StyleValues };
const CLASS_KEY: Record<StyleKey, string> = { padY: 'py', surface: 'sf', align: 'al', width: 'w' };
const CLASS_VALUE = (v: string) => v.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);   // accentSoft → accent-soft

/** a style as it may be saved: only known keys, only values of their scale — else nothing */
export function cleanStyle(raw: unknown): StyleValues {
  const o = obj(raw), out: Record<string, string> = {};
  for (const k of STYLE_KEYS) if (typeof o[k] === 'string' && STYLE_SCALES[k].some((x) => x.value === o[k])) out[k] = o[k] as string;
  return out as StyleValues;
}
export function cleanResponsive(raw: unknown): Responsive {
  const o = obj(raw), out: Responsive = {};
  for (const d of ['md', 'lg'] as const) { const s = cleanStyle(o[d]); if (Object.keys(s).length) out[d] = s; }
  return out;
}
/** the classes of a section's wrapper: sx-<key>-<value> for the phone, sx-md-… / sx-lg-… for the others */
export function styleClasses(style: StyleValues | undefined, responsive: Responsive | undefined): string[] {
  const one = (s: StyleValues | undefined, prefix: string) => STYLE_KEYS.filter((k) => s?.[k]).map((k) => `sx-${prefix}${CLASS_KEY[k]}-${CLASS_VALUE(s![k]!)}`);
  return [...one(style, ''), ...one(responsive?.md, 'md-'), ...one(responsive?.lg, 'lg-')];
}
/** a class the page may take from the editor (the same shape as styleClasses) */
export const STYLE_CLASS = /^sx-(md-|lg-)?(py|sf|al|w)-[a-z][a-z-]{0,14}$/;

/**
 * 2.69 (PR-3e): the library of "+ הוספה" — the kinds of section one may add, by category, each with a line about it and
 * the content it starts with: Hebrew words that read as a site (never lorem ipsum, never a made-up product). When the
 * site's kit has a section of that kind, the editor starts from the kit's words instead (kits.ts). Its picture is
 * /section-previews/<type>.jpg of the dashboard, shot from the real renderer (`npm run kit-shots`).
 */
export type LibraryCategory = 'מבנה' | 'תוכן' | 'מדיה' | 'מסחר' | 'יצירת קשר';
export const LIBRARY_CATEGORIES: LibraryCategory[] = ['מבנה', 'תוכן', 'מדיה', 'מסחר', 'יצירת קשר'];
export interface LibraryItem { type: string; category: LibraryCategory; about: string; starter: Record<string, unknown>; columns?: Column[] }
const cell = (type: BlockType, settings: Record<string, string>, id: string): Block => ({ id, type, settings: { ...BLOCKS[type].defaults, ...settings } });
export const STARTER_COLUMNS: Column[] = [
  { id: 'c1', span: 6, blocks: [
    cell('heading', { text: 'כותרת לחלק' }, 'b1'),
    cell('paragraph', {}, 'b2'),
    cell('button', {}, 'b3'),
  ] },
  { id: 'c2', span: 6, blocks: [cell('image', {}, 'b4')] },
];
export const LIBRARY: LibraryItem[] = [
  { type: 'hero', category: 'מבנה', about: 'כותרת גדולה, כמה מילים, כפתורים ותמונה — מה שרואים ראשון.', starter: {
    eyebrow: 'ברוכים הבאים', title: 'מה שאתם מחפשים — במקום אחד', subtitle: 'כמה מילים על העסק: מה אתם מציעים, ולמי.',
    primaryLabel: 'לכל המוצרים', primaryHref: '/collections/all', secondaryLabel: 'שאלה בוואטסאפ', secondaryHref: 'whatsapp' } },
  { type: 'custom', category: 'מבנה', about: 'עמודות זו לצד זו, ובכל אחת כותרת, טקסט, כפתור או תמונה — כמו שתרצו.', starter: {}, columns: STARTER_COLUMNS },
  { type: 'text', category: 'תוכן', about: 'כותרת וכמה פסקאות — על העסק, על איך עובדים, על מה שחשוב לכם.', starter: {
    title: 'קצת עלינו', text: 'כאן מספרים מי אתם, ממתי, ומה מיוחד אצלכם.\n\nשתיים או שלוש פסקאות קצרות מספיקות.' } },
  { type: 'imageText', category: 'תוכן', about: 'תמונה מצד אחד, ומהצד השני כותרת, טקסט וכפתור.', starter: {
    title: 'הסיפור שלנו', text: 'איך התחלנו, מה אנחנו אוהבים לעשות, ולמה כדאי לבחור בנו.', buttonLabel: 'לכל המוצרים', buttonHref: '/collections/all', imageSide: 'start' } },
  { type: 'steps', category: 'תוכן', about: 'שלבים ממוספרים — איך מזמינים, איך מגיעים, מה קורה אחר כך.', starter: {
    title: 'איך זה עובד', items: [
      { title: 'בוחרים', text: 'מסתכלים באתר ובוחרים מה מתאים לכם.' },
      { title: 'מזמינים', text: 'משלמים באתר בתשלום מאובטח, או שואלים אותנו קודם בוואטסאפ.' },
      { title: 'מקבלים', text: 'אנחנו מכינים ושולחים — ומעדכנים אתכם בדרך.' },
    ] } },
  { type: 'faq', category: 'תוכן', about: 'שאלות ותשובות שנפתחות בלחיצה.', starter: {
    title: 'שאלות נפוצות', items: [
      { q: 'תוך כמה זמן מגיע משלוח?', a: 'כתבו כאן כמה ימי עסקים לוקח משלוח, ולאן אתם שולחים.' },
      { q: 'אפשר להחליף או להחזיר?', a: 'כתבו כאן בקצרה, והפנו למדיניות ההחזרות של האתר.' },
      { q: 'איך משלמים?', a: 'כתבו כאן אילו אמצעי תשלום יש באתר.' },
    ] } },
  { type: 'gallery', category: 'מדיה', about: 'תמונות עם כיתוב — לפני ואחרי, אינסטגרם, לוקבוק.', starter: {
    title: 'מהאינסטגרם שלנו', text: 'רגעים מהעסק ומהלקוחות.', buttonLabel: '', buttonHref: '', items: [] } },
  { type: 'products', category: 'מסחר', about: 'מוצרים מהחנות — החדשים, או מקולקציה שתבחרו.', starter: {
    title: 'החדשים באתר', collection: '', limit: 8, buttonLabel: 'לכל המוצרים' } },
  { type: 'collections', category: 'מסחר', about: 'סוגי המוצרים שלכם, עם תמונה לכל אחד.', starter: { title: 'מה יש אצלנו', subtitle: '' } },
  { type: 'contact', category: 'יצירת קשר', about: 'וואטסאפ, טלפון, כתובת ושעות — מפרטי העסק.', starter: {
    title: 'דברו איתנו', text: 'שאלה על מוצר, הזמנה או משלוח — אנחנו כאן.' } },
];
