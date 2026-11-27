import { DOC_LABEL, docNumberLabel } from '@/features/documents/documents';
import { glKeyReserved } from '@/features/documents/customer-key';
import type { BooksState } from './books';
import { normalizeSupplier } from './expenses';
import type { ReportTable } from './statements';

/**
 * 2.123 — "הנהלת חשבונות" (stage 4ד; docs/ita-registration/STAGE4_PLAN_HE.md, answers 13–17 of 26–27.11.2026): the screens of the
 * double-entry books. Every number comes from the database (migration 20261129007200 — report_trial_balance / report_ledger /
 * report_journal / report_profit_loss / report_balance_sheet / gl_reconcile, security invoker: the RLS of the business and the
 * locations of the person; never a cashier). This module only reads the answers, places them (the trial balance's accounts under
 * the database's own groups) and lays them out as tables — one table for the screen, the CSV and the PDF (statements.ts). The
 * owner's writes (gl_manual_create / _reverse, gl_account_add / _update / _set_active, gl_opening_balances) are checked here first
 * by the database's own rules (each named below), in whole agorot — the database checks all of it again and has the last word.
 * Pure functions only (tests/books-screens.test.ts).
 */
const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));
const str = (v: unknown) => (v == null ? '' : String(v));
const strOrNull = (v: unknown) => (v == null || v === '' ? null : String(v));
const numOrNull = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
/** whole agorot (money.ts / vat.ts: never a float sum) */
export const ag = (n: number) => Math.round((Number(n) || 0) * 100);
const sh = (a: number) => a / 100;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// ---- who sees the area ---------------------------------------------------------------------------------------------------------
/**
 * The area "הנהלת חשבונות" in the menu (answer 13: every business keeps books; the screens hidden by default for a small business).
 * The rule (finance-agent, 27.11.2026 — to confirm with the owner): only once migration 7200 is in the database (`ready`), only for a
 * member with the whole of the money (access 'full' — never a cashier or a calendar member), and only once the books have an entry —
 * or for the owner (journal_writer), who enters the opening balances before the first entry. What each one reads is the RLS's.
 */
export function showBooksArea(o: { ready: boolean; state: BooksState | null; access: string | null | undefined }): boolean {
  return Boolean(o.ready && o.state && o.access === 'full' && (o.state.owner || o.state.transactions > 0));
}

export type BooksView = 'tb' | 'ledger' | 'journal' | 'pnl' | 'balance' | 'chart' | 'manual' | 'opening' | 'reconcile';
export const BOOKS_VIEWS: { id: BooksView; label: string; owner?: boolean }[] = [
  { id: 'tb', label: 'מאזן בוחן' }, { id: 'ledger', label: 'כרטסת' }, { id: 'journal', label: 'יומן' }, { id: 'pnl', label: 'רווח והפסד' },
  { id: 'balance', label: 'מאזן' }, { id: 'chart', label: 'לוח חשבונות' }, { id: 'manual', label: 'פקודה ידנית', owner: true },
  { id: 'opening', label: 'יתרות פתיחה', owner: true }, { id: 'reconcile', label: 'התאמה' },
];
export const isBooksView = (v: string | null | undefined): v is BooksView => BOOKS_VIEWS.some((x) => x.id === v);
/** the views a person gets: the owner's forms only for the owner; the opening balances only until they were entered */
export const booksViews = (s: Pick<BooksState, 'owner' | 'openingEntered'>) =>
  BOOKS_VIEWS.filter((v) => (!v.owner || s.owner) && (v.id !== 'opening' || !s.openingEntered));

// ---- the chart (gl_accounts) ---------------------------------------------------------------------------------------------------
export type AccountKind = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export const KINDS: AccountKind[] = ['asset', 'liability', 'equity', 'income', 'expense'];
export const KIND_LABEL: Record<AccountKind, string> = { asset: 'נכס', liability: 'התחייבות', equity: 'הון', income: 'הכנסה', expense: 'הוצאה' };
export interface ChartAccount { key: string; name: string; kind: AccountKind; tbCode: string; tbName: string; parentKey: string | null; role: string | null; active: boolean }
/** gl_accounts rows (key, name, kind, tb_code, tb_name, parent_key, role, active) → the chart, by key; a row that is not one is dropped */
export function toChart(rows: unknown): ChartAccount[] {
  return arr(rows).filter((r) => r && typeof r.key === 'string' && r.key && typeof r.name === 'string' && KINDS.includes(r.kind))
    .map((r) => ({ key: String(r.key), name: String(r.name), kind: r.kind as AccountKind, tbCode: str(r.tb_code), tbName: str(r.tb_name),
      parentKey: strOrNull(r.parent_key), role: strOrNull(r.role), active: r.active !== false }))
    .sort((a, b) => a.key.localeCompare(b.key, 'en'));
}
/** who the account is: the system's (a role), a customer's / a supplier's (role customer: / supplier:), or one the owner added */
export type AccountOrigin = 'system' | 'customer' | 'supplier' | 'owner';
export const originOf = (a: Pick<ChartAccount, 'role'>): AccountOrigin =>
  !a.role ? 'owner' : a.role.startsWith('customer:') ? 'customer' : a.role.startsWith('supplier:') ? 'supplier' : 'system';
/**
 * The keys of the system's own accounts — gl_key_system() of 7200: the keys of 7100's default chart (gl_chart_default), 2150
 * (cheques to pay, 7200 gl_system_account) and a location's cash / cheques (1100-n / 1150-n). tests/books-screens.test.ts reads the
 * default chart's keys out of the migration file and compares — change both together.
 */
export const SYSTEM_KEYS = ['1100', '1150', 'BANK', '1250', '1300', '1310', '1350', '1400', '2100', '2200', '2250', '2300', '3100', '3200', '4100', '4110',
  '4200', '6101', '6102', '6103', '6104', '6105', '6106', '6107', '6108', '6109', '6110', '6111', '6112', '6113', '6114', '6115', '6116', '6117', '6900', '9100'] as const;
export const isSystemKey = (k: string) => (SYSTEM_KEYS as readonly string[]).includes(k) || k === '2150' || /^(1100|1150)-[0-9]{1,2}$/.test(k);
/** the form of a key the owner gives (gl_account_add / _update: four digits, "-" and one or two digits allowed) */
export const OWNER_KEY = /^[0-9]{4}(-[0-9]{1,2})?$/;
export interface AccountDraft { key: string; name: string; kind: AccountKind | ''; tbCode: string; tbName: string; parentKey: string }
/** what is wrong with a new account, Hebrew — gl_account_add's checks in its order (the database checks all of it again) */
export function accountAddProblems(d: AccountDraft, chart: ChartAccount[]): string[] {
  const k = d.key.trim(), nm = d.name.trim(), tc = d.tbCode.trim(), tn = d.tbName.trim(), pk = d.parentKey.trim();
  const out: string[] = [];
  if (!OWNER_KEY.test(k)) out.push('מפתח חשבון — 4 ספרות (אפשר גם "-" ועוד ספרה או שתיים, למשל 6120-1).');
  else if (isSystemKey(k)) out.push(`המפתח ${k} שמור לחשבון של המערכת — בוחרים מפתח אחר.`);
  else if (chart.some((a) => a.key === k)) out.push(`כבר יש חשבון עם המפתח ${k}.`);
  if (nm.length < 1 || nm.length > 50) out.push('שם החשבון — עד 50 תווים (חובה).');
  if (!d.kind || !KINDS.includes(d.kind)) out.push('בוחרים סוג: נכס, התחייבות, הון, הכנסה או הוצאה.');
  if (tc.length > 15 || tn.length > 30) out.push('קוד מאזן בוחן — עד 15 תווים, ושמו — עד 30.');
  if (pk) {
    const p = chart.find((a) => a.key === pk);
    if (!p) out.push(`חשבון האב ${pk} לא נמצא.`);
    else if (pk === '1300' || pk === '2100' || (d.kind && p.kind !== d.kind)) out.push('חשבון אב — מאותו סוג, ולא לקוחות (1300) או ספקים (2100).');
  }
  return out;
}
/** what is wrong with an edit (gl_account_update): the name, the trial-balance code / name, a new key only of an account the owner
 *  added (no role) — its movements and its children are the database's to know */
export function accountUpdateProblems(a: ChartAccount, d: { name: string; tbCode: string; tbName: string; newKey: string }, chart: ChartAccount[]): string[] {
  const out: string[] = [];
  if (d.name.trim().length > 50) out.push('שם החשבון — עד 50 תווים.');
  if (d.tbCode.trim().length > 15 || d.tbName.trim().length > 30) out.push('קוד מאזן בוחן — עד 15 תווים, ושמו — עד 30.');
  const nk = d.newKey.trim();
  if (nk && nk !== a.key) {
    if (a.role) out.push('למפתח של חשבון של המערכת (או של לקוח / ספק) אין שינוי.');
    else if (!OWNER_KEY.test(nk)) out.push('מפתח חשבון — 4 ספרות (אפשר גם "-" ועוד ספרה או שתיים).');
    else if (isSystemKey(nk)) out.push(`המפתח ${nk} שמור לחשבון של המערכת.`);
    else if (chart.some((x) => x.key === nk)) out.push(`כבר יש חשבון עם המפתח ${nk}.`);
  }
  return out;
}
/** may it be deactivated (gl_account_set_active: never a system account — a customer's / a supplier's may; its balance — the database) */
export const canDeactivate = (a: ChartAccount) => a.active && originOf(a) !== 'system';
/** the chart as the screen lists it: the search (a key's start, a part of the name); customers' and suppliers' accounts only for a
 *  search (there are many) or when asked */
export function chartList(chart: ChartAccount[], q = '', o: { parties?: boolean } = {}): ChartAccount[] {
  const s = q.trim().toLowerCase();
  return chart.filter((a) => (s ? a.key.toLowerCase().startsWith(s) || a.name.toLowerCase().includes(s) : o.parties || (originOf(a) !== 'customer' && originOf(a) !== 'supplier')));
}
export const accountText = (a: { key: string; name: string }) => `${a.key} · ${a.name}`;

// ---- an amount typed in a form -------------------------------------------------------------------------------------------------
/** "1,234.5" → 123450 agorot; null when it is not an amount above 0 to the agora (a thousands comma only between groups of three) */
export function parseAgorot(s: string): number | null {
  const t = s.trim().replace(/\s/g, '');
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(t)) return null;
  const [i, f = ''] = t.replace(/,/g, '').split('.');
  const a = Number(i) * 100 + Number((f + '00').slice(0, 2));
  return Number.isSafeInteger(a) && a > 0 && a <= 99_999_999_999_900 ? a : null;
}

// ---- the manual double entry (gl_manual_create) -----------------------------------------------------------------------------------
export type Side = 'D' | 'C';
export interface EntryLine { account: string; side: Side; amount: string }
export interface ManualDraft { date: string; details: string; lines: EntryLine[] }
export const emptyLine = (side: Side = 'D'): EntryLine => ({ account: '', side, amount: '' });
export const emptyManual = (today: string): ManualDraft => ({ date: today, details: '', lines: [emptyLine('D'), emptyLine('C')] });
/** a line nobody touched (no account, no amount) is not a line — it is not sent */
const blank = (l: EntryLine) => !l.account.trim() && !l.amount.trim();
/** the live balance of the form, in agorot: Σ debit, Σ credit, debit − credit; balanced = equal and above 0 (lines with an amount
 *  that is not one count 0 here, and are refused by manualProblems) */
export function entryBalance(lines: EntryLine[]): { debit: number; credit: number; diff: number; balanced: boolean } {
  let debit = 0, credit = 0;
  for (const l of lines) { const a = parseAgorot(l.amount) ?? 0; if (l.side === 'D') debit += a; else credit += a; }
  return { debit, credit, diff: debit - credit, balanced: debit === credit && debit > 0 };
}
/** what is wrong with a manual entry, Hebrew — gl_manual_create's checks (the closed books too); [] = it may be sent */
export function manualProblems(d: ManualDraft, o: { today: string; start: string; lockedUntil: string | null; chart: ChartAccount[] }): string[] {
  const out: string[] = [];
  if (!DAY.test(d.date) || d.date > o.today) out.push('תאריך — היום או לפניו.');
  else if (d.date < o.start) out.push(`פקודה בספרים — מתאריך תחילת הספרים (${o.start.split('-').reverse().join('/')}).`);
  else if (o.lockedUntil && d.date <= o.lockedUntil) out.push(`הספרים סגורים עד ${o.lockedUntil.split('-').reverse().join('/')} — בוחרים תאריך אחריו.`);
  const det = d.details.trim();
  if (det.length < 2 || det.length > 50) out.push('פרטי הפקודה — 2 עד 50 תווים.');
  const lines = d.lines.filter((l) => !blank(l));
  if (lines.length < 2 || lines.length > 500) out.push('פקודה — 2 עד 500 שורות.');
  lines.forEach((l, i) => {
    const a = o.chart.find((x) => x.key === l.account.trim());
    if (!l.account.trim()) out.push(`שורה ${i + 1}: בוחרים חשבון.`);
    else if (!a || !a.active) out.push(`שורה ${i + 1}: החשבון ${l.account.trim()} לא נמצא בלוח החשבונות (או שאינו פעיל).`);
    if (parseAgorot(l.amount) == null) out.push(`שורה ${i + 1}: סכום מעל 0, עד אגורות.`);
  });
  const b = entryBalance(lines);
  if (lines.length >= 2 && !b.balanced) out.push('הפקודה לא מאוזנת — סך החובה צריך להיות שווה לסך הזכות.');
  return out;
}
/** gl_manual_create's arguments — the id is the form's (a second tap is the same entry); amounts as numbers of agorot / 100 */
export function manualArgs(id: string, d: ManualDraft, location: string | null) {
  return { p_id: id, p_date: d.date, p_details: d.details.trim(), p_location: location,
    p_lines: d.lines.filter((l) => !blank(l)).map((l) => ({ account: l.account.trim(), side: l.side, amount: sh(parseAgorot(l.amount) ?? 0) })) };
}
/** what is wrong with a reversal (gl_manual_reverse): from the entry's date to today, not in closed books, details 2–50 or none */
export function reverseProblems(o: { date: string; entryDate: string; today: string; lockedUntil: string | null; details: string }): string[] {
  const out: string[] = [];
  if (!DAY.test(o.date) || o.date > o.today || o.date < o.entryDate) out.push('ביטול — מתאריך הפקודה ועד היום.');
  else if (o.lockedUntil && o.date <= o.lockedUntil) out.push(`הספרים סגורים עד ${o.lockedUntil.split('-').reverse().join('/')}.`);
  const det = o.details.trim();
  if (det && (det.length < 2 || det.length > 50)) out.push('פרטי הפקודה — 2 עד 50 תווים (או ריק).');
  return out;
}

// ---- the opening balances (gl_opening_balances, once) ---------------------------------------------------------------------------
/** a line: an account of the chart, a new customer (account = its key — glCustomerKey of the CRM card — and its name), or (2.123,
 *  migration 7300 — when the database says it takes them) a supplier by its dealer number and name: the database opens its account
 *  as an expense of that supplier would (gl_supplier_account), so the opening balance and its later invoices meet in one account */
export interface OpeningSupplier { dealer: string; name: string }
export interface OpeningLine { account: string; name: string; side: Side; amount: string; customer: boolean; supplier?: OpeningSupplier | null }
export const emptyOpening = (side: Side = 'D'): OpeningLine => ({ account: '', name: '', side, amount: '', customer: false, supplier: null });
const blankOpening = (l: OpeningLine) => !l.account.trim() && !l.supplier && !l.amount.trim();
/**
 * Migration 7300 (20261130007300, gl_opening_balances — same signature) takes the supplier's line; nothing in the database says
 * whether it is there, so the picker is shown with the books' screens (after 7200), and an older database's refusal of a supplier's
 * line (it reads no "account": opening_account / opening_line) is said as "not possible yet" (openingSupplierRefused).
 */
export const OPENING_SUPPLIER_NOT_YET = 'יתרת פתיחה לספק חדש עוד לא אפשרית — צריך עדכון של המסד. ספק שכבר יש לו חשבון בלוח (מפתח שמתחיל ב-S-) — בוחרים אותו כ"חשבון".';
export const openingSupplierRefused = (raw: string, lines: OpeningLine[]) =>
  lines.some((l) => l.supplier) && /\bopening_(account|line)\b/.test(raw) && !/opening_supplier/.test(raw);
/** the suppliers of the business's expenses (supplier_name, supplier_dealer) — once each, as the books know a supplier (party_key:
 *  the dealer number, else the normalized name — expense_norm_supplier / normalizeSupplier); a name that normalizes to nothing
 *  without a dealer number is left out (the database would key it by the name itself) */
export function supplierChoices(rows: unknown, q = '', limit = 8): OpeningSupplier[] {
  const seen = new Map<string, OpeningSupplier>();
  for (const r of arr(rows)) {
    const dealer = /^\d{9}$/.test(str(r?.supplier_dealer).trim()) ? str(r.supplier_dealer).trim() : '';
    const name = str(r?.supplier_name).trim().slice(0, 120);
    const k = dealer ? `d:${dealer}` : normalizeSupplier(name) ? `n:${normalizeSupplier(name)}` : '';
    if (k && !seen.has(k)) seen.set(k, { dealer, name });
  }
  const s = q.trim().toLowerCase();
  return [...seen.values()].filter((x) => !s || x.name.toLowerCase().includes(s) || x.dealer.startsWith(s.replace(/\D/g, '') || '§'))
    .sort((a, b) => a.name.localeCompare(b.name, 'he')).slice(0, limit);
}
/** Σ debit, Σ credit, and what the database puts on 3100 (יתרות פתיחה) to balance it: credit (debit − credit) — in agorot */
export function openingBalance(lines: OpeningLine[]) {
  const b = entryBalance(lines.filter((l) => !blankOpening(l)).map((l) => ({ account: l.account, side: l.side, amount: l.amount })));
  return { debit: b.debit, credit: b.credit, toOpening: b.debit - b.credit };
}
/** what is wrong, Hebrew — gl_opening_balances' checks: 1–2000 lines; an account of the chart, or a new customer with a name and a key
 *  that is not the system's (gl_key_reserved — "S-" too); never 3100 itself; amounts above 0 to the agora */
export function openingProblems(lines: OpeningLine[], chart: ChartAccount[]): string[] {
  const out: string[] = [];
  const ls = lines.filter((l) => !blankOpening(l));
  if (!ls.length || ls.length > 2000) out.push('רשימת יתרות — 1 עד 2000 שורות.');
  ls.forEach((l, i) => {
    if (l.supplier) {
      const d = l.supplier.dealer.trim(), n = l.supplier.name.trim();
      // 7300 (gl_opening_balances): a name (required, up to 120) and a dealer number of 9 digits or none
      if (d && !/^\d{9}$/.test(d)) out.push(`שורה ${i + 1}: מספר עוסק של ספק — 9 ספרות (או בלי).`);
      if (!n || n.length > 120) out.push(`שורה ${i + 1}: ספק — שם (חובה, עד 120 תווים).`);
      if (parseAgorot(l.amount) == null) out.push(`שורה ${i + 1}: סכום מעל 0, עד אגורות.`);
      return;
    }
    const k = l.account.trim();
    const a = chart.find((x) => x.key === k);
    if (!k) out.push(`שורה ${i + 1}: בוחרים חשבון או לקוח.`);
    else if (k === '3100') out.push(`שורה ${i + 1}: חשבון יתרות הפתיחה (3100) מתאזן לבד.`);
    else if (!a && (!l.customer || !l.name.trim() || k.length > 15 || glKeyReserved(k))) out.push(`שורה ${i + 1}: החשבון ${k} לא נמצא בלוח החשבונות.`);
    if (parseAgorot(l.amount) == null) out.push(`שורה ${i + 1}: סכום מעל 0, עד אגורות.`);
  });
  return out;
}
export function openingArgs(lines: OpeningLine[], chart: ChartAccount[]) {
  return lines.filter((l) => !blankOpening(l)).map((l) => {
    if (l.supplier) return { supplier: { dealer: l.supplier.dealer.trim(), name: l.supplier.name.trim().slice(0, 120) }, side: l.side, amount: sh(parseAgorot(l.amount) ?? 0) };
    const k = l.account.trim();
    const known = chart.some((a) => a.key === k);
    return { account: k, side: l.side, amount: sh(parseAgorot(l.amount) ?? 0), ...(!known && l.name.trim() ? { name: l.name.trim().slice(0, 50) } : {}) };
  });
}

// ---- what the reports answer ---------------------------------------------------------------------------------------------------
export interface TbAccount { key: string; name: string; kind: string; tbCode: string; tbName: string; parentKey: string | null; opening: number; debit: number; credit: number; closing: number }
export interface TbGroup { tbCode: string; tbName: string; accounts: number; opening: number; debit: number; credit: number; closing: number }
export interface TrialBalance { from: string; to: string; accounts: TbAccount[]; groups: TbGroup[]; total: { opening: number; debit: number; credit: number; closing: number } }
const sums = (j: any) => ({ opening: num(j?.opening), debit: num(j?.debit), credit: num(j?.credit), closing: num(j?.closing) });
export const toTrialBalance = (j: any): TrialBalance => ({
  from: str(j?.from), to: str(j?.to),
  accounts: arr(j?.accounts).map((a) => ({ key: str(a.key), name: str(a.name), kind: str(a.kind), tbCode: str(a.tbCode), tbName: str(a.tbName), parentKey: strOrNull(a.parentKey), ...sums(a) })),
  groups: arr(j?.groups).map((g) => ({ tbCode: str(g.tbCode), tbName: str(g.tbName), accounts: num(g.accounts), ...sums(g) })),
  total: sums(j?.total),
});
/**
 * The trial balance by its code (B110 1405 / 1406): each of the database's groups (its totals — never summed here) with its accounts
 * under it, in the database's order. An account whose code has no group (never expected) gets a group of its own at the end, its
 * totals its own — so nothing ever disappears from the screen.
 */
export function groupTrialBalance(tb: TrialBalance): { group: TbGroup; accounts: TbAccount[] }[] {
  const by = new Map<string, TbAccount[]>();
  for (const a of tb.accounts) { const l = by.get(a.tbCode) ?? []; l.push(a); by.set(a.tbCode, l); }
  const out = tb.groups.map((g) => ({ group: g, accounts: by.get(g.tbCode) ?? [] }));
  for (const [code, list] of by) {
    if (tb.groups.some((g) => g.tbCode === code)) continue;
    const t = (k: 'opening' | 'debit' | 'credit' | 'closing') => sh(list.reduce((s, a) => s + ag(a[k]), 0));
    out.push({ group: { tbCode: code, tbName: list[0].tbName, accounts: list.length, opening: t('opening'), debit: t('debit'), credit: t('credit'), closing: t('closing') }, accounts: list });
  }
  return out;
}
/** the trial balance is balanced: Σ debit = Σ credit and the balances add up to 0 (to the agora) */
export const tbBalanced = (tb: TrialBalance) => ag(tb.total.debit) === ag(tb.total.credit) && ag(tb.total.opening) === 0 && ag(tb.total.closing) === 0;

export interface LedgerLine {
  date: string; valueDate: string; number: number; transactionId: string; lineNo: number; account: string; accountName: string; details: string; sourceKind: string;
  reverses: string | null; ref1Type: number | null; ref1Number: string | null; ref2Type: number | null; ref2Number: string | null; side: Side; debit: number; credit: number;
  balance: number; match1: string | null; match2: string | null;
}
export interface Ledger {
  account: { key: string; name: string; kind: string; tbCode: string; tbName: string; parentKey: string | null; active: boolean };
  from: string; to: string; opening: number; debit: number; credit: number; closing: number; lines: LedgerLine[];
}
export const toLedger = (j: any): Ledger => ({
  account: { key: str(j?.account?.key), name: str(j?.account?.name), kind: str(j?.account?.kind), tbCode: str(j?.account?.tbCode), tbName: str(j?.account?.tbName),
    parentKey: strOrNull(j?.account?.parentKey), active: j?.account?.active !== false },
  from: str(j?.from), to: str(j?.to), opening: num(j?.opening), debit: num(j?.debit), credit: num(j?.credit), closing: num(j?.closing),
  lines: arr(j?.lines).map((l) => ({ date: str(l.date), valueDate: str(l.valueDate), number: num(l.number), transactionId: str(l.transactionId), lineNo: num(l.lineNo),
    account: str(l.account), accountName: str(l.accountName), details: str(l.details), sourceKind: str(l.sourceKind), reverses: strOrNull(l.reverses),
    ref1Type: numOrNull(l.ref1Type), ref1Number: strOrNull(l.ref1Number), ref2Type: numOrNull(l.ref2Type), ref2Number: strOrNull(l.ref2Number),
    side: l.side === 'C' ? 'C' : 'D', debit: num(l.debit), credit: num(l.credit), balance: num(l.balance), match1: strOrNull(l.match1), match2: strOrNull(l.match2) })),
});

export interface JournalLine { lineNo: number; account: string; accountName: string; side: Side; amount: number; valueDate: string }
export interface BookEntry {
  id: string; number: number; date: string; valueDate: string; enteredOn: string; sourceKind: string; sourceId: string | null; details: string; reverses: string | null;
  reversedBy: string | null; ref1Type: number | null; ref1Number: string | null; ref2Type: number | null; ref2Number: string | null; locationId: string | null;
  debit: number; credit: number; lines: JournalLine[];
}
export interface BookJournal { from: string; to: string; count: number; debit: number; credit: number; entries: BookEntry[] }
export const toBookJournal = (j: any): BookJournal => ({
  from: str(j?.from), to: str(j?.to), count: num(j?.count), debit: num(j?.debit), credit: num(j?.credit),
  entries: arr(j?.entries).map((e) => ({ id: str(e.id), number: num(e.number), date: str(e.date), valueDate: str(e.valueDate), enteredOn: str(e.enteredOn),
    sourceKind: str(e.sourceKind), sourceId: strOrNull(e.sourceId), details: str(e.details), reverses: strOrNull(e.reverses), reversedBy: strOrNull(e.reversedBy),
    ref1Type: numOrNull(e.ref1Type), ref1Number: strOrNull(e.ref1Number), ref2Type: numOrNull(e.ref2Type), ref2Number: strOrNull(e.ref2Number),
    locationId: strOrNull(e.locationId), debit: num(e.debit), credit: num(e.credit),
    lines: arr(e.lines).map((l) => ({ lineNo: num(l.lineNo), account: str(l.account), accountName: str(l.accountName), side: l.side === 'C' ? 'C' as const : 'D' as const,
      amount: num(l.amount), valueDate: str(l.valueDate) })) })),
});
/** a manual entry that may be reversed now (gl_manual_reverse: a manual one, not a reversal, not reversed yet) */
export const canReverseEntry = (e: Pick<BookEntry, 'sourceKind' | 'reverses' | 'reversedBy'>) => e.sourceKind === 'manual' && !e.reverses && !e.reversedBy;
export const SOURCE_LABEL: Record<string, string> = {
  document: 'מסמך', cancellation: 'ביטול מסמך', payment: 'החזר כספי', deposit: 'הפקדה', deposit_cancel: 'ביטול הפקדה', opening: 'יתרות פתיחה', expense: 'הוצאה',
  expense_payment: 'תשלום הוצאה', shift: 'הפרש קופה', bank_match: 'התאמת בנק', bank_unmatch: 'ביטול התאמת בנק', bank_class: 'שורת בנק לחשבון',
  bank_unclass: 'ביטול רישום שורת בנק', manual: 'פקודה ידנית',
};
export const sourceLabel = (k: string) => SOURCE_LABEL[k] ?? k;

export interface Part { total: number; accounts: { key: string; name: string; tbCode: string; tbName: string; amount: number }[]; groups: { tbCode: string; tbName: string; amount: number }[] }
const toPart = (j: any): Part => ({
  total: num(j?.total),
  accounts: arr(j?.accounts).map((a) => ({ key: str(a.key), name: str(a.name), tbCode: str(a.tbCode), tbName: str(a.tbName), amount: num(a.amount) })),
  groups: arr(j?.groups).map((g) => ({ tbCode: str(g.tbCode), tbName: str(g.tbName), amount: num(g.amount) })),
});
export interface ProfitLoss { from: string; to: string; income: Part; expenses: Part; profit: number }
export const toProfitLoss = (j: any): ProfitLoss => ({ from: str(j?.from), to: str(j?.to), income: toPart(j?.income), expenses: toPart(j?.expenses), profit: num(j?.profit) });
export interface BalanceSheet { asOf: string; assets: Part; liabilities: Part; equity: Part; earnings: number; liabilitiesAndEquity: number; balanced: boolean }
export const toBalanceSheet = (j: any): BalanceSheet => ({
  asOf: str(j?.asOf), assets: toPart(j?.assets), liabilities: toPart(j?.liabilities), equity: toPart(j?.equity), earnings: num(j?.earnings),
  liabilitiesAndEquity: num(j?.liabilitiesAndEquity), balanced: j?.balanced === true,
});
export interface ReconRow { area: string; books: number; explained: number; source: number; difference: number }
export interface Reconcile { from: string; to: string; start: string; rows: ReconRow[]; same: boolean }
export const toReconcile = (j: any): Reconcile => ({
  from: str(j?.from), to: str(j?.to), start: str(j?.start), same: j?.same === true,
  rows: arr(j?.rows).map((r) => ({ area: str(r.area), books: num(r.books), explained: num(r.explained), source: num(r.source), difference: num(r.difference) })),
});
export const RECON_AREA: Record<string, string> = {
  income: 'הכנסות', expenses: 'הוצאות', profit: 'רווח', vat_output: 'מע״מ עסקאות', vat_input: 'מע״מ תשומות', vat_payable: 'מע״מ לתשלום',
  cash_differences: 'הפרשי קופה', receivables: 'לקוחות (חייבים)', cash: 'מזומן בקופות', cheques: 'צ׳קים בקופה',
};
/** the rows of balances — compared with today's sources (gl_reconcile: meaningful with the period ending today) */
export const RECON_BALANCES = ['receivables', 'cash', 'cheques'];
export const reconDiffers = (r: ReconRow) => ag(r.difference) !== 0;

// ---- the references: a document of the business --------------------------------------------------------------------------------
/** a reference of an entry that is a document of the business (a type of DOC_LABEL and its number) → "doc:<type>:<number>" */
export function docRefKey(type: number | null, n: string | null): string | null {
  if (type == null || !DOC_LABEL[type] || !n || !/^\d{1,12}$/.test(n)) return null;
  return `doc:${type}:${Number(n)}`;
}
/** every document reference of the lines (ref1 and ref2), once: type and number */
export function docRefs(rows: { ref1Type: number | null; ref1Number: string | null; ref2Type: number | null; ref2Number: string | null }[]): { type: number; number: number }[] {
  const seen = new Map<string, { type: number; number: number }>();
  for (const r of rows) for (const [t, n] of [[r.ref1Type, r.ref1Number], [r.ref2Type, r.ref2Number]] as const) {
    const k = docRefKey(t, n); if (k && !seen.has(k)) seen.set(k, { type: t!, number: Number(n) });
  }
  return [...seen.values()];
}
/** "חשבונית מס 01000001" — the number as every screen shows it (docNumberLabel); a reference that is not a document — as it is */
export const refText = (type: number | null, n: string | null): string =>
  !n ? '' : type != null && DOC_LABEL[type] && /^\d+$/.test(n) ? `${DOC_LABEL[type]} ${docNumberLabel(Number(n))}` : n;

// ---- the tables (screen, CSV, PDF) ---------------------------------------------------------------------------------------------
export function trialBalanceTable(tb: TrialBalance): ReportTable {
  const rows: (string | number | null)[][] = [];
  for (const { group, accounts } of groupTrialBalance(tb)) {
    for (const a of accounts) rows.push([a.tbCode, accountText(a), a.opening, a.debit, a.credit, a.closing]);
    rows.push([group.tbCode, `סה״כ ${group.tbName}`, group.opening, group.debit, group.credit, group.closing]);
  }
  return {
    title: 'מאזן בוחן',
    columns: [{ label: 'קוד מאזן', type: 'text' }, { label: 'חשבון', type: 'text' }, { label: 'יתרת פתיחה', type: 'money' }, { label: 'חובה', type: 'money' },
      { label: 'זכות', type: 'money' }, { label: 'יתרת סגירה', type: 'money' }],
    rows, total: ['', 'סה״כ', tb.total.opening, tb.total.debit, tb.total.credit, tb.total.closing],
    note: `יתרה חיובית = חובה, שלילית = זכות. ${tbBalanced(tb) ? 'המאזן מאוזן: סך החובה שווה לסך הזכות.' : 'שימו לב: המאזן לא מאוזן — לבירור עם רואה החשבון.'}`,
  };
}
export function ledgerTable(l: Ledger): ReportTable {
  const many = l.lines.some((x) => x.account !== l.account.key);
  return {
    title: `כרטסת ${l.account.key} · ${l.account.name}`,
    columns: [{ label: 'תאריך', type: 'date' }, { label: 'פקודה', type: 'count' }, { label: 'פרטים', type: 'text' }, { label: 'אסמכתא', type: 'text' },
      ...(many ? [{ label: 'חשבון', type: 'text' as const }] : []), { label: 'חובה', type: 'money' }, { label: 'זכות', type: 'money' }, { label: 'יתרה', type: 'money' }],
    rows: [[l.from, null, 'יתרת פתיחה', '', ...(many ? [''] : []), null, null, l.opening],
      ...l.lines.map((x) => [x.date, x.number, x.details, refText(x.ref1Type, x.ref1Number), ...(many ? [accountText({ key: x.account, name: x.accountName })] : []),
        x.debit || null, x.credit || null, x.balance])],
    total: ['', null, 'סה״כ', '', ...(many ? [''] : []), l.debit, l.credit, l.closing],
    note: 'יתרה חיובית = חובה, שלילית = זכות.',
  };
}
export function bookJournalTable(j: BookJournal): ReportTable {
  const rows: (string | number | null)[][] = [];
  for (const e of j.entries) e.lines.forEach((x, i) => rows.push([i ? null : e.number, i ? '' : e.date, i ? '' : e.details, accountText({ key: x.account, name: x.accountName }),
    x.side === 'D' ? x.amount : null, x.side === 'C' ? x.amount : null]));
  return {
    title: 'יומן',
    columns: [{ label: 'פקודה', type: 'count' }, { label: 'תאריך', type: 'date' }, { label: 'פרטים', type: 'text' }, { label: 'חשבון', type: 'text' },
      { label: 'חובה', type: 'money' }, { label: 'זכות', type: 'money' }],
    rows, total: [null, '', `${j.count} פקודות`, '', j.debit, j.credit],
  };
}
const partRows = (title: string, p: Part, totalLabel: string): (string | number | null)[][] =>
  [[`${title}`, '', null], ...p.accounts.map((a) => [a.tbCode, accountText(a), a.amount]), ['', totalLabel, p.total]];
export function profitLossTable(p: ProfitLoss): ReportTable {
  return {
    title: 'רווח והפסד',
    columns: [{ label: 'קוד מאזן', type: 'text' }, { label: 'חשבון', type: 'text' }, { label: 'סכום', type: 'money' }],
    rows: [...partRows('הכנסות', p.income, 'סה״כ הכנסות'), ...partRows('הוצאות', p.expenses, 'סה״כ הוצאות')],
    total: ['', ag(p.profit) < 0 ? 'הפסד' : 'רווח', p.profit],
    note: 'מתוך הספרים (הנהלת חשבונות כפולה), לפי תאריך הפקודה. לא דוח שהוגש — לבדיקת רואה החשבון.',
  };
}
export function balanceSheetTable(b: BalanceSheet): ReportTable {
  return {
    title: 'מאזן',
    columns: [{ label: 'קוד מאזן', type: 'text' }, { label: 'חשבון', type: 'text' }, { label: 'סכום', type: 'money' }],
    rows: [...partRows('נכסים', b.assets, 'סה״כ נכסים'), ...partRows('התחייבויות', b.liabilities, 'סה״כ התחייבויות'), ...partRows('הון', b.equity, 'סה״כ הון'),
      ['', 'רווח (הפסד) שטרם נסגר', b.earnings]],
    total: ['', 'סה״כ התחייבויות והון', b.liabilitiesAndEquity],
    note: b.balanced ? 'המאזן מאוזן: סך הנכסים שווה לסך ההתחייבויות וההון.' : 'שימו לב: המאזן לא מאוזן — לבירור עם רואה החשבון.',
  };
}
export function reconcileTable(r: Reconcile): ReportTable {
  return {
    title: 'התאמת הספרים לדוחות',
    columns: [{ label: 'נושא', type: 'text' }, { label: 'בספרים', type: 'money' }, { label: 'מוסבר', type: 'money' }, { label: 'בדוחות', type: 'money' },
      { label: 'הפרש', type: 'money' }],
    rows: r.rows.map((x) => [RECON_AREA[x.area] ?? x.area, x.books, x.explained, x.source, x.difference]),
    total: null,
    note: 'הפרש = בספרים − מוסבר − בדוחות. "מוסבר" — מה שרק הספרים יודעים: פקודות ידניות, הפרשי קופה, שורות בנק שנרשמו לחשבון ויתרות הפתיחה. '
      + 'השוואת היתרות (לקוחות, מזומן, צ׳קים) — מול המצב של היום.',
  };
}

// ---- the database's refusals of the books' screens, in Hebrew (financeError reads this first) -----------------------------------
const BOOKS_HE: [RegExp, string][] = [
  [/\baccount_key_fixed\b/, 'למפתח של החשבון הזה אין שינוי — יש בו תנועות, חשבונות תחתיו, או שהוא של המערכת / של לקוח / של ספק.'],
  [/\baccount_key\b/, 'מפתח חשבון — 4 ספרות (אפשר גם "-" ועוד ספרה או שתיים).'],
  [/\baccount_exists\b/, 'כבר יש חשבון עם המפתח הזה.'],
  [/\baccount_reserved\b/, 'המפתח הזה שמור לחשבון של המערכת — בוחרים מפתח אחר.'],
  [/\baccount_parent\b/, 'חשבון האב לא מתאים: צריך חשבון קיים מאותו סוג, ולא לקוחות (1300) או ספקים (2100).'],
  [/\baccount_kind\b/, 'סוג החשבון — נכס, התחייבות, הון, הכנסה או הוצאה.'],
  [/\baccount_system\b/, 'חשבון של המערכת לא מסירים.'],
  [/\baccount_balance\b/, 'בחשבון יש יתרה — מאפסים אותה בפקודה לפני שמסירים אותו.'],
  [/\baccount_name\b/, 'שם החשבון — עד 50 תווים.'],
  [/\baccount_tb\b/, 'קוד מאזן בוחן — עד 15 תווים, ושמו — עד 30.'],
  [/\baccount_missing\b/, 'החשבון לא נמצא — רעננו את הדף.'],
  [/\bmanual_unbalanced\b/, 'הפקודה לא מאוזנת — סך החובה צריך להיות שווה לסך הזכות.'],
  [/\bmanual_before_start\b/, 'פקודה בספרים — מתאריך תחילת הספרים.'],
  [/\bmanual_date\b/, 'התאריך לא מתאים: פקודה — היום או לפניו; ביטול — מתאריך הפקודה ועד היום.'],
  [/\bmanual_details\b/, 'פרטי הפקודה — 2 עד 50 תווים.'],
  [/\bmanual_lines\b/, 'פקודה — 2 עד 500 שורות.'],
  [/\bmanual_account\b/, 'אחד החשבונות לא נמצא בלוח החשבונות, או שהוא לא פעיל. רעננו ובחרו מהרשימה.'],
  [/\bmanual_amount\b|\bmanual_line\b/, 'כל שורה — חשבון, חובה או זכות, וסכום מעל 0 עד אגורות.'],
  [/\bmanual_match\b/, 'אסמכתת התאמה — עד 10 תווים.'],
  [/\bmanual_reversed\b/, 'הפקודה כבר בוטלה.'],
  [/\bmanual_reverse\b/, 'פקודה הפוכה לא מבטלים — רושמים פקודה חדשה.'],
  [/\bmanual_entry\b/, 'רק פקודה ידנית מבטלים כאן. רישום אוטומטי מתוקן במקור שלו (המסמך, ההוצאה, הבנק).'],
  [/\bmanual_location\b/, 'הסניף לא פעיל — בוחרים סניף אחר.'],
  [/\bopening_supplier\b/, 'ספק — שם (חובה, עד 120 תווים), ומספר עוסק של 9 ספרות או בלי.'],
  [/\bopening_account\b/, 'אחד החשבונות לא נמצא בלוח החשבונות (לקוח חדש — עם שם, ומפתח שאינו של המערכת; יתרות פתיחה — לא לחשבון 3100).'],
  [/\bopening_amount\b|\bopening_line\b/, 'כל שורה — חשבון, חובה או זכות, וסכום מעל 0 עד אגורות.'],
  [/\bopening_lines\b/, 'רשימת יתרות — 1 עד 2000 שורות.'],
  [/\bledger_account\b/, 'החשבון לא נמצא בלוח החשבונות.'],
];
/** a refusal of the books' functions → Hebrew; null when it is not one of them (never an amount or a key of the message) */
export function booksError(m: string): string | null {
  for (const [re, he] of BOOKS_HE) if (re.test(m)) return he;
  return null;
}
