import type { NewDoc } from './compose';
import { numberingError } from './numbering';
import { booksError } from './ledger';

/**
 * The documents row and the Hebrew of a database refusal — plain functions, used by the money screens (api.ts) and by the
 * dashboard's server (an online order's document, issued with the service role — src/lib/server/commerce.ts).
 */
export const FINANCE_MIGRATION = 'צריך להריץ את מיגרציה 20261004003100 (כספים) ב-Supabase לפני שהמסך הזה עובד.';
/** 2.122: the one-sided manual entries from the books' start (journal_entry_create / _reverse of 7200 refuse); 2.123: the
 *  double-entry form is "הנהלת חשבונות ← פקודה ידנית" (gl_manual_create) */
export const JOURNAL_BOOKS_CLOSED = 'מתחילת הספרים פקודות נרשמות בחובה וזכות — ב"הנהלת חשבונות ← פקודה ידנית".';
const missing = (m: string) => /schema cache|does not exist|PGRST20[24]|42P01|42703|Could not find/i.test(m);

/** a database refusal → what to tell the user */
export function financeError(e: unknown): string {
  const m = `${(e as any)?.message ?? e ?? ''} ${(e as any)?.code ?? ''} ${(e as any)?.details ?? ''}`;
  if (missing(m)) return FINANCE_MIGRATION;
  // 2.120 (migration 20261127007000): numbering per location, branch codes, the bank deposit's document (420)
  const numbering = numberingError(m);
  if (numbering) return numbering;
  // 2.123 (stage 4ד — the books' screens): the chart, the manual double entry, the opening balances, the ledger
  const books = booksError(m);
  if (books) return books;
  if (/business_details_missing/.test(m)) return 'חסרים פרטי העסק למסמכים (מספר עוסק בן 9 ספרות) — ממלאים ב"הגדרות".';
  if (/doc_type_not_allowed/.test(m)) return 'סוג המסמך הזה לא מתאים לסוג העסק (עוסק פטור לא מפיק חשבונית מס).';
  if (/period_locked/.test(m)) return 'הספרים סגורים לתקופה הזו — אי אפשר להפיק או לשנות בה מסמכים והוצאות.';
  if (/credit_exceeds_original/.test(m)) return 'הזיכוי גדול ממה שנשאר לזכות על החשבונית.';
  if (/cancel_not_allowed/.test(m)) return 'חשבונית מס מתקנים בחשבונית זיכוי, לא בביטול.';
  // 2.118 (migration 20261125006800 — the accountant's answers of 25.11.2026, stage 1)
  if (/doc_date_not_today/.test(m)) return 'תאריך המסמך הוא תמיד יום ההפקה (היום). כנראה שהשעון של המכשיר לא מדויק, או שהמסך היה פתוח מאתמול — רעננו ונסו שוב.';
  if (/cancel_receipt_not_allowed/.test(m)) return 'קבלה לא מבטלים. מחזירים כסף בקבלה במינוס ("החזר כספי" — עוסק פטור) או בחשבונית זיכוי.';
  if (/refund_receipt_not_exempt/.test(m)) return 'קבלה במינוס (החזר כספי) — רק לעוסק פטור. בעסק שגובה מע״מ מחזירים כסף בחשבונית מס זיכוי.';
  if (/refund_receipt_over/.test(m)) { const n = /להחזר (-?[0-9.]+)/.exec(m)?.[1]; return `ההחזר גדול ממה שנשאר להחזיר על הקבלה${n ? ` (נשארו ₪${Number(n).toLocaleString('he-IL')})` : ''}. אולי כבר נרשם החזר ממכשיר אחר — רעננו ובדקו.`; }
  if (/refund_receipt_base: [^\n]*בוטלה/.test(m)) return 'הקבלה שעליה ההחזר בוטלה — אין עליה החזר.';
  if (/refund_receipt_base/.test(m)) return 'הקבלה שעליה ההחזר לא נמצאה בעסק.';
  if (/refund_receipt_alone/.test(m)) return 'קבלה במינוס לא משלמת חשבונית ולא מופקת מהצעה או מטיוטה.';
  if (/refund_receipt_payments/.test(m)) return 'בקבלה במינוס כל תשלום הוא כסף שהוחזר (סכום, אמצעי תשלום) — בלי ניכוי במקור.';
  if (/refund_receipt_refund/.test(m)) return 'הקבלה במינוס לא תואמת להחזר שנרשם (סכום או עסקה). רעננו ונסו שוב.';
  if (/card_kind_missing/.test(m)) return 'בתשלום בכרטיס אשראי בוחרים את סוג העסקה: רגיל, תשלומים, קרדיט, חיוב נדחה או אחר.';
  if (/card_kind_not_card/.test(m)) return 'סוג עסקת אשראי — רק בתשלום בכרטיס אשראי.';
  // 2.121 (migration 20261128007100 — answer 8 of stage 4): a card payment in installments (documents_installments)
  if (/installments_card_only/.test(m)) return 'מספר תשלומים — רק בתשלום בכרטיס אשראי מסוג "תשלומים".';
  if (/installments_count/.test(m)) return 'מספר התשלומים — 2 עד 36.';
  if (/installments_refund/.test(m)) return 'החזר כספי לא מחולק לתשלומים.';
  if (/installments_first_due/.test(m)) return 'מועד החיוב הראשון — מיום התשלום ועד שנה אחריו.';
  // 2.122 (migration 20261129007200 — the owner's answers 15, 17 of 27.11.2026): from the books' start a manual entry is a double
  // one, and a bank line handled without a document is posted to an account (before "books_started" below — it is a part of it)
  if (/journal_books_started/.test(m)) { const d = /\((\d{4}-\d{2}-\d{2})\)/.exec(m)?.[1]; return `${JOURNAL_BOOKS_CLOSED}${d ? ` (תחילת הספרים: ${d.split('-').reverse().join('/')})` : ''}`; }
  if (/bank_line_account_required/.test(m)) return 'שורת בנק מתאריך תחילת הספרים נרשמת לחשבון בספרים, לא רק בהערה — רעננו ובחרו "רישום לחשבון".';
  if (/bank_class_account/.test(m)) return /הבנק עצמו|the bank itself/.test(m) ? 'שורת בנק לא נרשמת לחשבון הבנק עצמו — בוחרים חשבון אחר.' : 'החשבון לא נמצא בלוח החשבונות, או שהוא לא פעיל. רעננו ובחרו חשבון מהרשימה.';
  if (/books_not_allowed/.test(m)) return 'רק הבעלים של העסק רושמים בספרים.';
  if (/נפתחת מחדש רק על ידי הבעלים/.test(m)) return 'השורה נרשמה לחשבון בספרים — רק הבעלים מחזירים אותה לטיפול.';
  // 2.121: the books' start date (gl_books_start_set) and the opening balances (gl_opening_balances — the form is of stage 4ד)
  if (/books_start_date/.test(m)) return 'תחילת הספרים — ה-1 בחודש, לכל המאוחר החודש הבא.';
  if (/books_started/.test(m)) return 'כבר נרשמו פקודות בספרים — אי אפשר להזיז את תאריך ההתחלה.';
  if (/opening_done/.test(m)) return 'יתרות הפתיחה כבר נרשמו. תיקון — בפקודה.';
  // 2.121 (answer 19): a tax invoice made from a transaction invoice (documents_validate of 7100)
  if (/invoice_from_300_paylink/.test(m)) return 'יש לינק תשלום פתוח על חשבון העסקה — מבטלים אותו קודם או מחכים לתשלום.';
  if (/invoice_from_300_closed/.test(m)) return 'על חשבון העסקה הזה כבר הופקה חשבונית מס (או חשבונית מס / קבלה) — רעננו.';
  if (/invoice_from_300: [^\n]*בוטל/.test(m)) return 'חשבון העסקה בוטל — לא מפיקים ממנו חשבונית מס.';
  if (/invoice_from_300/.test(m)) return 'חשבון העסקה לא נמצא בעסק הזה.';
  if (/register_settings_deductions_file_check/.test(m)) return 'מספר תיק ניכויים — 9 ספרות (או ריק).';
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
  // 2.94 (migration 20261011004900): tax withheld at source on a receipt; the reports' period and card
  if (/withholding_pct/.test(m)) return 'אחוז הניכוי במקור: מספר בין 0 ל-100 (עד 2 ספרות אחרי הנקודה).';
  if (/withholding_customer/.test(m)) return 'ניכוי במקור צריך את שם הלקוח שניכה אותו.';
  if (/withholding_all/.test(m)) return 'ניכוי במקור הוא חלק מהתשלום — לא כולו.';
  if (/withholding: only a receipt|payments_withholding_source/.test(m)) return 'ניכוי במקור נרשם רק בקבלה.';
  if (/bad range/.test(m)) return 'טווח התאריכים לא תקין (מתאריך עד תאריך, עד עשר שנים).';
  if (/customer: a key|supplier: a key/.test(m)) return 'לא נבחר לקוח או ספק לכרטסת.';
  if (/method and amount are numbers|cheque's details/.test(m)) return 'פרטי התשלום לא תקינים (סכום, תאריך או פרטי הצ׳ק).';
  if (/names are text/.test(m)) return 'שורות המסמך לא תקינות (כמות, מחיר או שיעור מע״מ). רעננו ונסו שוב.';
  if (/payments:/.test(m)) return 'סכום התשלומים לא שווה לסכום המסמך.';
  // 2.95: a bank file's lines ("bank_lines:" — before the documents' "lines:" below)
  if (/bank_lines: 1 to 5,000/.test(m)) return 'עד 5,000 שורות בקובץ אחד — מורידים מהבנק תקופה קצרה יותר.';
  if (/bank_lines/.test(m)) return 'שורות הקובץ לא תקינות (תאריך, וסכום שאינו אפס).';
  if (/totals:|lines:/.test(m)) return 'הסכומים במסמך לא מסתדרים. רעננו ונסו שוב.';
  if (/the draft was|draft was not found/.test(m)) return 'הטיוטה כבר הופקה כמסמך.';
  // 2.93 (migration 20261011004800): a product with serial numbers moves only with its numbers — not on a document or an expense
  if (/serial_item/.test(m)) return 'מוצר עם מספרים סידוריים לא יוצא ולא נכנס במסמך או בהוצאה — מוכרים אותו בקופה (לפי המספר), וקולטים אותו בעורך המוצר ("מספרים סידוריים").';
  // 2.95 (migration 20261011005000): an order, a delivery note and a return note; deposits; the bank
  if (/goods_off/.test(m)) return 'הזמנה, תעודת משלוח ותעודת החזרה — לעסק שהפעיל "מכירת מוצרים" (הגדרות כספים).';
  if (/goods_return_base/.test(m)) return 'תעודת החזרה מופקת מתוך תעודת המשלוח.';
  if (/goods_base_receipt/.test(m)) return 'קבלה על חשבונית לא מופקת מהזמנה או מתעודת משלוח.';
  if (/goods_base_missing/.test(m)) return 'ההזמנה / תעודת המשלוח לא נמצאה בעסק.';
  if (/goods_base_cancelled/.test(m)) return 'ההזמנה / תעודת המשלוח בוטלה — לא מפיקים ממנה.';
  if (/goods_invoiced/.test(m)) return 'תעודת המשלוח כבר חויבה בחשבונית. סחורה שחוזרת אחרי החשבונית — בחשבונית זיכוי.';
  if (/goods_over_delivery/.test(m)) { const w = /\(([^)]*)\)/.exec(m)?.[1]; return `יותר ממה שנשאר בתעודת המשלוח${w ? ` (${w})` : ''}.`; }
  if (/cancel_has_followers: its delivery note/.test(m)) return 'תעודת המשלוח של ההחזרה כבר חויבה — ההחזרה נשארת.';
  if (/cancel_has_followers/.test(m)) return 'הופק ממנו מסמך — מבטלים קודם את המסמך שהופק ממנו.';
  if (/only a credit invoice points to a base document/.test(m)) return 'המסמך לא יכול להיות מופק מהמסמך הזה.';
  if (/deposit_cash_over/.test(m)) { const n = /holds (-?[0-9.]+)/.exec(m)?.[1]; return `בקופת המזומן רשומים רק ₪${n ? Number(n).toLocaleString('he-IL') : '0'}. הפקדה גדולה יותר אומרת שיש מזומן שלא הופקה עליו קבלה.`; }
  if (/deposit_cheque_taken/.test(m)) return 'אחד הצ׳קים כבר לא בקופה (הופקד, הותאם לבנק או שהקבלה שלו בוטלה). רעננו ונסו שוב.';
  if (/deposit_cheque_location/.test(m)) return 'הצ׳קים בהפקדה צריכים להיות של אותו סניף.';
  if (/deposit_cheques:/.test(m)) return 'עד 200 צ׳קים בהפקדה אחת.';
  if (/deposit_cheque:/.test(m)) return 'מפקידים רק צ׳ק שהתקבל בקבלה של העסק.';
  if (/deposit_empty/.test(m)) return 'מה מפקידים? מזומן, צ׳קים או שניהם.';
  if (/deposit_date/.test(m)) return 'תאריך ההפקדה — היום או לפני.';
  if (/deposit_cash/.test(m)) return 'סכום המזומן לא תקין.';
  if (/deposit_matched/.test(m)) return 'ההפקדה כבר הותאמה לבנק — מבטלים קודם את ההתאמה.';
  if (/deposit_location/.test(m)) return 'בוחרים סניף של העסק.';
  if (/bank_line_closed/.test(m)) return 'השורה כבר הותאמה או טופלה. רעננו.';
  if (/bank_line_not_matched|bank_line_not_handled/.test(m)) return 'השורה כבר לא במצב הזה. רעננו.';
  if (/bank_match_sum/.test(m)) { const x = /add up to (-?[0-9.]+) but the line is (-?[0-9.]+)/.exec(m); return x ? `מה שנבחר (₪${Number(x[1]).toLocaleString('he-IL')}) לא שווה לשורה (₪${Number(x[2]).toLocaleString('he-IL')}).` : 'מה שנבחר לא שווה לסכום השורה.'; }
  if (/bank_match_sign/.test(m)) return 'כסף שנכנס מתאימים לשורת זכות, ותשלום — לשורת חובה.';
  if (/bank_match_item: a cancelled deposit/.test(m)) return 'הפקדה שבוטלה לא מותאמת.';
  if (/bank_match_item:/.test(m)) return 'מתאימים רק כסף שעבר בבנק. מזומן וצ׳קים שהופקדו — דרך ההפקדה שלהם.';
  if (/bank_match_taken/.test(m)) return 'אחד מהם כבר הותאם לשורה אחרת. רעננו.';
  if (/bank_match_items/.test(m)) return 'בוחרים בין 1 ל-50 קבלות, תשלומים או הפקדות.';
  if (/the bank is the whole business/.test(m)) return 'התאמת בנק — רק למי שרואה את כל הסניפים.';
  if (/this location is not yours/.test(m)) return 'הסניף הזה לא שלך.';
  // 2.96 (migration 20261011005100): manual journal entries
  if (/journal_not_allowed/.test(m)) return 'רק הבעלים של העסק (ורואה חשבון שצורף לעסק) רושמים פקודה ידנית.';
  if (/journal_date/.test(m)) return 'תאריך הפקודה — היום או לפני (פקודה הפוכה — מתאריך הפקודה שהיא הופכת ועד היום).';
  if (/journal_kind/.test(m)) return 'סוג הפקודה: הכנסה, הוצאה, מע״מ או אחר.';
  if (/journal_amount/.test(m)) return 'סכום — מספר עד אגורות, ולא אפס.';
  if (/journal_vat_side/.test(m)) return 'מע״מ עסקאות או מע״מ תשומות?';
  if (/journal_vat: an exempt dealer/.test(m)) return 'עוסק פטור לא רושם מע״מ.';
  if (/journal_vat: a VAT entry/.test(m)) return 'פקודת מע״מ — רק סכום מע״מ (בלי סכום לפני מע״מ).';
  if (/journal_vat/.test(m)) return 'פקודה מסוג "אחר" — בלי מע״מ.';
  if (/journal_category/.test(m)) return 'סוג ההוצאה לא תקין.';
  if (/journal_explanation/.test(m)) return 'הסבר — חובה (2 עד 500 תווים).';
  if (/journal_party: a dealer number/.test(m)) return 'ע.מ / ח.פ — 9 ספרות.';
  if (/journal_party: a customer card/.test(m)) return 'הלקוח לא נמצא ברשימת הלקוחות של העסק.';
  if (/journal_party: a name/.test(m)) return 'שם או מספר עוסק של הלקוח / הספק.';
  if (/journal_party/.test(m)) return 'הכנסה שייכת ללקוח, הוצאה — לספק, "אחר" — לאחד מהם; פקודת מע״מ — לאף אחד.';
  if (/journal_location/.test(m)) return 'בוחרים סניף פעיל של העסק.';
  if (/journal_entry:/.test(m)) return 'הפקודה לא נמצאה בעסק הזה.';
  if (/journal_reversed/.test(m)) return 'הפקודה כבר בוטלה בפקודה הפוכה.';
  if (/journal_reverse/.test(m)) return 'פקודה הפוכה לא מבטלים — רושמים פקודה חדשה.';
  if (/reason_required/.test(m)) return 'צריך לכתוב סיבה או הערה (שתי אותיות לפחות).';
  if (/a reason is required/.test(m)) return 'צריך לכתוב סיבה (5 תווים לפחות).';
  if (/42501|row-level security|permission denied|not allowed/i.test(m)) return 'אין הרשאה לפעולה הזו.';
  return 'משהו השתבש. נסו שוב.';
}

/**
 * 2.118: the refusal of a refund receipt (a 400 below zero) — call these ONLY for a refund receipt. Until migration 20261125006800
 * runs on the database, its old checks (documents_validate of 20261011005000) refuse it: first a base document on a receipt
 * ("only a credit invoice points to a base document (or a document made from an order or a delivery note)"), and without one
 * "totals: amounts are positive and the total is above zero". Then say so plainly — and where to complete it after the update
 * (nothing retries by itself). Anything else — financeError.
 */
export const REFUND_RECEIPT_WAITS = 'הקבלה במינוס (החזר כספי) לא הופקה: מסד הנתונים עוד לא עודכן (מיגרציה 20261125006800). ההחזר עצמו נרשם. אחרי העדכון משלימים אותה מהקבלה המקורית ב"כספים ← מסמכים": בקבלה של מכירה (קופה או אתר) — "הפקת הקבלה במינוס", בכל קבלה אחרת — "החזר כספי".';
const OLD_DB = /only a credit invoice points to a base document|totals: amounts are positive|each payment needs a method \(1–9\), an amount above zero/;
/** the old database (before 6800) refused the refund receipt */
export const refundReceiptWaits = (e: unknown) => OLD_DB.test(`${(e as any)?.message ?? e ?? ''} ${(e as any)?.details ?? ''}`);
export function refundReceiptError(e: unknown): string {
  return refundReceiptWaits(e) ? REFUND_RECEIPT_WAITS : financeError(e);
}

export interface IssueExtra {
  userId: string; idempotencyKey: string; vatRate: number; saleId?: string | null; leadId?: string | null; refundId?: string | null;
  paidDocumentId?: string | null; quoteId?: string | null; draftId?: string | null; source?: string;
  /** 2.91 (T12א): the location chosen for a document of its own (else the database decides: its sale, the invoice it pays, …) */
  locationId?: string | null;
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
    ...(x.locationId ? { location_id: x.locationId } : {}),
  };
}
