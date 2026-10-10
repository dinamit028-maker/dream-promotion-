import { MIGRATION_4200, PACKAGE_LIMITS } from '@/features/catalog/catalog';
import type { ComposeLine } from './compose';
import { csv } from './reports';
import { financeError } from './rows';
import { ag, sh } from './vat';

/**
 * Packages and series of treatments paid in advance (docs/FINANCE_ADDITIONS_HE.md, T1; migration 20261010004200).
 * Pure rules (no React, no network) — the finance screen, the client card and the tests use the same ones:
 *  - a package is an item of the one catalog (catalog_items, kind 'package' — the register's "🎁 חבילות") with its terms: how
 *    many treatments, of which treatment type (none = any), for how many months. A sold package (client_packages) COPIES
 *    them: a later change in the catalog changes nothing that was sold;
 *  - its document comes only from the existing engine (compose.ts → issueDocumentRow) with the key "package:<id>" — one per
 *    package, linked by the database; its money is that document's, in the payments ledger;
 *  - a treatment taken is a row of client_package_uses, one per session; cancelling the session gives it back.
 * The numbers come from the database view client_package_status. Here: the state, the warnings, which package to offer for a
 * session, the cancellation's suggestion (the owner approves every amount) and the report — in whole agorot.
 */
export const PACKAGES_MIGRATION = MIGRATION_4200;
export const MAX_SESSIONS = PACKAGE_LIMITS.sessions;
export const MAX_VALID_MONTHS = PACKAGE_LIMITS.months;
/** a package that ends within this many days is "about to expire" (a warning on the card) */
export const EXPIRY_SOON_DAYS = 14;

/** the key of a package's document: the database links the document to its package by it (one document per package) */
export const packageKey = (id: string) => `package:${id}`;

// ---- the catalog's packages -----------------------------------------------------------------------------------------------
export interface PackageTerms { sessions: number | null; typeId: string | null; validMonths: number | null }
/** a package of the catalog (catalog_items, kind 'package'); sessions null = its terms were never set (it is not sold as a package) */
export interface CatalogPackage extends PackageTerms { id: string; name: string; price: number; active: boolean; description: string }
const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export const toCatalogPackage = (r: any): CatalogPackage => ({
  id: String(r.id), name: String(r.name ?? ''), price: Number(r.price ?? 0), active: r.active !== false, description: String(r.description ?? ''),
  sessions: num(r.package_sessions), typeId: r.package_type_id ?? null, validMonths: num(r.package_valid_months),
});
/** "6 טיפולים" / "טיפול אחד" */
export const sessionsLabel = (n: number) => (n === 1 ? 'טיפול אחד' : `${n} טיפולים`);
/** what a package of the catalog gives: "6 טיפולים · לייזר · 6 חודשים" */
export function termsText(p: PackageTerms, typeName?: string | null): string {
  return [p.sessions ? sessionsLabel(p.sessions) : 'בלי מספר טיפולים', typeName || (p.typeId ? 'סוג טיפול' : 'כל טיפול'),
    p.validMonths ? (p.validMonths === 1 ? 'חודש' : `${p.validMonths} חודשים`) : 'בלי הגבלת תוקף'].join(' · ');
}
// ---- dates ------------------------------------------------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0');
export const ddmmyyyy = (d: string | null | undefined) => (d ? d.split('-').reverse().join('/') : '');
/** the same day n calendar months later; a month without that day ends on its last day (31.8 + 6 → 28/29.2) */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}
/** the last day a package sold on that day is valid (null = no expiry) */
export const validUntilOf = (soldOn: string, months: number | null) => (months ? addMonths(soldOn, months) : null);
const dayNo = (d: string) => Math.round(Date.parse(`${d}T12:00:00Z`) / 864e5);
/** whole days from today to that day (0 = today, negative = passed) */
export const daysUntil = (date: string, today: string) => dayNo(date) - dayNo(today);

// ---- a sold package ---------------------------------------------------------------------------------------------------------
export interface ClientPackage {
  id: string; leadId: string; customerName: string; itemId: string | null; name: string; typeId: string | null;
  sessionsTotal: number; price: number; soldOn: string; validUntil: string | null; notes: string;
  status: 'active' | 'cancelled'; documentId: string | null; cancelledAt: string | null; cancelReason: string; createdAt: string;
  /** treatments taken and not given back; remaining = sessionsTotal − used */
  used: number; returned: number; remaining: number; lastUsedAt: string | null;
  /** its document (null: none was issued — a package without a price, or an issue that failed) */
  docType: number | null; docNumber: number | null; docTotal: number | null; docDate: string | null; docCancelled: boolean;
  /** the ledger of its document: what came in less what went back; and its credit invoices */
  paid: number; credited: number;
}
export const toClientPackage = (r: any): ClientPackage => {
  const total = Number(r.sessions_total ?? 0), used = Number(r.used ?? 0);
  return {
    id: String(r.id), leadId: String(r.lead_id), customerName: String(r.customer_name ?? ''), itemId: r.item_id ?? null, name: String(r.name ?? ''),
    typeId: r.treatment_type_id ?? null, sessionsTotal: total, price: Number(r.price ?? 0), soldOn: String(r.sold_on ?? ''), validUntil: r.valid_until ?? null,
    notes: String(r.notes ?? ''), status: r.status === 'cancelled' ? 'cancelled' : 'active', documentId: r.document_id ?? null,
    cancelledAt: r.cancelled_at ?? null, cancelReason: String(r.cancel_reason ?? ''), createdAt: String(r.created_at ?? ''),
    used, returned: Number(r.returned ?? 0), remaining: r.remaining == null ? total - used : Number(r.remaining), lastUsedAt: r.last_used_at ?? null,
    docType: r.doc_type == null ? null : Number(r.doc_type), docNumber: r.doc_number == null ? null : Number(r.doc_number),
    docTotal: r.doc_total == null ? null : Number(r.doc_total), docDate: r.doc_date ?? null, docCancelled: Boolean(r.doc_cancelled),
    paid: Number(r.paid ?? 0), credited: Number(r.credited ?? 0),
  };
};

/** a treatment taken from a package (and maybe given back) */
export interface PackageUse { id: string; packageId: string; sessionId: string | null; usedAt: string; returnedAt: string | null; returnReason: string }
export const toPackageUse = (r: any): PackageUse => ({
  id: String(r.id), packageId: String(r.package_id), sessionId: r.session_id ?? null, usedAt: String(r.used_at ?? ''),
  returnedAt: r.returned_at ?? null, returnReason: String(r.return_reason ?? ''),
});

export type PackageState = 'active' | 'used_up' | 'expired' | 'cancelled';
export const STATE_HE: Record<PackageState, string> = { active: 'פעילה', used_up: 'נוצלה', expired: 'פג תוקף', cancelled: 'בוטלה' };
export function packageState(p: Pick<ClientPackage, 'status' | 'remaining' | 'validUntil'>, today: string): PackageState {
  if (p.status === 'cancelled') return 'cancelled';
  if (p.remaining <= 0) return 'used_up';
  if (p.validUntil && p.validUntil < today) return 'expired';
  return 'active';
}

/** "נותרו 4 מתוך 6 · בתוקף עד 10/04/2027" — the card's line */
export function packageLine(p: Pick<ClientPackage, 'status' | 'remaining' | 'sessionsTotal' | 'validUntil'>, today: string): string {
  const left = p.remaining <= 0 ? (p.sessionsTotal === 1 ? 'הטיפול נוצל' : `נוצלו כל ${p.sessionsTotal} הטיפולים`)
    : `${p.remaining === 1 ? 'נותר' : 'נותרו'} ${p.remaining} מתוך ${p.sessionsTotal}`;
  if (p.status === 'cancelled') return `בוטלה · ${left}`;
  const valid = !p.validUntil ? 'בלי הגבלת תוקף' : p.validUntil < today ? `פג תוקף ב-${ddmmyyyy(p.validUntil)}` : `בתוקף עד ${ddmmyyyy(p.validUntil)}`;
  return `${left} · ${valid}`;
}

export interface PackageWarning { kind: 'last_one' | 'expiring' | 'expired'; text: string }
/** the card warns when one treatment is left and when the validity is about to end (or ended with treatments left) */
export function packageWarnings(p: Pick<ClientPackage, 'status' | 'remaining' | 'validUntil'>, today: string): PackageWarning[] {
  const st = packageState(p, today);
  if (st === 'cancelled' || st === 'used_up') return [];
  if (st === 'expired') {
    return [{ kind: 'expired', text: `התוקף פג ב-${ddmmyyyy(p.validUntil)}, ${p.remaining === 1 ? 'ונשאר טיפול אחד' : `ונשארו ${p.remaining} טיפולים`}` }];
  }
  const out: PackageWarning[] = [];
  if (p.remaining === 1) out.push({ kind: 'last_one', text: 'נותר טיפול אחד' });
  if (p.validUntil) {
    const d = daysUntil(p.validUntil, today);
    if (d <= EXPIRY_SOON_DAYS) out.push({ kind: 'expiring', text: d === 0 ? 'התוקף מסתיים היום' : d === 1 ? 'התוקף מסתיים מחר' : `התוקף מסתיים בעוד ${d} ימים` });
  }
  return out;
}

/**
 * The packages a session may be taken from, in the order to offer them — the first is the one the screen suggests:
 * the customer's packages that are active, with treatments left and valid on the session's day; of the session's treatment type
 * first, then those for any treatment; within each, the one whose validity ends first, then the oldest. A session whose
 * treatment has no type: every such package. (An expired package is not offered: the owner may still pick it on purpose.)
 */
export function packagesFor<P extends Pick<ClientPackage, 'status' | 'remaining' | 'validUntil' | 'typeId' | 'createdAt'>>(list: P[], typeId: string | null, day: string): P[] {
  const rank = (p: P) => (typeId && p.typeId === typeId ? 0 : 1);
  return list
    .filter((p) => p.status === 'active' && p.remaining > 0 && (!p.validUntil || p.validUntil >= day) && (!typeId || !p.typeId || p.typeId === typeId))
    .sort((a, b) => rank(a) - rank(b) || (a.validUntil ?? '9999-12-31').localeCompare(b.validUntil ?? '9999-12-31') || a.createdAt.localeCompare(b.createdAt));
}
/** every package a session MAY be taken from (the database's rule: active, treatments left, a matching type) — expired included */
export const deductibleFor = <P extends Pick<ClientPackage, 'status' | 'remaining' | 'typeId'>>(list: P[], typeId: string | null): P[] =>
  list.filter((p) => p.status === 'active' && p.remaining > 0 && (!typeId || !p.typeId || p.typeId === typeId));

// ---- money: what was used, and putting it right when a package is cancelled ---------------------------------------------------
/** the value of the treatments taken: price × used / total, in whole agorot */
export const usedValueA = (p: Pick<ClientPackage, 'price' | 'sessionsTotal' | 'used'>) =>
  p.sessionsTotal > 0 ? Math.round((ag(p.price) * Math.min(Math.max(p.used, 0), p.sessionsTotal)) / p.sessionsTotal) : 0;

export type CancelRoute = 'credit' | 'cancel_document' | 'none' | 'no_document';
export interface CancelPlan {
  route: CancelRoute;
  /** what the treatments taken are worth, what is left of the package, what the customer paid (all ₪) */
  usedValue: number; unusedValue: number; paid: number;
  /** route 'credit': a credit invoice for this much (suggested: what was not used), at most what is left to credit */
  credit: number; maxCredit: number;
  /** money back to the customer (suggested: what they paid beyond what they are charged after the credit); never below 0 */
  refund: number;
  /** what the customer still owes after it (they paid less than the treatments they took) */
  owed: number;
  /** why this route, in Hebrew */
  note: string;
}
/**
 * The system SUGGESTS — the owner approves or changes every amount (credit: the amount of the credit invoice they choose).
 *  - a tax invoice (305 / 320): a credit invoice (330) that leaves exactly the value used charged (what was not used, when
 *    nothing was credited before); money back = what was paid beyond what is still charged — the existing credit engine
 *    (composeCredit) and record_credit_refund;
 *  - a receipt (400) or a transaction invoice (300) with nothing used (and a 300 that was not paid): the existing cancellation
 *    of the document (a 400's money goes back off the books by itself);
 *  - otherwise (an exempt dealer with treatments used): no credit invoice exists for an exempt dealer — the package is
 *    cancelled, and money given back is documented as the accountant says;
 *  - no document (a package without a price, or its document was never issued): only the package.
 */
export function cancelSuggestion(p: ClientPackage, credit?: number): CancelPlan {
  const usedA = usedValueA(p), priceA = ag(p.price), paidA = ag(p.paid);
  const base = { usedValue: sh(usedA), unusedValue: sh(priceA - usedA), paid: p.paid };
  const plan = (route: CancelRoute, creditA: number, maxA: number, chargedA: number, note: string): CancelPlan => ({
    ...base, route, credit: sh(creditA), maxCredit: sh(maxA), refund: sh(Math.max(0, paidA - chargedA)), owed: sh(Math.max(0, chargedA - paidA)), note,
  });
  if (!p.documentId || p.docType == null || p.docTotal == null) {
    return plan('no_document', 0, 0, paidA, p.price > 0 ? 'לחבילה לא הופק מסמך — אין חשבונית לזכות. מבטלים את החבילה בלבד.' : 'חבילה ללא תשלום — מבטלים אותה בלבד.');
  }
  const docA = ag(p.docTotal), creditedA = ag(p.credited);
  if (p.docCancelled) return plan('no_document', 0, 0, 0, 'המסמך של החבילה כבר בוטל.');
  if (p.docType === 305 || p.docType === 320) {
    const maxA = Math.max(0, docA - creditedA);
    // suggested: what leaves exactly the value used charged (= what was not used, when nothing was credited before)
    const wantA = credit === undefined ? Math.min(Math.max(0, docA - creditedA - usedA), maxA) : Math.min(Math.max(0, ag(credit)), maxA);
    return plan('credit', wantA, maxA, docA - creditedA - wantA,
      'חשבונית זיכוי על מה שלא נוצל, והחזר של מה ששולם מעבר לזה. הסכומים הם הצעה — אפשר לשנות לפני ההפקה.');
  }
  if (p.used === 0 && (p.docType === 400 || (p.docType === 300 && paidA === 0))) {
    return plan('cancel_document', 0, 0, 0, p.docType === 400
      ? 'לא נוצל אף טיפול: מבטלים את הקבלה. הכסף שלה יוצא מיומן התשלומים — ומחזירים אותו ללקוח/ה.'
      : 'לא נוצל אף טיפול ולא שולם: מבטלים את חשבונית העסקה.');
  }
  return plan('none', 0, 0, usedA, p.docType === 400 || p.docType === 300
    ? 'עוסק פטור לא מפיק חשבונית זיכוי. מבטלים את החבילה; החזר כספי חלקי מתעדים לפי הנחיית רואה החשבון.'
    : 'אין מסמך לזכות. מבטלים את החבילה בלבד.');
}

// ---- the report ---------------------------------------------------------------------------------------------------------------
export interface PackagesReport {
  /** active packages, valid, with treatments left */
  open: number; remainingSessions: number;
  /** what their treatments left are worth (price × left / total) */
  remainingValue: number;
  /** paid in advance and not used yet: what was paid beyond the treatments taken (per package, never below 0) */
  prepaidUnused: number;
  /** still to collect on them (their document less credits and payments) */
  owed: number;
  /** packages whose validity ended with treatments left */
  expired: number; expiredSessions: number; expiredValue: number;
}
/** information for the owner — not an accounting determination (how to book income paid in advance is the accountant's call) */
export function packagesReport(list: ClientPackage[], today: string): PackagesReport {
  const r = { open: 0, remainingSessions: 0, remainingA: 0, prepaidA: 0, owedA: 0, expired: 0, expiredSessions: 0, expiredA: 0 };
  for (const p of list) {
    const st = packageState(p, today);
    const leftA = ag(p.price) - usedValueA(p);
    if (st === 'active') {
      r.open++; r.remainingSessions += p.remaining; r.remainingA += leftA;
      r.prepaidA += Math.max(0, ag(p.paid) - usedValueA(p));
      if (p.docTotal != null && !p.docCancelled && (p.docType === 305 || p.docType === 300)) r.owedA += Math.max(0, ag(p.docTotal) - ag(p.credited) - ag(p.paid));
    } else if (st === 'expired') {
      r.expired++; r.expiredSessions += p.remaining; r.expiredA += leftA;
    }
  }
  return { open: r.open, remainingSessions: r.remainingSessions, remainingValue: sh(r.remainingA), prepaidUnused: sh(r.prepaidA), owed: sh(r.owedA),
    expired: r.expired, expiredSessions: r.expiredSessions, expiredValue: sh(r.expiredA) };
}

const DOC_SHORT: Record<number, string> = { 300: 'חשבונית עסקה', 305: 'חשבונית מס', 320: 'חשבונית מס / קבלה', 400: 'קבלה' };
const money = (n: number) => n.toFixed(2);
/** the packages as the accountant / owner opens them in Excel — one row per sold package, the same numbers as the screen */
export function packagesCsv(list: ClientPackage[], today: string): string {
  return csv(['לקוח/ה', 'חבילה', 'טיפולים', 'נוצלו', 'נותרו', 'מחיר', 'שולם', 'זוכה', 'מסמך', 'נמכרה', 'בתוקף עד', 'מצב'],
    list.map((p) => [p.customerName, p.name, p.sessionsTotal, p.used, p.remaining, money(p.price), money(p.paid), money(p.credited),
      p.docType ? `${DOC_SHORT[p.docType] ?? p.docType} ${p.docNumber ?? ''}${p.docCancelled ? ' (בוטל)' : ''}` : '', ddmmyyyy(p.soldOn), ddmmyyyy(p.validUntil),
      STATE_HE[packageState(p, today)]]));
}

// ---- the sale --------------------------------------------------------------------------------------------------------------
/** the document of a sale: a VAT business — paid now 320 (tax invoice-receipt), later 305 (tax invoice; its receipts follow);
 *  an exempt dealer — 400 (receipt) / 300 (transaction invoice) */
export const packageDocType = (vat: boolean, payNow: boolean): 300 | 305 | 320 | 400 => (vat ? (payNow ? 320 : 305) : payNow ? 400 : 300);
/** the line on the document: the package and how many treatments, at its price (VAT inside, as every price of the catalog) */
export const packageDocLine = (name: string, sessions: number, price: number, itemId?: string | null): ComposeLine =>
  ({ name: `${name.trim()} — ${sessionsLabel(sessions)}`.slice(0, 120), qty: 1, unitPrice: price, ...(itemId ? { itemId } : {}) });
const okMoney = (s: string) => { const t = s.replace(/[₪,\s]/g, ''); const n = Number(t); return t !== '' && Number.isFinite(n) && n >= 0 && n < 1e8 && Math.round(n * 100) === n * 100; };
export const priceOf = (s: string) => Number(s.replace(/[₪,\s]/g, '')) || 0;
/** what is missing before a sale, in Hebrew (the database checks the same again) */
export function saleProblems(d: { leadId: string | null; pkg: Pick<CatalogPackage, 'sessions'> | null; price: string; validUntil: string; today: string }): string[] {
  const e: string[] = [];
  if (!d.leadId) e.push('בחרו לקוח/ה מאנשי הקשר.');
  if (!d.pkg) e.push('בחרו חבילה מהקטלוג.');
  else if (!d.pkg.sessions) e.push('לחבילה הזו לא הוגדר מספר טיפולים — עורכים אותה בקטלוג.');
  if (!okMoney(d.price)) e.push('המחיר: מספר, 0 או יותר (עד 2 ספרות אחרי הנקודה).');
  if (d.validUntil && d.validUntil < d.today) e.push('תאריך התוקף כבר עבר.');
  return e;
}

/** a refusal of the database → what to tell the user */
export function packageError(e: unknown): string {
  const m = `${(e as any)?.message ?? e ?? ''} ${(e as any)?.code ?? ''} ${(e as any)?.details ?? ''}`;
  if (/schema cache|does not exist|PGRST20[2-5]|42P01|42703|42883|Could not find/i.test(m)
      && /client_package|client_session_add|package_sessions|package_type_id|package_valid_months|cancelled_at|cancel_reason/.test(m)) return PACKAGES_MIGRATION;
  if (/session_deducted|client_package_uses_session_uq/.test(m)) return 'הטיפול הזה כבר נוכה מחבילה.';
  if (/package_used_up/.test(m)) return 'לא נשארו טיפולים בחבילה הזו.';
  if (/package_cancelled/.test(m)) return 'החבילה בוטלה — לא מנכים ממנה.';
  if (/session_cancelled/.test(m)) return 'הטיפול בוטל — לא מנכים אותו.';
  if (/package_other_type/.test(m)) return 'החבילה היא לסוג טיפול אחר.';
  if (/not found for this customer/.test(m)) return 'החבילה או הטיפול לא שייכים ללקוח/ה הזה/ו.';
  if (/client_sessions_treatment_id|client_treatments/.test(m) && /foreign key|23503/.test(m)) return 'הטיפול לא שייך ללקוח/ה הזה/ו.';
  if (/session_time/.test(m)) return 'טיפול שבוצע — לא תאריך עתידי.';
  if (/package_document/.test(m)) return 'המסמך לא תואם לחבילה (לקוח/ה או מחיר).';
  if (/keeps its terms/.test(m)) return 'חבילה שנמכרה לא משנה תנאים. אם נמכרה בטעות — מבטלים אותה ומוכרים מחדש.';
  if (/keeps its document/.test(m)) return 'לחבילה כבר יש מסמך.';
  if (/stays cancelled|cancelled package does not change/.test(m)) return 'חבילה שבוטלה לא משתנה.';
  if (/cancelled session does not change/.test(m)) return 'טיפול שבוטל לא משתנה.';
  if (/deduction does not change/.test(m)) return 'הניכוי כבר הוחזר.';
  if (/reason is required/.test(m)) return 'צריך לכתוב סיבה לביטול (2 תווים לפחות).';
  if (/not sold in the future/.test(m)) return 'תאריך המכירה לא יכול להיות בעתיד.';
  if (/client_packages_valid_check/.test(m)) return 'תאריך התוקף לפני תאריך המכירה.';
  if (/catalog_items_package_check/.test(m)) return `מספר טיפולים 1–${MAX_SESSIONS}, תוקף 1–${MAX_VALID_MONTHS} חודשים.`;
  if (/catalog_items_package_type_fk/.test(m)) return 'סוג הטיפול לא נמצא בעסק.';
  if (/not in this business's catalog/.test(m)) return 'החבילה לא נמצאה בקטלוג של העסק.';
  if (/client_packages/.test(m) && /foreign key|23503/.test(m)) return 'ללקוח/ה יש חבילה שנמכרה — היא נשארת ברישומים הכספיים, ולכן אי אפשר למחוק את איש הקשר.';
  return financeError(e);
}
