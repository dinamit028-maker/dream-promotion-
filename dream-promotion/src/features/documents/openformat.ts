/**
 * "ממשק פתוח" — the unified-structure files of the Israel Tax Authority, spec v1.31 (10.05.2009):
 * INI.TXT + BKMVDATA.TXT, fixed-width records, ISO-8859-8 (logical Hebrew), CRLF after each record.
 * This module produces the documents part (C100 / D110 / D120). The software keeps no books (B100/B110 — field 1013 = 0, "not
 * relevant", spec p. 10). It does keep stock (per location, from 2.92), but this export writes no M100 ("פריטים במלאי", §4.8,
 * p. 17) records — whether it has to is an open question (22.11.2026). Every field position below is from the spec.
 * Checked against the official text (horaot-131.pdf, 22 pages) on 22.11.2026: pages 6, 10, 12, 13, 21 — see each change.
 * 2.120 (26.11.2026, against the same text, pdftotext): the branch fields and 1034 (seriesNumber, BranchInfo below) and the bank
 * deposit 420 (C100 + D120, no D110).
 * 2.124 (stage 4ה — the accountant's answer 9, 25.11.2026: 1013 = 2; checked against horaot-131.pdf, pdftotext, 28.11.2026:
 * A000 p. 10, §4.6 B100 p. 15, §4.7 B110 p. 16, §2.4יא p. 7, clarifications 7, 8, 12 p. 21–22): a period inside the time of the
 * double-entry books (from gl_books.start_date on — booksPeriod) is written from the books — a B100 per line of an entry and a B110
 * per account (BooksFile, booksAccountsOf), 1013 = 2 and 1014 = 1. A period before the start — exactly as before (1013 = 0, the
 * customers' cards of accountsOf). A period across the start is not written (BOOKS_PERIOD_SPLIT).
 */
import { glCustomerKey } from './customer-key';

export const SYSTEM_CONST = '&OF1.31&';

// ---------- field formatting (spec 2.3 / 2.4) ----------
/** numeric 9(n): digits only, zero-padded on the left */
export const N = (v: number | string | null | undefined, len: number) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length > len ? d.slice(-len) : d.padStart(len, '0');
};
/** alphanumeric X(n): left-aligned, space-padded on the right — the text first made writable in ISO-8859-8 (isoText) */
export const X = (v: string | null | undefined, len: number) => {
  const s = isoText(String(v ?? ''));
  return s.length > len ? s.slice(0, len) : s.padEnd(len, ' ');
};
/** signed amount X9(int)v99: sign, integer digits zero-padded, 2 decimals, no point — e.g. +00000000124565 */
export const AMT = (v: number, intDigits = 12, dec = 2) => {
  const cents = Math.round(Math.abs(v) * 10 ** dec);
  return (v < 0 ? '-' : '+') + String(cents).padStart(intDigits + dec, '0').slice(-(intDigits + dec));
};
export const yyyymmdd = (d: string) => d.replace(/-/g, '').slice(0, 8);
/**
 * A document's number as written in every field that carries it — 1204 (C100), 1257 (D110, the base), 1304 (D120), 1357 / 1359
 * (B100, not written by Dream) — X(20) (spec p. 12–14). §2.4ד (p. 6, checked against horaot-131.pdf 26.11.2026): a number of
 * digits only may be written as it is or with leading zeros ("00000000000000001234 או 1234"), the same way in every field.
 * 2.120 (migration 20261127007000 — the accountant's answer 5, the owner's decision of 26.11.2026): a number of a location's
 * series is the branch code and then six digits (code × 1,000,000 + n ≥ 1,000,001) and is written with its eight digits
 * (01000001); the business's own series is below 1,000,000 and is written exactly as before (String(n)). The screens show the
 * same (docNumberLabel, documents.ts — it calls this).
 */
export const seriesNumber = (n: number | string | null | undefined): string => {
  if (n == null || n === '') return '';
  const v = Number(n);
  return Number.isSafeInteger(v) && v >= 1_000_000 && v <= 99_999_999 ? String(v).padStart(8, '0') : String(n);
};

/**
 * Spec §2.4ח (p. 6, checked 22.11.2026): the files are written in ISO-8859-8-i (logical Hebrew) — field 1029 = 1 (p. 10).
 * That set has ASCII and the 27 Hebrew letters only (for us): the marks the app itself writes ("מס׳", "בע״מ", "זיכוי — …", "₪")
 * and what a phone's keyboard adds (direction marks, a non-breaking space, curly quotes) have no place in it and came out as "?".
 * Here each one becomes the nearest character the set has — before a field is padded / cut, so the record keeps its fixed length
 * (₪ is three characters: ש"ח). The mapping is ours (the spec names the set only), as the plain-text way of writing these marks.
 */
const ONE: Record<string, string> = {
  '\u05F3': "'", '\u05F4': '"',                                                   // ׳ geresh, ״ gershayim
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'",       // ‘ ’ ‚ ‛ ′
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"', '\u2033': '"',       // “ ” „ ‟ ″
  '\u05BE': '-', '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-', // ־ maqaf, dashes, minus
};
/** a character that is not written at all: direction marks and embeddings, zero-width characters, Hebrew points (niqqud) */
const DROP = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF\u0591-\u05BD\u05BF-\u05C7]/g;
/** a space of another kind (non-breaking, thin, narrow …) and any control character (tab, CR, LF) → a plain space */
const SPACE = /[\u0000-\u001F\u007F\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;
/** text as it may be written in the file (2.4ח): the marks above as their plain form, ₪ as ש"ח, … as ..., the rest as is */
export function isoText(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(DROP, '').replace(SPACE, ' ').replace(/\u20AA/g, 'ש"ח').replace(/\u2026/g, '...')
    .replace(/[\u05F3\u05F4\u2018-\u201F\u2032\u2033\u05BE\u2010-\u2015\u2212]/g, (c) => ONE[c] ?? c);
}
/**
 * ISO-8859-8 (logical): ASCII as is, Hebrew letters U+05D0–U+05EA → 0xE0–0xFA. One byte per character, always (a record keeps
 * its length): the marks of isoText that have a one-character form get it here too, a space of another kind or a direction
 * mark is a space, anything else '?'. Every field already went through isoText (X); this is the last guard of the bytes.
 */
export function toIso88598(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0d || c === 0x0a || (c >= 0x20 && c < 0x7f)) { out[i] = c; continue; }   // ASCII (CR LF end a record — §2.4ט)
    if (c >= 0x05d0 && c <= 0x05ea) { out[i] = c - 0x05d0 + 0xe0; continue; }
    const one = ONE[s[i]];
    out[i] = one ? one.charCodeAt(0) : /[\s\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF]/.test(s[i]) ? 0x20 : 0x3f;
  }
  return out;
}

// ---------- the business and the documents ----------
export interface Business {
  dealerNumber: string; companyNumber?: string; name: string; street?: string; houseNo?: string; city?: string; zip?: string;
  /** 2.118: the business's deductions file number (תיק ניכויים) — field 1016 (register_settings.deductions_file, 9 digits or none) */
  deductionsFile?: string | null;
}
export interface SoftwareInfo { regNumber: string; name: string; version: string; vendorVat: string; vendorName: string }
/** itemId ties a line to the price list (stock); restock marks a credit line whose goods came back (2.51); variantId: the
 *  size / colour sold (2.54 — the database moves that variant's stock; not part of the file to the Tax Authority) */
export interface DocLine { name: string; qty: number; unitPriceExVat: number; discountExVat: number; totalExVat: number; vatRate: number; kind: 1 | 2 | 3; itemId?: string; variantId?: string; restock?: boolean }
/** method = field 1306; m = the app's own method (Bit: 9 "other" before 2.118, 4 "bank transfer" from 2.118 — the accountant,
 *  answer 12); cheque = fields 1307–1311 (2.51) */
export interface DocPayment {
  method: number; amount: number; date: string; m?: string; cheque?: { bank?: string; branch?: string; account?: string; number?: string; dueDate?: string };
  /** 2.94: tax withheld at source (m 'withholding', method 9) — the percent on the customer's certificate */
  pct?: number;
  /** 2.118: a card payment's credit transaction kind — field 1315 (1 regular, 2 installments, 3 credit, 4 deferred, 5 other) */
  cardKind?: number;
  /** 2.121 (migration 20261128007100 — answer 8 of stage 4): a card payment in installments (cardKind 2) — how many (2–36) and
   *  when the first is charged (YYYY-MM-DD; none = the payment's day). For the books (a line per installment) — not a field of
   *  the unified file: D120 writes the payment as before (1315 = 2) */
  installments?: number;
  firstDue?: string;
}
export interface Doc {
  docType: number; docNumber: number; linkNo: number; issuedAt: string /* ISO */; docDate: string /* YYYY-MM-DD */;
  customerName: string; customerPhone?: string; customerDealer?: string; customerStreet?: string; customerCity?: string; customerKey?: string;
  beforeDiscount: number; discount: number; afterDiscount: number; vatAmount: number; total: number;
  baseDocType?: number | null; baseDocNumber?: number | null; issuedBy?: string; lines: DocLine[]; payments: DocPayment[];
  /** a receipt / transaction invoice cancelled after issue (document_cancellations, 2.51) — field 1228 */
  cancelled?: boolean;
  /** who in the business issued it (documents.user_id) — its code goes into field 1233 (operatorOf) */
  userId?: string | null;
  /** the invoice this receipt pays (documents.paid_document_id: a 400 pays a 305 / 300, a 320 pays a 300) — B110 (accountsOf) */
  paidDocumentId?: string | null;
  /** 2.91: the location it was issued in (none = the main one — the business's id) — its branch code goes into the branch fields */
  locationId?: string | null;
}

/**
 * 2.120 — branches (spec clarification 3, appendix 5.5, p. 21; A000 field 1034, p. 10; checked against horaot-131.pdf
 * 26.11.2026): "כאשר לעסק יש כמה סניפים … יש לעדכן את ערך מזהה זה. בנוסף לכך יש לעדכן את השדה 1034 בערך 1". The branch id,
 * X(7), "מספר הסניף/ענף כפי שמופיע ברישומי בית העסק", "חובה כאשר ערך שדה 1034 = 1":
 *   C100 1231 (positions 409–415), D110 1270 (290–296), D110 1274 "מזהה סניף/ענף למסמך בסיס" (312–318), D120 1320 (141–147),
 *   B110 1421 (336–342); B100 1374 — Dream writes no B100.
 *   NOTE: clarification 3 lists "1231, 1270, 1320, 1374, 1421, 1272" — but in the D110 table itself 1272 is "תאריך המסמך"
 *   (297–304, 9(8)) and the base document's branch is 1274. We write the table (1274) and keep 1272 the date — an open question
 *   for the simulator / the accountant (26.11.2026).
 * Dream: a business that numbers per location (document_numbering — the owner's one-way switch, migration 7000) writes 1034 = 1
 * and every document's location's branch code (business_locations.branch_code, '01'–'99'). A business that did not switch —
 * 1034 = 0 and the fields empty, exactly as before (even with several locations: an open question for the accountant, 26.11.2026).
 */
export interface BranchInfo {
  /** the business numbers per location (document_numbering_state().perLocation) */
  perLocation: boolean;
  /** the business's id — the main location's id (a document with no location is the main one's) */
  businessId: string;
  /** location id → its branch code */
  codes: ReadonlyMap<string, string>;
  /** a base document ("type:number") → its location, for a base not among the documents of the file */
  baseLocations?: ReadonlyMap<string, string | null>;
}
/** the branch code of a location (empty when unknown — never made up) */
export const branchOf = (info: BranchInfo | null | undefined, locationId: string | null | undefined): string =>
  info?.perLocation ? info.codes.get(locationId || info.businessId) ?? '' : '';
/** a base document's branch: its row (in the file, or looked up by the caller), else — a number of a location's series carries
 *  its branch code in its first two digits (seriesNumber) */
export function baseBranchOf(info: BranchInfo | null | undefined, d: Pick<Doc, 'baseDocType' | 'baseDocNumber'>, inFile?: ReadonlyMap<string, Doc>): string {
  if (!info?.perLocation || !d.baseDocType || !d.baseDocNumber) return '';
  const k = `${d.baseDocType}:${d.baseDocNumber}`;
  const row = inFile?.get(k);
  if (row) return branchOf(info, row.locationId);
  if (info.baseLocations?.has(k)) return branchOf(info, info.baseLocations.get(k));
  return Number(d.baseDocNumber) >= 1_000_000 ? seriesNumber(d.baseDocNumber).slice(0, 2) : '';
}

/**
 * 2.120 — a bank deposit, 420 "הפקדת בנק" (appendix 1, §5.1, p. 18; D120 "פרטי קבלה / הפקדה", §4.5, p. 14; checked against
 * horaot-131.pdf 26.11.2026). Issued by bank_deposit_create (migration 7000): no customer, no lines, no VAT; its payments are the
 * cash (1306 = 1) and each cheque (2, with 1307–1311 from the receipt's payment), each dated the deposit's day. In the file:
 * C100 (1219 = 1221 = 1223 = the amount, 1220 = 1222 = 0, 1216 "תאריך ערך" = the day of the deposit — its payments' date,
 * 1228 = 1 when it was cancelled with its deposit) and a D120 per payment; no D110 (NO_D110).
 * 1207 and 1225 are "חובה כאשר קוד מסמך בטווח 100–710" and every 1225 must be an account of the file (the simulator, 25.11.2026:
 * "מפתח לקוח אינו קיים באינדקס חשבונות (B110)"): a deposit is written to the bank's account — DEPOSIT_KEY / DEPOSIT_NAME, its
 * B110 with its own trial-balance code (DEPOSIT_CODE) and no movements. Ours, not the spec's — for the accountant to confirm.
 */
export const DEPOSIT_KEY = 'BANK';
export const DEPOSIT_NAME = 'בנק';
export const DEPOSIT_CODE = 'BANK';
const isDeposit = (d: Pick<Doc, 'docType'>) => d.docType === 420;
/** field 1216 of a document: its date — a deposit's, the day of the deposit (its payments' date) */
const valueDate = (d: Pick<Doc, 'docType' | 'docDate' | 'payments'>) =>
  isDeposit(d) && d.payments[0]?.date && /^\d{4}-\d{2}-\d{2}$/.test(d.payments[0].date) ? d.payments[0].date : d.docDate;

/**
 * Field 1258 "סוג עסקה" (spec p. 13, checked 22.11.2026): 1 service, 2 sale (מכר), 3 service and sale. A line of the price list
 * carries its kind ('service' | 'product' | 'package' | 'other' — catalog.ts): a product is a sale (2); a service, a package, a
 * line typed by hand (no kind) and anything else — a service (1), as every line was before 2.117. Only new documents get it:
 * a document keeps the kind it was issued with (old ones — 1), and the file writes what the document has.
 */
export const txKind = (l: { kind?: string | null }): 1 | 2 => (l.kind === 'product' ? 2 : 1);

const ag = (v: number) => Math.round(v * 100);
const isWithholding = (p: DocPayment) => p.m === 'withholding';
/**
 * Tax withheld at source in the file — spec clarification 4 (p. 21, checked 22.11.2026), field 1224 (p. 12, "בקבלה בלבד, אם
 * נוכה"): "a customer paid a debt of 1250 ₪ but withheld 250 ₪ at source: fields 1219, 1221, 1223 = 1000 ₪, field 1224 = 250 ₪,
 * fields 1220, 1222 = 0 ₪"; 1223 — "בקבלה, סכום ללא הניכוי במקור"; 1224 is positive (§2.4יב, p. 6). The document itself keeps the
 * withholding as one of its payments (m 'withholding', 2.94) and is not changed: only the file is written this way.
 * A receipt (400) only. A tax invoice-receipt (320) with tax withheld is written as before (1224 = 0, a D120 line of code 9):
 * the clarification's example is a receipt without VAT, and what 1219 / 1221 (before VAT) of a 320 should be is not written —
 * an open question to the accountant (22.11.2026).
 */
export const withheldOf = (d: Pick<Doc, 'docType' | 'payments'>): number =>
  d.docType === 400 ? d.payments.filter(isWithholding).reduce((a, p) => a + ag(p.amount), 0) / 100 : 0;
/** field 1223 of a document as the file writes it (a receipt — without the tax withheld, clarification 4); the printout of
 *  §2.6ב (docTypeReport) sums this same number, so the report and the file agree (spec p. 9: "פלטים לאימות נתונים") */
export const fileTotal = (d: Pick<Doc, 'docType' | 'payments' | 'total'>): number => (ag(d.total) - ag(withheldOf(d))) / 100;
/** the D120 lines of a document: a receipt's withholding is in 1224, not a payment line — so the D120 lines add up to 1223 */
export const filePayments = (d: Pick<Doc, 'docType' | 'payments'>): DocPayment[] =>
  d.docType === 400 ? d.payments.filter((p) => !isWithholding(p)) : d.payments;
/**
 * Field 1233 "מבצע הפעולה" — "שם המשתמש של מבצע הפעולה", X(9), ח/ר (spec p. 12, checked 22.11.2026). The owner of the system
 * (22.11.2026): a short code per person of the business (member_doc_codes: U01, U02 …) — never a name or another personal detail.
 * A document that names its issuer (the site's: 'אתר', and the credits made from them) keeps it, as before; without a code
 * (the table is not in the database yet, or a document without user_id) — empty, as before.
 */
/** member_doc_codes rows → user_id → code (only a code that fits field 1233: up to 9 letters / digits) */
export function docCodesMap(rows: unknown): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const u = (r as any)?.user_id, c = (r as any)?.code;
    if (typeof u === 'string' && u && typeof c === 'string' && /^[A-Za-z0-9]{1,9}$/.test(c)) m.set(u, c);
  }
  return m;
}
export function operatorOf(d: Pick<Doc, 'issuedBy' | 'userId'>, codes?: ReadonlyMap<string, string>): string {
  if (d.issuedBy) return d.issuedBy;
  const c = d.userId ? codes?.get(d.userId) : undefined;
  return c && c.length <= 9 ? c : '';
}
const ilTime = (iso: string) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return { date: `${p.year}${p.month}${p.day}`, time: `${p.hour}${p.minute}` };
};

// ---------- BKMVDATA.TXT records ----------
export const A100 = (rec: number, b: Business, id: string) =>
  'A100' + N(rec, 9) + N(b.dealerNumber, 9) + N(id, 15) + X(SYSTEM_CONST, 8) + X('', 50); // 95

export const Z900 = (rec: number, b: Business, id: string, total: number) =>
  'Z900' + N(rec, 9) + N(b.dealerNumber, 9) + N(id, 15) + X(SYSTEM_CONST, 8) + N(total, 15) + X('', 50); // 110

/**
 * field 1225 "מפתח הלקוח אצל המוכר" X(15), as written — the same 15 characters are 1403 of the customer's B110.
 * 2.121 (stage 4ב; the plan's note 20 — the brain's decision, 27.11.2026: a file already given is never written differently):
 *   * a document dated on / after the business's books start (booksStart — gl_books_state().startDate, migration 20261128007100):
 *     the customer's account key in the books (glCustomerKey = public.gl_customer_key, customer-key.ts — cleaned as the file writes
 *     text, cut to 15, "C-" when it looks like a system account's key: four digits, or BANK — the deposit's DEPOSIT_KEY);
 *   * any other document (dated before the start; no books start — a database before 7100): exactly as before 2.121 —
 *     the phone, else the name, else 'CASH' (legacyCustomerKey).
 * A customer with documents on both sides of the start may so have two keys in one file — each one is its own B110 (accountsOf).
 */
export const legacyCustomerKey = (d: Pick<Doc, 'customerPhone' | 'customerName'>) => d.customerPhone || d.customerName || 'CASH';
export const customerKeyField = (d: Pick<Doc, 'customerKey' | 'customerPhone' | 'customerName'> & { docType?: number; docDate?: string }, booksStart?: string | null) =>
  X(d.docType === 420 ? DEPOSIT_KEY : d.customerKey
    ?? (booksStart && d.docDate && d.docDate >= booksStart ? glCustomerKey(d.customerPhone, d.customerName) : legacyCustomerKey(d)), 15);

export function C100(rec: number, b: Business, d: Doc, operator: string = d.issuedBy ?? '', branch = '', booksStart: string | null = null) {
  const t = ilTime(d.issuedAt);
  const wA = ag(withheldOf(d));                                       // clarification 4: a receipt's amounts without the withholding
  const less = (v: number) => (ag(v) - wA) / 100;
  // a credit invoice is positive; its type gives the meaning (clarification 1). 2.118: an exempt dealer's refund receipt (a 400
  // below zero — the accountant's answer 15) is written with its own sign: §2.4יב (p. 6) "משמעות המסמך … בהתאם לסוג המסמך ולא
  // בהתאם לערך המסמך", and the table of document types (appendix 1, p. 18): "כאשר ערך המסמך שלילי, ההשפעה הפוכה" — 1219, 1221,
  // 1223 below zero (1220 and 1222 are 0). The receipt it refunds (1256/1257) is not in the file: those fields are D110's only,
  // and a 400 has no D110 (NO_D110, below) — open question for the simulator / the accountant (25.11.2026).
  const sign = (v: number) => (d.docType === 330 ? v : v);
  return 'C100' + N(rec, 9) + N(b.dealerNumber, 9) + N(d.docType, 3) + X(seriesNumber(d.docNumber), 20)   // 1204 (seriesNumber)
    + N(t.date, 8) + N(t.time, 4)                                   // 1205, 1206
    + X(isDeposit(d) ? DEPOSIT_NAME : d.customerName || 'לקוח מזדמן', 50) + X(d.customerStreet, 50) + X('', 10) + X(d.customerCity, 30) + X('', 8) // 1207–1211
    + X('', 30) + X('', 2) + X(d.customerPhone, 15) + N(d.customerDealer || 0, 9)   // 1212–1215
    + N(yyyymmdd(valueDate(d)), 8)                                    // 1216 value date (a deposit: its day — valueDate)
    + AMT(0) + X('', 3)                                               // 1217, 1218 (export only)
    + AMT(sign(less(d.beforeDiscount))) + AMT(-Math.abs(d.discount)) + AMT(sign(less(d.afterDiscount))) // 1219, 1220 (negative), 1221
    + AMT(sign(d.vatAmount)) + AMT(sign(fileTotal(d))) + AMT(wA / 100, 9) // 1222, 1223, 1224 withholding (positive — clarification 4)
    + customerKeyField(d, booksStart)                                // 1225 customer key (= 1403 of its B110; 2.121 — booksStart)
    + X('', 10)                                                       // 1226 matching field
    + X(d.cancelled ? '1' : '', 1)                                    // 1228 cancelled: a 300 / 400 cancelled after issue (a tax invoice gets a credit invoice instead)
    + N(yyyymmdd(d.docDate), 8)                                       // 1230 document date
    + X(branch, 7)                                                    // 1231 branch (BranchInfo; empty unless 1034 = 1)
    + X(operator, 9) + N(d.linkNo, 7) + X('', 13);                    // 1233 (operatorOf), 1234, 1235 → 444
}

export function D110(rec: number, b: Business, d: Doc, line: DocLine, lineNo: number, branch = '', baseBranch = '') {
  return 'D110' + N(rec, 9) + N(b.dealerNumber, 9) + N(d.docType, 3) + X(seriesNumber(d.docNumber), 20) + N(lineNo, 4)
    + N(d.baseDocType ?? 0, 3) + X(d.baseDocNumber ? seriesNumber(d.baseDocNumber) : '', 20)  // 1256, 1257
    + N(line.kind === 2 || line.kind === 3 ? line.kind : 1, 1) + X('', 20) + X(line.name, 30) + X('', 50) + X('', 30) + X('יחידה', 20) // 1258–1263
    + AMT(line.qty, 12, 4) + AMT(line.unitPriceExVat) + AMT(-Math.abs(line.discountExVat)) + AMT(line.totalExVat) // 1264–1267
    + N(Math.round(line.vatRate * 100), 4)                             // 1268 (18% → 1800)
    + X(branch, 7) + N(yyyymmdd(d.docDate), 8) + N(d.linkNo, 7) + X(baseBranch, 7) + X('', 21); // 1270, 1272, 1273, 1274 (base's branch), 1275 → 339
}

/**
 * Field 1315 "סוג עסקת האשראי" 9(1), ח/ר (spec §4.5, p. 14, checked against horaot-131.pdf 25.11.2026): 1 רגיל, 2 תשלומים,
 * 3 קרדיט, 4 חיוב נדחה, 5 אחר. From 2.118 a card payment carries its kind (cardKind — asked at issue, the accountant's answer 13,
 * 25.11.2026). A card payment of a document issued before has none — written 1, exactly as before; not a card — 0, as before.
 */
export const cardKindField = (p: Pick<DocPayment, 'method' | 'cardKind'>): number =>
  p.method !== 3 ? 0 : [1, 2, 3, 4, 5].includes(Number(p.cardKind)) && Number.isInteger(p.cardKind) ? Number(p.cardKind) : 1;

export function D120(rec: number, b: Business, d: Doc, p: DocPayment, lineNo: number, branch = '') {
  const c = p.method === 2 ? p.cheque : undefined;                      // a cheque's bank, branch, account, number, due date (2.51)
  return 'D120' + N(rec, 9) + N(b.dealerNumber, 9) + N(d.docType, 3) + X(seriesNumber(d.docNumber), 20) + N(lineNo, 4)
    + N(p.method, 1) + N(c?.bank || 0, 10) + N(c?.branch || 0, 10) + N(c?.account || 0, 15) + N(c?.number || 0, 10) // 1306–1310
    + N(c?.dueDate ? yyyymmdd(c.dueDate) : p.method === 3 ? yyyymmdd(p.date) : 0, 8) // 1311 cheque due date / card payment date
    + AMT(p.amount) + N(0, 1) + X('', 20) + N(cardKindField(p), 1)        // 1312–1315 (1312 signed: a refund receipt's money back is below zero)
    + X(branch, 7) + N(yyyymmdd(d.docDate), 8) + N(d.linkNo, 7) + X('', 60);  // 1320 branch, 1322, 1323, 1324 → 222
}

// ---------- INI.TXT ----------
/**
 * A000 1013 "סוג הנהח"ש של התוכנה" 9(1), position 185: "0 = לא רלוונטי, 1 = חד צידית, 2 = כפולה"; 1014 "איזון חשבונאי נדרש" 9(1),
 * position 186: "1 = רמת התנועה, 2 = רמת המנה. בהנהלת חשבונות כפולה חובה" (spec p. 10, checked against horaot-131.pdf 28.11.2026).
 * 2.124: o.books — the file is written from the double-entry books (the accountant's answer 9): 1013 = 2, 1014 = 1 (every entry —
 * one 1353 — balances by itself: gl_check_balanced, migration 7100; Dream has no batches, 1355). Else 0 / 0, exactly as before.
 */
export function A000(b: Business, sw: SoftwareInfo, o: { id: string; totalRecords: number; path: string; from: string; to: string; startedAt: string; perLocation?: boolean; books?: boolean }) {
  const t = ilTime(o.startedAt);
  return 'A000' + X('', 5) + N(o.totalRecords, 15) + N(b.dealerNumber, 9) + N(o.id, 15) + X(SYSTEM_CONST, 8)
    + N(sw.regNumber, 8) + X(sw.name, 20) + X(sw.version, 20) + N(sw.vendorVat, 9) + X(sw.vendorName, 20) // 1006–1010 (p. 10)
    + N(2, 1) + X(o.path, 50) + N(o.books ? 2 : 0, 1) + N(o.books ? 1 : 0, 1) // 1011 multi-year, 1012 path, 1013 (2 = double entry), 1014 (1 = per transaction)
    + N(b.companyNumber || 0, 9) + N(deductionsFileField(b), 9) + X('', 10) // 1015, 1016 (2.118), 1017
    + X(b.name, 50) + X(b.street, 50) + X(b.houseNo, 10) + X(b.city, 30) + X(b.zip, 8) // 1018–1022
    + N(0, 4) + N(yyyymmdd(o.from), 8) + N(yyyymmdd(o.to), 8)              // 1023 (single-year only), 1024, 1025
    + N(t.date, 8) + N(t.time, 4) + N(0, 1) + N(1, 1)                       // 1026, 1027, 1028 Hebrew, 1029 ISO-8859-8
    + X('JSZip', 20) + X('ILS', 3) + N(o.perLocation ? 1 : 0, 1) + X('', 46); // 1030, 1032, 1034 (1 — the business numbers per location, BranchInfo), 1035 → 466
}
/**
 * Field 1016 "מספר תיק ניכויים" 9(9), ח/ר (spec p. 10, positions 196–204, checked against horaot-131.pdf 25.11.2026). The
 * accountant's answer 17 (25.11.2026): the business's deductions file number. None (or anything but 9 digits) — 0, as before 2.118.
 */
export const deductionsFileField = (b: Pick<Business, 'deductionsFile'>): number | string =>
  /^\d{9}$/.test(String(b.deductionsFile ?? '').trim()) ? String(b.deductionsFile).trim() : 0;
export const SUM = (code: string, count: number) => X(code, 4) + N(count, 15); // 19

/** a 15-digit random id, unique per export (clarification 2) */
export const exportId = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), (b, i) => (i === 0 ? 1 + (b % 9) : b % 10)).join('');

/** the whole export: INI.TXT, BKMVDATA.TXT (as text) and the counts for the printed summary */
/**
 * Which documents have D110 lines ("פרטי מסמך", §4.4, p. 13). A receipt's details are its payments — D120 "פרטי קבלה / הפקדה"
 * (§4.5, p. 14, the example: "ברשומה מסוג 'כותרת מסמך' – C100 תופיע רשומה אחת שתכיל את נתוני כותרת הקבלה. בנוסף לכך יופיעו 5
 * רשומות, אחת לכל המחאה מסוג רשומה 'פרטי קבלה/הפקדה' – D120" — no D110). The Tax Authority's simulator (25.11.2026, the sample of
 * 2.117.0) refused every D110 of a 400 ("לא נמצאה רשומת כותרת מסמך", field 1250) and counted them as "D110 ללא התאמה". So a receipt
 * (400) and a bank deposit (420 — D120 is its record too; produced from 2.120, migration 7000) are written C100 + D120 only; their C100 is unchanged
 * (1219–1224 come from the document, not from its lines), and the document keeps its lines. A 320 (invoice and receipt) keeps both.
 */
export const NO_D110 = new Set([400, 420]);

/**
 * B110 "חשבון בהנהלת חשבונות" (§4.7, p. 16, checked 25.11.2026) — one per customer key of the file.
 * B110 נבנה כדי לענות על הסימולטור (25.11.2026: "לא הועברו רשומות מסוג חשבון בהנהלת חשבונות (B110)"); הסכומים מהמסמכים —
 * לאישור רו״ח. The owner of the system decided (25.11.2026, option א): the software keeps no books (1013 stays 0), so each account
 * is a customer's card built from the documents of the period:
 *   1403 the key — exactly field 1225 of its C100s (the same 15 characters, so two keys cut to the same 15 are one account);
 *   1404 the name, 1407 / 1409 street and city — from its first C100 (first with an address);
 *   1405 / 1406 a fixed trial-balance code and description: 'CUSTOMERS' / 'לקוחות' — there is no chart of accounts, every account
 *        here is a customer;
 *   1414 opening balance 0 (no books before the period);
 *   1415 debit = charges: 300, 305 and 320 (an invoice-receipt charges and is paid in one document) — field 1223 of each;
 *   1416 credit = what closed them: 400 (1223 + 1224 — the money and the tax withheld at source, clarification 4: the debt of 1250
 *        is closed by both), the payment of a 320 (its 1223), and 330 (its 1223);
 *   a 320 that pays a 300 (paid_document_id — `receipt:<300>`) is credit only: the charge is the 300's, already in 1415 —
 *        else the customer who paid would show a debt;
 *   open question to the accountant: a 330 whose money was given back (a refund) — the refund is not a document of the file
 *        (a 330 has no payments), so it cannot be told here; the 330 stays credit only;
 *   2.118 — an exempt dealer's refund receipt (a 400 below zero, the accountant's answer 15): the money given back to the
 *        customer is a debit (1415, its 1223 as a positive amount) — the movements stay positive (§2.4יא), and the receipt it
 *        refunds stays credit as it was. For the accountant to confirm (open question, 25.11.2026);
 *   a cancelled document (1228 = 1) is not counted — it does not charge or pay (its account is still written, as its key is in
 *   the file); 100 / 200 / 210 charge nothing;
 *   1417 0; 1419 0 (only when 1013 = 2); 1421 empty (no branches, 1034 = 0) — 2.120: a business that numbers per location, the
 *   branch of the account's first document in the file (an account is not of one branch: open question, 26.11.2026);
 *   1422 0 / 1423 empty (shekels only).
 * Amounts are summed in agorot, positive (§2.4יא: debit and credit movements positive; 1414 is 0).
 */
export const B110_CODE = 'CUSTOMERS';
export const B110_NAME = 'לקוחות';
export interface Account { key: string; name: string; street: string; city: string; debitA: number; creditA: number;
  /** 2.120: the bank's account (a deposit, 420 — DEPOSIT_KEY): its own trial-balance code, no movements */
  bank?: boolean;
  /** 2.120: field 1421 — the branch of the account's first document in the file (BranchInfo; empty unless 1034 = 1) */
  branch?: string;
  /** 2.124 — an account of the double-entry books (booksAccountsOf): its own trial-balance code and description (1405 / 1406), its
   *  parent (1413), its balance at the start of the period in agorot (1414 — debit positive, credit negative, §2.4יא), the dealer
   *  number of a customer / supplier (1419) and its country code (1412). None of them on the cards of accountsOf — written as before */
  tbCode?: string; tbName?: string; parent?: string; openingA?: number; dealer?: string; country?: string }
export function accountsOf(docs: Doc[], branches?: BranchInfo | null, booksStart: string | null = null): Account[] {
  const m = new Map<string, Account>();
  for (const d of docs) {
    const key = customerKeyField(d, booksStart);
    let a = m.get(key);
    if (!a) m.set(key, (a = { key, name: isDeposit(d) ? DEPOSIT_NAME : d.customerName || 'לקוח מזדמן', street: '', city: '', debitA: 0, creditA: 0,
      ...(isDeposit(d) ? { bank: true } : {}), ...(branches?.perLocation ? { branch: branchOf(branches, d.locationId) } : {}) }));
    if (isDeposit(d)) continue;                                      // 2.120: a deposit charges and pays no customer
    if (!a.street && !a.city && (d.customerStreet || d.customerCity)) { a.street = d.customerStreet ?? ''; a.city = d.customerCity ?? ''; }
    if (d.cancelled) continue;
    const t = ag(fileTotal(d));                                      // 1223 as the C100 writes it
    if (d.docType === 300 || d.docType === 305) a.debitA += t;
    else if (d.docType === 320) { if (!d.paidDocumentId) a.debitA += t; a.creditA += t; }   // a 320 paying a 300: credit only
    else if (d.docType === 400 && t < 0) a.debitA += -t;            // 2.118: a refund receipt — the money given back (see above)
    else if (d.docType === 400) a.creditA += t + ag(withheldOf(d)); // 1223 + 1224
    else if (d.docType === 330) a.creditA += t;
  }
  return [...m.values()];
}
export const B110 = (rec: number, b: Business, a: Account) =>
  'B110' + N(rec, 9) + N(b.dealerNumber, 9) + a.key + X(a.name, 50)   // 1400–1404 (1403: the C100's 1225 as is)
  + X(a.tbCode ?? (a.bank ? DEPOSIT_CODE : B110_CODE), 15) + X(a.tbName ?? (a.bank ? DEPOSIT_NAME : B110_NAME), 30) // 1405, 1406 (2.120: the bank's own; 2.124: the books')
  + X(a.street, 50) + X('', 10) + X(a.city, 30) + X('', 8) + X('', 30) + X(a.country ?? '', 2) // 1407–1412 (1412: 2.124, a customer / supplier of the books)
  + X(a.parent ?? '', 15)                                            // 1413 parent account (2.124: the books' parent_key)
  + AMT((a.openingA ?? 0) / 100) + AMT(a.debitA / 100) + AMT(a.creditA / 100) // 1414 (2.124: the balance before the period), 1415, 1416
  + N(0, 4) + N(a.dealer || 0, 9) + X(a.branch ?? '', 7) + AMT(0) + X('', 3) + X('', 16); // 1417 (answer 11: 0), 1419, 1421 (branch), 1422, 1423, 1424 → 376
// ---------- 2.124 (stage 4ה): the double-entry books — B100 / B110 ----------
/**
 * Which kind of file a period makes (the plan of stage 4, part 4ה; the accountant's answer 9): the books start on start
 * (gl_books.start_date, the 1st of a month — migration 7100):
 *   'single'   — the period ends before the start, or there are no books (a database before 7100): the file exactly as before;
 *   'books'    — the period starts on / after the start: B100 + B110 from the books, 1013 = 2, 1014 = 1;
 *   'straddle' — it starts before and ends on / after the start: not written. STAGE4_PLAN_HE.md does not say how such a file is
 *                made (the same file cannot say 1013 = 0 for part of it and 2 for the rest — A000 has one 1013): the person is asked
 *                to split the period (BOOKS_PERIOD_SPLIT). Open question for the accountant (28.11.2026).
 */
export type BooksPeriod = 'single' | 'books' | 'straddle';
export const booksPeriod = (from: string, to: string, start: string | null | undefined): BooksPeriod =>
  !start || to < start ? 'single' : from >= start ? 'books' : 'straddle';
const dmy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const dayBefore = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) - 1)).toISOString().slice(0, 10);
export const BOOKS_PERIOD_SPLIT = (start: string) =>
  `הנהלת החשבונות הכפולה מתחילה ב-${dmy(start)}, והתקופה שנבחרה מתחילה לפני התאריך הזה ונגמרת אחריו. אי אפשר להפיק קובץ אחד לשתיהן — `
  + `מפיקים שני קבצים: אחד עד ${dmy(dayBefore(start))}, ואחד מ-${dmy(start)}.`;

/** a line of an entry (gl_lines): the amount in agorot, above 0 (§2.4יא: positive, its side in 1366) */
export interface BookLine { lineNo: number; account: string; side: 'D' | 'C'; amountA: number; valueDate: string; match1?: string | null; match2?: string | null }
/** an entry (gl_transactions — one 1353): its dates (1362 tx_date, 1375 entered_on), what made it, its reference documents */
export interface BookTx {
  number: number; date: string; enteredOn: string; sourceKind: string; details: string;
  ref1Type?: number | null; ref1Number?: string | null; ref2Type?: number | null; ref2Number?: string | null;
  locationId?: string | null; userId?: string | null; lines: BookLine[];
}
/** an account of the books (gl_accounts) with its numbers for the period (report_trial_balance — agorot) */
export interface BookAccount {
  key: string; name: string; tbCode: string; tbName: string; parentKey?: string | null; dealer?: string | null; street?: string; city?: string;
  locationId?: string | null; party?: boolean; openingA: number; debitA: number; creditA: number;
}
export interface BooksFile { start: string; transactions: BookTx[]; accounts: BookAccount[] }

/**
 * 1356 "סוג תנועה" X(15), ח/ר — what made the entry (gl_transactions.source_kind; the names of the books' screens, SOURCE_LABEL
 * in ledger.ts, cut to fit 15). The spec gives no list: ours, for the accountant to see.
 */
export const B100_KIND: Record<string, string> = {
  document: 'מסמך', cancellation: 'ביטול מסמך', payment: 'החזר כספי', deposit: 'הפקדה', deposit_cancel: 'ביטול הפקדה', opening: 'יתרות פתיחה',
  expense: 'הוצאה', expense_payment: 'תשלום הוצאה', shift: 'הפרש קופה', bank_match: 'התאמת בנק', bank_unmatch: 'ביטול התאמה',
  bank_class: 'שורת בנק', bank_unclass: 'ביטול שורת בנק', manual: 'פקודה ידנית',
};
/**
 * B100 "תנועות בהנהלת חשבונות" (§4.6, p. 15, checked against horaot-131.pdf 28.11.2026) — one record per line of an entry, 317:
 *   1350 1–4, 1351 5–13, 1352 14–22, 1353 "מספר תנועה" 9(10) 23–32 (clarification 7: the field that ties every line of the journal
 *   entry — gl_transactions.number, running per business), 1354 "מספר שורה בתנועה" 9(5) 33–37 (gl_lines.line_no), 1355 "מנה" 9(8)
 *   38–45 ח/ר (Dream has no batches — 0; 1014 = 1), 1356 "סוג תנועה" X(15) 46–60 (B100_KIND), 1357 "אסמכתא" X(20) 61–80 and 1358
 *   its document type 9(3) 81–83, 1359 "אסמכתא 2" X(20) 84–103 and 1360 9(3) 104–106 (the entry's ref1 / ref2 — a document's number
 *   as C100 1204 writes it, gl_doc_ref = seriesNumber; §2.4ד), 1361 "פרטים" X(50) 107–156, 1362 "תאריך" 9(8) 157–164 (the entry's
 *   date), 1363 "תאריך ערך" 9(8) 165–172 (the line's own value date — an installment's, answer 8 and clarification 12's example),
 *   1364 "חשבון בתנועה" X(15) 173–187 (must be a B110), 1365 "חשבון נגדי" X(15) 188–202 ("בהנהלת חשבונות חד צדית בלבד" — empty),
 *   1366 "סימן הפעולה" 9(1) 203 (1 debit, 2 credit), 1367 currency X(3) 204–206 (empty — shekels), 1368 "סכום הפעולה" X9(12)v99
 *   207–221 (positive, §2.4יא), 1369 foreign amount 222–236 and 1370 quantity X9(9)v99 237–248 (0, as 1217 / 1422 are written),
 *   1371 / 1372 "שדה התאמה 1 / 2" X(10) 249–258 / 259–268 (the line's match1 / match2 — answer 9 of stage 4: filled), 1373 X(0),
 *   1374 "מזהה סניף/ענף" X(7) 269–275 (the entry's location's branch code when 1034 = 1), 1375 "תאריך הזנה" 9(8) 276–283 (the day
 *   the entry was written, Israel time — entered_on), 1376 "מבצע פעולה" X(9) 284–292 (the person's code, as 1233), 1377 X(25) 293–317.
 */
export function B100(rec: number, b: Business, t: BookTx, l: BookLine, branch = '', operator = '') {
  return 'B100' + N(rec, 9) + N(b.dealerNumber, 9) + N(t.number, 10) + N(l.lineNo, 5) + N(0, 8)          // 1350–1355
    + X(B100_KIND[t.sourceKind] ?? '', 15)                                                              // 1356
    + X(t.ref1Number ?? '', 20) + N(t.ref1Number ? t.ref1Type ?? 0 : 0, 3) + X(t.ref2Number ?? '', 20) + N(t.ref2Number ? t.ref2Type ?? 0 : 0, 3) // 1357–1360
    + X(t.details, 50) + N(yyyymmdd(t.date), 8) + N(yyyymmdd(l.valueDate || t.date), 8)                  // 1361–1363
    + X(l.account, 15) + X('', 15) + N(l.side === 'C' ? 2 : 1, 1)                                       // 1364, 1365 (double entry — empty), 1366
    + X('', 3) + AMT(l.amountA / 100) + AMT(0) + AMT(0, 9)                                              // 1367–1370
    + X(l.match1 ?? '', 10) + X(l.match2 ?? '', 10)                                                     // 1371, 1372 (1373 — 0 long)
    + X(branch, 7) + N(yyyymmdd(t.enteredOn || t.date), 8) + X(operator, 9) + X('', 25);                // 1374–1377 → 317
}

/**
 * The accounts of a file from the books (B110 §4.7, p. 16): every account of the books' period (books.accounts — the trial
 * balance's accounts with their details, booksFileOf) as written, and — so every 1225 of a C100 is an account of the file (the
 * simulator, 25.11.2026) — a customer of a document that made no entry (an order / delivery / return note: 100 / 200 / 210 post
 * nothing) gets a card of its own: the books' customer code (CUSTOMERS / לקוחות under 1300 — gl_customer_account's), its name and
 * address from its first document, no movements.
 *   1414 the balance before the period (debit +, credit −; 0 is "+", §2.4יא), 1415 / 1416 the debits / credits of the period —
 *   "ללא יתרת פתיחה": the opening balances' entry (dated the books' start, 7100) is a movement of the period that starts on that day,
 *   as in the books' trial balance — open question for the accountant (28.11.2026);
 *   1419 the dealer number of a customer / supplier with one (answer 10: a private customer — 0); 1412 'IL' for a customer /
 *   supplier (every party of Dream is in Israel — for the accountant); 1417 0 (answer 11); 1421 the account's location's branch
 *   code when 1034 = 1 (an account of no location — the main location's: the business's own; open question 2.120 (ד)).
 */
export function booksAccountsOf(books: BooksFile, inFile: Doc[], branches?: BranchInfo | null): Account[] {
  const out: Account[] = books.accounts.map((a) => ({
    key: X(a.key, 15), name: a.name, street: a.street ?? '', city: a.city ?? '', debitA: a.debitA, creditA: a.creditA, openingA: a.openingA,
    tbCode: a.tbCode, tbName: a.tbName, parent: a.parentKey ?? '', dealer: a.party && /^\d{9}$/.test(a.dealer ?? '') ? a.dealer! : '',
    country: a.party ? 'IL' : '', ...(branches?.perLocation ? { branch: branchOf(branches, a.locationId) } : {}),
  }));
  const have = new Set(out.map((a) => a.key));
  const hasCustomers = have.has(X('1300', 15));
  for (const c of accountsOf(inFile, branches, books.start)) {
    if (have.has(c.key)) continue;
    have.add(c.key);
    out.push({ ...c, debitA: 0, creditA: 0, openingA: 0, tbCode: c.bank ? DEPOSIT_CODE : B110_CODE, tbName: c.bank ? DEPOSIT_NAME : B110_NAME,
      parent: c.bank || !hasCustomers ? '' : '1300', country: c.bank ? '' : 'IL' });
  }
  return out;
}

/**
 * What would make a file from the books wrong — checked before the file is made (the screens say it in Hebrew; never a key, an
 * amount or a dealer number in the message): an entry that does not balance (1014 = 1), a line whose account is not among the
 * accounts (1364 "חייבת להיות רשומה מסוג B110"), two accounts whose keys are written the same (1403 "חד חד ערכי"), an account's
 * debits / credits that are not the sum of its lines of the period.
 */
export const BOOKS_FILE_BROKEN = 'הנתונים של הנהלת החשבונות לתקופה לא שלמים (פקודה לא מאוזנת, חשבון חסר או סכומים שלא מתאימים) — הקובץ לא הופק. רעננו ונסו שוב; אם זה חוזר — פנו לתמיכה.';
export function booksFileProblems(books: BooksFile): string[] {
  const bad: string[] = [];
  const keys = new Map<string, BookAccount>();
  for (const a of books.accounts) {
    const k = X(a.key, 15);
    if (keys.has(k)) bad.push('account_key_twice'); else keys.set(k, a);
  }
  const sums = new Map<string, { d: number; c: number }>();
  for (const t of books.transactions) {
    let d = 0, c = 0;
    for (const l of t.lines) {
      if (!Number.isSafeInteger(l.amountA) || l.amountA <= 0) bad.push('line_amount');
      if (l.side === 'D') d += l.amountA; else c += l.amountA;
      const k = X(l.account, 15);
      if (!keys.has(k)) { bad.push('line_account'); continue; }
      const s = sums.get(k) ?? { d: 0, c: 0 };
      if (l.side === 'D') s.d += l.amountA; else s.c += l.amountA;
      sums.set(k, s);
    }
    if (d !== c || t.lines.length < 2) bad.push('tx_balance');
  }
  for (const [k, a] of keys) {
    const s = sums.get(k) ?? { d: 0, c: 0 };
    if (s.d !== a.debitA || s.c !== a.creditA) bad.push('account_sums');
  }
  return [...new Set(bad)];
}

/** o.codes: the people's codes for field 1233 (member_doc_codes, user_id → code); none — 1233 as before (operatorOf).
 *  o.branches (2.120): the business numbers per location — 1034 = 1 and the branch fields; none / not per location — as before */
export function buildOpenFormat(b: Business, sw: SoftwareInfo, docs: Doc[], o: { from: string; to: string; startedAt: string; id?: string; codes?: ReadonlyMap<string, string>;
  branches?: BranchInfo | null;
  /** 2.121: the business's books start (gl_books_state().startDate) — documents from it on get the books' customer key (1225);
   *  none (a database before 7100) — every key exactly as before */
  booksStart?: string | null;
  /** 2.124: the books of the period (booksPeriod(from, to, start) = 'books' — the caller reads them, booksFileOf): B100 + B110 from
   *  them, 1013 = 2, 1014 = 1. A file with books that are not whole (booksFileProblems) is never written — throws BOOKS_FILE_BROKEN */
  books?: BooksFile | null }) {
  const id = o.id ?? exportId();
  const t = ilTime(o.startedAt);
  const dir = `OPENFRMT\\${N(b.dealerNumber, 9).slice(0, 8)}.${t.date.slice(2, 4)}\\${t.date.slice(4, 8)}${t.time}`;
  const recs: string[] = [];
  const books = o.books ?? null;
  if (books) {
    // never a file from books that are not whole, nor from books of another period's kind (a period before / across the start)
    if (booksPeriod(o.from, o.to, books.start) !== 'books' || booksFileProblems(books).length) throw new Error(BOOKS_FILE_BROKEN);
  }
  const counts: Record<string, number> = books ? { B100: 0, B110: 0, C100: 0, D110: 0, D120: 0 } : { B110: 0, C100: 0, D110: 0, D120: 0 };
  // (a file before the books has no B100 key at all — its counts exactly as before)
  recs.push(A100(1, b, id));
  const inFile = docs.filter((x) => x.docDate >= o.from && x.docDate <= o.to).sort((a, z) => a.docType - z.docType || a.docNumber - z.docNumber);
  const br = o.branches?.perLocation ? o.branches : null;
  const byKey = new Map(docs.map((x) => [`${x.docType}:${x.docNumber}`, x] as const));
  if (books) {
    // 2.124: the accounts (B110), then the entries' lines (B100) in the order of the journal (date, number, line), then the documents
    for (const a of booksAccountsOf(books, inFile, br)) { recs.push(B110(recs.length + 1, b, a)); counts.B110++; }
    const txs = [...books.transactions].sort((a, z) => (a.date < z.date ? -1 : a.date > z.date ? 1 : a.number - z.number));
    for (const t of txs) {
      const branch = branchOf(br, t.locationId), op = t.userId ? o.codes?.get(t.userId) ?? '' : '';
      for (const l of [...t.lines].sort((a, z) => a.lineNo - z.lineNo)) { recs.push(B100(recs.length + 1, b, t, l, branch, op)); counts.B100++; }
    }
  } else for (const a of accountsOf(inFile, br, o.booksStart ?? null)) { recs.push(B110(recs.length + 1, b, a)); counts.B110++; }   // the accounts first, then the documents
  for (const d of inFile) {
    const branch = branchOf(br, d.locationId), baseBranch = baseBranchOf(br, d, byKey);
    recs.push(C100(recs.length + 1, b, d, operatorOf(d, o.codes), branch, books?.start ?? o.booksStart ?? null)); counts.C100++;
    if (!NO_D110.has(d.docType)) d.lines.forEach((l, i) => { recs.push(D110(recs.length + 1, b, d, l, i + 1, branch, baseBranch)); counts.D110++; });
    filePayments(d).forEach((p, i) => { recs.push(D120(recs.length + 1, b, d, p, i + 1, branch)); counts.D120++; });
  }
  recs.push(Z900(recs.length + 1, b, id, recs.length + 1));
  const ini = [A000(b, sw, { id, totalRecords: recs.length, path: dir, from: o.from, to: o.to, startedAt: o.startedAt, perLocation: Boolean(br), books: Boolean(books) }),
    ...Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => SUM(k, n))];
  return { id, dir, ini: ini.join('\r\n') + '\r\n', bkmv: recs.join('\r\n') + '\r\n', counts: { A100: 1, ...counts, Z900: 1 } as Record<string, number>, totalRecords: recs.length };
}

/** printout 2.6(b): number and money total of each document type the software handles (0 when not handled) — the total is the
 *  sum of field 1223 as the file writes it (fileTotal: a receipt without the tax withheld), so the printout checks the file */
export const DOC_TYPES: Record<number, string> = {
  100: 'הזמנה', 200: 'תעודת משלוח', 205: 'תעודת משלוח סוכן', 210: 'תעודת החזרה', 300: 'חשבונית / חשבונית עסקה', 305: 'חשבונית מס', 310: 'חשבונית ריכוז',
  320: 'חשבונית מס / קבלה', 330: 'חשבונית מס זיכוי', 340: 'חשבונית שריון', 345: 'חשבונית סוכן', 400: 'קבלה', 405: 'קבלה על תרומות', 410: 'יציאה מקופה', 420: 'הפקדת בנק',
  500: 'הזמנת רכש', 600: 'תעודת משלוח רכש', 610: 'החזרת רכש', 700: 'חשבונית מס רכש', 710: 'זיכוי רכש', 800: 'יתרת פתיחה', 810: 'כניסה כללית למלאי',
  820: 'יציאה כללית מהמלאי', 830: 'העברה בין מחסנים', 840: 'עדכון בעקבות ספירה', 900: 'דוח ייצור - כניסה', 910: 'דוח ייצור - יציאה',
};
export function docTypeReport(docs: Doc[], from: string, to: string) {
  const inRange = docs.filter((d) => d.docDate >= from && d.docDate <= to);
  return Object.entries(DOC_TYPES).map(([code, name]) => {
    const list = inRange.filter((d) => d.docType === Number(code));
    return { code: Number(code), name, count: list.length, total: list.reduce((a, d) => a + ag(fileTotal(d)), 0) / 100 };
  });
}
