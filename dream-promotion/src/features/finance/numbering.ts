import type { BranchInfo } from '@/features/documents/openformat';

/**
 * 2.120 — numbering per location (migration 20261127007000; docs/ita-registration/CPA_ANSWERS_HE.md, the accountant's answer 5:
 * "סדרת מספור לכל סניף"; the owner's decisions of 26.11.2026). Pure functions: the database decides (document_numbering_state,
 * document_numbering_per_location, location_branch_code_set and the numbering trigger) — the screen only asks what to show.
 *   * the switch is one-way and the owner's only (location_owner()), for a business with more than one active location;
 *   * from then on every location numbers its own series: its two-digit branch code ('01'–'99') and then six digits, shown with
 *     eight digits (01000001 — docNumberLabel / seriesNumber); a credit invoice / refund receipt goes to the series of the location
 *     that issues it; every document issued before keeps its number;
 *   * a location's code may be changed only until its first document of its series (codeFixed).
 */
export interface NumberingSeries { docType: number; count: number; last: string; next: string }
export interface NumberingLocation { id: string; name: string; active: boolean; branchCode: string | null; codeFixed: boolean; series: NumberingSeries[] }
export interface NumberingState {
  perLocation: boolean; since: string | null; activeLocations: number;
  /** the business's one series: the last number of each type */
  business: Record<string, number>;
  locations: NumberingLocation[];
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** document_numbering_state()'s answer → the screen's (anything that is not one → null: the card is not shown) */
export function toNumberingState(j: any): NumberingState | null {
  if (!j || typeof j !== 'object' || !Array.isArray(j.locations)) return null;
  const business: Record<string, number> = {};
  for (const [k, v] of Object.entries(j.business && typeof j.business === 'object' ? j.business : {})) if (Number.isFinite(Number(v))) business[k] = Number(v);
  return {
    perLocation: j.perLocation === true, since: str(j.since) || null, activeLocations: Number(j.activeLocations) || 0, business,
    locations: j.locations.map((l: any) => ({
      id: str(l?.id), name: str(l?.name), active: l?.active !== false, branchCode: /^\d{2}$/.test(str(l?.branchCode)) ? str(l.branchCode) : null,
      codeFixed: l?.codeFixed === true,
      series: (Array.isArray(l?.series) ? l.series : []).map((x: any) => ({ docType: Number(x?.docType), count: Number(x?.count) || 0, last: str(x?.last), next: str(x?.next) })),
    })),
  };
}

/**
 * Who sees the numbering card (CLAUDE.md, locations: a business with one active location sees nothing of locations — showSwitch):
 * the owner only (location_state().owner — the same as location_owner() in the database), with more than one active location,
 * and only once migration 7000 is in the database (the state answered).
 */
export const showNumbering = (o: { owner: boolean; multi: boolean; state: NumberingState | null }) => Boolean(o.owner && o.multi && o.state);
/** the switch itself: only before the business switched (one-way) */
export const canSwitch = (s: NumberingState | null) => Boolean(s && !s.perLocation && s.activeLocations > 1);

/** a code as typed → as the database keeps it: '1' → '01'; anything else as is (trimmed) */
export const normalizeCode = (v: string) => { const c = v.trim(); return /^[1-9]$/.test(c) ? `0${c}` : c; };
/** what location_branch_code_set would refuse (branch_code_format / branch_code_taken) — Hebrew, '' when fine */
export function branchCodeProblem(code: string, others: (string | null)[]): string {
  const c = normalizeCode(code);
  if (!/^(0[1-9]|[1-9][0-9])$/.test(c)) return NUMBERING_HE.branch_code_format;
  if (others.includes(c)) return NUMBERING_HE.branch_code_taken;
  return '';
}

/** the database's refusals of migration 7000, in Hebrew (financeError reads them too) */
export const NUMBERING_HE = {
  numbering_one_location: 'מספור לפי סניף — רק לעסק עם יותר מסניף פעיל אחד.',
  numbering_long_series: 'לעסק כבר יש מסמך עם מספר של 7 ספרות — מספור לפי סניף מתחיל ב-01000001, ולכן אי אפשר לעבור אליו. פנו לתמיכה.',
  branch_code_format: 'קוד סניף — שתי ספרות, מ-01 עד 99.',
  branch_code_taken: 'הקוד הזה כבר של סניף אחר.',
  branch_code_fixed: 'קוד הסניף כבר נקבע — לסניף יש מסמכים בסדרה שלו, ולכן הוא לא משתנה.',
  branch_code_missing: 'לסניף אין קוד סניף (01–99) — הבעלים קובעים אותו ב"הגדרות הכספים ← מספור מסמכים", ואז מפיקים שוב.',
  branch_code_required: 'בעסק שממספר לפי סניף לכל סניף יש קוד — אי אפשר למחוק אותו.',
  series_full: 'סדרת המסמכים של הסניף מהסוג הזה מלאה (999,999 מסמכים). פנו לתמיכה.',
  deposit_document_only: 'מסמך הפקדה (הפקדת בנק) מופק רק יחד עם ההפקדה (קופות ← הפקדות).',
  cancel_deposit_document: 'מסמך הפקדה מבוטל רק יחד עם ההפקדה (קופות ← הפקדות ← ביטול ההפקדה).',
} as const;
/** a refusal of 7000 → its Hebrew, or null (not one of them) */
export function numberingError(m: string): string | null {
  for (const [code, he] of Object.entries(NUMBERING_HE)) if (new RegExp(`\\b${code}\\b`).test(m)) return he;
  if (/deposit_document_location/.test(m)) return 'מסמך ההפקדה הוא של הסניף של ההפקדה.';
  if (/deposit_document_alone/.test(m)) return 'מסמך הפקדה לא שייך ללקוח, למכירה או למסמך אחר.';
  return null;
}

/** the confirmation in the page before the switch (never a browser dialog) — what it does, and that it is once */
export const SWITCH_CONFIRM = 'פעם אחת, אין דרך חזרה';
export const SWITCH_EXPLAIN = [
  'מהרגע הזה לכל סניף סדרת מספור משלו: קוד הסניף (שתי ספרות) ואחריו המספר הרץ של הסניף — למשל 01000001, 01000002 בסניף 01, ו-02000001 בסניף 02.',
  'חשבונית זיכוי וקבלה במינוס הולכות לסדרה של הסניף שמפיק אותן.',
  'מסמכים שכבר הופקו לא משתנים ושומרים את המספר שלהם.',
  'אי אפשר לחזור למספור אחד לעסק.',
];

/** the unified file's branch fields (openformat.ts, BranchInfo) from the state; null when the business did not switch */
export function branchInfoOf(s: NumberingState | null, businessId: string | null): BranchInfo | null {
  if (!s?.perLocation || !businessId) return null;
  return { perLocation: true, businessId, codes: new Map(s.locations.filter((l) => l.branchCode).map((l) => [l.id, l.branchCode!])) };
}
