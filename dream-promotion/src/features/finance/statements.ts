import { DOC_LABEL } from '@/features/documents/documents';
import { categoryLabel, normalizeSupplier } from './expenses';
import { payLabel } from './payments';
import { csv } from './reports';

/**
 * The reports of 2.94 (docs/FINANCE_ADDITIONS_HE.md T8): income by customer, sales by item and treatment type, a customer's and a
 * supplier's card, suppliers and kinds of expense (paid and not yet), tax withheld at source, profit and loss against the same
 * period a year before, and the income tax advances (an estimate). The numbers come from the database (report_* and
 * finance_summary — the same rows, by the same rules, so a report's total is the money screens' number); this module only reads
 * them and lays them out as tables — one table for the screen, the CSV and the PDF alike.
 */
const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));
const numOrNull = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v: unknown) => (v == null ? '' : String(v));
const strOrNull = (v: unknown) => (v == null || v === '' ? null : String(v));
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const ag = (n: number) => Math.round(n * 100);

/**
 * who a customer (or a supplier) of a report is — the database's party_key: the CRM card; else the dealer / company number;
 * else the name, as the duplicate check of expenses reads it (letters and digits only)
 */
export const partyKey = (p: { leadId?: string | null; dealer?: string | null; name?: string | null }) =>
  p.leadId ? `l:${p.leadId}` : /^\d{9}$/.test(p.dealer ?? '') ? `d:${p.dealer}` : `n:${normalizeSupplier(p.name ?? '')}`;

// ---- what the database answers ----------------------------------------------------------------------------------------------
/** 2.96 (T13א): "manual" — how much of it manual journal entries are; key "m:" — the entries that belong to no customer */
export interface CustomerIncome { key: string; leadId: string | null; name: string; dealer: string; net: number; vat: number; gross: number; count: number; manual: number }
export interface IncomeByCustomer { from: string; to: string; vat: boolean; total: { net: number; vat: number; count: number; manual: number }; customers: CustomerIncome[] }
export const toIncomeByCustomer = (j: any): IncomeByCustomer => ({
  from: str(j?.from), to: str(j?.to), vat: Boolean(j?.vat),
  total: { net: num(j?.total?.net), vat: num(j?.total?.vat), count: num(j?.total?.count), manual: num(j?.total?.manual) },
  customers: arr(j?.customers).map((c) => ({ key: str(c.key), leadId: strOrNull(c.leadId), name: str(c.name), dealer: str(c.dealer), net: num(c.net), vat: num(c.vat),
    gross: num(c.gross), count: num(c.count), manual: num(c.manual) })),
});

export interface ItemSales { key: string; itemId: string | null; variantId: string | null; name: string; kind: string; typeId: string | null; qty: number; net: number }
export interface TypeSales { typeId: string | null; name: string; qty: number; net: number }
export interface SalesByItem {
  from: string; to: string; vat: boolean; total: number; items: ItemSales[]; types: TypeSales[]; unattributed: { net: number; count: number };
  /** 2.96 (T13א): manual income entries — a line of their own */
  manual: { net: number; count: number };
}
export const toSalesByItem = (j: any): SalesByItem => ({
  from: str(j?.from), to: str(j?.to), vat: Boolean(j?.vat), total: num(j?.total),
  items: arr(j?.items).map((i) => ({ key: str(i.key), itemId: strOrNull(i.itemId), variantId: strOrNull(i.variantId), name: str(i.name), kind: str(i.kind),
    typeId: strOrNull(i.typeId), qty: num(i.qty), net: num(i.net) })),
  types: arr(j?.types).map((t) => ({ typeId: strOrNull(t.typeId), name: str(t.name), qty: num(t.qty), net: num(t.net) })),
  unattributed: { net: num(j?.unattributed?.net), count: num(j?.unattributed?.count) },
  manual: { net: num(j?.manual?.net), count: num(j?.manual?.count) },
});

export type CustomerMove = 'charge' | 'credit' | 'cancelled' | 'payment_document' | 'payment_cancel' | 'payment_credit' | 'payment_refund';
/** 2.96 (T13א): kind "manual" — a manual journal entry of the customer (docNumber: the entry's number, note: its explanation) */
export interface CustomerLedgerRow {
  date: string; kind: CustomerMove | 'manual' | string; docType: number | null; docNumber: number | null; debit: number; credit: number; method: string; balance: number; note: string;
}
export interface CustomerLedger { key: string; from: string; to: string; name: string; opening: number; debit: number; credit: number; closing: number; rows: CustomerLedgerRow[] }
export const toCustomerLedger = (j: any): CustomerLedger => ({
  key: str(j?.key), from: str(j?.from), to: str(j?.to), name: str(j?.name), opening: num(j?.opening), debit: num(j?.debit), credit: num(j?.credit), closing: num(j?.closing),
  rows: arr(j?.rows).map((r) => ({ date: str(r.date), kind: str(r.kind), docType: numOrNull(r.docType), docNumber: numOrNull(r.docNumber), debit: num(r.debit),
    credit: num(r.credit), method: str(r.method), balance: num(r.balance), note: str(r.note) })),
});

/** 2.96 (T13א): "manual" — manual expense entries in the total (never paid, never owed: not in "open"); key "m:" — of no supplier */
export interface SupplierRow { key: string; name: string; dealer: string; count: number; net: number; vat: number; total: number; paid: number; open: number; manual: number }
export interface CategoryRow { category: string; count: number; net: number; total: number; paid: number; open: number; manual: number }
export interface SupplierReport {
  from: string; to: string; total: { net: number; vat: number; total: number; paid: number; open: number; count: number; manual: number }; suppliers: SupplierRow[]; categories: CategoryRow[];
}
export const toSupplierReport = (j: any): SupplierReport => ({
  from: str(j?.from), to: str(j?.to),
  total: { net: num(j?.total?.net), vat: num(j?.total?.vat), total: num(j?.total?.total), paid: num(j?.total?.paid), open: num(j?.total?.open), count: num(j?.total?.count),
    manual: num(j?.total?.manual) },
  suppliers: arr(j?.suppliers).map((s) => ({ key: str(s.key), name: str(s.name), dealer: str(s.dealer), count: num(s.count), net: num(s.net), vat: num(s.vat),
    total: num(s.total), paid: num(s.paid), open: num(s.open), manual: num(s.manual) })),
  categories: arr(j?.categories).map((c) => ({ category: str(c.category), count: num(c.count), net: num(c.net), total: num(c.total), paid: num(c.paid), open: num(c.open),
    manual: num(c.manual) })),
});

export type SupplierMove = 'invoice' | 'supplier_credit' | 'payment_expense' | 'payment_reversal';
/** 2.96 (T13א): kind "manual" — a manual journal entry of the supplier (number: the entry's, note: its explanation) */
export interface SupplierLedgerRow {
  date: string; kind: SupplierMove | 'manual' | string; number: number | null; ref: string; debit: number; credit: number; method: string; balance: number; note: string;
}
export interface SupplierLedger { key: string; from: string; to: string; name: string; opening: number; debit: number; credit: number; closing: number; rows: SupplierLedgerRow[] }
export const toSupplierLedger = (j: any): SupplierLedger => ({
  key: str(j?.key), from: str(j?.from), to: str(j?.to), name: str(j?.name), opening: num(j?.opening), debit: num(j?.debit), credit: num(j?.credit), closing: num(j?.closing),
  rows: arr(j?.rows).map((r) => ({ date: str(r.date), kind: str(r.kind), number: numOrNull(r.number), ref: str(r.ref), debit: num(r.debit), credit: num(r.credit),
    method: str(r.method), balance: num(r.balance), note: str(r.note) })),
});

export interface WithholdingCustomer { key: string; leadId: string | null; name: string; dealer: string; amount: number; count: number }
export interface WithholdingRow { date: string; key: string; name: string; dealer: string; docType: number | null; docNumber: number | null; invoice: string | null; amount: number; pct: number | null }
export interface WithholdingReport { from: string; to: string; total: number; customers: WithholdingCustomer[]; rows: WithholdingRow[] }
export const toWithholding = (j: any): WithholdingReport => ({
  from: str(j?.from), to: str(j?.to), total: num(j?.total),
  customers: arr(j?.customers).map((c) => ({ key: str(c.key), leadId: strOrNull(c.leadId), name: str(c.name), dealer: str(c.dealer), amount: num(c.amount), count: num(c.count) })),
  rows: arr(j?.rows).map((r) => ({ date: str(r.date), key: str(r.key), name: str(r.name), dealer: str(r.dealer), docType: numOrNull(r.docType), docNumber: numOrNull(r.docNumber),
    invoice: strOrNull(r.invoice), amount: num(r.amount), pct: numOrNull(r.pct) })),
});

// ---- a table: for the screen, the CSV and the PDF ---------------------------------------------------------------------------
export type ColType = 'text' | 'money' | 'qty' | 'date' | 'pct' | 'count';
export interface Column { label: string; type: ColType }
export type Cell = string | number | null;
export interface ReportTable { title: string; columns: Column[]; rows: Cell[][]; total: Cell[] | null; note?: string }
const NUMERIC: ColType[] = ['money', 'qty', 'date', 'pct', 'count'];
export const isNumeric = (t: ColType) => NUMERIC.includes(t);
const day = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split('-').reverse().join('/') : d);
const grouped = (n: number, digits: number) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** a cell as text: the CSV keeps plain numbers (Excel adds them up), the screen and the PDF group the thousands */
export function cellText(v: Cell, t: ColType, mode: 'csv' | 'show'): string {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return t === 'date' ? day(v) : v;
  switch (t) {
    case 'money': return mode === 'csv' ? v.toFixed(2) : grouped(v, 2);
    case 'qty': return Number.isInteger(v) ? String(v) : mode === 'csv' ? String(Math.round(v * 100) / 100) : grouped(v, 2);
    case 'pct': return `${Math.round(v * 100) / 100}%`;
    case 'count': return String(v);
    default: return String(v);
  }
}
/** the CSV of a table (UTF-8 with BOM, as every report file of the module): the rows, then the total */
export function tableCsv(t: ReportTable): string {
  const line = (r: Cell[]) => r.map((v, i) => cellText(v, t.columns[i]?.type ?? 'text', 'csv'));
  return csv(t.columns.map((c) => c.label), [...t.rows.map(line), ...(t.total ? [line(t.total)] : [])]);
}
/** what the PDF route draws (src/lib/server/report-pdf.ts): every cell already as text */
export interface ReportPdfBody { title: string; subtitle: string; columns: { label: string; numeric: boolean }[]; rows: string[][]; total: string[] | null; note: string }
export function pdfBody(t: ReportTable, subtitle: string): ReportPdfBody {
  const line = (r: Cell[]) => r.map((v, i) => cellText(v, t.columns[i]?.type ?? 'text', 'show'));
  return { title: t.title, subtitle, columns: t.columns.map((c) => ({ label: c.label, numeric: isNumeric(c.type) })), rows: t.rows.map(line), total: t.total ? line(t.total) : null,
    note: t.note ?? '' };
}
/** a file name of the report: its title and period, safe on every system */
export const reportFileName = (title: string, p: { from: string; to: string }, ext: 'csv' | 'pdf') =>
  `${title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, '-')}-${p.from}-${p.to}.${ext}`;

// ---- the tables -------------------------------------------------------------------------------------------------------------
const docName = (type: number | null, n: number | null) => (type ? `${DOC_LABEL[type] ?? type} ${n ?? ''}`.trim() : '');
const KIND_HE: Record<string, string> = { service: 'שירות', product: 'מוצר', package: 'חבילה', other: 'אחר' };
export const NO_TYPE = 'בלי סוג טיפול';
export const NOT_BY_ITEM = 'לא לפי פריט (מסמך בלי שורות)';
/** 2.96 (T13א): the line of the manual journal entries in a report, and of those that belong to no customer / supplier */
export const MANUAL_ENTRIES = 'פקודות יומן ידניות';
export const MANUAL_KEY = 'm:';
export const MANUAL_NO_CUSTOMER = 'פקודות ידניות (בלי לקוח)';
export const MANUAL_NO_SUPPLIER = 'פקודות ידניות (בלי ספק)';
const manualNote = (n: number) => (ag(n) ? ` כולל פקודות יומן ידניות: ₪${n.toLocaleString('he-IL', { maximumFractionDigits: 2 })}.` : '');

export function incomeTable(r: IncomeByCustomer): ReportTable {
  const columns: Column[] = r.vat
    ? [{ label: 'לקוח', type: 'text' }, { label: 'ע.מ / ח.פ', type: 'text' }, { label: 'מסמכים', type: 'count' }, { label: 'לפני מע״מ', type: 'money' },
      { label: 'מע״מ', type: 'money' }, { label: 'כולל מע״מ', type: 'money' }]
    : [{ label: 'לקוח', type: 'text' }, { label: 'ע.מ / ח.פ', type: 'text' }, { label: 'קבלות', type: 'count' }, { label: 'הכנסות', type: 'money' }];
  const nameOf = (c: CustomerIncome) => (c.key === MANUAL_KEY ? MANUAL_NO_CUSTOMER : c.name || 'לקוח מזדמן');
  const rows = r.customers.map((c) => (r.vat ? [nameOf(c), c.dealer, c.count, c.net, c.vat, c.gross] : [nameOf(c), c.dealer, c.count, c.net]));
  const total = r.vat ? ['סה״כ', '', r.total.count, r.total.net, r.total.vat, (ag(r.total.net) + ag(r.total.vat)) / 100] : ['סה״כ', '', r.total.count, r.total.net];
  return { title: 'הכנסות לפי לקוח', columns, rows, total,
    note: (r.vat ? 'חשבוניות מס וחשבוניות מס / קבלה, פחות חשבוניות זיכוי — כמו ההכנסות במסך הכספים.' : 'קבלות שלא בוטלו — כמו ההכנסות במסך הכספים.') + manualNote(r.total.manual) };
}

export function itemsTable(r: SalesByItem): ReportTable {
  const typeName = new Map(r.types.map((t) => [t.typeId ?? '', t.name]));
  const rows: Cell[][] = r.items.map((i) => [i.name || '—', KIND_HE[i.kind] ?? '', i.typeId ? typeName.get(i.typeId) || '' : '', i.qty, i.net]);
  if (ag(r.unattributed.net)) rows.push([NOT_BY_ITEM, '', '', null, r.unattributed.net]);
  if (ag(r.manual.net)) rows.push([MANUAL_ENTRIES, '', '', null, r.manual.net]);
  return { title: 'מכירות לפי פריט ושירות', columns: [{ label: 'פריט / שירות', type: 'text' }, { label: 'סוג', type: 'text' }, { label: 'סוג טיפול', type: 'text' },
    { label: 'כמות', type: 'qty' }, { label: r.vat ? 'הכנסות (לפני מע״מ)' : 'הכנסות', type: 'money' }],
  rows, total: ['סה״כ', '', '', null, r.total],
  note: 'כל מסמך מתחלק בין השורות שלו לפי הסכומים בהן (ההנחה בתוכן). קבלה בלי שורות על חשבונית — לפי השורות של החשבונית, בחלק ששולם.' };
}
export function typesTable(r: SalesByItem): ReportTable {
  const rows: Cell[][] = r.types.map((t) => [t.typeId ? t.name : NO_TYPE, t.qty, t.net]);
  if (ag(r.unattributed.net)) rows.push([NOT_BY_ITEM, null, r.unattributed.net]);
  if (ag(r.manual.net)) rows.push([MANUAL_ENTRIES, null, r.manual.net]);
  return { title: 'מכירות לפי סוג טיפול', columns: [{ label: 'סוג טיפול', type: 'text' }, { label: 'כמות', type: 'qty' },
    { label: r.vat ? 'הכנסות (לפני מע״מ)' : 'הכנסות', type: 'money' }], rows, total: ['סה״כ', null, r.total],
  note: 'שירות — לפי סוג הטיפול שלו בקטלוג; חבילה — לפי סוג הטיפול של החבילה.' };
}

const CUSTOMER_MOVE_HE: Record<string, string> = {
  charge: 'חיוב', credit: 'זיכוי', cancelled: 'ביטול מסמך', payment_document: 'תשלום', payment_cancel: 'ביטול קבלה', payment_credit: 'החזר כספי על זיכוי',
  payment_refund: 'החזר בקופה', manual: 'פקודה ידנית',
};
export const customerMoveLabel = (r: Pick<CustomerLedgerRow, 'kind' | 'method'>) =>
  `${CUSTOMER_MOVE_HE[r.kind] ?? r.kind}${r.method && r.kind.startsWith('payment_') ? ` · ${payLabel(r.method)}` : ''}`;
export function customerLedgerTable(r: CustomerLedger): ReportTable {
  return {
    title: `כרטסת לקוח — ${r.name || 'לקוח'}`,
    columns: [{ label: 'תאריך', type: 'date' }, { label: 'פעולה', type: 'text' }, { label: 'מסמך', type: 'text' }, { label: 'חובה', type: 'money' },
      { label: 'זכות', type: 'money' }, { label: 'יתרה', type: 'money' }],
    rows: [[r.from, 'יתרת פתיחה', '', null, null, r.opening],
      ...r.rows.map((x) => x.kind === 'manual'
        ? [x.date, `${customerMoveLabel(x)}${x.note ? ` — ${x.note}` : ''}`, `פקודה ${x.docNumber ?? ''}`.trim(), x.debit || null, x.credit || null, x.balance]
        : [x.date, customerMoveLabel(x), docName(x.docType, x.docNumber), x.debit || null, x.credit || null, x.balance])],
    total: [r.to, 'יתרת סגירה', '', r.debit, r.credit, r.closing],
    note: 'חובה: מה שהלקוח חויב בו. זכות: מה ששילם (גם ניכוי במקור) או זוכה בו. יתרה חיובית — הלקוח חייב לעסק.'
      + (r.rows.some((x) => x.kind === 'manual') ? ' פקודה ידנית נכללת ביתרה — אבל לא ב"חייבים" (היא לא חשבונית).' : ''),
  };
}

// 2.96 (T13א): with manual expense entries in the period — a column of their own (they are in the total, never paid, never owed)
const MANUAL_NOTE = ' פקודה ידנית נכללת בסה״כ — לא ב"שולם" ולא ב"לתשלום".';
export function suppliersTable(r: SupplierReport): ReportTable {
  const m = ag(r.total.manual) !== 0;
  return {
    title: 'הוצאות לפי ספק',
    columns: [{ label: 'ספק', type: 'text' }, { label: 'ע.מ ספק', type: 'text' }, { label: 'מסמכים', type: 'count' }, { label: 'לפני מע״מ', type: 'money' },
      { label: 'מע״מ', type: 'money' }, { label: 'סה״כ', type: 'money' }, { label: 'שולם', type: 'money' }, { label: 'לתשלום', type: 'money' },
      ...(m ? [{ label: 'פקודות ידניות', type: 'money' as const }] : [])],
    rows: r.suppliers.map((s) => [s.key === MANUAL_KEY ? MANUAL_NO_SUPPLIER : s.name, s.dealer, s.count, s.net, s.vat, s.total, s.paid, s.open, ...(m ? [s.manual] : [])]),
    total: ['סה״כ', '', r.total.count, r.total.net, r.total.vat, r.total.total, r.total.paid, r.total.open, ...(m ? [r.total.manual] : [])],
    note: 'הוצאות מאושרות בתקופה (זיכוי מספק — בניכוי). "שולם" — לפי התשלום שנרשם בהוצאה.' + (m ? MANUAL_NOTE : ''),
  };
}
export function categoriesTable(r: SupplierReport): ReportTable {
  const m = ag(r.total.manual) !== 0;
  return {
    title: 'הוצאות לפי סוג',
    columns: [{ label: 'סוג הוצאה', type: 'text' }, { label: 'מסמכים', type: 'count' }, { label: 'לפני מע״מ', type: 'money' }, { label: 'סה״כ', type: 'money' },
      { label: 'שולם', type: 'money' }, { label: 'לתשלום', type: 'money' }, ...(m ? [{ label: 'פקודות ידניות', type: 'money' as const }] : [])],
    rows: r.categories.map((c) => [categoryLabel(c.category), c.count, c.net, c.total, c.paid, c.open, ...(m ? [c.manual] : [])]),
    total: ['סה״כ', r.total.count, r.total.net, r.total.total, r.total.paid, r.total.open, ...(m ? [r.total.manual] : [])],
    ...(m ? { note: MANUAL_NOTE.trim() } : {}),
  };
}

const SUPPLIER_MOVE_HE: Record<string, string> = {
  invoice: 'חשבונית ספק', supplier_credit: 'זיכוי מהספק', payment_expense: 'תשלום לספק', payment_reversal: 'ביטול תשלום', manual: 'פקודה ידנית',
};
export const supplierMoveLabel = (r: Pick<SupplierLedgerRow, 'kind' | 'method' | 'credit'>) =>
  r.kind === 'payment_expense' && r.credit > 0 ? `החזר מהספק · ${payLabel(r.method)}`
    : `${SUPPLIER_MOVE_HE[r.kind] ?? r.kind}${r.method && r.kind.startsWith('payment_') ? ` · ${payLabel(r.method)}` : ''}`;
export function supplierLedgerTable(r: SupplierLedger): ReportTable {
  return {
    title: `כרטסת ספק — ${r.name || 'ספק'}`,
    columns: [{ label: 'תאריך', type: 'date' }, { label: 'פעולה', type: 'text' }, { label: 'הוצאה מס׳', type: 'text' }, { label: 'מסמך ספק', type: 'text' },
      { label: 'חובה', type: 'money' }, { label: 'זכות', type: 'money' }, { label: 'יתרה', type: 'money' }],
    rows: [[r.from, 'יתרת פתיחה', '', '', null, null, r.opening],
      ...r.rows.map((x) => x.kind === 'manual'
        ? [x.date, `${supplierMoveLabel(x)}${x.note ? ` — ${x.note}` : ''}`, `פקודה ${x.number ?? ''}`.trim(), '', x.debit || null, x.credit || null, x.balance]
        : [x.date, supplierMoveLabel(x), x.number == null ? '' : String(x.number), x.ref, x.debit || null, x.credit || null, x.balance])],
    total: [r.to, 'יתרת סגירה', '', '', r.debit, r.credit, r.closing],
    note: 'זכות: חשבוניות הספק (מה שהעסק חייב). חובה: תשלומים לספק וזיכויים ממנו. יתרה חיובית — העסק חייב לספק.',
  };
}

export function withholdingTable(r: WithholdingReport): ReportTable {
  return {
    title: 'ניכוי במקור לפי לקוח',
    columns: [{ label: 'לקוח', type: 'text' }, { label: 'ע.מ / ח.פ', type: 'text' }, { label: 'קבלות', type: 'count' }, { label: 'סכום שנוכה', type: 'money' }],
    rows: r.customers.map((c) => [c.name || 'לקוח', c.dealer, c.count, c.amount]),
    total: ['סה״כ', '', r.customers.reduce((a, c) => a + c.count, 0), r.total],
    note: 'מס שהלקוח ניכה במקור מתשלומים לעסק, לפי הקבלות. להשוואה מול אישורי הניכוי של הלקוחות — רואה החשבון מקזז אותו בדוח השנתי.',
  };
}
export function withholdingRowsTable(r: WithholdingReport): ReportTable {
  return {
    title: 'ניכוי במקור — קבלות',
    columns: [{ label: 'תאריך', type: 'date' }, { label: 'לקוח', type: 'text' }, { label: 'ע.מ / ח.פ', type: 'text' }, { label: 'קבלה', type: 'text' },
      { label: 'על חשבונית', type: 'text' }, { label: '% ניכוי', type: 'pct' }, { label: 'סכום', type: 'money' }],
    rows: r.rows.map((x) => {
      const inv = x.invoice?.match(/^(\d+)-(\d+)$/);
      return [x.date, x.name, x.dealer, docName(x.docType, x.docNumber) + (x.amount < 0 ? ' (בוטלה)' : ''), inv ? docName(Number(inv[1]), Number(inv[2])) : '', x.pct, x.amount];
    }),
    total: ['', 'סה״כ', '', '', '', null, r.total],
  };
}

// ---- profit and loss against the same period a year before ------------------------------------------------------------------
/** the same dates a year before (29 February → 28) */
export function yearBefore(p: { from: string; to: string }): { from: string; to: string } {
  const back = (d: string) => {
    const y = Number(d.slice(0, 4)) - 1, md = d.slice(5);
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return `${y}-${md === '02-29' && !leap ? '02-28' : md}`;
  };
  return { from: back(p.from), to: back(p.to) };
}
export interface PnlFigures { revenue: { net: number }; expenses: { net: number; vat: number; vatDeductible: number }; profit: number }
/** a change and its percent (no percent from zero) */
export const change = (now: number, before: number) => ({ diff: (ag(now) - ag(before)) / 100, pct: ag(before) ? Math.round(((now - before) / Math.abs(before)) * 1000) / 10 : null });
export function pnlTable(now: PnlFigures, before: PnlFigures, labels: { now: string; before: string }): ReportTable {
  const nonDeductible = (s: PnlFigures) => (ag(s.expenses.vat) - ag(s.expenses.vatDeductible)) / 100;
  const line = (label: string, a: number, b: number): Cell[] => { const c = change(a, b); return [label, a, b, c.diff, c.pct]; };
  return {
    title: 'רווח והפסד מול התקופה המקבילה',
    columns: [{ label: '', type: 'text' }, { label: labels.now, type: 'money' }, { label: labels.before, type: 'money' }, { label: 'שינוי', type: 'money' },
      { label: 'שינוי %', type: 'pct' }],
    rows: [line('הכנסות (לפני מע״מ)', now.revenue.net, before.revenue.net), line('הוצאות (לפני מע״מ)', now.expenses.net, before.expenses.net),
      line('מע״מ על הוצאות שלא מקוזז', nonDeductible(now), nonDeductible(before))],
    total: line('רווח משוער', now.profit, before.profit),
    note: 'הערכה לפני מס הכנסה, מתוך המסמכים וההוצאות המאושרות — לא דוח כספי מבוקר.',
  };
}
export interface MonthFigures { month: string; revenue: number; expenses: number }
const MONTH_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
export const monthLabel = (m: string) => `${MONTH_HE[Number(m.slice(5, 7)) - 1] ?? m.slice(5, 7)} ${m.slice(0, 4)}`;
/** month by month (finance_summary's months): revenue, expenses (what they cost — non-deductible VAT included), profit; and a year before */
export function monthsTable(now: MonthFigures[], before: MonthFigures[]): ReportTable {
  const prev = new Map(before.map((m) => [m.month, m]));
  const minus = (a: number, b: number) => (ag(a) - ag(b)) / 100;
  const lastYear = (m: string) => `${Number(m.slice(0, 4)) - 1}${m.slice(4)}`;
  const rows: Cell[][] = now.map((m) => {
    const b = prev.get(lastYear(m.month));
    return [monthLabel(m.month), m.revenue, m.expenses, minus(m.revenue, m.expenses), b ? b.revenue : null, b ? minus(b.revenue, b.expenses) : null];
  });
  const sum = (xs: MonthFigures[], f: (m: MonthFigures) => number) => xs.reduce((a, m) => a + ag(f(m)), 0) / 100;
  return {
    title: 'רווח והפסד לפי חודש',
    columns: [{ label: 'חודש', type: 'text' }, { label: 'הכנסות', type: 'money' }, { label: 'הוצאות', type: 'money' }, { label: 'רווח', type: 'money' },
      { label: 'הכנסות שנה קודמת', type: 'money' }, { label: 'רווח שנה קודמת', type: 'money' }],
    rows,
    total: ['סה״כ', sum(now, (m) => m.revenue), sum(now, (m) => m.expenses), sum(now, (m) => m.revenue - m.expenses), sum(before, (m) => m.revenue),
      sum(before, (m) => m.revenue - m.expenses)],
  };
}

// ---- income tax advances: an estimate only ---------------------------------------------------------------------------------
export const ADVANCE_NOTE = 'הערכה בלבד — לא סכום לתשלום. שיעור המקדמה נקבע בפנקס המקדמות של מס הכנסה; התשלום וההגשה — של העסק או של רואה החשבון.';
/** the advances' percent as typed (0–100, up to two decimals; empty = not set) — null when fine */
export function advancePctError(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t) || Number(t) > 100) return 'שיעור המקדמה: מספר בין 0 ל-100 (עד 2 ספרות אחרי הנקודה) — או ריק.';
  return null;
}
/** the estimate as a table (the screen, the CSV, the PDF): the income it is figured on, the percent, the estimate, and tax withheld */
export function advanceTable(e: { base: number; pct: number; amount: number }, withheld: number, vat: boolean): ReportTable {
  return {
    title: 'מקדמות מס הכנסה — הערכה',
    columns: [{ label: '', type: 'text' }, { label: 'סכום', type: 'money' }],
    rows: [[vat ? 'הכנסות בתקופה (לפני מע״מ)' : 'הכנסות בתקופה (קבלות)', e.base], ['שיעור המקדמה', `${e.pct}%`], ['מקדמה משוערת', e.amount],
      ['ניכוי במקור בתקופה (לבדוק עם רואה החשבון אם לקזז)', withheld]],
    total: null,
    note: ADVANCE_NOTE,
  };
}
/** the estimate of a period: its income (as the money screens: before VAT, or an exempt dealer's receipts) × the percent */
export function advanceEstimate(revenueNet: number, pct: number | null): { base: number; pct: number; amount: number } | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  return { base: revenueNet, pct, amount: Math.round(ag(revenueNet) * pct / 100) / 100 };
}
