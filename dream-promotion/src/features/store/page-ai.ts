/**
 * ✨ AI for the site's pages and policies (2.59). The AI drafts; the owner reads, takes it into the editor, and saves — nothing
 * is saved or published by the AI. A policy keeps NEEDS_LEGAL_VERIFICATION: a "[לבדוק עם עורך דין …]" line stays in it (so it
 * cannot be published before someone removes it), and "קראתי ואני מאשר/ת" is still asked on publishing.
 *
 * The law a policy follows is the store's country (stores.country). For Israel the rules below were checked on 6.10.2026:
 *   - Consumer Protection Law 1981, §14C + Cancellation of Transaction Regulations 2010 — a distance sale: 14 days from
 *     receiving the product or the transaction document (the later); a fee of at most 5% of the price or ₪100 (the lower);
 *     the money back within 14 days of the notice; 4 months for a person with a disability, a senior citizen or a new
 *     immigrant when the sale included a conversation; not for perishables, goods made to the customer's specification,
 *     or copiable goods whose package was opened; a defect / late delivery — no fee, the business collects the product.
 *   - Privacy Protection Law 1981, Amendment 13 (in force August 2025) — what is collected, for what, who receives it, the
 *     right to see and correct the information, how to contact the business.
 *   - Equal Rights for Persons with Disabilities (Service Accessibility) Regulations 2013 + Israeli Standard 5568 (WCAG) — an
 *     accessibility statement: what was made accessible, and an accessibility contact (name, phone, email).
 * Anything only the business knows (delivery times, the accessibility contact's name) stays in [brackets] with a suggestion.
 */
import type { PolicyKind } from './store';
import { STORE_LIMITS } from './store';

export interface PageFacts {
  kind: 'page' | 'policy'; policy: PolicyKind | null; title: string; current: string;
  store: { name: string; legalName: string; number: string; numberKind: 'company' | 'dealer'; address: string; phone: string; email: string;
    whatsapp: string; country: string; description: string };
  selling: { checkout: boolean; delivery: boolean; deliveryPrice: number; freeDeliveryOver: number | null; deliveryNote: string;
    pickup: boolean; pickupNote: string };
  /** Google Analytics is on (the cookie window asks first) */
  analytics: boolean;
}

const IL: Record<PolicyKind, string[]> = {
  returns: [
    'לפי חוק הגנת הצרכן, התשמ"א-1981 (סעיף 14ג) ותקנות הגנת הצרכן (ביטול עסקה), התשע"א-2010.',
    'עסקת מכר מרחוק: אפשר לבטל מיום העסקה ועד 14 ימים מיום קבלת המוצר או מסמך פרטי העסקה — המאוחר מביניהם.',
    'דמי ביטול: לכל היותר 5% ממחיר העסקה או 100 ₪ — הנמוך מביניהם.',
    'העסק מחזיר את הכסף תוך 14 ימים מקבלת הודעת הביטול, והלקוח מחזיר את המוצר.',
    'אדם עם מוגבלות, אזרח ותיק או עולה חדש: עד 4 חודשים, אם העסקה כללה שיחה בין העסק ללקוח (גם שיחה אלקטרונית).',
    'החריגים: מוצרים פסידים (כמו מזון), מוצרים שיוצרו במיוחד לפי דרישת הלקוח, ומוצרים שניתן להעתיק שאריזתם נפתחה.',
    'ביטול בגלל פגם, אי-התאמה או איחור באספקה: בלי דמי ביטול, והעסק אוסף את המוצר.',
    'ביטול אפשרי באותה דרך שבה נעשתה העסקה — באתר יש עמוד "ביטול עסקה" (/cancel), ובנוסף בטלפון או במייל.',
  ],
  privacy: [
    'לפי חוק הגנת הפרטיות, התשמ"א-1981, כולל תיקון 13 (בתוקף מאוגוסט 2025).',
    'לפרט: איזה מידע נאסף, למה, האם חובה למסור אותו, למי הוא מועבר (למשל: חברת הסליקה, חברת המשלוחים, שירות המייל), כמה זמן נשמר.',
    'זכות לעיין במידע ולבקש לתקן או למחוק אותו — ואיך פונים.',
    'מידע לתשלום (כרטיס אשראי) נמסר ישירות לחברת הסליקה ולא נשמר אצל העסק.',
    'דיוור ופרסום — רק למי שהסכים, עם אפשרות להסיר בכל עת.',
  ],
  accessibility: [
    'לפי חוק שוויון זכויות לאנשים עם מוגבלות, התשנ"ח-1998, ותקנות נגישות השירות, התשע"ג-2013; התקן: ת"י 5568 (מבוסס WCAG).',
    'לתאר מה נעשה באתר: מבנה כותרות ברור, ניווט במקלדת, טקסט חלופי לתמונות, ניגודיות צבעים, התאמה לטלפון.',
    'פרטי רכז/ת נגישות: שם, טלפון ומייל — השם בסוגריים אם אינו ידוע.',
    'אסור לכתוב "האתר נגיש", "עומד בתקן" או "מונגש במלואו" — רק מה שנעשה, ושאפשר לפנות.',
    'תאריך עדכון ההצהרה בסוגריים.',
  ],
  shipping: [
    'אזורי משלוח, זמני אספקה ומחיר — לפי הנתונים של העסק למטה; מה שלא ידוע — בסוגריים עם הצעה.',
    'לפי חוק הגנת הצרכן: מועד האספקה שהובטח מחייב; איחור מאפשר ביטול בלי דמי ביטול.',
  ],
  terms: [
    'תנאי שימוש באתר: מי מפעיל את האתר (השם החוקי והמספר), הזמנה ותשלום, מחירים כוללים מע"מ, זמינות מלאי, קניין רוחני בתוכן האתר, הגבלת אחריות סבירה, הדין החל (ישראל) ומקום השיפוט.',
    'לא לכתוב סעיף שמוותר על זכויות הצרכן לפי החוק — סעיף כזה בטל.',
    'הפניה לעמודי "ביטולים והחזרות" ו"מדיניות פרטיות".',
  ],
};

/** the rules the AI writes by: Israel's in full; elsewhere the country's consumer law, everything legal in brackets */
export function legalFacts(country: string, policy: PolicyKind): string[] {
  if ((country || 'IL').toUpperCase() === 'IL') return IL[policy];
  return [`החוק החל: חוקי הצרכנות והפרטיות של המדינה ${country.toUpperCase()} — לכתוב לפי מה שידוע עליהם, וכל מועד, סכום או חובה בסוגריים [לבדוק לפי החוק המקומי].`];
}

/** words a draft may never say (it would be a claim nobody checked) */
const CLAIMS = [/האתר נגיש/, /עומד(ת|ים)? ב(תקן|דרישות|כל)/, /מונגש במלואו/, /מאושר(ת)? (ע["״]י|על ידי)/, /אושר(ה)? (ע["״]י|על ידי)/, /בדיקה משפטית/];
export const copyClaims = (text: string) => CLAIMS.filter((r) => r.test(text)).map((r) => r.source);

export const LEGAL_CHECK = '[לבדוק עם עורך דין לפני הפרסום — ואחרי הבדיקה למחוק את השורה הזו.]';
export interface PageCopy { title: string; body: string; seoTitle: string; seoDescription: string }

/**
 * The AI's answer as the editor's text: no HTML (the storefront's RichText takes "## ", "- " and empty lines), within the
 * limits, nothing it may not claim — and a policy always ends with the lawyer line. Null when unusable.
 */
export function cleanPageCopy(raw: unknown, kind: 'page' | 'policy'): PageCopy | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const line = (v: unknown, max: number) => (typeof v === 'string' ? v : '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  let body = (typeof r.body === 'string' ? r.body : '')
    .replace(/<[^>]*>/g, '').replace(/\r/g, '').replace(/\*\*|__/g, '').replace(/^#{1}\s+/gm, '## ').replace(/^#{3,}\s+/gm, '## ')
    .replace(/^[*•]\s+/gm, '- ').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!body || copyClaims(body).length) return null;
  if (kind === 'policy' && !body.includes('[לבדוק עם עורך דין')) body = `${body}\n\n${LEGAL_CHECK}`;
  body = body.slice(0, STORE_LIMITS.pageBody);
  return { title: line(r.title, STORE_LIMITS.pageTitle), body, seoTitle: line(r.seoTitle, 60), seoDescription: line(r.seoDescription, 160) };
}

/** the editor writes by itself (default): an empty page, or one still holding a "[…]" to fill — never over the owner's own text */
export const wantsAutoFill = (body: string) => !body.trim() || /\[[^\]\n]{2,}\]/.test(body);

/** what the AI is told about the business — the store's own details, never orders, customers or money */
export function factsText(f: PageFacts): string {
  const s = f.store, sel = f.selling;
  const money = (n: number) => `${n.toLocaleString('he-IL')} ₪`;
  return [
    `שם החנות: ${s.name}`,
    s.legalName && `השם החוקי: ${s.legalName}`,
    s.number && `${s.numberKind === 'company' ? 'ח.פ.' : 'ע.מ.'}: ${s.number}`,
    s.address && `כתובת: ${s.address}`, s.phone && `טלפון: ${s.phone}`, s.email && `מייל: ${s.email}`, s.whatsapp && 'יש וואטסאפ',
    s.description && `על העסק: ${s.description}`,
    `מכירה באתר: ${sel.checkout ? 'כן — תשלום באתר' : 'עוד לא (הזמנות בפנייה)'}`,
    sel.delivery ? `משלוח: ${sel.deliveryPrice ? money(sel.deliveryPrice) : 'חינם'}${sel.freeDeliveryOver ? `, חינם מעל ${money(sel.freeDeliveryOver)}` : ''}${sel.deliveryNote ? ` (${sel.deliveryNote})` : ''}` : 'משלוח: לא הוגדר',
    sel.pickup ? `איסוף עצמי: כן${sel.pickupNote ? ` — ${sel.pickupNote}` : ''}` : 'איסוף עצמי: לא',
    `מדידה באתר: ${f.analytics ? 'Google Analytics, רק אחרי הסכמה בחלונית העוגיות' : 'אין'}`,
  ].filter(Boolean).join('\n');
}

// ---- short texts people leave empty: a category's description, the store's one sentence ----------------------------------------
export type ShortField = 'collection' | 'store';
export interface ShortAsk { field: ShortField; title: string; tags: string[]; current: string }
export interface ShortCopy { text: string; seoTitle: string; seoDescription: string }
export const SHORT_MAX: Record<ShortField, number> = { collection: 600, store: 320 };

/** the AI's short text: one plain paragraph (the store's sentence: one line), no claim nobody checked — or null */
export function cleanShortCopy(raw: unknown, field: ShortField): ShortCopy | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const line = (v: unknown, max: number) => (typeof v === 'string' ? v : '').replace(/<[^>]*>/g, '').replace(/\*\*|__|^#+\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, max);
  const text = line(r.text, SHORT_MAX[field]);
  if (!text || copyClaims(text).length) return null;
  return { text, seoTitle: field === 'collection' ? line(r.seoTitle, 60) : '', seoDescription: field === 'collection' ? line(r.seoDescription, 160) : '' };
}
/** the AI writes by itself when the field is empty and there is something to write from (a category's name) */
export const wantsShortFill = (a: Pick<ShortAsk, 'field' | 'title' | 'current'>) => !a.current.trim() && (a.field === 'store' || Boolean(a.title.trim()));
