import type { NewDoc } from './compose';

/**
 * The documents row and the Hebrew of a database refusal — plain functions, used by the money screens (api.ts) and by the
 * dashboard's server (an online order's document, issued with the service role — src/lib/server/commerce.ts).
 */
export const FINANCE_MIGRATION = 'צריך להריץ את מיגרציה 20261004003100 (כספים) ב-Supabase לפני שהמסך הזה עובד.';
const missing = (m: string) => /schema cache|does not exist|PGRST20[24]|42P01|42703|Could not find/i.test(m);

/** a database refusal → what to tell the user */
export function financeError(e: unknown): string {
  const m = `${(e as any)?.message ?? e ?? ''} ${(e as any)?.code ?? ''} ${(e as any)?.details ?? ''}`;
  if (missing(m)) return FINANCE_MIGRATION;
  if (/business_details_missing/.test(m)) return 'חסרים פרטי העסק למסמכים (מספר עוסק בן 9 ספרות) — ממלאים ב"הגדרות".';
  if (/doc_type_not_allowed/.test(m)) return 'סוג המסמך הזה לא מתאים לסוג העסק (עוסק פטור לא מפיק חשבונית מס).';
  if (/period_locked/.test(m)) return 'הספרים סגורים לתקופה הזו — אי אפשר להפיק או לשנות בה מסמכים והוצאות.';
  if (/credit_exceeds_original/.test(m)) return 'הזיכוי גדול ממה שנשאר לזכות על החשבונית.';
  if (/cancel_not_allowed/.test(m)) return 'חשבונית מס מתקנים בחשבונית זיכוי, לא בביטול.';
  if (/paid transaction invoice/.test(m)) return 'חשבונית עסקה ששולמה לא מבוטלת — קודם מבטלים את הקבלה שלה.';
  if (/quote_status/.test(m)) return 'אי אפשר להעביר את ההצעה למצב הזה.';
  if (/decided quote/.test(m)) return 'הצעה שהוחלט עליה לא משתנה — אפשר לשכפל אותה להצעה חדשה.';
  if (/paid expense keeps/.test(m)) return 'הוצאה ששולמה לא משנה סכומים — מבטלים אותה ורושמים מחדש.';
  if (/void expense/.test(m)) return 'הוצאה מבוטלת לא משתנה.';
  if (/more than the credit invoice/.test(m)) return 'הסכום גדול מסכום חשבונית הזיכוי.';
  if (/already has an allocation/.test(m)) return 'למסמך כבר יש מספר הקצאה.';
  if (/digits only/.test(m)) return 'מספר הקצאה — ספרות בלבד.';
  if (/future/.test(m)) return 'אי אפשר לרשום תאריך עתידי.';
  if (/due date is before/.test(m)) return 'מועד התשלום לפני תאריך המסמך.';
  // 2.52.1 (migration 20261005003200): the database's own checks of receipts, contents and money back
  if (/receipt_exceeds_balance/.test(m)) return 'הסכום גדול מהיתרה לתשלום על החשבונית (אולי כבר נרשם תשלום ממכשיר אחר). רעננו ובדקו.';
  if (/tax invoice-receipt \(320\), not a receipt/.test(m)) return 'בעסק שגובה מע״מ, תשלום על חשבונית עסקה מקבל חשבונית מס / קבלה — לא קבלה.';
  if (/refund_exceeds_paid/.test(m)) return 'הסכום גדול ממה שנשאר להחזיר על העסקה (חלק כבר הוחזר בקופה).';
  // 2.87 (migration 20261010004200): a package's document is linked to its package — the same customer and price
  if (/package_document/.test(m)) return 'המסמך לא תואם לחבילה (לקוח/ה או מחיר). סגרו ופתחו את המכירה מחדש.';
  if (/method and amount are numbers|cheque's details/.test(m)) return 'פרטי התשלום לא תקינים (סכום, תאריך או פרטי הצ׳ק).';
  if (/names are text/.test(m)) return 'שורות המסמך לא תקינות (כמות, מחיר או שיעור מע״מ). רעננו ונסו שוב.';
  if (/payments:/.test(m)) return 'סכום התשלומים לא שווה לסכום המסמך.';
  if (/totals:|lines:/.test(m)) return 'הסכומים במסמך לא מסתדרים. רעננו ונסו שוב.';
  if (/the draft was|draft was not found/.test(m)) return 'הטיוטה כבר הופקה כמסמך.';
  if (/a reason is required/.test(m)) return 'צריך לכתוב סיבה (5 תווים לפחות).';
  if (/42501|row-level security|permission denied|not allowed/i.test(m)) return 'אין הרשאה לפעולה הזו.';
  return 'משהו השתבש. נסו שוב.';
}

export interface IssueExtra {
  userId: string; idempotencyKey: string; vatRate: number; saleId?: string | null; leadId?: string | null; refundId?: string | null;
  paidDocumentId?: string | null; quoteId?: string | null; draftId?: string | null; source?: string;
}
/** the documents row of a new document (the number, issue time and issuer are set by the database) */
export function documentRow(d: NewDoc, x: IssueExtra) {
  return {
    user_id: x.userId, doc_type: d.docType, doc_number: 0, doc_date: d.docDate, customer_name: d.customerName, customer_phone: d.customerPhone ?? '',
    customer_dealer: d.customerDealer ?? '', customer_street: d.customerStreet ?? '', customer_city: d.customerCity ?? '', customer_email: d.customerEmail ?? '',
    lines: d.lines, payments: d.payments, before_discount: d.beforeDiscount, discount: d.discount, after_discount: d.afterDiscount, vat_amount: d.vatAmount,
    total: d.total, vat_rate: x.vatRate, base_doc_type: d.baseDocType ?? null, base_doc_number: d.baseDocNumber ?? null, issued_by: d.issuedBy ?? '',
    sale_id: x.saleId ?? null, lead_id: x.leadId ?? null, refund_id: x.refundId ?? null, due_date: d.dueDate ?? null, notes: d.notes ?? '',
    paid_document_id: x.paidDocumentId ?? null, quote_id: x.quoteId ?? null, draft_id: x.draftId ?? null, idempotency_key: x.idempotencyKey,
    ...(x.source ? { source: x.source } : {}),
  };
}
