import JSZip from 'jszip';
import { DOC_LABEL } from '@/features/documents/documents';
import { payLabel } from './payments';

/**
 * The bank's reconciliation (2.95, migration 20261011005000 — docs/FINANCE_ADDITIONS_HE.md T9): the owner uploads the file of
 * movements the bank's site gives (CSV, Excel — xlsx, or the HTML "xls" some banks send) — this is not a connection to the bank.
 * The file is read here, in the browser: its columns are found by their names (Hebrew or English — or the owner points at them), each
 * row becomes a line (a day, an amount: money in above zero, money out below), and the database keeps every line once however many
 * files carry it (bank_import). A match is suggested by amount (to the agora) and date (a few days apart) — a line of money in with a
 * receipt or a deposit, a line of money out with a payment to a supplier — and saved only when the owner approves it (bank_match).
 */

// ---------- reading a file ----------
export type Grid = string[][];
export type FileKind = 'csv' | 'xlsx' | 'html';
export type ReadResult = { ok: true; grid: Grid; kind: FileKind } | { ok: false; error: string };

/** the text of a file: UTF-8 (with or without its mark), else Windows-1255 (the Hebrew of the banks' older exports) */
export function decodeText(bytes: Uint8Array): string {
  const b = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { /* not UTF-8 */ }
  try { return new TextDecoder('windows-1255').decode(b); } catch { return new TextDecoder('utf-8').decode(b); }
}

/** CSV / TSV / semicolons: the separator the header row uses most; quotes ("a, b" and "" inside) as Excel writes them */
export function parseCsv(text: string): Grid {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const count = (ch: string) => first.split(ch).length - 1;
  const sep = [',', ';', '\t', '|'].sort((a, z) => count(z) - count(a))[0];
  const rows: Grid = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"' && cell.trim() === '') { q = true; cell = ''; }
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? m);
const cellText = (html: string) => decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** an HTML table (what some banks call "xls"): every row of every table, in order */
export function parseHtmlTable(text: string): Grid {
  const rows: Grid = [];
  for (const tr of text.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...tr.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cellText(m[1]));
    if (cells.some((c) => c !== '')) rows.push(cells);
  }
  return rows;
}

const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const xmlText = (s: string) => decodeEntities([...s.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
/** an Excel file (xlsx): its first sheet, as text — numbers as written in the file (a date is a day number: parseDate reads it) */
export async function parseXlsx(bytes: Uint8Array): Promise<Grid> {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (p: string) => (await zip.file(p)?.async('string')) ?? null;
  const wb = (await read('xl/workbook.xml')) ?? '';
  const rels = (await read('xl/_rels/workbook.xml.rels')) ?? '';
  const firstId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  const target = firstId ? new RegExp(`<Relationship\\b[^>]*\\bId="${firstId}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1]
                           ?? new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${firstId}"`).exec(rels)?.[1] : null;
  const path = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`) : 'xl/worksheets/sheet1.xml';
  const sheet = (await read(path)) ?? (await read('xl/worksheets/sheet1.xml'));
  if (!sheet) throw new Error('no sheet');
  const shared = [...((await read('xl/sharedStrings.xml')) ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]));
  const rows: Grid = [];
  for (const r of sheet.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
    const row: string[] = [];
    for (const c of r.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]; const body = c[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      const text = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? xmlText(body) : decodeEntities(v);
      const i = ref ? colIndex(ref) : row.length;
      while (row.length < i) row.push('');
      row[i] = text.trim();
    }
    if (row.some((x) => x !== '')) rows.push(row);
  }
  return rows;
}

/** any file of the bank → its rows of text */
export async function readBankFile(name: string, bytes: Uint8Array): Promise<ReadResult> {
  if (!bytes.length) return { ok: false, error: 'הקובץ ריק.' };
  if (bytes.length > 5 * 1024 * 1024) return { ok: false, error: 'הקובץ גדול מדי (עד 5MB). מורידים מהבנק תקופה קצרה יותר.' };
  try {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return { ok: true, grid: await parseXlsx(bytes), kind: 'xlsx' };
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      return { ok: false, error: 'זה קובץ Excel ישן (xls). פותחים אותו ב-Excel ושומרים כ-xlsx או כ-CSV, ומעלים שוב.' };
    }
    const text = decodeText(bytes);
    if (/<table[\s>]/i.test(text)) return { ok: true, grid: parseHtmlTable(text), kind: 'html' };
    if (/\.pdf$/i.test(name) || text.startsWith('%PDF')) return { ok: false, error: 'קובץ PDF לא נקרא כאן — מורידים מהבנק קובץ Excel או CSV.' };
    return { ok: true, grid: parseCsv(text), kind: 'csv' };
  } catch {
    return { ok: false, error: 'הקובץ לא נקרא. מורידים מהבנק קובץ Excel (xlsx) או CSV ומנסים שוב.' };
  }
}

// ---------- the columns ----------
/** the column of each field in the file (-1 = none); the header row's index */
export interface ColumnMap { header: number; date: number; description: number; reference: number; amount: number; debit: number; credit: number; balance: number }
export const NO_COLUMNS: ColumnMap = { header: -1, date: -1, description: -1, reference: -1, amount: -1, debit: -1, credit: -1, balance: -1 };
const norm = (s: string) => s.toLowerCase().replace(/["'׳״`.:()\-_/\\₪]/g, '').replace(/\s+/g, '');
const NAMES: Record<Exclude<keyof ColumnMap, 'header'>, string[]> = {
  date: ['תאריך', 'תאריךתנועה', 'תאריךהתנועה', 'תאריךפעולה', 'תאריךהפעולה', 'תאריךרישום', 'date', 'transactiondate', 'תאריךערך', 'valuedate'],
  description: ['תיאור', 'תיאורהתנועה', 'תיאורפעולה', 'הפעולה', 'פעולה', 'פרטים', 'פירוט', 'סוגתנועה', 'תנועה', 'description', 'details', 'memo', 'narrative'],
  reference: ['אסמכתא', 'אסמכתה', 'מסאסמכתא', 'מספראסמכתא', 'reference', 'ref', 'referenceno'],
  amount: ['סכום', 'סכוםהתנועה', 'סכוםבשח', 'סכוםב', 'סכוםבשקלים', 'סכוםפעולה', 'amount', 'sum'],
  debit: ['חובה', 'בחובה', 'סכוםבחובה', 'סכוםחובה', 'חובהבשח', 'משיכה', 'משיכות', 'חיוב', 'debit', 'withdrawal', 'withdrawals'],
  credit: ['זכות', 'בזכות', 'סכוםבזכות', 'סכוםזכות', 'זכותבשח', 'הפקדה', 'הפקדות', 'זיכוי', 'credit', 'deposit', 'deposits'],
  balance: ['יתרה', 'יתרהבשח', 'יתרהב', 'יתרהבשקלים', 'יתרהלאחרתנועה', 'יתרהבחשבון', 'יתרהבסוףיום', 'balance', 'runningbalance'],
};
/** a header that starts with one of these names is that column, when no header is exactly a name of it ("תאריך התנועה בבנק") */
const PREFIX: Partial<Record<Exclude<keyof ColumnMap, 'header'>, string[]>> = {
  date: ['תאריך', 'date'], description: ['תיאור', 'פרטי', 'description'], reference: ['אסמכת', 'reference'], debit: ['חובה', 'debit'],
  credit: ['זכות', 'credit'], amount: ['סכום', 'amount'], balance: ['יתרה', 'balance'],
};
const ORDER: Exclude<keyof ColumnMap, 'header'>[] = ['date', 'debit', 'credit', 'amount', 'balance', 'description', 'reference'];
/** the columns by their names: the first row (of the first 30) that names a day and an amount (or debit and credit) */
export function detectColumns(grid: Grid): ColumnMap | null {
  for (let h = 0; h < Math.min(grid.length, 30); h++) {
    const cells = grid[h].map(norm);
    const m: ColumnMap = { ...NO_COLUMNS, header: h };
    const taken = () => ORDER.map((k) => m[k]).filter((i) => i >= 0);
    for (const k of ORDER) {
      for (const n of NAMES[k]) { const i = cells.findIndex((c, x) => c === n && !taken().includes(x)); if (i >= 0) { m[k] = i; break; } }
    }
    for (const k of ORDER) {
      if (m[k] >= 0 || (k === 'amount' && m.debit >= 0 && m.credit >= 0)) continue;
      for (const n of PREFIX[k] ?? []) { const i = cells.findIndex((c, x) => c.startsWith(n) && !taken().includes(x)); if (i >= 0) { m[k] = i; break; } }
    }
    if (m.date >= 0 && (m.amount >= 0 || (m.debit >= 0 && m.credit >= 0))) return m;
  }
  return null;
}
export const mapReady = (m: ColumnMap) => m.date >= 0 && (m.amount >= 0 || m.debit >= 0 || m.credit >= 0);

// ---------- the values ----------
/** an amount as the banks write it: 1,234.56 · -1,234.56 · 1,234.56- · (1,234.56) · ₪ 1,234.56 · 1.234,56 — null when none */
export function parseAmount(raw: string | null | undefined): number | null {
  let s = String(raw ?? '').replace(/[‎‏‪-‮]/g, '').replace(/₪|ש"ח|ש״ח|nis|ils/gi, '').replace(/\s+/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s) * 100) / 100;
  return neg ? -n : n;
}
const pad = (n: number) => String(n).padStart(2, '0');
const validDay = (y: number, m: number, d: number) => {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};
/** a day as the banks write it: 31/12/2026 · 31.12.26 · 31-12-2026 · 2026-12-31 · an Excel day number — yyyy-mm-dd, or null */
export function parseDate(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').replace(/[‎‏]/g, '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) return validDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})(?:\s.*)?$/.exec(s);
  if (m) return validDay(m[3].length === 2 ? 2000 + Number(m[3]) : +m[3], +m[2], +m[1]);
  if (/^\d{5}(\.\d+)?$/.test(s)) {           // Excel: days since 30.12.1899
    const n = Math.floor(Number(s));
    if (n < 36526 || n > 73050) return null;  // 2000 … 2099
    const dt = new Date(Date.UTC(1899, 11, 30) + n * 864e5);
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  }
  return null;
}

/** a line of the bank as bank_import takes it */
export interface BankLineIn { date: string; amount: number; description: string; reference: string; balance: number | null }
/** the rows under the header → lines. A row with no day or no amount (a total, an empty row, the account's title) is skipped. */
export function toBankLines(grid: Grid, m: ColumnMap): { lines: BankLineIn[]; skipped: number } {
  const lines: BankLineIn[] = [];
  let skipped = 0;
  const at = (r: string[], i: number) => (i >= 0 ? r[i] ?? '' : '');
  for (const r of grid.slice(m.header + 1)) {
    const date = parseDate(at(r, m.date));
    let amount: number | null = null;
    if (m.amount >= 0) amount = parseAmount(at(r, m.amount));
    if (amount == null && (m.debit >= 0 || m.credit >= 0)) {
      const d = parseAmount(at(r, m.debit)), c = parseAmount(at(r, m.credit));
      if (d != null || c != null) amount = Math.round(((c ?? 0) - Math.abs(d ?? 0)) * 100) / 100;
    }
    if (!date || amount == null || amount === 0) { skipped++; continue; }
    const bal = parseAmount(at(r, m.balance));
    lines.push({ date, amount, description: at(r, m.description).replace(/\s+/g, ' ').trim().slice(0, 300), reference: at(r, m.reference).trim().slice(0, 60),
      balance: bal });
  }
  return { lines, skipped };
}
/** what a file gives: its days, money in and out — for the owner to see before importing */
export function fileSummary(lines: BankLineIn[]) {
  const days = lines.map((l) => l.date).sort();
  let inA = 0, outA = 0;
  for (const l of lines) { const a = Math.round(l.amount * 100); if (a > 0) inA += a; else outA -= a; }
  return { count: lines.length, from: days[0] ?? null, to: days[days.length - 1] ?? null, in: inA / 100, out: outA / 100 };
}

// ---------- the lines, the candidates and the suggestions ----------
export interface PayCard {
  id: string; direction: 'in' | 'out'; amount: number; method: string; paidOn: string; source: string; docType: number | null; docNumber: number | null;
  customer: string; expenseNumber: number | null; supplier: string; note: string; cheque: string | null;
}
export interface DepositCard { id: string; number: number; date: string; cash: number; cheques: number; total: number; count: number }
export interface BankMatch { id: string; amount: number; payment: PayCard | null; deposit: { id: string; number: number; date: string; cash: number; cheques: number } | null }
export interface BankLine {
  id: string; date: string; description: string; reference: string; amount: number; balance: number | null; status: 'open' | 'matched' | 'handled';
  note: string; account: string; statement: string; matches: BankMatch[];
}
export interface Statement { id: string; account: string; file: string; total: number; added: number; from: string | null; to: string | null; at: string }

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const numOrNull = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
export const toPayCard = (p: any): PayCard => ({
  id: str(p?.id), direction: p?.direction === 'out' ? 'out' : 'in', amount: num(p?.amount), method: str(p?.method), paidOn: str(p?.paidOn), source: str(p?.source),
  docType: numOrNull(p?.docType), docNumber: numOrNull(p?.docNumber), customer: str(p?.customer), expenseNumber: numOrNull(p?.expenseNumber),
  supplier: str(p?.supplier), note: str(p?.note), cheque: p?.cheque == null ? null : str(p.cheque),
});
const toDepositCard = (d: any): DepositCard => ({ id: str(d?.id), number: num(d?.number), date: str(d?.date), cash: num(d?.cash), cheques: num(d?.cheques),
  total: num(d?.total ?? num(d?.cash) + num(d?.cheques)), count: num(d?.count) });
export const toBankBook = (j: any): { lines: BankLine[]; statements: Statement[] } => ({
  lines: arr(j?.lines).map((l) => ({
    id: str(l?.id), date: str(l?.date), description: str(l?.description), reference: str(l?.reference), amount: num(l?.amount), balance: numOrNull(l?.balance),
    status: l?.status === 'matched' || l?.status === 'handled' ? l.status : 'open', note: str(l?.note), account: str(l?.account), statement: str(l?.statement),
    matches: arr(l?.matches).map((m) => ({ id: str(m?.id), amount: num(m?.amount), payment: m?.payment ? toPayCard(m.payment) : null,
      deposit: m?.deposit ? { id: str(m.deposit.id), number: num(m.deposit.number), date: str(m.deposit.date), cash: num(m.deposit.cash), cheques: num(m.deposit.cheques) } : null })),
  })),
  statements: arr(j?.statements).map((s) => ({ id: str(s?.id), account: str(s?.account), file: str(s?.file), total: num(s?.total), added: num(s?.added),
    from: s?.from ? str(s.from) : null, to: s?.to ? str(s.to) : null, at: str(s?.at) })),
});
export const toCandidates = (j: any): { payments: PayCard[]; deposits: DepositCard[] } => ({
  payments: arr(j?.payments).map(toPayCard), deposits: arr(j?.deposits).map(toDepositCard),
});

/** what a candidate is, in a line: "קבלה 400-12 · דנה · העברה", "הוצאה 7 · ספק ציוד · העברה", "הפקדה 3" */
export function payCardLabel(p: PayCard): string {
  const what = p.source === 'expense' ? `הוצאה${p.expenseNumber ? ` ${p.expenseNumber}` : ''}${p.supplier ? ` · ${p.supplier}` : ''}`
    : p.docType && p.docNumber ? `${DOC_LABEL[p.docType] ?? 'מסמך'} ${p.docNumber}${p.customer ? ` · ${p.customer}` : ''}`
    : p.source === 'refund' ? 'החזר בקופה' : p.note || 'תשלום';
  return `${what} · ${payLabel(p.method)}${p.cheque ? ` ${p.cheque}` : ''}`;
}
export const depositLabel = (d: Pick<DepositCard, 'number' | 'cash' | 'cheques'> & { count?: number }) =>
  `הפקדה ${d.number}${d.cash ? ` · מזומן ₪${d.cash.toLocaleString('he-IL')}` : ''}${d.cheques ? ` · ${d.count ? `${d.count} ` : ''}צ׳קים ₪${d.cheques.toLocaleString('he-IL')}` : ''}`;

const dayGap = (a: string, b: string) => Math.abs(Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 864e5));
/** a suggestion for an open line: one receipt, payment or deposit of the same amount (to the agora), a few days apart */
export interface Suggestion { lineId: string; kind: 'payment' | 'deposit'; id: string; days: number }
/**
 * The suggestions: every open line with a candidate of its sign and amount within `days` days — the closest pairs first, each line
 * and each candidate in one suggestion at most. Nothing is matched by this: the owner approves each one.
 */
export function suggest(lines: BankLine[], c: { payments: PayCard[]; deposits: DepositCard[] }, days = 7): Map<string, Suggestion> {
  const pairs: { lineId: string; lineDate: string; kind: 'payment' | 'deposit'; id: string; date: string; days: number }[] = [];
  for (const l of lines) {
    if (l.status !== 'open') continue;
    const a = Math.round(l.amount * 100);
    for (const p of c.payments) {
      if ((a > 0) !== (p.direction === 'in') || Math.round(p.amount * 100) !== Math.abs(a)) continue;
      const g = dayGap(l.date, p.paidOn);
      if (g <= days) pairs.push({ lineId: l.id, lineDate: l.date, kind: 'payment', id: p.id, date: p.paidOn, days: g });
    }
    if (a > 0) for (const d of c.deposits) {
      if (Math.round(d.total * 100) !== a) continue;
      const g = dayGap(l.date, d.date);
      if (g <= days) pairs.push({ lineId: l.id, lineDate: l.date, kind: 'deposit', id: d.id, date: d.date, days: g });
    }
  }
  pairs.sort((x, y) => x.days - y.days || x.lineDate.localeCompare(y.lineDate) || x.date.localeCompare(y.date) || x.lineId.localeCompare(y.lineId) || x.id.localeCompare(y.id));
  const out = new Map<string, Suggestion>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (out.has(p.lineId) || used.has(p.id)) continue;
    out.set(p.lineId, { lineId: p.lineId, kind: p.kind, id: p.id, days: p.days });
    used.add(p.id);
  }
  return out;
}

/** the sum of what the owner chose for a line, against the line — agorot-exact; null when it is right */
export function chosenGap(line: Pick<BankLine, 'amount'>, chosen: { amount: number }[]): number | null {
  const s = chosen.reduce((a, x) => a + Math.round(x.amount * 100), 0);
  const gap = Math.abs(Math.round(line.amount * 100)) - s;
  return gap === 0 ? null : gap / 100;
}
export const LINE_STATUS: Record<BankLine['status'], string> = { open: 'לטיפול', matched: 'הותאם', handled: 'טופל' };
