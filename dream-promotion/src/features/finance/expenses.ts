import { dealerDigits, validIsraeliId } from '@/features/register/billing';
import { ag, pctOf, sh, vatOfGross } from './vat';

/**
 * Expenses ("הוצאות"): supplier invoices and receipts, with the file (PDF / photo / camera) kept in a private bucket.
 * Never deleted — voided with a reason (the database refuses a delete). A confirmed, paid expense is money out in
 * the ledger; products bought come into stock through the same stock log as the register (receive_expense_stock).
 * AI reading a file only fills the form: the user checks and confirms every field before anything is saved
 * (sanitizeExtraction drops anything it can not trust; it never guesses a missing number).
 */
export interface ExpenseCategory { id: string; label: string; vatPct: number; hint?: string }
/** the default VAT share that may be deducted is a suggestion — an accountant confirms it per business */
export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  { id: 'inventory', label: 'סחורה ומלאי', vatPct: 100 },
  { id: 'materials', label: 'חומרי עבודה', vatPct: 100 },
  { id: 'rent', label: 'שכירות', vatPct: 100 },
  { id: 'utilities', label: 'חשמל, מים וארנונה', vatPct: 100 },
  { id: 'communication', label: 'טלפון ואינטרנט', vatPct: 100 },
  { id: 'marketing', label: 'פרסום ושיווק', vatPct: 100 },
  { id: 'software', label: 'תוכנה ומנויים', vatPct: 100 },
  { id: 'professional', label: 'שירותים מקצועיים (רו״ח, עו״ד)', vatPct: 100 },
  { id: 'equipment', label: 'ציוד', vatPct: 100 },
  { id: 'office', label: 'משרד', vatPct: 100 },
  { id: 'vehicle', label: 'רכב ודלק', vatPct: 66.67, hint: 'ברכב פרטי נהוג לקזז רק חלק מהמע״מ — לבדוק עם רו״ח' },
  { id: 'fees', label: 'עמלות בנק וסליקה', vatPct: 100 },
  { id: 'refreshments', label: 'כיבוד', vatPct: 0, hint: 'מע״מ על כיבוד בדרך כלל לא מקוזז' },
  { id: 'commissions', label: 'עמלות עובדים', vatPct: 0, hint: 'שכר ועמלות — בלי מע״מ' },
  { id: 'insurance', label: 'ביטוח', vatPct: 0 },
  { id: 'taxes', label: 'מיסים ואגרות', vatPct: 0 },
  { id: 'other', label: 'אחר', vatPct: 100 },
];
export const categoryLabel = (id: string) => EXPENSE_CATEGORIES.find((c) => c.id === id)?.label ?? id;
export const SUPPLIER_DOC_TYPES: { id: string; label: string }[] = [
  { id: 'tax_invoice', label: 'חשבונית מס' }, { id: 'tax_invoice_receipt', label: 'חשבונית מס / קבלה' }, { id: 'receipt', label: 'קבלה' },
  { id: 'invoice', label: 'חשבונית עסקה' }, { id: 'credit', label: 'חשבונית זיכוי מספק' }, { id: 'other', label: 'אחר' },
];
/** documents that carry VAT a business may deduct (a receipt / transaction invoice does not) */
export const carriesVat = (supplierDocType: string) => supplierDocType === 'tax_invoice' || supplierDocType === 'tax_invoice_receipt' || supplierDocType === 'credit';

export interface Expense {
  id: string; number: number; status: 'draft' | 'confirmed' | 'void'; supplierName: string; supplierDealer: string; supplierDocType: string; supplierDocNumber: string;
  allocationNumber: string; docDate: string; category: string; description: string; amountBeforeVat: number; vatAmount: number; total: number; vatDeductiblePct: number;
  paidOn: string | null; paymentMethod: string | null; filePath: string; fileMime: string; aiModel: string; aiExtracted: unknown; confirmedAt: string | null;
  /** products bought (2.54: a size / colour too — its stock moves) */
  stockLines: { itemId: string; qty: number; variantId?: string }[]; voidReason: string; voidedAt: string | null; createdAt: string;
  /** 2.89: the file's sha256, and "זו הוצאה אחרת" (which expenses it was told apart from, who and when — the database's) */
  fileSha256?: string | null; duplicateAck?: { of: string[]; reasons: string[]; by: string | null; at: string | null } | null;
}
export const toExpense = (r: any): Expense => ({
  id: r.id, number: Number(r.expense_number), status: r.status, supplierName: r.supplier_name ?? '', supplierDealer: r.supplier_dealer ?? '',
  supplierDocType: r.supplier_doc_type ?? 'tax_invoice', supplierDocNumber: r.supplier_doc_number ?? '', allocationNumber: r.allocation_number ?? '',
  docDate: r.doc_date, category: r.category ?? 'other', description: r.description ?? '', amountBeforeVat: Number(r.amount_before_vat), vatAmount: Number(r.vat_amount),
  total: Number(r.total), vatDeductiblePct: Number(r.vat_deductible_pct ?? 100), paidOn: r.paid_on ?? null, paymentMethod: r.payment_method ?? null,
  filePath: r.file_path ?? '', fileMime: r.file_mime ?? '', aiModel: r.ai_model ?? '', aiExtracted: r.ai_extracted ?? null, confirmedAt: r.confirmed_at ?? null,
  stockLines: Array.isArray(r.stock_lines) ? r.stock_lines : [], voidReason: r.void_reason ?? '', voidedAt: r.voided_at ?? null, createdAt: r.created_at,
  fileSha256: r.file_sha256 ?? null,
  duplicateAck: r.duplicate_ack && typeof r.duplicate_ack === 'object'
    ? { of: Array.isArray(r.duplicate_ack.of) ? r.duplicate_ack.of : [], reasons: Array.isArray(r.duplicate_ack.reasons) ? r.duplicate_ack.reasons : [],
        by: r.duplicate_ack.by ?? null, at: r.duplicate_ack.at ?? null } : null,
});

/** the amounts from a total that includes VAT (a supplier tax invoice) or none (a receipt / an exempt supplier) */
export function splitTotal(total: number, rate: number): { amountBeforeVat: number; vatAmount: number; total: number } {
  const tA = ag(total), vA = vatOfGross(tA, rate);
  return { amountBeforeVat: sh(tA - vA), vatAmount: sh(vA), total: sh(tA) };
}
/**
 * The VAT this expense lets the business deduct (only a VAT business, only on a document that carries VAT): in whole agorot,
 * rounded as the database's summary does (round(vat × % / 100, 2)), so the screen, the CSV and the report agree.
 */
export const vatDeductible = (e: Pick<Expense, 'vatAmount' | 'vatDeductiblePct' | 'supplierDocType'>, businessChargesVat: boolean) =>
  businessChargesVat && carriesVat(e.supplierDocType) ? sh(pctOf(ag(e.vatAmount), e.vatDeductiblePct)) : 0;

export interface ExpenseForm {
  supplierName: string; supplierDealer: string; supplierDocType: string; supplierDocNumber: string; allocationNumber: string; docDate: string; category: string;
  description: string; amountBeforeVat: number; vatAmount: number; total: number; vatDeductiblePct: number; paidOn: string | null; paymentMethod: string | null;
}
export function expenseError(f: ExpenseForm, today: string, lockedUntil: string | null = null): string | null {
  if (!f.supplierName.trim()) return 'חסר שם הספק';
  const d = dealerDigits(f.supplierDealer);
  if (d && (d.length !== 9 || !validIsraeliId(d))) return 'מספר העוסק של הספק לא תקין (9 ספרות עם ספרת ביקורת)';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.docDate) || f.docDate > today) return 'תאריך המסמך לא יכול להיות בעתיד';
  if (lockedUntil && f.docDate <= lockedUntil) return `הספרים סגורים עד ${lockedUntil.split('-').reverse().join('/')} — אי אפשר לרשום הוצאה בתאריך הזה`;
  if (!(f.total > 0)) return 'הסכום הכולל חייב להיות גדול מאפס';
  if (f.amountBeforeVat < 0 || f.vatAmount < 0) return 'סכומים לא יכולים להיות שליליים';
  if (ag(f.amountBeforeVat) + ag(f.vatAmount) !== ag(f.total)) return 'סכום לפני מע״מ + מע״מ צריך להיות שווה לסה״כ';
  if (ag(f.vatAmount) > 0 && !carriesVat(f.supplierDocType)) return 'בקבלה או בחשבונית עסקה אין מע״מ לקיזוז — הסכום לפני מע״מ הוא הסה״כ';
  if (f.allocationNumber && !/^\d{1,20}$/.test(f.allocationNumber)) return 'מספר הקצאה — ספרות בלבד';
  if (f.vatDeductiblePct < 0 || f.vatDeductiblePct > 100) return 'אחוז המע״מ לקיזוז — בין 0 ל-100';
  if ((f.paidOn == null) !== (f.paymentMethod == null)) return 'אם שולם — צריך תאריך תשלום ואמצעי תשלום';
  if (f.paidOn && (f.paidOn > today || !/^\d{4}-\d{2}-\d{2}$/.test(f.paidOn))) return 'תאריך התשלום לא יכול להיות בעתיד';
  return null;
}
export const expenseColumns = (f: ExpenseForm) => ({
  supplier_name: f.supplierName.trim().slice(0, 120), supplier_dealer: dealerDigits(f.supplierDealer), supplier_doc_type: f.supplierDocType,
  supplier_doc_number: f.supplierDocNumber.trim().slice(0, 40), allocation_number: f.allocationNumber.trim(), doc_date: f.docDate, category: f.category,
  description: f.description.trim().slice(0, 300), amount_before_vat: f.amountBeforeVat, vat_amount: f.vatAmount, total: f.total,
  vat_deductible_pct: f.vatDeductiblePct, paid_on: f.paidOn, payment_method: f.paymentMethod,
});

// ---- reading a supplier document with AI: only what can be trusted reaches the form ------------------------------
export interface Extraction {
  supplierName?: string; supplierDealer?: string; supplierDocType?: string; supplierDocNumber?: string; allocationNumber?: string; docDate?: string;
  amountBeforeVat?: number; vatAmount?: number; total?: number; category?: string; description?: string;
}
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[₪,\s]/g, '')) : NaN;
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? Math.round(n * 100) / 100 : undefined;
};
const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
/**
 * The model's answer → form fields + warnings. Unreadable or impossible values are dropped (left for the user), never
 * guessed: a dealer number must pass the check digit, a date must be a real date not in the future, the amounts must
 * add up (else only the total is kept), the category must be one of ours.
 */
export function sanitizeExtraction(raw: unknown, today: string): { fields: Extraction; warnings: string[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const f: Extraction = {};
  const warnings: string[] = [];
  f.supplierName = str(r.supplierName, 120);
  const dealer = typeof r.supplierDealer === 'string' || typeof r.supplierDealer === 'number' ? dealerDigits(String(r.supplierDealer)) : '';
  if (dealer) { if (dealer.length === 9 && validIsraeliId(dealer)) f.supplierDealer = dealer; else warnings.push('מספר העוסק של הספק לא נקרא בוודאות — לא מולא'); }
  if (typeof r.supplierDocType === 'string' && SUPPLIER_DOC_TYPES.some((t) => t.id === r.supplierDocType)) f.supplierDocType = r.supplierDocType;
  f.supplierDocNumber = str(r.supplierDocNumber, 40);
  const alloc = typeof r.allocationNumber === 'string' || typeof r.allocationNumber === 'number' ? String(r.allocationNumber).replace(/\D/g, '') : '';
  if (alloc) { if (alloc.length >= 6 && alloc.length <= 20) f.allocationNumber = alloc; else warnings.push('מספר ההקצאה לא נקרא בוודאות — לא מולא'); }
  if (typeof r.docDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.docDate) && !Number.isNaN(Date.parse(`${r.docDate}T12:00:00Z`))) {
    if (r.docDate <= today && r.docDate >= '2000-01-01') f.docDate = r.docDate; else warnings.push('התאריך שנקרא לא סביר — לא מולא');
  }
  const before = num(r.amountBeforeVat), vat = num(r.vatAmount), total = num(r.total);
  if (total !== undefined && total > 0) {
    f.total = total;
    if (before !== undefined && vat !== undefined) {
      if (ag(before) + ag(vat) === ag(total)) { f.amountBeforeVat = before; f.vatAmount = vat; }
      else warnings.push('הסכומים שנקראו לא מסתכמים — מולא רק הסה״כ; צריך לבדוק את פירוק המע״מ');
    }
  } else if (r.total !== undefined && r.total !== null) warnings.push('הסכום הכולל לא נקרא בוודאות — לא מולא');
  if (typeof r.category === 'string' && EXPENSE_CATEGORIES.some((c) => c.id === r.category)) f.category = r.category;
  f.description = str(r.description, 300);
  for (const k of Object.keys(f) as (keyof Extraction)[]) if (f[k] === undefined) delete f[k];
  return { fields: f, warnings };
}

// ---- a duplicate expense (2.89, migration 20261010004400): a warning, never a block --------------------------------------
/** the same rule as the database's expense_norm_supplier: lower case, letters (Latin / Hebrew) and digits only */
export const normalizeSupplier = (s: string) => (s ?? '').toLowerCase().replace(/[^0-9a-zא-ת]+/g, '');
/** expense_norm_number: letters and digits only, no leading zeros ("INV-0012" → "inv0012", "000345" → "345") */
export function normalizeDocNumber(s: string): string {
  const x = (s ?? '').toLowerCase().replace(/[^0-9a-zא-ת]+/g, '');
  if (!x) return '';
  return x.replace(/^0+/, '') || '0';
}
export type DuplicateReason = 'file' | 'number' | 'amount_date';
export interface DuplicateMatch {
  id: string; number: number; docDate: string; createdAt: string; supplierName: string; supplierDocNumber: string; total: number; status: string; reasons: DuplicateReason[];
}
export const toDuplicate = (r: any): DuplicateMatch => ({
  id: r.id, number: Number(r.expense_number), docDate: r.doc_date, createdAt: r.created_at, supplierName: r.supplier_name ?? '',
  supplierDocNumber: r.supplier_doc_number ?? '', total: Number(r.total), status: r.status, reasons: (Array.isArray(r.reasons) ? r.reasons : []) as DuplicateReason[],
});
export interface DuplicateQuery { sha: string | null; dealer: string; supplier: string; docNumber: string; total: number | null; docDate: string | null }
const SHA = /^[0-9a-f]{64}$/;
/**
 * Why an expense may repeat another (the database's expense_duplicates, for one row — the e2e fake and the tests use this):
 *   file         the same file (its sha256)
 *   number       the same supplier (both dealer numbers when both have one, else the name) and the same document number
 *   amount_date  the same supplier, total and date
 * A void expense never counts.
 */
export function duplicateReasons(q: DuplicateQuery, e: { fileSha256?: string | null; supplierDealer: string; supplierName: string; supplierDocNumber: string;
                                                          total: number; docDate: string; status: string }): DuplicateReason[] {
  if (e.status === 'void') return [];
  const out: DuplicateReason[] = [];
  if (q.sha && SHA.test(q.sha) && e.fileSha256 === q.sha) out.push('file');
  const dealers = /^\d{9}$/.test(q.dealer) && /^\d{9}$/.test(e.supplierDealer);
  const sup = normalizeSupplier(q.supplier);
  const sameSupplier = dealers ? e.supplierDealer === q.dealer : sup !== '' && normalizeSupplier(e.supplierName) === sup;
  const num = normalizeDocNumber(q.docNumber);
  if (sameSupplier && num !== '' && normalizeDocNumber(e.supplierDocNumber) === num) out.push('number');
  if (sameSupplier && q.total != null && q.docDate && ag(e.total) === ag(q.total) && e.docDate === q.docDate) out.push('amount_date');
  return out;
}
const ddmmyy = (d: string) => (d ? d.split('-').reverse().join('/') : '');
/** the warning, in the words of the owner's screen */
export function duplicateMessage(m: Pick<DuplicateMatch, 'number' | 'docDate' | 'reasons'>): string {
  if (m.reasons.includes('file')) return `הקובץ הזה כבר נקלט בהוצאה #${m.number} מתאריך ${ddmmyy(m.docDate)}.`;
  const why = m.reasons.includes('number') ? 'אותו ספק ואותו מספר מסמך' : 'אותו ספק, אותו סכום ואותו תאריך';
  return `נראה שההוצאה הזו כבר קיימת: ${why} — הוצאה #${m.number} מתאריך ${ddmmyy(m.docDate)}.`;
}
/** what "זו הוצאה אחרת" keeps (the database adds who and when) */
export const duplicateAck = (matches: Pick<DuplicateMatch, 'id' | 'reasons'>[]) => ({
  of: matches.slice(0, 10).map((m) => m.id),
  reasons: [...new Set(matches.flatMap((m) => m.reasons))].slice(0, 3),
});
/** a file's sha256, in hex (Web Crypto: the browser, and Node in the tests) */
export async function fileSha256(file: Blob): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
