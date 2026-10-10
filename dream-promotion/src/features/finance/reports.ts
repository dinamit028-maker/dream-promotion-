import { DOC_LABEL, PAY_LABEL } from '@/features/documents/documents';
import type { DocRow } from '@/features/documents/documents';
import { categoryLabel, SUPPLIER_DOC_TYPES, vatDeductible, type Expense } from './expenses';
import { LEDGER_SOURCE_HE, payLabel, type LedgerRow } from './payments';
import { STATUS_HE, receivableStatus, type Receivable } from './receivables';

/**
 * Report periods and the accountant's files (CSV, UTF-8 with BOM so Excel shows Hebrew). The totals themselves come
 * from finance_summary() in the database — these files list the rows behind them, one row per document / expense /
 * ledger entry, nothing recomputed differently.
 */
export type PeriodKind = 'month' | 'bimonth' | 'quarter' | 'year';
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1..12
/** the period that contains `ref` (YYYY-MM-DD). VAT reports are monthly or every two months (Jan–Feb, Mar–Apr…). */
export function periodOf(kind: PeriodKind, ref: string): { from: string; to: string; label: string } {
  const y = Number(ref.slice(0, 4)), m = Number(ref.slice(5, 7));
  const span = kind === 'month' ? 1 : kind === 'bimonth' ? 2 : kind === 'quarter' ? 3 : 12;
  const start = kind === 'year' ? 1 : Math.floor((m - 1) / span) * span + 1;
  const end = start + span - 1;
  const months = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  const label = kind === 'year' ? `${y}` : span === 1 ? `${months[start - 1]} ${y}` : `${months[start - 1]}–${months[end - 1]} ${y}`;
  return { from: `${y}-${pad(start)}-01`, to: `${y}-${pad(end)}-${pad(lastDay(y, end))}`, label };
}
/** the period before (for "the previous VAT report") */
export function previousPeriod(kind: PeriodKind, ref: string) {
  const p = periodOf(kind, ref);
  const d = new Date(`${p.from}T12:00:00Z`); d.setUTCDate(0);
  return periodOf(kind, d.toISOString().slice(0, 10));
}

const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
/** a CSV file as Excel opens it in Hebrew (UTF-8 with BOM) — every report file of the module is made by it */
export const csv = (head: string[], rows: unknown[][]) => '﻿' + [head.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
const money = (n: number) => n.toFixed(2);
const day = (d: string | null | undefined) => (d ? d.split('-').reverse().join('/') : '');

export function documentsCsv(docs: (DocRow & { cancelled?: boolean; allocation?: string })[]) {
  return csv(['סוג', 'מספר', 'תאריך', 'לקוח', 'ע.מ / ח.פ לקוח', 'לפני הנחה', 'הנחה', 'לפני מע״מ', 'מע״מ', 'סה״כ', 'אמצעי תשלום', 'מסמך בסיס', 'מועד תשלום', 'מספר הקצאה', 'סטטוס'],
    docs.map((d) => [DOC_LABEL[d.docType] ?? d.docType, d.docNumber, day(d.docDate), d.customerName, d.customerDealer ?? '', money(d.beforeDiscount), money(d.discount),
      money(d.afterDiscount), money(d.vatAmount), money(d.total), d.payments.map((p) => `${PAY_LABEL[p.method] ?? 'אחר'} ${money(p.amount)}`).join(' + '),
      d.baseDocNumber ? `${DOC_LABEL[d.baseDocType ?? 0] ?? ''} ${d.baseDocNumber}` : '', day(d.dueDate), d.allocation ?? '', d.cancelled ? 'בוטל' : '']));
}
export function expensesCsv(list: Expense[], businessChargesVat: boolean) {
  return csv(['מספר', 'תאריך', 'ספק', 'ע.מ ספק', 'סוג מסמך', 'מספר מסמך', 'מספר הקצאה', 'קטגוריה', 'תיאור', 'לפני מע״מ', 'מע״מ', 'סה״כ', '% מע״מ לקיזוז', 'מע״מ לקיזוז', 'שולם', 'סטטוס', 'קובץ'],
    list.map((e) => [e.number, day(e.docDate), e.supplierName, e.supplierDealer, SUPPLIER_DOC_TYPES.find((t) => t.id === e.supplierDocType)?.label ?? e.supplierDocType,
      e.supplierDocNumber, e.allocationNumber, categoryLabel(e.category), e.description, money(e.amountBeforeVat), money(e.vatAmount), money(e.total), e.vatDeductiblePct,
      money(e.status === 'confirmed' ? vatDeductible(e, businessChargesVat) : 0),
      e.paidOn ? `${day(e.paidOn)} · ${payLabel(e.paymentMethod ?? '')}` : '', e.status === 'void' ? `מבוטלת: ${e.voidReason}` : e.status === 'draft' ? 'טיוטה' : 'מאושרת',
      e.filePath ? e.filePath.split('/').pop() : '']));
}
export function ledgerCsv(rows: LedgerRow[]) {
  return csv(['תאריך', 'כיוון', 'סכום', 'אמצעי', 'מקור', 'הערה'],
    rows.map((r) => [day(r.paidOn), r.direction === 'in' ? 'נכנס' : 'יצא', money(r.direction === 'in' ? r.amount : -r.amount), payLabel(r.method), LEDGER_SOURCE_HE[r.source], r.note]));
}
export function receivablesCsv(list: Receivable[], today: string) {
  return csv(['סוג', 'מספר', 'תאריך', 'לקוח', 'טלפון', 'סה״כ', 'זוכה', 'שולם', 'יתרה', 'לתשלום עד', 'סטטוס'],
    list.map((r) => [DOC_LABEL[r.docType] ?? r.docType, r.docNumber, day(r.docDate), r.customerName, r.customerPhone, money(r.total), money(r.credited), money(r.paid),
      money(r.balance), day(r.dueDate), STATUS_HE[receivableStatus(r, today)]]));
}
/** the VAT report of a period, as the accountant reads it (a working paper — not a filing) */
export function vatReportRows(s: { revenue: { net: number; vat: number }; expenses: { net: number; vat: number; vatDeductible: number }; vatPayable: number }) {
  return [
    ['עסקאות חייבות (לפני מע״מ)', s.revenue.net], ['מע״מ עסקאות', s.revenue.vat], ['תשומות (לפני מע״מ)', s.expenses.net],
    ['מע״מ תשומות (סה״כ)', s.expenses.vat], ['מע״מ תשומות לקיזוז', s.expenses.vatDeductible], ['מע״מ לתשלום (להחזר אם שלילי)', s.vatPayable],
  ] as [string, number][];
}
