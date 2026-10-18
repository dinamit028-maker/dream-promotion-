/**
 * The automatic accessibility statement (2.104). The site shows it at /policies/accessibility until the business publishes its
 * own, and the dashboard opens the statement's editor with it ("עמודים" ← "הצהרת נגישות"). It says only what is true of every
 * site: its accessibility menu (when the store has it on) and how to reach the business — never "האתר נגיש", "עומד בתקן" or
 * anything that was not checked.
 * Two identical copies: storefront/src/lib/a11y-statement.ts and src/features/store/a11y-statement.ts (store-a11y.test.ts).
 */

/** when this text last changed (shown as the statement's date) */
export const A11Y_STATEMENT_DATE = '2026-10-17';

/** what the accessibility menu offers — the same order as the menu */
export const A11Y_MENU_OPTIONS: readonly string[] = [
  'הגדלת טקסט (שלוש רמות)', 'ניגודיות גבוהה', 'הדגשת קישורים', 'פונט קריא', 'עצירת אנימציות', 'ריווח שורות מוגדל',
];

const digits = (s: string) => s.replace(/\D/g, '');
/** a phone, a number or an address as its own left-to-right run (LRI … PDI): a leading "+" in a right-to-left line stays first */
const ltr = (s: string) => `\u2066${s}\u2069`;
/** 050-1234567, 0501234567 and 972501234567 are one number */
function sameNumber(a: string, b: string): boolean {
  const x = digits(a);
  const y = digits(b);
  return x.length >= 9 && y.length >= 9 && x.slice(-9) === y.slice(-9);
}

export interface StatementFacts { name: string; phone: string; whatsapp: string; email: string; widget: boolean }

export function a11yStatement(f: StatementFacts): string {
  const phone = f.phone.trim();
  const wa = digits(f.whatsapp);
  const email = f.email.trim();
  const together = Boolean(phone && wa && sameNumber(phone, wa));
  const contact = [
    phone && (together ? `טלפון / וואטסאפ: ${ltr(phone)}` : `טלפון: ${ltr(phone)}`),
    wa && !together && `וואטסאפ: ${ltr(`+${wa}`)}`,
    email && `מייל: ${ltr(email)}`,
  ].filter(Boolean);
  const ask = 'אם משהו באתר לא נוח או לא נגיש לכם — ספרו לנו, ונשמח לעזור';
  return [
    '## נגישות באתר',
    `ב-${f.name.trim()} אנחנו רוצים שכל אחד ואחת יוכלו להשתמש באתר, כולל אנשים עם מוגבלות.`,
    ...(f.widget ? [
      '## תפריט הנגישות',
      'בפינה השמאלית התחתונה של כל עמוד יש כפתור נגישות. אפשר לבחור בו:',
      A11Y_MENU_OPTIONS.map((o) => `- ${o}`).join('\n'),
      'הבחירה נשמרת רק בדפדפן שלכם, ואפשר לבטל אותה בכל רגע ב"איפוס הכול".',
    ] : []),
    '## נתקלתם בבעיה?',
    contact.length ? `${ask}:\n${contact.join('\n')}` : `${ask}.`,
  ].join('\n\n');
}
