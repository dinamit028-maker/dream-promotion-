import { chargesVat, entityOf } from './rules';

/**
 * Allocation numbers ("מספר הקצאה", the "Israel invoices" model): when a tax invoice needs one, and what the app
 * may claim about one. Nothing here talks to the Tax Authority (that is src/lib/server/tax, server only).
 *
 * The rules are versioned (table tax_allocation_rules, a new row per change) and carry verified = false until an
 * accountant confirms them against the official publication: the thresholds below come from secondary sources,
 * because the Tax Authority's site was not reachable from the development environment.
 *
 * A number is "real" only when it is digits only, not a test, and approved by the gateway or typed in by the
 * business ("manual" — shown as such). A test number ("TEST-…") is never shown as an allocation number.
 */
export interface AllocationRule {
  version: number; effectiveFrom: string; thresholdBeforeVat: number; docTypes: number[]; requiresCustomerDealer: boolean; verified: boolean; sourceNote: string;
}
/** the same four rows the migration seeds (for tests and before the rules are loaded) */
export const SEED_RULES: AllocationRule[] = [
  { version: 1, effectiveFrom: '2024-05-05', thresholdBeforeVat: 25000, docTypes: [305, 320], requiresCustomerDealer: true, verified: false, sourceNote: 'מקורות משניים' },
  { version: 2, effectiveFrom: '2025-01-01', thresholdBeforeVat: 20000, docTypes: [305, 320], requiresCustomerDealer: true, verified: false, sourceNote: 'מקורות משניים' },
  { version: 3, effectiveFrom: '2026-01-01', thresholdBeforeVat: 10000, docTypes: [305, 320], requiresCustomerDealer: true, verified: false, sourceNote: 'מקורות משניים' },
  { version: 4, effectiveFrom: '2026-06-01', thresholdBeforeVat: 5000, docTypes: [305, 320], requiresCustomerDealer: true, verified: false, sourceNote: 'מקורות משניים' },
];
export const toRule = (r: any): AllocationRule => ({
  version: r.version, effectiveFrom: r.effective_from, thresholdBeforeVat: Number(r.threshold_before_vat), docTypes: (r.doc_types ?? []).map(Number),
  requiresCustomerDealer: Boolean(r.requires_customer_dealer), verified: Boolean(r.verified), sourceNote: r.source_note ?? '',
});
/** the rule in force on a day (the latest one that started on or before it) */
export function ruleOn(rules: AllocationRule[], date: string): AllocationRule | null {
  let best: AllocationRule | null = null;
  for (const r of rules) if (r.effectiveFrom <= date && (!best || r.effectiveFrom > best.effectiveFrom)) best = r;
  return best;
}

export interface AllocationNeed { required: boolean; rule: AllocationRule | null; verified: boolean; reason: string }
/** does this document need an allocation number, under the rule of its date? */
export function allocationNeed(doc: { docType: number; docDate: string; afterDiscount: number; customerDealer?: string | null },
  issuer: { entityType?: string | null }, rules: AllocationRule[]): AllocationNeed {
  const rule = ruleOn(rules, doc.docDate);
  const no = (reason: string): AllocationNeed => ({ required: false, rule, verified: rule?.verified ?? false, reason });
  if (!chargesVat(entityOf(issuer.entityType))) return no('עוסק פטור / מלכ״ר לא מפיק חשבוניות מס');
  if (!rule) return no('אין כלל בתוקף לתאריך המסמך');
  if (!rule.docTypes.includes(doc.docType)) return no('סוג המסמך לא דורש מספר הקצאה לפי הכלל');
  if (rule.requiresCustomerDealer && !/^\d{9}$/.test(doc.customerDealer ?? '')) return no('הלקוח לא עוסק (אין מספר עוסק) — לא נדרש');
  if (doc.afterDiscount <= rule.thresholdBeforeVat) return no(`מתחת לסף (₪${rule.thresholdBeforeVat.toLocaleString('he-IL')} לפני מע״מ)`);
  return { required: true, rule, verified: rule.verified, reason: `מעל ₪${rule.thresholdBeforeVat.toLocaleString('he-IL')} לפני מע״מ לעוסק — נדרש מספר הקצאה` };
}

/**
 * What the gateway would send: only what identifies the invoice and its amounts — no names, phones, addresses or lines.
 * These are OUR names; how they map to the Tax Authority's API is not implemented until the official spec is verified.
 */
export interface AllocationRequest {
  issuerVatNumber: string; customerVatNumber: string; docType: number; docNumber: number; docDate: string;
  amountBeforeVat: number; vatAmount: number; total: number;
}
export function minimizedRequest(doc: { docType: number; docNumber: number; docDate: string; afterDiscount: number; vatAmount: number; total: number; customerDealer?: string | null },
  issuer: { dealerNumber?: string }): AllocationRequest {
  return {
    issuerVatNumber: String(issuer.dealerNumber ?? ''), customerVatNumber: String(doc.customerDealer ?? ''), docType: doc.docType, docNumber: doc.docNumber,
    docDate: doc.docDate, amountBeforeVat: doc.afterDiscount, vatAmount: doc.vatAmount, total: doc.total,
  };
}

export interface AllocationRow { id: string; status: 'requested' | 'approved' | 'rejected' | 'error' | 'manual'; isTest: boolean; number: string | null; gateway: 'mock' | 'live' | 'manual'; errorMessage: string; createdAt: string }
export const toAllocationRow = (r: any): AllocationRow => ({
  id: r.id, status: r.status, isTest: Boolean(r.is_test), number: r.allocation_number ?? null, gateway: r.gateway, errorMessage: r.error_message ?? '', createdAt: r.created_at,
});
export const isRealAllocation = (r: Pick<AllocationRow, 'status' | 'isTest' | 'number' | 'gateway'>) =>
  !r.isTest && r.gateway !== 'mock' && (r.status === 'approved' || r.status === 'manual') && /^\d{1,20}$/.test(r.number ?? '');

export type AllocationState =
  | { kind: 'not_required'; reason: string } | { kind: 'missing'; reason: string; verified: boolean }
  | { kind: 'real'; number: string; manual: boolean } | { kind: 'test'; number: string } | { kind: 'error'; message: string } | { kind: 'pending' };
/** the one thing to show for a document: its real number, else a test number (labelled), else what is missing */
export function allocationState(rows: AllocationRow[], need: AllocationNeed): AllocationState {
  const real = rows.find(isRealAllocation);
  if (real) return { kind: 'real', number: real.number!, manual: real.status === 'manual' };
  const latest = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latest?.isTest && latest.number) return { kind: 'test', number: latest.number };
  if (latest?.status === 'requested') return { kind: 'pending' };
  if (latest && (latest.status === 'error' || latest.status === 'rejected')) return { kind: 'error', message: latest.errorMessage || 'הבקשה נדחתה' };
  return need.required ? { kind: 'missing', reason: need.reason, verified: need.verified } : { kind: 'not_required', reason: need.reason };
}
/** the line printed on a document (null = print nothing). A test number says so, in words. */
export function allocationPrintLine(s: AllocationState): string | null {
  switch (s.kind) {
    case 'real': return `מספר הקצאה: ${s.number}${s.manual ? ' (הוזן ידנית)' : ''}`;
    case 'test': return `מספר בדיקה ${s.number} — סביבת בדיקות, לא מספר הקצאה של רשות המסים`;
    case 'missing': case 'pending': case 'error': return 'מספר הקצאה: טרם התקבל';
    default: return null;
  }
}
