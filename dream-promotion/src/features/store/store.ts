/**
 * The store's rules in the dashboard (Dream Commerce stage 2, 2.55) — pure functions, tested directly
 * (tests/store-settings.test.ts). The database holds the same rules (migration 20261005003400); these only give the
 * owner a clear sentence before a save fails.
 */
import { toCheckout, type CheckoutSettings } from './checkout';
import { isSlug, slugify, uniqueSlug } from '@/features/catalog/catalog';

export type StoreStatus = 'draft' | 'published' | 'paused';
export type DomainStatus = 'pending' | 'verifying' | 'active' | 'error';
export type PolicyKind = 'returns' | 'privacy' | 'accessibility' | 'terms' | 'shipping';

export interface StoreRow {
  id: string; businessId: string; name: string; status: StoreStatus; template: string; lang: 'he' | 'en'; logoUrl: string;
  description: string; phone: string; whatsapp: string; email: string; address: string; ga4Id: string; gscCode: string;
  showStockCount: boolean; publishedAt: string | null; updatedAt: string;
  checkout: CheckoutSettings;                 // selling on the site (2.56)
  /** 2.57.1 (migration 3700): the store's own address <slug>.<STORE_ROOT_DOMAIN>, and its password */
  slug: string; storefrontPassword: string; passwordLock: boolean; subdomainSeenAt: string | null;
}
export interface DomainRow {
  id: string; storeId: string; domain: string; isPrimary: boolean; status: DomainStatus; lastSeenAt: string | null;
  lastCheckedAt: string | null; vercel: Record<string, unknown>;
}
export interface ThemeVersion { id: string; version: number; status: 'draft' | 'published' | 'archived'; template: string; settings: Record<string, unknown>; createdAt: string; publishedAt: string | null; note: string }
export interface PageRow { id: string; kind: 'page' | 'policy'; policy: PolicyKind | null; slug: string; title: string; body: string; seoTitle: string; seoDescription: string; published: boolean; updatedAt: string }
export interface MenuLink { label: string; href: string }
export interface CollectionRow {
  id: string; title: string; slug: string; description: string; imageUrl: string; kind: 'manual' | 'auto'; tags: string[];
  sort: 'manual' | 'newest' | 'price_asc' | 'price_desc' | 'name'; publishOnline: boolean; seoTitle: string; seoDescription: string; position: number;
  items: { itemId: string; position: number }[];
}

export const toStore = (r: any): StoreRow => ({
  id: r.id, businessId: r.business_id, name: r.name ?? '', status: r.status ?? 'draft', template: r.template ?? 'bags', lang: r.lang ?? 'he',
  logoUrl: r.logo_url ?? '', description: r.description ?? '', phone: r.phone ?? '', whatsapp: r.whatsapp ?? '', email: r.email ?? '',
  address: r.address ?? '', ga4Id: r.ga4_id ?? '', gscCode: r.gsc_code ?? '', showStockCount: Boolean(r.show_stock_count),
  publishedAt: r.published_at ?? null, updatedAt: r.updated_at ?? '', checkout: toCheckout(r),
  slug: r.slug ?? '', storefrontPassword: r.storefront_password ?? '', passwordLock: Boolean(r.password_lock), subdomainSeenAt: r.subdomain_seen_at ?? null,
});
export const toDomain = (r: any): DomainRow => ({
  id: r.id, storeId: r.store_id, domain: r.domain, isPrimary: Boolean(r.is_primary), status: r.status ?? 'pending',
  lastSeenAt: r.last_seen_at ?? null, lastCheckedAt: r.last_checked_at ?? null, vercel: r.vercel && typeof r.vercel === 'object' ? r.vercel : {},
});
export const toVersion = (r: any): ThemeVersion => ({
  id: r.id, version: Number(r.version), status: r.status, template: r.template, settings: r.settings && typeof r.settings === 'object' ? r.settings : {},
  createdAt: r.created_at, publishedAt: r.published_at ?? null, note: r.note ?? '',
});
export const toPage = (r: any): PageRow => ({
  id: r.id, kind: r.kind, policy: r.policy ?? null, slug: r.slug, title: r.title, body: r.body ?? '', seoTitle: r.seo_title ?? '',
  seoDescription: r.seo_description ?? '', published: Boolean(r.published), updatedAt: r.updated_at ?? '',
});
export const toCollection = (r: any, links: any[] = []): CollectionRow => ({
  id: r.id, title: r.title, slug: r.slug, description: r.description ?? '', imageUrl: r.image_url ?? '', kind: r.kind === 'auto' ? 'auto' : 'manual',
  tags: Array.isArray(r.rules?.tags) ? r.rules.tags.filter((t: unknown) => typeof t === 'string') : [], sort: r.sort ?? 'manual',
  publishOnline: Boolean(r.publish_online), seoTitle: r.seo_title ?? '', seoDescription: r.seo_description ?? '', position: Number(r.position ?? 0),
  items: links.filter((l) => l.collection_id === r.id).map((l) => ({ itemId: l.item_id, position: Number(l.position ?? 0) })).sort((a, b) => a.position - b.position),
});

// ---- the domain ----------------------------------------------------------------------------------------------------------
/** second-level suffixes of Israel: example.co.il is a "bare" domain, like example.com */
const IL_SECOND = new Set(['co.il', 'org.il', 'net.il', 'ac.il', 'gov.il', 'muni.il', 'k12.il', 'idf.il']);
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * What the owner typed → the domain itself: no https://, no path, no port, lower case, a Hebrew name in punycode;
 * "www." is the same store (it is added beside it).
 */
export function normalizeDomain(input: string): { ok: true; domain: string; bare: boolean } | { ok: false; error: string } {
  let s = input.trim().toLowerCase();
  if (!s) return { ok: false, error: 'כתבו את הדומיין, למשל followmecollection.com' };
  s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  if (s.startsWith('www.')) s = s.slice(4);
  try { s = new URL(`http://${s}`).hostname; } catch { return { ok: false, error: 'זה לא נראה כמו דומיין. כתבו רק את השם, למשל followmecollection.com' }; }
  const labels = s.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !/^[a-z]/.test(labels[labels.length - 1]) || s.length > 253) {
    return { ok: false, error: 'זה לא נראה כמו דומיין. כתבו רק את השם, למשל followmecollection.com' };
  }
  if (/^\d+(\.\d+){3}$/.test(s)) return { ok: false, error: 'צריך שם של דומיין, לא כתובת IP.' };
  if (s === 'localhost' || s.endsWith('.vercel.app') || s.endsWith('.supabase.co')) return { ok: false, error: 'זה דומיין של שירות, לא של העסק.' };
  const bare = labels.length === 2 || (labels.length === 3 && IL_SECOND.has(labels.slice(1).join('.')));
  return { ok: true, domain: s, bare };
}

/** the rows of a domain: a bare name is primary and gets www beside it (which sends to it); a subdomain stands alone */
export const domainRows = (d: { domain: string; bare: boolean }) =>
  d.bare ? [{ domain: d.domain, isPrimary: true }, { domain: `www.${d.domain}`, isPrimary: false }] : [{ domain: d.domain, isPrimary: true }];

export const DOMAIN_STATUS: Record<DomainStatus, { label: string; tone: 'default' | 'ok' | 'warn' }> = {
  pending: { label: 'ממתין לחיבור', tone: 'default' },
  verifying: { label: 'ממתין ל-DNS', tone: 'warn' },
  active: { label: 'פעיל', tone: 'ok' },
  error: { label: 'יש בעיה', tone: 'warn' },
};

// ---- contact, Analytics, Search Console ---------------------------------------------------------------------------------
/** a WhatsApp number in the international form wa.me needs: 050-1234567 → 972501234567 */
export function normalizeWhatsapp(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const d = input.replace(/\D/g, '');
  if (!d) return { ok: true, value: '' };
  const v = d.startsWith('00') ? d.slice(2) : d.startsWith('0') ? `972${d.slice(1)}` : d;
  return /^\d{9,15}$/.test(v) ? { ok: true, value: v } : { ok: false, error: 'מספר וואטסאפ לא תקין. למשל 050-1234567' };
}
export const validPhone = (s: string) => s === '' || /^[0-9+() -]{7,20}$/.test(s);
export const validEmail = (s: string) => s === '' || (s.length <= 120 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
/** GA4's Measurement ID: G-XXXXXXX */
export const cleanGa4 = (s: string): string | null => { const v = s.trim().toUpperCase(); return v === '' || /^G-[A-Z0-9]{4,16}$/.test(v) ? v : null; };
/** Search Console's HTML tag, or only its code → the code */
export function cleanGscCode(input: string): string | null {
  const s = input.trim();
  if (!s) return '';
  const m = s.match(/content=["']([^"']+)["']/i);
  const v = (m ? m[1] : s).trim();
  return /^[A-Za-z0-9_-]{10,100}$/.test(v) ? v : null;
}

// ---- links of a menu (the same rule as store_links_ok in the database) -----------------------------------------------------
export function linkOk(l: MenuLink): boolean {
  const label = l.label.trim(), href = l.href.trim();
  if (label.length < 1 || label.length > 40 || href.length < 1 || href.length > 300) return false;
  return /^\/([^/\s<>"'\\][^\s<>"'\\]*)?$/.test(href) || /^https:\/\/[^\s<>"'\\]+$/.test(href);
}

// ---- the checklist before the store goes on the air ---------------------------------------------------------------------
export type Missing = 'legal' | 'contact' | 'returns' | 'privacy' | 'accessibility' | 'domain' | 'product';
export const CHECKLIST: { code: Missing; label: string; fix: string; href: string }[] = [
  { code: 'legal', label: 'פרטי העסק (שם, מספר עוסק / ח.פ., כתובת)', fix: 'משלימים בהגדרות הכספים', href: '/finance/settings' },
  { code: 'contact', label: 'דרך ליצור קשר (טלפון, וואטסאפ או מייל)', fix: 'למטה, בפרטי החנות', href: '/store/settings#contact' },
  { code: 'returns', label: 'מדיניות ביטולים והחזרות', fix: 'כותבים ומפרסמים בעמודים', href: '/store/pages?policy=returns' },
  { code: 'privacy', label: 'מדיניות פרטיות', fix: 'כותבים ומפרסמים בעמודים', href: '/store/pages?policy=privacy' },
  { code: 'accessibility', label: 'הצהרת נגישות', fix: 'כותבים ומפרסמים בעמודים', href: '/store/pages?policy=accessibility' },
  { code: 'domain', label: 'כתובת פעילה (הכתובת של החנות או דומיין משלכם)', fix: 'פותחים את האתר פעם אחת, או מחברים דומיין', href: '/store/settings#address' },
  { code: 'product', label: 'לפחות מוצר אחד באתר', fix: 'מדליקים "באתר" ליד מוצר', href: '/store/products' },
];
/** "store_not_ready: accessibility,domain" (the database's refusal) → the codes */
export const missingFromError = (msg: string): Missing[] =>
  ((msg.match(/store_not_ready:\s*([a-z,]+)/)?.[1] ?? '').split(',').filter(Boolean)) as Missing[];

// ---- policies: a starting text, never "approved" --------------------------------------------------------------------------
export const POLICY_LABEL: Record<PolicyKind, string> = {
  returns: 'ביטולים והחזרות', privacy: 'מדיניות פרטיות', accessibility: 'הצהרת נגישות', terms: 'תנאי שימוש', shipping: 'משלוחים',
};
export const REQUIRED_POLICIES: PolicyKind[] = ['returns', 'privacy', 'accessibility'];

/**
 * A draft to start from — every one of them is NEEDS_LEGAL_VERIFICATION: the business checks it with a lawyer before it
 * goes up (DREAM_COMMERCE_ARCHITECTURE §10). Brackets mark what only the business knows.
 */
export function policyDraft(kind: PolicyKind, b: { name: string; phone?: string; email?: string; address?: string }): { title: string; body: string } {
  const contact = [b.phone && `טלפון: ${b.phone}`, b.email && `מייל: ${b.email}`, b.address && `כתובת: ${b.address}`].filter(Boolean).join('\n') || '[פרטי קשר]';
  switch (kind) {
    case 'returns': return { title: POLICY_LABEL.returns, body: [
      '## ביטול עסקה',
      `אפשר לבטל רכישה מ-${b.name} לפי חוק הגנת הצרכן. [לבדוק עם עורך דין: המועדים, דמי הביטול והחריגים שחלים על המוצרים שלכם — למשל מוצר שהודפס במיוחד בשבילכם.]`,
      '## איך מבטלים',
      `פונים אלינו בכתב או בטלפון, עם מספר ההזמנה:\n${contact}`,
      '## החזר כספי',
      '[מתי ואיך מוחזר הכסף, ומה קורה עם דמי המשלוח.]',
    ].join('\n\n') };
    case 'privacy': return { title: POLICY_LABEL.privacy, body: [
      '## איזה מידע נאסף',
      '[למשל: שם, טלפון, מייל וכתובת למשלוח — רק כשמזמינים או פונים אלינו.]',
      '## למה',
      '[כדי לטפל בהזמנה ובפנייה, ולשלוח עדכונים רק למי שהסכים לקבל אותם.]',
      '## עוגיות ומדידה',
      'האתר מודד שימוש (Google Analytics) רק אחרי שמאשרים זאת בחלונית העוגיות.',
      '## יצירת קשר בענייני פרטיות',
      contact,
      '[לבדוק עם עורך דין: חובות היידוע לפי תיקון 13 לחוק הגנת הפרטיות.]',
    ].join('\n\n') };
    case 'accessibility': return { title: POLICY_LABEL.accessibility, body: [
      '## נגישות באתר',
      `אנחנו ב-${b.name} רוצים שכל אחד יוכל להשתמש באתר. האתר נבנה עם מבנה ברור, ניווט במקלדת, טקסט חלופי לתמונות וניגודיות צבעים.`,
      '## נתקלתם בבעיה?',
      `ספרו לנו ונטפל בה:\n${contact}`,
      '[לבדוק עם מומחה נגישות לפני שמצהירים על עמידה בתקן ישראלי 5568. אסור לכתוב "האתר נגיש" בלי בדיקה כזו.]',
    ].join('\n\n') };
    case 'terms': return { title: POLICY_LABEL.terms, body: '[תנאי השימוש באתר — לנסח עם עורך דין.]' };
    case 'shipping': return { title: POLICY_LABEL.shipping, body: ['## משלוחים', '[אזורים, זמני אספקה ומחיר.]', '## איסוף עצמי', '[אם יש — מאיפה ומתי.]'].join('\n\n') };
  }
}
/** a draft still has a bracket to fill: publishing it as is would show "[…]" to shoppers */
export const hasPlaceholders = (body: string) => /\[[^\]\n]{2,}\]/.test(body);

// ---- collections, pages, menus: the database's limits, said before a save ---------------------------------------------------
export const STORE_LIMITS = {
  collectionTitle: 80, collectionDescription: 2000, pageTitle: 120, pageBody: 30000, seoTitle: 120, seoDescription: 320,
  menuItems: 30, menuLabel: 40, href: 300,
} as const;
export const COLLECTION_SORT: Record<CollectionRow['sort'], string> = {
  manual: 'לפי הסדר שלכם', newest: 'החדשים קודם', price_asc: 'מחיר: מהזול', price_desc: 'מחיר: מהיקר', name: 'לפי השם',
};

/** a new address from a title: free in this list ("שקיות" → "שקיות-2"); "all" is the address of every product */
export function suggestSlug(title: string, taken: Iterable<string>, fallback: string): string {
  return uniqueSlug(slugify(title) || fallback, [...taken, 'all']);
}

/** a collection before a save → the first problem (null = fine) */
export function collectionProblem(c: { title: string; slug: string; description: string; kind: 'manual' | 'auto'; tags: string[]; seoTitle: string; seoDescription: string },
  takenSlugs: Iterable<string>): string | null {
  const title = c.title.trim();
  if (!title) return 'לקולקציה צריך שם.';
  if (title.length > STORE_LIMITS.collectionTitle) return `השם ארוך מדי (עד ${STORE_LIMITS.collectionTitle} תווים).`;
  if (!isSlug(c.slug)) return 'הכתובת יכולה לכלול רק אותיות, ספרות ומקפים (למשל שקיות-נייר).';
  if (c.slug === 'all') return 'הכתובת all שמורה לכל המוצרים. בחרו כתובת אחרת.';
  if (new Set(takenSlugs).has(c.slug)) return 'הכתובת הזו כבר בשימוש. בחרו כתובת אחרת.';
  if (c.description.length > STORE_LIMITS.collectionDescription) return `התיאור ארוך מדי (עד ${STORE_LIMITS.collectionDescription} תווים).`;
  if (c.kind === 'auto' && !c.tags.length) return 'קולקציה אוטומטית צריכה לפחות תגית אחת.';
  return seoProblem(c.seoTitle, c.seoDescription);
}

/** a page (or a policy) before a save → the first problem (null = fine); publishing a policy with "[…]" left is refused */
export function pageProblem(p: { kind: 'page' | 'policy'; title: string; slug: string; body: string; seoTitle: string; seoDescription: string; published: boolean },
  takenSlugs: Iterable<string>): string | null {
  const title = p.title.trim();
  if (!title) return 'לעמוד צריך כותרת.';
  if (title.length > STORE_LIMITS.pageTitle) return `הכותרת ארוכה מדי (עד ${STORE_LIMITS.pageTitle} תווים).`;
  if (!isSlug(p.slug)) return 'הכתובת יכולה לכלול רק אותיות, ספרות ומקפים (למשל אודות).';
  if (new Set(takenSlugs).has(p.slug)) return 'הכתובת הזו כבר בשימוש. בחרו כתובת אחרת.';
  if (p.body.length > STORE_LIMITS.pageBody) return `הטקסט ארוך מדי (עד ${STORE_LIMITS.pageBody.toLocaleString('he-IL')} תווים).`;
  if (p.published && !p.body.trim()) return 'אי אפשר לפרסם עמוד ריק.';
  if (p.published && p.kind === 'policy' && hasPlaceholders(p.body)) return 'בטקסט עוד יש סימונים בסוגריים מרובעים [ … ] שצריך להשלים או למחוק. אחרי זה אפשר לפרסם.';
  return seoProblem(p.seoTitle, p.seoDescription);
}

/**
 * 2.58: a policy goes on the site only after the owner ticks "קראתי ואני מאשר/ת" — it is a starting text, not a legal check
 * (NEEDS_LEGAL_VERIFICATION). Asked when it is about to be published, not on every save of one already on the site.
 */
export const POLICY_ACK = 'קראתי את הנוסח ואני מאשר/ת לפרסם אותו באתר. ידוע לי שזו נקודת התחלה ולא בדיקה משפטית.';
export function policyAckProblem(p: { kind: 'page' | 'policy'; published: boolean }, wasPublished: boolean, acknowledged: boolean): string | null {
  return p.kind === 'policy' && p.published && !wasPublished && !acknowledged ? 'כדי לפרסם מדיניות באתר, סמנו "קראתי ואני מאשר/ת".' : null;
}

function seoProblem(title: string, description: string): string | null {
  if (title.length > STORE_LIMITS.seoTitle) return `הכותרת לגוגל ארוכה מדי (עד ${STORE_LIMITS.seoTitle} תווים).`;
  if (description.length > STORE_LIMITS.seoDescription) return `התיאור לגוגל ארוך מדי (עד ${STORE_LIMITS.seoDescription} תווים).`;
  return null;
}

/** the address of a policy's row (the site shows it at /policies/<kind>) */
export const policySlug = (kind: PolicyKind) => `policy-${kind}`;

/** every tag of the products, once, in Hebrew order */
export const allTags = (items: { tags: string[] }[]) => [...new Set(items.flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b, 'he'));
/** an automatic collection: a product with any of its tags (the same rule as sf_in_collection) */
export const matchesTags = (itemTags: string[], tags: string[]) => itemTags.some((t) => tags.includes(t));

/** where a menu link can lead: the store's own addresses first */
export function linkTargets(collections: Pick<CollectionRow, 'title' | 'slug' | 'publishOnline'>[], pages: Pick<PageRow, 'kind' | 'policy' | 'slug' | 'title' | 'published'>[]):
  { href: string; label: string; note?: string }[] {
  const off = (on: boolean) => (on ? undefined : 'לא באתר');
  return [
    { href: '/', label: 'דף הבית' },
    { href: '/collections/all', label: 'כל המוצרים' },
    { href: '/collections', label: 'כל הקולקציות' },
    { href: '/search', label: 'חיפוש' },
    ...collections.map((c) => ({ href: `/collections/${c.slug}`, label: c.title, note: off(c.publishOnline) })),
    ...pages.filter((g) => g.kind === 'page').map((g) => ({ href: `/pages/${g.slug}`, label: g.title, note: off(g.published) })),
    ...pages.filter((g) => g.kind === 'policy' && g.policy).map((g) => ({ href: `/policies/${g.policy}`, label: g.title, note: off(g.published) })),
  ];
}

/** a menu before a save → the first problem (null = fine) */
export function menuProblem(items: MenuLink[]): string | null {
  if (items.length > STORE_LIMITS.menuItems) return `עד ${STORE_LIMITS.menuItems} קישורים בתפריט.`;
  const i = items.findIndex((l) => !linkOk(l));
  if (i < 0) return null;
  const l = items[i];
  if (!l.label.trim()) return `לקישור ${i + 1} צריך שם.`;
  if (l.label.trim().length > STORE_LIMITS.menuLabel) return `השם של קישור ${i + 1} ארוך מדי (עד ${STORE_LIMITS.menuLabel} תווים).`;
  return `הכתובת של "${l.label.trim()}" לא תקינה: כתובת באתר שמתחילה ב-/ או קישור שמתחיל ב-https://`;
}

// ---- the store's own address and its password (2.57.1) -----------------------------------------------------------------------
/**
 * Names that are never a store's address — the same list as the database's store_slug_reserved() (migration 3700);
 * tests/store-subdomain.test.ts fails when the two differ.
 */
export const RESERVED_SLUGS: readonly string[] = [
  'www', 'app', 'apps', 'admin', 'administrator', 'api', 'mail', 'email', 'smtp', 'imap', 'pop', 'mx', 'ftp', 'ns1', 'ns2', 'dns',
  'shop', 'shops', 'store', 'stores', 'my', 'dashboard', 'login', 'logout', 'signin', 'signup', 'auth', 'account', 'accounts',
  'billing', 'pay', 'payment', 'payments', 'checkout', 'cart', 'orders', 'help', 'support', 'status', 'docs', 'blog', 'news',
  'cdn', 'static', 'assets', 'media', 'img', 'images', 'files', 'download', 'downloads', 'preview', 'staging', 'dev', 'test',
  'beta', 'demo', 'secure', 'security', 'root', 'system', 'internal', 'webmail', 'portal', 'dream', 'platform', 'official',
];
export const slugReserved = (s: string) => s.startsWith('xn--') || RESERVED_SLUGS.includes(s);

/** what the owner typed → an address: lower case, 3–40 of a–z, 0–9 and single hyphens, not reserved */
export function checkSlug(raw: string): { ok: true; slug: string } | { ok: false; error: string } {
  const s = raw.trim().toLowerCase();
  if (s.length < 3 || s.length > 40) return { ok: false, error: 'הכתובת צריכה 3 עד 40 תווים.' };
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)) return { ok: false, error: 'רק אותיות באנגלית, ספרות ומקף אחד בין מילים (למשל flowers-tlv).' };
  if (slugReserved(s)) return { ok: false, error: 'השם הזה שמור למערכת. בחרו שם אחר.' };
  return { ok: true, slug: s };
}
export const SLUG_ERROR: Record<'invalid' | 'reserved' | 'taken', string> = {
  invalid: 'הכתובת לא תקינה: רק אותיות באנגלית, ספרות ומקף.', reserved: 'השם הזה שמור למערכת. בחרו שם אחר.', taken: 'הכתובת הזו כבר של חנות אחרת.',
};

/** the store's password: 4–40 characters, or empty (then a store before publishing is closed to everyone but the preview link) */
export function checkPassword(raw: string): { ok: true; password: string } | { ok: false; error: string } {
  const p = raw.trim();
  if (p && (p.length < 4 || p.length > 40)) return { ok: false, error: 'סיסמה של 4 עד 40 תווים (או ריקה).' };
  return { ok: true, password: p };
}
/** a new password: 10 letters and digits, no look-alikes (0/o, 1/l) */
export function newPassword(random: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from({ length: 10 }, () => abc[random(abc.length)]).join('');
}

/** the root of the stores' addresses (STORE_ROOT_DOMAIN), clean, or '' */
export const cleanRoot = (raw: string | undefined) => {
  const r = (raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(r) ? r : '';
};
/**
 * where the store lives now: its own domain once that works; else its subdomain (when the root is set); else, with no
 * domain at all, the storefront's own address + /s/<slug> (2.57.2, STOREFRONT_URL); else nowhere yet
 */
export function storeAddress(store: Pick<StoreRow, 'slug'>, domains: Pick<DomainRow, 'domain' | 'isPrimary' | 'status'>[], root: string,
  storefrontUrl = ''): { url: string; kind: 'domain' | 'subdomain' | 'platform' } | null {
  const own = domains.find((d) => d.isPrimary && d.status === 'active');
  if (own) return { url: `https://${own.domain}`, kind: 'domain' };
  if (root && store.slug) return { url: `https://${store.slug}.${root}`, kind: 'subdomain' };
  const base = cleanPlatformUrl(storefrontUrl);
  if (base && store.slug) return { url: `${base}/s/${store.slug}`, kind: 'platform' };
  return null;
}
/** STOREFRONT_URL → https://… without a trailing slash, or '' */
export const cleanPlatformUrl = (raw: string | undefined) => {
  const u = (raw ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u) ? u : '';
};

/** what a visitor sees now: draft (closed), password, live — the same rule as the database's store_access() */
export type Visibility = 'draft' | 'paused' | 'password' | 'live';
export function storeVisibility(s: Pick<StoreRow, 'status' | 'storefrontPassword' | 'passwordLock'>): Visibility {
  if (s.status === 'published' && !s.passwordLock) return 'live';
  if (s.storefrontPassword) return 'password';
  return s.status === 'paused' ? 'paused' : 'draft';
}
export const VISIBILITY: Record<Visibility, { label: string; tone: 'ok' | 'warn' | 'default'; text: string }> = {
  live: { label: 'באוויר', tone: 'ok', text: 'כל אחד רואה את האתר, וגוגל יכול לאנדקס אותו.' },
  password: { label: 'מוגן בסיסמה', tone: 'warn', text: 'רק מי שיש לו את הקישור והסיסמה נכנס. כל השאר רואים "בקרוב", וגוגל לא מאנדקס.' },
  draft: { label: 'טיוטה', tone: 'default', text: 'בלי סיסמה: רק קישור התצוגה המקדימה פותח את האתר.' },
  paused: { label: 'מושהה', tone: 'default', text: 'הלקוחות רואים "בקרוב".' },
};
/** "העתק קישור + סיסמה": what the owner pastes to whoever should see the store */
export const shareText = (url: string, password: string, name: string) =>
  password ? `${name}\n${url}\nסיסמה: ${password}` : `${name}\n${url}`;
