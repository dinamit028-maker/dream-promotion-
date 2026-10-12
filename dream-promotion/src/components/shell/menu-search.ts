import type { ComponentType } from 'react';
import { NAV, NAV_ADMIN, NAV_BOTTOM_ALL, NAV_STOCK } from './app-nav';
import type { ModuleGroup } from './module-nav';
import { FINANCE_MODULE, financeGroups } from '@/features/finance/module';
import { STORE_MODULE } from '@/features/store/module';

/**
 * The search in the menu (2.96, docs/FINANCE_ADDITIONS_HE.md T11): every screen of Dream the person may open — the app's menu, the
 * modules' menus (כספים, חנות) and a few screens inside them (a report of its own) — with the words people use for it ("גבייה" →
 * חייבים). Pure: the shells hand it what the person sees now, and it ranks what was typed. Hebrew is read loosely: no points, no
 * geresh or gershayim (מעמ = מע״מ, רוח = רו״ח), final letters as any letter (חשבון… finds חשבונית).
 */
export interface MenuEntry {
  href: string; label: string;
  /** where it is: '' — the app's own menu; 'כספים' / 'חנות' — a module */
  where: string;
  keywords: string[];
  Icon?: ComponentType<any>;
}

/** the words people use for a screen (by its address) — besides its name */
export const KEYWORDS: Record<string, string[]> = {
  '/dashboard': ['ראשי', 'דף הבית', 'מועדפים'],
  '/create': ['פוסט', 'תוכן חדש', 'כתיבה', 'AI'],
  '/reels': ['ריל', 'וידאו', 'סרטון'],
  '/content': ['פוסטים', 'פרסומים'],
  '/calendar': ['לוח תוכן', 'תכנון', 'פרסום מתוזמן'],
  '/media': ['תמונות', 'סרטונים', 'קבצים'],
  '/strategy': ['תוכנית שיווק', 'מטרות'],
  '/ads': ['מודעות', 'פרסום ממומן', 'פייסבוק', 'אינסטגרם'],
  '/leads': ['CRM', 'אנשי קשר', 'לידים', 'כרטיס לקוח'],
  '/appointments': ['תור', 'זימון', 'הזמנת תור', 'יומן תורים'],
  '/declarations': ['הצהרה', 'טופס', 'חתימה'],
  '/register': ['מכירה', 'POS', 'סגירת יום', 'עסקה'],
  '/stock': ['העברה בין סניפים', 'ספירת מלאי', 'מחסן'],
  '/finance': ['חשבונות', 'כסף', 'הנהלת חשבונות', 'לובי'],
  '/store/products': ['אתר', 'חנות אונליין', 'קטלוג', 'מוצר'],
  '/attendance': ['שעון נוכחות', 'משמרות', 'עובדים'],
  '/analytics': ['סטטיסטיקה', 'תוצאות', 'נתונים'],
  '/integrations': ['פייסבוק', 'אינסטגרם', 'טיקטוק', 'גוגל'],
  '/settings': ['פרטי העסק', 'חשבון'],
  '/admin': ['מנהל מערכת', 'עסקים'],
  // כספים
  '/finance/documents': ['חשבונית', 'חשבונית מס', 'קבלה', 'זיכוי', 'חשבונית עסקה', 'הזמנה', 'תעודת משלוח'],
  '/finance/income': ['תקבולים', 'תשלומים', 'יומן תשלומים', 'כסף שנכנס'],
  '/finance/receivables': ['גבייה', 'חובות', 'חוב', 'יתרות', 'גיול', 'תזכורת תשלום', 'איחור', 'פריסה לתשלומים'],
  '/finance/quotes': ['הצעה'],
  '/finance/packages': ['סדרה', 'סדרת טיפולים', 'כרטיסייה', 'מנוי'],
  '/finance/recurring': ['הוראת קבע', 'ריטיינר', 'מנוי חודשי', 'חיוב חודשי'],
  '/finance/expenses': ['ספק', 'ספקים', 'חשבונית ספק', 'קבלה מספק', 'סריקה'],
  '/finance/cash': ['הפקדה', 'צ׳ק', 'צ׳קים', 'מזומן', 'קופה'],
  '/finance/bank': ['בנק', 'דף בנק', 'תנועות בנק', 'התאמה'],
  '/finance/reports': ['רווח והפסד', 'מע״מ', 'דוח מע״מ', 'דוח', 'סיכום תקופה'],
  '/finance/accountant': ['רו״ח', 'ממשק פתוח', 'מבנה אחיד', 'סגירת ספרים', 'נעילת תקופה', 'יומן ביקורת', 'חבילה לרואה חשבון'],
  '/finance/journal': ['פקודה ידנית', 'פקודת יומן', 'תיקון', 'הפרשה', 'העברה בין סיווגים'],
  '/finance/settings': ['פרטי בנק', 'מספר הקצאה', 'רשות המסים', 'מקדמות', 'תנאי תשלום'],
  // חנות
  '/store/collections': ['קטגוריות'],
  '/store/design': ['ערכה', 'תבנית', 'צבעים'],
  '/store/pages': ['מדיניות', 'אודות', 'תקנון'],
  '/store/navigation': ['תפריט האתר'],
  '/store/orders': ['הזמנה מהאתר', 'משלוחים'],
  '/store/selling': ['סליקה', 'מסוף', 'תשלום באתר', 'משלוח'],
  '/store/coupons': ['הנחה', 'קוד הנחה'],
  '/store/settings': ['דומיין', 'כתובת האתר', 'סיסמה'],
};

/** screens inside a screen: a report of its own (2.94), the lead departments (2.99) — found by the search, not in the menu */
export const DEEP_LINKS: MenuEntry[] = [
  { href: '/finance/reports?view=customers', label: 'הכנסות לפי לקוח', where: 'כספים › דוחות', keywords: ['לקוחות', 'הכנסה'] },
  { href: '/finance/reports?view=items', label: 'מכירות לפי פריט וטיפול', where: 'כספים › דוחות', keywords: ['פריטים', 'מוצרים', 'שירותים', 'סוג טיפול'] },
  { href: '/finance/reports?view=cledger', label: 'כרטסת לקוח', where: 'כספים › דוחות', keywords: ['כרטסת', 'תנועות לקוח', 'יתרת לקוח'] },
  { href: '/finance/reports?view=suppliers', label: 'ספקים והוצאות', where: 'כספים › דוחות', keywords: ['ספק', 'שולם', 'לתשלום'] },
  { href: '/finance/reports?view=sledger', label: 'כרטסת ספק', where: 'כספים › דוחות', keywords: ['כרטסת', 'תנועות ספק'] },
  { href: '/finance/reports?view=withholding', label: 'ניכוי במקור', where: 'כספים › דוחות', keywords: ['ניכוי', 'מס במקור', 'אישור ניכוי'] },
  { href: '/finance/reports?view=advances', label: 'מקדמות מס הכנסה', where: 'כספים › דוחות', keywords: ['מקדמות', 'מס הכנסה'] },
  // 2.99: the lead departments, inside לקוחות
  { href: '/leads/departments', label: 'מחלקות לידים', where: 'לקוחות', keywords: ['מחלקה', 'אחראי', 'צוות', 'וואטסאפ', 'ניתוב לידים', 'הלידים שלי'] },
];

const entry = (href: string, label: string, where: string, Icon?: ComponentType<any>): MenuEntry => ({ href, label, where, keywords: KEYWORDS[href.split('?')[0]] ?? [], Icon });
/** a module's menu as entries: each link, under the module's name */
export function moduleEntries(name: string, groups: ModuleGroup[]): MenuEntry[] {
  return groups.flatMap((g) => g.links.map((l) => entry(l.href, g.links.length === 1 ? g.label : l.label, name, l.Icon)));
}
/**
 * every screen the person may open from the app's menu: the app's own (מלאי only with several locations, ניהול only for the
 * system's admins), the modules' (כספים — with what this business turned on, when known; חנות), and the reports inside כספים
 */
export function appEntries(o: { multi?: boolean; admin?: boolean; cash?: boolean; journal?: boolean } = {}): MenuEntry[] {
  const own = [...NAV.flatMap((n) => (n.href === '/register' && o.multi ? [n, NAV_STOCK] : [n])), ...NAV_BOTTOM_ALL, ...(o.admin ? [NAV_ADMIN] : [])]
    .map((n) => entry(n.href, n.label, '', n.Icon));
  return dedupe([...own, ...moduleEntries(FINANCE_MODULE.name, financeGroups({ cash: Boolean(o.cash), journal: Boolean(o.journal) })),
    ...moduleEntries(STORE_MODULE.name, STORE_MODULE.groups), ...DEEP_LINKS]);
}
/** one entry per address — the first wins (a module's own menu before the app's) */
export function dedupe(list: MenuEntry[]): MenuEntry[] {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.href) ? false : (seen.add(e.href), true)));
}

const FINALS: Record<string, string> = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
/** Hebrew read loosely: lower case, no points, no geresh / gershayim / quotes, final letters as any letter, words by spaces */
export const normalizeHe = (s: string) => s.toLowerCase()
  .replace(/[֑-ׇ]/g, '')
  .replace(/["'`׳״]/g, '')
  .replace(/[ךםןףץ]/g, (c) => FINALS[c])
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

/**
 * what was typed → the screens, best first: every word must be in the name, the words of the screen or where it is. A word of
 * the name counts more than a word people use for the screen ("חשבון" → רואה חשבון before הגדרות), and that more than where it is
 */
export function searchMenu(entries: MenuEntry[], query: string, limit = 8): MenuEntry[] {
  const q = normalizeHe(query);
  if (!q) return [];
  const tokens = q.split(' ');
  const hits: { e: MenuEntry; i: number; score: number }[] = [];
  entries.forEach((e, i) => {
    const label = normalizeHe(e.label);
    const labelWords = label.split(' ');
    const keys = e.keywords.map(normalizeHe);
    const keyWords = keys.flatMap((k) => k.split(' '));
    const whereWords = normalizeHe(e.where).split(' ');
    let score = label === q ? 100 : label.startsWith(q) ? 60 : 0;
    if (keys.includes(q)) score += 15;
    for (const t of tokens) {
      const s = labelWords.some((w) => w.startsWith(t)) ? 40 : keyWords.some((w) => w.startsWith(t)) ? 20 : whereWords.some((w) => w.startsWith(t)) ? 10
        : t.length >= 2 && (label.includes(t) || keys.some((k) => k.includes(t))) ? 5 : 0;
      if (!s) return;
      score += s;
    }
    hits.push({ e, i, score });
  });
  hits.sort((a, b) => b.score - a.score || a.e.label.length - b.e.label.length || a.i - b.i);
  return dedupe(hits.map((h) => h.e)).slice(0, limit);
}
