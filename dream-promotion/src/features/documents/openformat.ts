/**
 * "ממשק פתוח" — the unified-structure files of the Israel Tax Authority, spec v1.31 (10.05.2009):
 * INI.TXT + BKMVDATA.TXT, fixed-width records, ISO-8859-8 (logical Hebrew), CRLF after each record.
 * This module produces the documents part (C100 / D110 / D120) — the software has no bookkeeping
 * (B100/B110) or inventory (M100) module, so field 1013 = 0. Every field position below is from the spec.
 */
export const SYSTEM_CONST = '&OF1.31&';

// ---------- field formatting (spec 2.3 / 2.4) ----------
/** numeric 9(n): digits only, zero-padded on the left */
export const N = (v: number | string | null | undefined, len: number) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length > len ? d.slice(-len) : d.padStart(len, '0');
};
/** alphanumeric X(n): left-aligned, space-padded on the right */
export const X = (v: string | null | undefined, len: number) => {
  const s = String(v ?? '').replace(/[\r\n]+/g, ' ');
  return s.length > len ? s.slice(0, len) : s.padEnd(len, ' ');
};
/** signed amount X9(int)v99: sign, integer digits zero-padded, 2 decimals, no point — e.g. +00000000124565 */
export const AMT = (v: number, intDigits = 12, dec = 2) => {
  const cents = Math.round(Math.abs(v) * 10 ** dec);
  return (v < 0 ? '-' : '+') + String(cents).padStart(intDigits + dec, '0').slice(-(intDigits + dec));
};
export const yyyymmdd = (d: string) => d.replace(/-/g, '').slice(0, 8);

/** ISO-8859-8 (logical): ASCII as is, Hebrew letters U+05D0–U+05EA → 0xE0–0xFA, anything else → '?' */
export function toIso88598(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 0x80 ? c : c >= 0x05d0 && c <= 0x05ea ? c - 0x05d0 + 0xe0 : 0x3f;
  }
  return out;
}

// ---------- the business and the documents ----------
export interface Business {
  dealerNumber: string; companyNumber?: string; name: string; street?: string; houseNo?: string; city?: string; zip?: string;
}
export interface SoftwareInfo { regNumber: string; name: string; version: string; vendorVat: string; vendorName: string }
/** itemId ties a line to the price list (stock); restock marks a credit line whose goods came back (2.51); variantId: the
 *  size / colour sold (2.54 — the database moves that variant's stock; not part of the file to the Tax Authority) */
export interface DocLine { name: string; qty: number; unitPriceExVat: number; discountExVat: number; totalExVat: number; vatRate: number; kind: 1 | 2 | 3; itemId?: string; variantId?: string; restock?: boolean }
/** method = field 1306; m = the app's own method (Bit is "other" in the file); cheque = fields 1307–1311 (2.51) */
export interface DocPayment { method: number; amount: number; date: string; m?: string; cheque?: { bank?: string; branch?: string; account?: string; number?: string; dueDate?: string } }
export interface Doc {
  docType: number; docNumber: number; linkNo: number; issuedAt: string /* ISO */; docDate: string /* YYYY-MM-DD */;
  customerName: string; customerPhone?: string; customerDealer?: string; customerStreet?: string; customerCity?: string; customerKey?: string;
  beforeDiscount: number; discount: number; afterDiscount: number; vatAmount: number; total: number;
  baseDocType?: number | null; baseDocNumber?: number | null; issuedBy?: string; lines: DocLine[]; payments: DocPayment[];
  /** a receipt / transaction invoice cancelled after issue (document_cancellations, 2.51) — field 1228 */
  cancelled?: boolean;
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

export function C100(rec: number, b: Business, d: Doc) {
  const t = ilTime(d.issuedAt);
  const sign = (v: number) => (d.docType === 330 ? v : v); // a credit invoice is positive; its type gives the meaning (clarification 1)
  return 'C100' + N(rec, 9) + N(b.dealerNumber, 9) + N(d.docType, 3) + X(String(d.docNumber), 20)
    + N(t.date, 8) + N(t.time, 4)                                   // 1205, 1206
    + X(d.customerName || 'לקוח מזדמן', 50) + X(d.customerStreet, 50) + X('', 10) + X(d.customerCity, 30) + X('', 8) // 1207–1211
    + X('', 30) + X('', 2) + X(d.customerPhone, 15) + N(d.customerDealer || 0, 9)   // 1212–1215
    + N(yyyymmdd(d.docDate), 8)                                       // 1216 value date
    + AMT(0) + X('', 3)                                               // 1217, 1218 (export only)
    + AMT(sign(d.beforeDiscount)) + AMT(-Math.abs(d.discount)) + AMT(sign(d.afterDiscount)) // 1219, 1220 (negative), 1221
    + AMT(sign(d.vatAmount)) + AMT(sign(d.total)) + AMT(0, 9)         // 1222, 1223, 1224 withholding
    + X(d.customerKey ?? (d.customerPhone || d.customerName || 'CASH'), 15) // 1225 customer key
    + X('', 10)                                                       // 1226 matching field
    + X(d.cancelled ? '1' : '', 1)                                    // 1228 cancelled: a 300 / 400 cancelled after issue (a tax invoice gets a credit invoice instead)
    + N(yyyymmdd(d.docDate), 8)                                       // 1230 document date
    + X('', 7)                                                        // 1231 branch
    + X(d.issuedBy, 9) + N(d.linkNo, 7) + X('', 13);                  // 1233, 1234, 1235 → 444
}

export function D110(rec: number, b: Business, d: Doc, line: DocLine, lineNo: number) {
  return 'D110' + N(rec, 9) + N(b.dealerNumber, 9) + N(d.docType, 3) + X(String(d.docNumber), 20) + N(lineNo, 4)
    + N(d.baseDocType ?? 0, 3) + X(d.baseDocNumber ? String(d.baseDocNumber) : '', 20)  // 1256, 1257
    + N(line.kind, 1) + X('', 20) + X(line.name, 30) + X('', 50) + X('', 30) + X('יחידה', 20) // 1258–1263
    + AMT(line.qty, 12, 4) + AMT(line.unitPriceExVat) + AMT(-Math.abs(line.discountExVat)) + AMT(line.totalExVat) // 1264–1267
    + N(Math.round(line.vatRate * 100), 4)                             // 1268 (18% → 1800)
    + X('', 7) + N(yyyymmdd(d.docDate), 8) + N(d.linkNo, 7) + X('', 7) + X('', 21); // 1270, 1272, 1273, 1274, 1275 → 339
}

export function D120(rec: number, b: Business, d: Doc, p: DocPayment, lineNo: number) {
  const c = p.method === 2 ? p.cheque : undefined;                      // a cheque's bank, branch, account, number, due date (2.51)
  return 'D120' + N(rec, 9) + N(b.dealerNumber, 9) + N(d.docType, 3) + X(String(d.docNumber), 20) + N(lineNo, 4)
    + N(p.method, 1) + N(c?.bank || 0, 10) + N(c?.branch || 0, 10) + N(c?.account || 0, 15) + N(c?.number || 0, 10) // 1306–1310
    + N(c?.dueDate ? yyyymmdd(c.dueDate) : p.method === 3 ? yyyymmdd(p.date) : 0, 8) // 1311 cheque due date / card payment date
    + AMT(p.amount) + N(0, 1) + X('', 20) + N(p.method === 3 ? 1 : 0, 1)  // 1312–1315
    + X('', 7) + N(yyyymmdd(d.docDate), 8) + N(d.linkNo, 7) + X('', 60);  // 1320, 1322, 1323, 1324 → 222
}

// ---------- INI.TXT ----------
export function A000(b: Business, sw: SoftwareInfo, o: { id: string; totalRecords: number; path: string; from: string; to: string; startedAt: string }) {
  const t = ilTime(o.startedAt);
  return 'A000' + X('', 5) + N(o.totalRecords, 15) + N(b.dealerNumber, 9) + N(o.id, 15) + X(SYSTEM_CONST, 8)
    + N(sw.regNumber, 8) + X(sw.name, 20) + X(sw.version, 20) + N(sw.vendorVat, 9) + X(sw.vendorName, 20)
    + N(2, 1) + X(o.path, 50) + N(0, 1) + N(0, 1)                         // 1011 multi-year, 1012 path, 1013 no bookkeeping, 1014
    + N(b.companyNumber || 0, 9) + N(0, 9) + X('', 10)                      // 1015, 1016, 1017
    + X(b.name, 50) + X(b.street, 50) + X(b.houseNo, 10) + X(b.city, 30) + X(b.zip, 8) // 1018–1022
    + N(0, 4) + N(yyyymmdd(o.from), 8) + N(yyyymmdd(o.to), 8)              // 1023 (single-year only), 1024, 1025
    + N(t.date, 8) + N(t.time, 4) + N(0, 1) + N(1, 1)                       // 1026, 1027, 1028 Hebrew, 1029 ISO-8859-8
    + X('JSZip', 20) + X('ILS', 3) + N(0, 1) + X('', 46);                   // 1030, 1032, 1034 no branches, 1035 → 466
}
export const SUM = (code: string, count: number) => X(code, 4) + N(count, 15); // 19

/** a 15-digit random id, unique per export (clarification 2) */
export const exportId = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), (b, i) => (i === 0 ? 1 + (b % 9) : b % 10)).join('');

/** the whole export: INI.TXT, BKMVDATA.TXT (as text) and the counts for the printed summary */
export function buildOpenFormat(b: Business, sw: SoftwareInfo, docs: Doc[], o: { from: string; to: string; startedAt: string; id?: string }) {
  const id = o.id ?? exportId();
  const t = ilTime(o.startedAt);
  const dir = `OPENFRMT\\${N(b.dealerNumber, 9).slice(0, 8)}.${t.date.slice(2, 4)}\\${t.date.slice(4, 8)}${t.time}`;
  const recs: string[] = [];
  const counts: Record<string, number> = { C100: 0, D110: 0, D120: 0 };
  recs.push(A100(1, b, id));
  for (const d of docs.filter((x) => x.docDate >= o.from && x.docDate <= o.to).sort((a, z) => a.docType - z.docType || a.docNumber - z.docNumber)) {
    recs.push(C100(recs.length + 1, b, d)); counts.C100++;
    d.lines.forEach((l, i) => { recs.push(D110(recs.length + 1, b, d, l, i + 1)); counts.D110++; });
    d.payments.forEach((p, i) => { recs.push(D120(recs.length + 1, b, d, p, i + 1)); counts.D120++; });
  }
  recs.push(Z900(recs.length + 1, b, id, recs.length + 1));
  const ini = [A000(b, sw, { id, totalRecords: recs.length, path: dir, from: o.from, to: o.to, startedAt: o.startedAt }),
    ...Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => SUM(k, n))];
  return { id, dir, ini: ini.join('\r\n') + '\r\n', bkmv: recs.join('\r\n') + '\r\n', counts: { A100: 1, ...counts, Z900: 1 }, totalRecords: recs.length };
}

/** printout 2.6(b): number and money total of each document type the software handles (0 when not handled) */
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
    return { code: Number(code), name, count: list.length, total: Math.round(list.reduce((a, d) => a + d.total, 0) * 100) / 100 };
  });
}
