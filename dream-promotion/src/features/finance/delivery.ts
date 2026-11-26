import type { AllocationNeed, AllocationRule } from './allocation';

/**
 * 2.119 — delivering a document to the customer (the accountant's answers of 25.11.2026, docs/ita-registration/CPA_ANSWERS_HE.md,
 * rows 1, 2, 3א, 4, 6 and 6 נוסף; migration 20261126006900). Pure: what the screens and the server say and decide — the rules are in
 * the database only (allocation_required / allocation_awaiting, document_share_open, document_delivery_record / _state):
 *   - a document that needs an allocation number (305 / 320 / 330 to a customer with a dealer number, before VAT from the threshold
 *     of its date up) is issued without it, and reaches the customer only after the number is recorded (answers 1, 2, 3א);
 *   - the first delivery is the original ("מקור"), every later one "העתק נאמן למקור" (answer 6) — the database says which;
 *   - a wrong number is never edited: a credit invoice and a new invoice (answer 4, as decided 25.11.2026).
 * Nothing here talks to the Tax Authority, and nothing here says a number was "approved" or "reported".
 */
export const MARK_ORIGINAL = 'מקור';
export const MARK_COPY = 'העתק נאמן למקור';
/** the mark on a delivered document — from the database's answer (is_original), never guessed by a screen */
export const deliveryMark = (original: boolean) => (original ? MARK_ORIGINAL : MARK_COPY);

export const AWAITING_TITLE = 'המסמך ממתין למספר הקצאה מרשות המסים';
export const AWAITING_CUSTOMER = `${AWAITING_TITLE}. הוא יהיה זמין כאן מיד אחרי שהעסק יקבל את המספר.`;
export const AWAITING_STAFF = `${AWAITING_TITLE}. אי אפשר למסור אותו ללקוח (הדפסה, PDF, קישור או שליחה) לפני שמזינים את המספר שהתקבל — במסך המסמך, "הזנת מספר שהתקבל".`;
export const WRONG_NUMBER_NOTE = 'מספר הקצאה שנשמר לא משתנה. אם הוזן מספר שגוי — מפיקים חשבונית זיכוי על המסמך הזה וחשבונית חדשה, ולכל אחת מזינים את המספר שהתקבל לה (כשהיא דורשת מספר).';

export type DeliveryChannel = 'link' | 'pdf' | 'storefront' | 'print' | 'email' | 'whatsapp';
/** document_share_open / document_delivery_record — a delivery that was recorded */
export interface Delivery { deliveryId: string; documentId: string; businessId: string; channel: DeliveryChannel; original: boolean; mark: string; at: string; printCount: number; filePath: string }
export const toDelivery = (j: any): Delivery | null => {
  if (!j || j.ok !== true || typeof j.delivery_id !== 'string' || typeof j.document_id !== 'string') return null;
  return { deliveryId: j.delivery_id, documentId: j.document_id, businessId: String(j.business_id ?? ''), channel: j.channel, original: j.original === true,
    // the mark is recomputed from is_original (the same words as the database's) — a missing / odd mark never reaches a document
    mark: deliveryMark(j.original === true), at: String(j.at ?? ''), printCount: Number(j.print_count ?? 0), filePath: String(j.file_path ?? '') };
};

/** document_delivery_state — what a screen needs before it delivers */
export interface DeliveryState {
  allocation: { required: boolean; awaiting: boolean; number: string | null; manual: boolean; rule: { version: number; effectiveFrom: string; threshold: number; inclusive: boolean; docTypes: number[]; verified: boolean } | null };
  delivered: boolean; original: { at: string; channel: string } | null; deliveries: number; printCount: number;
}
export const toDeliveryState = (j: any): DeliveryState | null => {
  if (!j || typeof j !== 'object' || !j.allocation || typeof j.allocation !== 'object') return null;
  const a = j.allocation, r = a.rule;
  return {
    allocation: {
      required: a.required === true, awaiting: a.awaiting === true, number: typeof a.number === 'string' && a.number ? a.number : null, manual: a.manual === true,
      rule: r && typeof r === 'object' ? { version: Number(r.version), effectiveFrom: String(r.effectiveFrom ?? ''), threshold: Number(r.threshold), inclusive: r.inclusive !== false,
        docTypes: Array.isArray(r.docTypes) ? r.docTypes.map(Number) : [], verified: r.verified === true } : null,
    },
    delivered: j.delivered === true, original: j.original && typeof j.original === 'object' ? { at: String(j.original.at ?? ''), channel: String(j.original.channel ?? '') } : null,
    deliveries: Number(j.deliveries ?? 0), printCount: Number(j.printCount ?? 0),
  };
};

const shekels = (n: number) => `₪${n.toLocaleString('he-IL')}`;
/** the database's answer as the allocation section reads it (allocationState in allocation.ts) — the reason in words */
export function needFromState(s: DeliveryState): AllocationNeed {
  const r = s.allocation.rule;
  const rule: AllocationRule | null = r ? { version: r.version, effectiveFrom: r.effectiveFrom, thresholdBeforeVat: r.threshold, docTypes: r.docTypes, inclusive: r.inclusive,
    requiresCustomerDealer: true, verified: r.verified, sourceNote: '' } : null;
  const from = r ? `${r.inclusive ? 'מ-' : 'מעל '}${shekels(r.threshold)} לפני מע״מ` : '';
  return s.allocation.required
    ? { required: true, rule, verified: r?.verified ?? false, reason: `${from ? `${from} ` : ''}ללקוח עם מספר עוסק — נדרש מספר הקצאה לפני המסירה ללקוח` }
    : { required: false, rule, verified: r?.verified ?? false, reason: 'לא נדרש מספר הקצאה למסמך הזה' };
}

/** an error of the database: the document waits for its allocation number (document_delivery_record, the print trigger — 55000) */
export const isAwaiting = (e: { code?: string; message?: string } | null | undefined) =>
  Boolean(e && (e.code === '55000' || /awaiting_allocation/.test(e.message ?? '')));
/** the function / view is not in the database yet (before migration 20261126006900): the screens keep working as before it */
export const isMissing = (e: { code?: string; message?: string } | null | undefined) =>
  Boolean(e && (e.code === 'PGRST202' || e.code === 'PGRST205' || e.code === '42883' || e.code === '42P01'
    || /Could not find the (function|table)|does not exist/i.test(e.message ?? '')));
