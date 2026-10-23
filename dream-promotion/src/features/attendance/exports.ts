import JSZip from 'jszip';
import { ABSENCE_LABEL, DAY_NAMES, DAY_TYPE_LABEL, METHOD_LABEL, STATUS_LABEL, hm, pctColumns, type AbsenceKind, type DayRow, type MonthReport } from './hours-engine';

/**
 * The attendance files (tests/attendance-exports.test.ts): an employee's month as Excel and as PDF (the same rows as the screen —
 * the hours engine's), and the payroll report (PDF, or CSV when the business allows) for all employees. Pure, except the xlsx zip.
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

/** what every file says (the owner of the system, 23.10.2026): the system records and arranges; the accountant and the employer decide the pay */
export const AID_NOTE = 'הדוח מסכם את השעות כפי שנרשמו, לפי הגדרות המסלול של המעסיק — מדויק לדקה, בלי עיגול. החישוב בתלוש — של רואה החשבון והמעסיק.';
export const DRAFT_NOTE = 'שעות נוספות — טיוטה: המעסיק עוד לא אישר את הגדרות מסלול השעות.';
type Person = { employee: ExportEmployee; report: MonthReport };
const pctLabel = (p: number, draft: boolean) => (p === 100 ? 'רגילות' : `${p}%${draft ? ' (טיוטה)' : ''}`);

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
    pctColumns([r]).map((p) => `${p}%: ${hm(t.pct[p] ?? 0)}`).join(' · '),
    !r.confirmed ? DRAFT_NOTE : '',
    AID_NOTE,
  ].filter(Boolean).join(' — ');
  return { title: `דוח נוכחות חודשי — ${e.name}`, subtitle: `${businessName ? `${businessName} · ` : ''}${monthLabel(r.month)}`, columns, rows, total, note };
}

/** the month for Excel: every column of the reference; hours as H:MM — exact to the minute (a decimal hour would round) */
export function monthSheet(r: MonthReport, e: ExportEmployee): (string | number)[][] {
  const cols = pctColumns([r]);
  const head = ['תאריך', 'יום', 'סוג יום', 'שעות תקן', 'כניסה', 'דרך כניסה', 'יציאה', 'דרך יציאה', 'סה״כ יומי', 'מצטבר',
    ...cols.map((p) => pctLabel(p, !r.confirmed)), 'סטטוס'];
  const rows = r.days.map((d) => [
    dmy(d.date), DAY_NAMES[d.weekday], d.holiday || DAY_TYPE_LABEL[d.type], hm(d.standard), times(d, 'in'), ways(d, 'in'), times(d, 'out'), ways(d, 'out'),
    hm(d.paid), hm(d.cumulative), ...cols.map((p) => hm(d.pct[p] ?? 0)), statusOf(d),
  ]);
  const t = r.totals;
  return [
    [`דוח נוכחות — ${e.name}`, e.code ? `מספר עובד ${e.code}` : '', e.department, monthLabel(r.month)],
    [],
    head,
    ...rows,
    ['סה״כ', '', `${t.workDays} ימים`, hm(t.standard), '', '', '', '', hm(t.paid), '', ...cols.map((p) => hm(t.pct[p] ?? 0)), ''],
    [],
    ...(r.confirmed ? [] : [[DRAFT_NOTE]]),
    [AID_NOTE],
  ];
}

const ABSENCE_ORDER: AbsenceKind[] = ['vacation', 'sick', 'reserve', 'other'];
/** the payroll report's columns: number, name, days, regular, each overtime rate, absences, missing days */
export function payrollHeader(cols: number[]) {
  return ['מספר עובד', 'שם', 'ת.ז', 'ימי עבודה', 'שעות רגילות', ...cols.filter((p) => p !== 100).map((p) => `${p}%`), 'שעות בימי מנוחה',
    ...ABSENCE_ORDER.map((k) => `ימי ${ABSENCE_LABEL[k]}`), ...ABSENCE_ORDER.map((k) => `שעות ${ABSENCE_LABEL[k]}`), 'ימים חסרים'];
}

/** CSV (UTF-8 with BOM, so Excel shows Hebrew); hours as H:MM (exact), counts as plain numbers */
export function csv(rows: (string | number)[][]) {
  const cell = (v: string | number) => (typeof v === 'number' ? String(v) : /[",\r\n]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);
  return '\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** whose rules are not confirmed (their payroll waits); empty = the payroll report may be produced */
export const unconfirmed = (list: Person[]) => list.filter((x) => !x.report.confirmed).map((x) => x.employee.name);

/** the payroll file (CSV): one row per employee — only when every employee's rules are confirmed, and the business allows files other than PDF */
export function payrollCsv(list: Person[]): string | null {
  if (unconfirmed(list).length) return null;
  const cols = pctColumns(list.map((x) => x.report));
  const rows = list.map(({ employee: e, report: { totals: t } }) => [
    e.code, e.name, e.idNumber ?? '', t.workDays, hm(t.pct[100] ?? 0), ...cols.filter((p) => p !== 100).map((p) => hm(t.pct[p] ?? 0)), hm(t.restMinutes),
    ...ABSENCE_ORDER.map((k) => t.absenceDays[k]), ...ABSENCE_ORDER.map((k) => hm(t.absenceMinutes[k])), t.missingDays,
  ]);
  return csv([payrollHeader(cols), ...rows]);
}

/** the payroll report as a PDF (the owner of the system, 23.10.2026: a file nobody edits): 10 columns — the rates found, in order */
export function payrollPdfBody(list: Person[], month: string, businessName: string) {
  if (unconfirmed(list).length) return null;
  const rates = pctColumns(list.map((x) => x.report)).filter((p) => p !== 100);
  // number, name, days, regular, the rates (up to 4 in one column each; more — together), absence days, missing days
  const shown = rates.length <= 4 ? rates : rates.slice(0, 3);
  const rest = rates.length <= 4 ? [] : rates.slice(3);
  const columns = [
    { label: 'מספר', numeric: true }, { label: 'שם', numeric: false }, { label: 'ימים', numeric: true }, { label: 'רגילות', numeric: true },
    ...shown.map((p) => ({ label: `${p}%`, numeric: true })), ...(rest.length ? [{ label: `${rest.map((p) => `${p}%`).join('+')}`, numeric: true }] : []),
    { label: 'היעדרות', numeric: true }, { label: 'חסרים', numeric: true },
  ];
  const absDays = (t: MonthReport['totals']) => ABSENCE_ORDER.reduce((a, k) => a + t.absenceDays[k], 0);
  const line = (t: MonthReport['totals']) => [hm(t.pct[100] ?? 0), ...shown.map((p) => hm(t.pct[p] ?? 0)), ...(rest.length ? [hm(rest.reduce((a, p) => a + (t.pct[p] ?? 0), 0))] : [])];
  const rows = list.map(({ employee: e, report: { totals: t } }) => [e.code, e.name, String(t.workDays), ...line(t), String(absDays(t)), String(t.missingDays)]);
  const sum = list.reduce((acc, { report: { totals: t } }) => {
    acc.workDays += t.workDays; acc.missing += t.missingDays; acc.abs += absDays(t);
    for (const [p, m] of Object.entries(t.pct)) acc.pct[+p] = (acc.pct[+p] ?? 0) + m;
    return acc;
  }, { workDays: 0, missing: 0, abs: 0, pct: {} as Record<number, number> });
  const total = ['', 'סה״כ', String(sum.workDays), ...line({ pct: sum.pct } as MonthReport['totals']), String(sum.abs), String(sum.missing)];
  const note = ['היעדרויות לפי סוג:', ...list.map(({ employee: e, report: { totals: t } }) => {
    const k = ABSENCE_ORDER.filter((x) => t.absenceDays[x] || t.absenceMinutes[x]).map((x) => `${ABSENCE_LABEL[x]} ${t.absenceDays[x]}${t.absenceMinutes[x] ? ` + ${hm(t.absenceMinutes[x])}` : ''}`);
    return k.length ? `${e.name}: ${k.join(', ')}` : '';
  }).filter(Boolean)].join(' ');
  return { title: `דוח שכר — ${monthLabel(month)}`, subtitle: businessName, columns, rows, total, note: [note === 'היעדרויות לפי סוג:' ? '' : note, AID_NOTE].filter(Boolean).join(' — ') };
}

/** the month of all employees, for the screen and Excel (it carries the draft note while any rules wait) */
export function summarySheet(list: Person[], month: string): (string | number)[][] {
  const cols = pctColumns(list.map((x) => x.report));
  const draft = unconfirmed(list).length > 0;
  return [
    [`סיכום נוכחות — ${monthLabel(month)}`],
    [],
    ['מספר עובד', 'שם', 'מחלקה', 'ימי עבודה', 'סה״כ שעות', 'תקן', ...cols.map((p) => pctLabel(p, false)), 'ימים חסרים', 'יציאות חסרות',
      ...ABSENCE_ORDER.map((k) => `ימי ${ABSENCE_LABEL[k]}`)],
    ...list.map(({ employee: e, report: { totals: t } }) => [
      e.code, e.name, e.department, t.workDays, hm(t.paid), hm(t.standard), ...cols.map((p) => hm(t.pct[p] ?? 0)), t.missingDays, t.openShifts,
      ...ABSENCE_ORDER.map((k) => t.absenceDays[k]),
    ]),
    [],
    ...(draft ? [[`${DRAFT_NOTE} (${unconfirmed(list).join(', ')})`]] : []),
    [AID_NOTE],
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
