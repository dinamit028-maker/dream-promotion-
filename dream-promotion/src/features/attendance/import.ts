import { decodeText, parseCsv, parseXlsx, type Grid } from '@/features/finance/bank';
import { phoneDigits } from '@/features/crm/crm';
import { validIsraeliId } from './people';

/**
 * Employees from a file — the export of the previous system (OK2GO) or any sheet with a header row (tests/attendance-import.test.ts).
 * Only adds: a row whose employee code or phone is already in the business is skipped, never changed; nothing is deleted.
 * The file is read in the browser only; what is saved goes through the same insert as "הוספת עובד/ת".
 */
export type ImportField = 'code' | 'name' | 'first' | 'last' | 'phone' | 'department' | 'title' | 'idNumber' | 'startDate';
export type ImportMap = Partial<Record<ImportField, number>> & { header: number };

const WORDS: Record<ImportField, RegExp> = {
  code: /^(קוד|מספר|מס['׳"]?)\s*(ה)?עובד|^מספר אישי$|^employee\s*(id|code|no)/i,
  name: /^(שם\s*(ה)?עובד|שם\s*מלא|שם|full\s*name|name)$/i,
  first: /^(שם\s*פרטי|first\s*name)$/i,
  last: /^(שם\s*משפחה|last\s*name)$/i,
  phone: /(טלפון|נייד|פלאפון|סלולרי|phone|mobile)/i,
  department: /^(מחלקה|department)$/i,
  title: /^(תואר|תפקיד|title|role)$/i,
  idNumber: /^(ת\.?\s*ז\.?|תעודת\s*זהות|מספר\s*זהות|id\s*number)$/i,
  startDate: /(תאריך\s*(תחילת\s*עבודה|התחלה|קליטה|תחילה)|start\s*date)/i,
};

/** the header row (one of the first 10) and the column of each field */
export function detectImportColumns(grid: Grid): ImportMap | null {
  for (let h = 0; h < Math.min(10, grid.length); h++) {
    const row = grid[h].map((c) => c.trim().replace(/\s+/g, ' '));
    const map: ImportMap = { header: h };
    const used = new Set<number>();
    (Object.keys(WORDS) as ImportField[]).forEach((f) => {
      const i = row.findIndex((c, ci) => WORDS[f].test(c) && !used.has(ci));
      if (i >= 0) { map[f] = i; used.add(i); }
    });
    if (map.name != null || (map.first != null && map.last != null)) return map;
  }
  return null;
}

export interface ImportDraft { row: number; code: string; name: string; phone: string; department: string; title: string; idNumber: string; startDate: string | null }
export interface ImportPlan { add: ImportDraft[]; skipped: { row: number; name: string; why: string }[]; departments: string[] }

/** a date as a sheet writes it: 2026-01-31, 31/01/2026, 31.1.26, or an Excel day number */
export function sheetDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(s);
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else if (dmy) { d = +dmy[1]; m = +dmy[2]; y = +dmy[3] < 100 ? 2000 + +dmy[3] : +dmy[3]; }
  else if (/^\d{5}(\.\d+)?$/.test(s)) { const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 864e5); y = t.getUTCFullYear(); m = t.getUTCMonth() + 1; d = t.getUTCDate(); }
  else return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d || y < 1950 || y > 2100) return null;
  return t.toISOString().slice(0, 10);
}

/** the rows to add, and the ones skipped with why — against the business's employees (code / phone) and within the file */
export function planImport(grid: Grid, map: ImportMap, existing: { code: string; phone: string }[]): ImportPlan {
  const codes = new Set(existing.map((e) => e.code.trim()).filter(Boolean));
  const phones = new Set(existing.map((e) => phoneDigits(e.phone)).filter((p) => p.length >= 9));
  const cell = (r: string[], f: ImportField) => (map[f] != null ? String(r[map[f]!] ?? '').trim() : '');
  const out: ImportPlan = { add: [], skipped: [], departments: [] };
  grid.slice(map.header + 1).forEach((r, i) => {
    const row = map.header + i + 2;   // as the sheet numbers it
    const name = (cell(r, 'name') || `${cell(r, 'first')} ${cell(r, 'last')}`).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) { if (r.some((c) => c.trim())) out.skipped.push({ row, name: '', why: 'אין שם' }); return; }
    const code = cell(r, 'code').slice(0, 20);
    const phone = cell(r, 'phone');
    const digits = phoneDigits(phone);
    if (code && codes.has(code)) { out.skipped.push({ row, name, why: `מספר עובד ${code} כבר קיים` }); return; }
    if (digits.length >= 9 && phones.has(digits)) { out.skipped.push({ row, name, why: 'הטלפון כבר שייך לעובד/ת' }); return; }
    const idRaw = cell(r, 'idNumber').replace(/\D/g, '');
    const idNumber = idRaw ? idRaw.padStart(9, '0') : '';
    const start = cell(r, 'startDate');
    out.add.push({
      row, code, name, phone: phone.slice(0, 30), department: cell(r, 'department').slice(0, 60), title: cell(r, 'title').slice(0, 60),
      idNumber: idNumber && validIsraeliId(idNumber) ? idNumber : '', startDate: start ? sheetDate(start) : null,
    });
    if (code) codes.add(code);
    if (digits.length >= 9) phones.add(digits);
  });
  out.departments = [...new Set(out.add.map((a) => a.department).filter(Boolean))];
  return out;
}

/** any file → its rows of text (xlsx, csv; an old xls is asked to be saved again) */
export async function readSheet(name: string, bytes: Uint8Array): Promise<{ ok: true; grid: Grid } | { ok: false; error: string }> {
  if (!bytes.length) return { ok: false, error: 'הקובץ ריק.' };
  if (bytes.length > 5 * 1024 * 1024) return { ok: false, error: 'הקובץ גדול מדי (עד 5MB).' };
  try {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return { ok: true, grid: await parseXlsx(bytes) };
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf) return { ok: false, error: 'זה קובץ Excel ישן (xls). פותחים אותו ב-Excel, שומרים כ-xlsx או CSV, ומעלים שוב.' };
    if (/\.pdf$/i.test(name)) return { ok: false, error: 'קובץ PDF לא נקרא — מעלים Excel או CSV.' };
    return { ok: true, grid: parseCsv(decodeText(bytes)) };
  } catch {
    return { ok: false, error: 'לא הצלחנו לקרוא את הקובץ. שומרים אותו שוב כ-xlsx או CSV ומנסים שוב.' };
  }
}
