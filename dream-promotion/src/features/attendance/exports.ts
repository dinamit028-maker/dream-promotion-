import JSZip from 'jszip';
import { ABSENCE_LABEL, DAY_NAMES, DAY_TYPE_LABEL, METHOD_LABEL, STATUS_LABEL, hm, hoursDec, type AbsenceKind, type DayRow, type MonthReport } from './hours-engine';
import { OVERTIME_CONFIRMED, PCT_COLUMNS } from './overtime-rules';

/**
 * The attendance files (tests/attendance-exports.test.ts): an employee's month as Excel and as PDF (the same rows as the screen —
 * the hours engine's), and the payroll file (CSV) for all employees. Pure, except the xlsx zip.
 * Nothing here computes hours: it only writes what monthReport() returned.
 */
export interface ExportEmployee { id: string; name: string; code: string; department: string; title: string; idNumber?: string }

const dmy = (d: string) => d.split('-').reverse().join('/');
const times = (d: DayRow, side: 'in' | 'out') =>
  d.shifts.map((s) => (side === 'in' ? s.inTime : s.outTime ? `${s.outTime}${s.outNextDay ? '+1' : ''}` : 'חסר')).join(' / ');
const ways = (d: DayRow, side: 'in' | 'out') =>
  d.shifts.map((s) => (side === 'in' ? METHOD_LABEL[s.method] : s.outMethod ? METHOD_LABEL[s.outMethod] : '')).join(' / ');
const overtime = (d: DayRow) => Object.entries(d.pct).filter(([p]) => +p !== 100).reduce((a, [, m]) => a + m, 0);
const statusOf = (d: DayRow) => (d.absence ? `${ABSENCE_LABEL[d.absence.kind]}${d.absence.minutes ? ` ${hm(d.absence.minutes)}` : ''}` : STATUS_LABEL[d.status]);

export const DRAFT_NOTE = 'שעות נוספות (125% / 150% ומעלה) — טיוטה: כללי השעות הנוספות עדיין ממתינים לאישור.';

/** the month for the PDF: 10 columns at most (report-pdf.ts), every cell as text */
export function monthPdfBody(r: MonthReport, e: ExportEmployee, businessName: string) {
  const columns = [
    { label: 'תאריך', numeric: true }, { label: 'יום', numeric: false }, { label: 'סוג יום', numeric: false }, { label: 'תקן', numeric: true },
    { label: 'כניסה', numeric: true }, { label: 'יציאה', numeric: true }, { label: 'יומי', numeric: true }, { label: 'מצטבר', numeric: true },
    { label: 'נוספות', numeric: true }, { label: 'סטטוס', numeric: false },
  ];
  const rows = r.days.map((d) => [
    dmy(d.date), DAY_NAMES[d.weekday], d.holiday || DAY_TYPE_LABEL[d.type], d.standard ? hm(d.standard) : '',
    times(d, 'in'), times(d, 'out'), d.paid ? hm(d.paid) : '', hm(d.cumulative), overtime(d) ? hm(overtime(d)) : '', statusOf(d),
  ]);
  const t = r.totals;
  const total = ['סה״כ', '', `${t.workDays} ימים`, hm(t.standard), '', '', hm(t.paid), '', hm(t.paid - (t.pct[100] ?? 0)), t.missingDays ? `${t.missingDays} חסרים` : ''];
  const note = [
    `${e.name}${e.code ? ` · מספר עובד ${e.code}` : ''}${e.department ? ` · ${e.department}` : ''}`,
    PCT_COLUMNS.map((p) => `${p}%: ${hm(t.pct[p] ?? 0)}`).join(' · '),
    !OVERTIME_CONFIRMED ? DRAFT_NOTE : '',
  ].filter(Boolean).join(' — ');
  return { title: `דוח נוכחות חודשי — ${e.name}`, subtitle: `${businessName ? `${businessName} · ` : ''}${monthLabel(r.month)}`, columns, rows, total, note };
}

/** the month for Excel: every column of the reference, hours as numbers (decimal hours) so Excel can add them up */
export function monthSheet(r: MonthReport, e: ExportEmployee): (string | number)[][] {
  const head = ['תאריך', 'יום', 'סוג יום', 'שעות תקן', 'כניסה', 'דרך כניסה', 'יציאה', 'דרך יציאה', 'סה״כ יומי', 'מצטבר',
    ...PCT_COLUMNS.map((p) => (p === 100 ? 'רגילות' : `${p}%${OVERTIME_CONFIRMED ? '' : ' (טיוטה)'}`)), 'סטטוס'];
  const rows = r.days.map((d) => [
    dmy(d.date), DAY_NAMES[d.weekday], d.holiday || DAY_TYPE_LABEL[d.type], hoursDec(d.standard), times(d, 'in'), ways(d, 'in'), times(d, 'out'), ways(d, 'out'),
    hoursDec(d.paid), hoursDec(d.cumulative), ...PCT_COLUMNS.map((p) => hoursDec(d.pct[p] ?? 0)), statusOf(d),
  ]);
  const t = r.totals;
  return [
    [`דוח נוכחות — ${e.name}`, e.code ? `מספר עובד ${e.code}` : '', e.department, monthLabel(r.month)],
    [],
    head,
    ...rows,
    ['סה״כ', '', `${t.workDays} ימים`, hoursDec(t.standard), '', '', '', '', hoursDec(t.paid), '', ...PCT_COLUMNS.map((p) => hoursDec(t.pct[p] ?? 0)), ''],
    ...(OVERTIME_CONFIRMED ? [] : [[], [DRAFT_NOTE]]),
  ];
}

const ABSENCE_ORDER: AbsenceKind[] = ['vacation', 'sick', 'reserve', 'other'];
/** the payroll file's columns (the standard ones: number, days, regular, 125%, 150% — and the rest, and absences by kind) */
export const PAYROLL_HEADER = ['מספר עובד', 'שם', 'ת.ז', 'ימי עבודה', 'שעות רגילות', '125%', '150%', '175%', '200%', 'שעות בימי מנוחה',
  ...ABSENCE_ORDER.map((k) => `ימי ${ABSENCE_LABEL[k]}`), ...ABSENCE_ORDER.map((k) => `שעות ${ABSENCE_LABEL[k]}`), 'ימים חסרים'];

/** CSV (UTF-8 with BOM, so Excel shows Hebrew); a number is a plain number with a point */
export function csv(rows: (string | number)[][]) {
  const cell = (v: string | number) => (typeof v === 'number' ? String(v) : /[",\r\n]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** the payroll file: one row per employee. Refused (null) while the overtime rules are not confirmed. */
export function payrollCsv(list: { employee: ExportEmployee; report: MonthReport }[], o: { confirmed?: boolean } = {}): string | null {
  if (!(o.confirmed ?? OVERTIME_CONFIRMED)) return null;
  const rows = list.map(({ employee: e, report: { totals: t } }) => [
    e.code, e.name, e.idNumber ?? '', t.workDays, hoursDec(t.pct[100] ?? 0), hoursDec(t.pct[125] ?? 0), hoursDec(t.pct[150] ?? 0),
    hoursDec(t.pct[175] ?? 0), hoursDec(t.pct[200] ?? 0), hoursDec(t.restMinutes),
    ...ABSENCE_ORDER.map((k) => t.absenceDays[k]), ...ABSENCE_ORDER.map((k) => hoursDec(t.absenceMinutes[k])), t.missingDays,
  ]);
  return csv([PAYROLL_HEADER, ...rows]);
}

/** the month of all employees, for the screen and Excel (always — it carries the draft note while the rules wait) */
export function summarySheet(list: { employee: ExportEmployee; report: MonthReport }[], month: string): (string | number)[][] {
  return [
    [`סיכום נוכחות — ${monthLabel(month)}`],
    [],
    ['מספר עובד', 'שם', 'מחלקה', 'ימי עבודה', 'סה״כ שעות', 'תקן', ...PCT_COLUMNS.map((p) => (p === 100 ? 'רגילות' : `${p}%`)), 'ימים חסרים', 'יציאות חסרות',
      ...ABSENCE_ORDER.map((k) => `ימי ${ABSENCE_LABEL[k]}`)],
    ...list.map(({ employee: e, report: { totals: t } }) => [
      e.code, e.name, e.department, t.workDays, hoursDec(t.paid), hoursDec(t.standard), ...PCT_COLUMNS.map((p) => hoursDec(t.pct[p] ?? 0)), t.missingDays, t.openShifts,
      ...ABSENCE_ORDER.map((k) => t.absenceDays[k]),
    ]),
    ...(OVERTIME_CONFIRMED ? [] : [[], [DRAFT_NOTE]]),
  ];
}

const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
export const monthLabel = (month: string) => `${HE_MONTHS[+month.slice(5, 7) - 1]} ${month.slice(0, 4)}`;
export const fileName = (title: string, month: string, ext: 'xlsx' | 'pdf' | 'csv') => `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim().replace(/\s+/g, '-')}-${month}.${ext}`;

// ---- a minimal xlsx (one sheet per table, right to left; strings inline, numbers as numbers) ----------------------------------
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // characters XML 1.0 does not allow
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const colName = (i: number) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
export function sheetXml(rows: (string | number | null)[][]) {
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    if (v == null || v === '') return '';
    const ref = `${colName(ci)}${ri + 1}`;
    return typeof v === 'number' && Number.isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
  }).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews><sheetData>${body}</sheetData></worksheet>`;
}
export async function xlsx(sheets: { name: string; rows: (string | number | null)[][] }[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const safe = (n: string, i: number) => (n.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || `גיליון ${i + 1}`);
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(safe(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)));
  return zip.generateAsync({ type: 'uint8array' });
}
