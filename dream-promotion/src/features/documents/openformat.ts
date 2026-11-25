/**
 * "ממשק פתוח" — the unified-structure files of the Israel Tax Authority, spec v1.31 (10.05.2009):
 * INI.TXT + BKMVDATA.TXT, fixed-width records, ISO-8859-8 (logical Hebrew), CRLF after each record.
 * This module produces the documents part (C100 / D110 / D120). The software keeps no books (B100/B110 — field 1013 = 0, "not
 * relevant", spec p. 10). It does keep stock (per location, from 2.92), but this export writes no M100 ("פריטים במלאי", §4.8,
 * p. 17) records — whether it has to is an open question (22.11.2026). Every field position below is from the spec.
 * Checked against the official text (horaot-131.pdf, 22 pages) on 22.11.2026: pages 6, 10, 12, 13, 21 — see each change.
 */
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
}

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

/** field 1225 "מפתח הלקוח אצל המוכר" X(15), as written — the same 15 characters are 1403 of the customer's B110 */
export const customerKeyField = (d: Pick<Doc, 'customerKey' | 'customerPhone' | 'customerName'>) =>
  X(d.customerKey ?? (d.customerPhone || d.customerName || 'CASH'), 15);

export function C100(rec: number, b: Business, d: Doc, operator: string = d.issuedBy ?? '') {
  const t = ilTime(d.issuedAt);
  const wA = ag(withheldOf(d));                                       // clarification 4: a receipt's amounts without the withholding
  const less = (v: number) => (ag(v) - wA) / 100;
  // a credit invoice is positive; its type gives the meaning (clarification 1). 2.118: an exempt dealer's refund receipt (a 400
  // below zero — the accountant's answer 15) is written with its own sign: §2.4יב (p. 6) "משמעות המסמך … בהתאם לסוג המסמך ולא
  // בהתאם לערך המסמך", and the table of document types (appendix 1, p. 18): "כאשר ערך המסמך שלילי, ההשפעה הפוכה" — 1219, 1221,
  // 1223 below zero (1220 and 1222 are 0). The receipt it refunds (1256/1257) is not in the file: those fields are D110's only,
  // and a 400 has no D110 (NO_D110, below) — open question for the simulator / the accountant (25.11.2026).
  const sign = (v: number) => (d.docType === 330 ? v : v);
  return 'C100' + N(rec, 9) + N(b.dealerNumber, 9) + N(d.docType, 3) + X(String(d.docNumber), 20)
    + N(t.date, 8) + N(t.time, 4)                                   // 1205, 1206
    + X(d.customerName || 'לקוח מזדמן', 50) + X(d.customerStreet, 50) + X('', 10) + X(d.customerCity, 30) + X('', 8) // 1207–1211
    + X('', 30) + X('', 2) + X(d.customerPhone, 15) + N(d.customerDealer || 0, 9)   // 1212–1215
    + N(yyyymmdd(d.docDate), 8)                                       // 1216 value date
    + AMT(0) + X('', 3)                                               // 1217, 1218 (export only)
    + AMT(sign(less(d.beforeDiscount))) + AMT(-Math.abs(d.discount)) + AMT(sign(less(d.afterDiscount))) // 1219, 1220 (negative), 1221
    + AMT(sign(d.vatAmount)) + AMT(sign(fileTotal(d))) + AMT(wA / 100, 9) // 1222, 1223, 1224 withholding (positive — clarification 4)
    + customerKeyField(d)                                            // 1225 customer key (= 1403 of its B110)
    + X('', 10)                                                       // 1226 matching field
    + X(d.cancelled ? '1' : '', 1)                                    // 1228 cancelled: a 300 / 400 cancelled after issue (a tax invoice gets a credit invoice instead)
    + N(yyyymmdd(d.docDate), 8)                                       // 1230 document date
    + X('', 7)                                                        // 1231 branch
    + X(operator, 9) + N(d.linkNo, 7) + X('', 13);                    // 1233 (operatorOf), 1234, 1235 → 444
}

export function D110(rec: number, b: Business, d: Doc, line: DocLine, lineNo: number) {
  return 'D110' + N(rec, 9) + N(b.dealerNumber, 9) + N(d.docType, 3) + X(String(d.docNumber), 20) + N(lineNo, 4)
    + N(d.baseDocType ?? 0, 3) + X(d.baseDocNumber ? String(d.baseDocNumber) : '', 20)  // 1256, 1257
    + N(line.kind === 2 || line.kind === 3 ? line.kind : 1, 1) + X('', 20) + X(line.name, 30) + X('', 50) + X('', 30) + X('יחידה', 20) // 1258–1263
    + AMT(line.qty, 12, 4) + AMT(line.unitPriceExVat) + AMT(-Math.abs(line.discountExVat)) + AMT(line.totalExVat) // 1264–1267
    + N(Math.round(line.vatRate * 100), 4)                             // 1268 (18% → 1800)
    + X('', 7) + N(yyyymmdd(d.docDate), 8) + N(d.linkNo, 7) + X('', 7) + X('', 21); // 1270, 1272, 1273, 1274, 1275 → 339
}

/**
 * Field 1315 "סוג עסקת האשראי" 9(1), ח/ר (spec §4.5, p. 14, checked against horaot-131.pdf 25.11.2026): 1 רגיל, 2 תשלומים,
 * 3 קרדיט, 4 חיוב נדחה, 5 אחר. From 2.118 a card payment carries its kind (cardKind — asked at issue, the accountant's answer 13,
 * 25.11.2026). A card payment of a document issued before has none — written 1, exactly as before; not a card — 0, as before.
 */
export const cardKindField = (p: Pick<DocPayment, 'method' | 'cardKind'>): number =>
  p.method !== 3 ? 0 : [1, 2, 3, 4, 5].includes(Number(p.cardKind)) && Number.isInteger(p.cardKind) ? Number(p.cardKind) : 1;

export function D120(rec: number, b: Business, d: Doc, p: DocPayment, lineNo: number) {
  const c = p.method === 2 ? p.cheque : undefined;                      // a cheque's bank, branch, account, number, due date (2.51)
  return 'D120' + N(rec, 9) + N(b.dealerNumber, 9) + N(d.docType, 3) + X(String(d.docNumber), 20) + N(lineNo, 4)
    + N(p.method, 1) + N(c?.bank || 0, 10) + N(c?.branch || 0, 10) + N(c?.account || 0, 15) + N(c?.number || 0, 10) // 1306–1310
    + N(c?.dueDate ? yyyymmdd(c.dueDate) : p.method === 3 ? yyyymmdd(p.date) : 0, 8) // 1311 cheque due date / card payment date
    + AMT(p.amount) + N(0, 1) + X('', 20) + N(cardKindField(p), 1)        // 1312–1315 (1312 signed: a refund receipt's money back is below zero)
    + X('', 7) + N(yyyymmdd(d.docDate), 8) + N(d.linkNo, 7) + X('', 60);  // 1320, 1322, 1323, 1324 → 222
}

// ---------- INI.TXT ----------
export function A000(b: Business, sw: SoftwareInfo, o: { id: string; totalRecords: number; path: string; from: string; to: string; startedAt: string }) {
  const t = ilTime(o.startedAt);
  return 'A000' + X('', 5) + N(o.totalRecords, 15) + N(b.dealerNumber, 9) + N(o.id, 15) + X(SYSTEM_CONST, 8)
    + N(sw.regNumber, 8) + X(sw.name, 20) + X(sw.version, 20) + N(sw.vendorVat, 9) + X(sw.vendorName, 20) // 1006–1010 (p. 10)
    + N(2, 1) + X(o.path, 50) + N(0, 1) + N(0, 1)                         // 1011 multi-year, 1012 path, 1013 no bookkeeping, 1014
    + N(b.companyNumber || 0, 9) + N(deductionsFileField(b), 9) + X('', 10) // 1015, 1016 (2.118), 1017
    + X(b.name, 50) + X(b.street, 50) + X(b.houseNo, 10) + X(b.city, 30) + X(b.zip, 8) // 1018–1022
    + N(0, 4) + N(yyyymmdd(o.from), 8) + N(yyyymmdd(o.to), 8)              // 1023 (single-year only), 1024, 1025
    + N(t.date, 8) + N(t.time, 4) + N(0, 1) + N(1, 1)                       // 1026, 1027, 1028 Hebrew, 1029 ISO-8859-8
    + X('JSZip', 20) + X('ILS', 3) + N(0, 1) + X('', 46);                   // 1030, 1032, 1034 no branches, 1035 → 466
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
 * (400) and a bank deposit (420 — D120 is its record too; not produced yet) are written C100 + D120 only; their C100 is unchanged
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
 *   1417 0; 1419 0 (only when 1013 = 2); 1421 empty (no branches, 1034 = 0); 1422 0 / 1423 empty (shekels only).
 * Amounts are summed in agorot, positive (§2.4יא: debit and credit movements positive; 1414 is 0).
 */
export const B110_CODE = 'CUSTOMERS';
export const B110_NAME = 'לקוחות';
export interface Account { key: string; name: string; street: string; city: string; debitA: number; creditA: number }
export function accountsOf(docs: Doc[]): Account[] {
  const m = new Map<string, Account>();
  for (const d of docs) {
    const key = customerKeyField(d);
    let a = m.get(key);
    if (!a) m.set(key, (a = { key, name: d.customerName || 'לקוח מזדמן', street: '', city: '', debitA: 0, creditA: 0 }));
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
  + X(B110_CODE, 15) + X(B110_NAME, 30)                              // 1405, 1406
  + X(a.street, 50) + X('', 10) + X(a.city, 30) + X('', 8) + X('', 30) + X('', 2) // 1407–1412
  + X('', 15)                                                        // 1413 parent account
  + AMT(0) + AMT(a.debitA / 100) + AMT(a.creditA / 100)              // 1414, 1415, 1416
  + N(0, 4) + N(0, 9) + X('', 7) + AMT(0) + X('', 3) + X('', 16);    // 1417, 1419, 1421, 1422, 1423, 1424 → 376
/** o.codes: the people's codes for field 1233 (member_doc_codes, user_id → code); none — 1233 as before (operatorOf) */
export function buildOpenFormat(b: Business, sw: SoftwareInfo, docs: Doc[], o: { from: string; to: string; startedAt: string; id?: string; codes?: ReadonlyMap<string, string> }) {
  const id = o.id ?? exportId();
  const t = ilTime(o.startedAt);
  const dir = `OPENFRMT\\${N(b.dealerNumber, 9).slice(0, 8)}.${t.date.slice(2, 4)}\\${t.date.slice(4, 8)}${t.time}`;
  const recs: string[] = [];
  const counts: Record<string, number> = { B110: 0, C100: 0, D110: 0, D120: 0 };
  recs.push(A100(1, b, id));
  const inFile = docs.filter((x) => x.docDate >= o.from && x.docDate <= o.to).sort((a, z) => a.docType - z.docType || a.docNumber - z.docNumber);
  for (const a of accountsOf(inFile)) { recs.push(B110(recs.length + 1, b, a)); counts.B110++; }   // the accounts first, then the documents
  for (const d of inFile) {
    recs.push(C100(recs.length + 1, b, d, operatorOf(d, o.codes))); counts.C100++;
    if (!NO_D110.has(d.docType)) d.lines.forEach((l, i) => { recs.push(D110(recs.length + 1, b, d, l, i + 1)); counts.D110++; });
    filePayments(d).forEach((p, i) => { recs.push(D120(recs.length + 1, b, d, p, i + 1)); counts.D120++; });
  }
  recs.push(Z900(recs.length + 1, b, id, recs.length + 1));
  const ini = [A000(b, sw, { id, totalRecords: recs.length, path: dir, from: o.from, to: o.to, startedAt: o.startedAt }),
    ...Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => SUM(k, n))];
  return { id, dir, ini: ini.join('\r\n') + '\r\n', bkmv: recs.join('\r\n') + '\r\n', counts: { A100: 1, ...counts, Z900: 1 }, totalRecords: recs.length };
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
