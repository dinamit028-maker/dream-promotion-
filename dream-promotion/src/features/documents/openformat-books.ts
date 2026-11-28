/**
 * 2.124 (stage 4ה) — the double-entry books as the unified file needs them (openformat.ts BooksFile), from the database's own
 * answers — nothing is summed here that the database did not sum:
 *   journal       report_journal(from, to)        (migration 7200 — the entries of the period by their date, 1362, with their lines);
 *   trialBalance  report_trial_balance(from, to)  (7200 — per account: the balance before the period, the debits and credits of the
 *                                                  period: 1414 / 1415 / 1416);
 *   accounts      gl_accounts rows                (the details of B110: name, trial-balance code, parent, dealer number, address,
 *                                                  location — read in pages, pageAll);
 *   users         gl_transactions (id, user_id)   (1376 — the person's code, as 1233; report_journal does not return it).
 * Pure (no database, no browser): the screens (openformat-books-data.ts) and scripts/ita-sample.mjs both call it.
 * The result is checked again by booksFileProblems (balance per entry, every line's account in B110, the sums equal the lines,
 * 1414 + 1415 − 1416 = the closing balance).
 * The accountant's answer 22 (STAGE4_PLAN_HE.md, 28.11.2026): the opening balances' entry (source_kind 'opening' — the one
 * gl_opening_balances writes, dated the books' start) is not a movement of the file: it is taken out of the entries (no B100) and
 * out of the period's debits / credits, and added to the balance at the start (1414). A later period already has it in the trial
 * balance's "opening" (before its from) — nothing to move.
 */
import { BOOKS_DOCS_CHANGED, BOOKS_FILE_BROKEN, BOOKS_PERIOD_SPLIT, booksDocsMissing, booksFileProblems, booksPeriod, type BookAccount, type BookTx, type BooksFile, type Doc } from './openformat';

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const strOrNull = (v: unknown) => (v == null || v === '' ? null : String(v));
/** an amount of the database (numeric(14,2) as JSON) → agorot; NaN when it is not a number (booksFileProblems then refuses) */
const agorot = (v: unknown) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const intOrNull = (v: unknown) => (v == null || v === '' || !Number.isSafeInteger(Number(v)) ? null : Number(v));
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

export type BooksFileResult = { ok: true; books: BooksFile } | { ok: false; problem: 'account_missing' | 'hidden_account' | 'bad_answer' };

export function booksFileOf(i: { start: string; journal: unknown; trialBalance: unknown; accounts: unknown; users?: unknown }): BooksFileResult {
  const j = i.journal as any, tb = i.trialBalance as any;
  if (!j || !Array.isArray(j.entries) || !tb || !Array.isArray(tb.accounts)) return { ok: false, problem: 'bad_answer' };
  const users = new Map<string, string>();
  for (const u of arr(i.users)) if (typeof u?.id === 'string' && typeof u?.user_id === 'string') users.set(u.id, u.user_id);
  const all: BookTx[] = j.entries.map((e: any) => ({
    number: Number(e.number), date: str(e.date), enteredOn: str(e.enteredOn), sourceKind: str(e.sourceKind), details: str(e.details),
    ref1Type: intOrNull(e.ref1Type), ref1Number: strOrNull(e.ref1Number), ref2Type: intOrNull(e.ref2Type), ref2Number: strOrNull(e.ref2Number),
    locationId: strOrNull(e.locationId), userId: users.get(str(e.id)) ?? null,
    lines: arr(e.lines).map((l: any) => ({ lineNo: Number(l.lineNo), account: str(l.account), side: l.side === 'C' ? 'C' as const : 'D' as const,
      amountA: agorot(l.amount), valueDate: str(l.valueDate), match1: strOrNull(l.match1), match2: strOrNull(l.match2) })),
  }));
  // an account the person may not see (report_*: "?" — another location's): the file is the whole business's only
  if (tb.accounts.some((a: any) => str(a.key) === '?') || all.some((t) => t.lines.some((l) => l.account === '?'))) return { ok: false, problem: 'hidden_account' };
  const transactions = all.filter((t) => t.sourceKind !== 'opening');
  const opening = all.filter((t) => t.sourceKind === 'opening');
  const rows = new Map<string, any>();
  for (const r of arr(i.accounts)) if (typeof r?.key === 'string') rows.set(r.key, r);
  const nums = new Map<string, { openingA: number; debitA: number; creditA: number }>();
  // the closing balance is the database's own (report_trial_balance "closing") — never recomputed here, so booksFileProblems'
  // 1414 + 1415 − 1416 = closing really checks the numbers (a missing one is NaN: refused)
  const closing = new Map<string, number>();
  for (const a of tb.accounts) {
    nums.set(str(a.key), { openingA: agorot(a.opening), debitA: agorot(a.debit), creditA: agorot(a.credit) });
    closing.set(str(a.key), agorot(a.closing));
  }
  // answer 22: the opening entry of the period → the balance at its start (debit +, credit −), out of its debits / credits
  for (const t of opening) for (const l of t.lines) {
    const v = nums.get(l.account);
    if (!v) return { ok: false, problem: 'bad_answer' };   // a line the trial balance does not have — never expected
    if (l.side === 'D') { v.openingA += l.amountA; v.debitA -= l.amountA; } else { v.openingA -= l.amountA; v.creditA -= l.amountA; }
  }
  // the accounts of the file: the trial balance's (every account with a movement up to the period's end), every line's, and their
  // parents (1413 names an account of the file)
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (k: string) => { if (k && !seen.has(k)) { seen.add(k); keys.push(k); } };
  for (const k of nums.keys()) add(k);
  for (const t of all) for (const l of t.lines) add(l.account);
  for (let n = 0; n < keys.length; n++) { const p = strOrNull(rows.get(keys[n])?.parent_key); if (p) add(p); }
  const accounts: BookAccount[] = [];
  for (const k of keys) {
    const r = rows.get(k);
    if (!r) return { ok: false, problem: 'account_missing' };
    const role = str(r.role);
    const v = nums.get(k) ?? { openingA: 0, debitA: 0, creditA: 0 };
    accounts.push({ key: k, name: str(r.name), tbCode: str(r.tb_code), tbName: str(r.tb_name), parentKey: strOrNull(r.parent_key),
      dealer: strOrNull(r.dealer_number), street: str(r.street), city: str(r.city), locationId: strOrNull(r.location_id),
      party: role.startsWith('customer:') || role.startsWith('supplier:'), ...v, closingA: closing.has(k) ? closing.get(k)! : 0 });   // an account not in the trial balance (a parent): no movement at all — 0
  }
  accounts.sort((a, z) => (a.key < z.key ? -1 : a.key > z.key ? 1 : 0));
  return { ok: true, books: { start: i.start, transactions, accounts } };
}

export { BOOKS_DOCS_CHANGED, booksDocsMissing };
// ---------- reading the books for a file — one place for the screens (openformat-books-data.ts) and scripts/ita-sample.mjs ----------
export const BOOKS_READ_FAILED = 'לא הצלחנו לקרוא את הנהלת החשבונות של התקופה — הקובץ לרשות המסים לא הופק. רעננו את הדף ונסו שוב.';
export const BOOKS_DB_OLD = 'כדי להפיק קובץ מהנהלת החשבונות צריך עדכון של המסד (דוחות הספרים) — הקובץ לא הופק. פנו לתמיכה.';
export const BOOKS_TOO_MANY = 'בתקופה יש יותר שורות בספרים ממה שאפשר להפיק בקובץ אחד — מפיקים לתקופות קצרות יותר.';
export const BOOKS_UNPOSTED = (n: number) =>
  `${n === 1 ? 'פעולה אחת' : `${n} פעולות`} מתחילת הספרים ועד סוף התקופה עוד לא ${n === 1 ? 'נרשמה' : 'נרשמו'} בהנהלת החשבונות, והקובץ חייב להיות שלם — הוא לא הופק. `
  + 'בהגדרות הכספים ← "ספרים" ← "לרשום עכשיו", ואחר כך מפיקים שוב.';
/** a refusal of ours (its message is Hebrew, for the person) — any other error becomes BOOKS_READ_FAILED */
export class BooksError extends Error {}

/**
 * Where the books come from — the browser (supabase-js, openformat-books-data.ts) or the local demo database (psql,
 * scripts/ita-sample.mjs). Each call answers the database's data, or throws — a BooksError with one of the messages above
 * (BOOKS_DB_OLD, BOOKS_READ_FAILED); anything else becomes BOOKS_READ_FAILED: never an English error to the person.
 */
export interface BooksSource {
  /** how many sources of the books' time did not post, dated from..to (the view gl_unposted, 7100 — a count only) */
  unposted(from: string, to: string): Promise<number>;
  journal(from: string, to: string): Promise<unknown>;        // report_journal
  trialBalance(from: string, to: string): Promise<unknown>;   // report_trial_balance
  /** gl_accounts (key, name, tb_code, tb_name, parent_key, role, dealer_number, street, city, location_id) — every row */
  accounts(): Promise<{ rows: unknown[]; truncated: boolean }>;
  /** gl_transactions (id, user_id) of tx_date from..to — every row */
  users(from: string, to: string): Promise<{ rows: unknown[]; truncated: boolean }>;
}

/**
 * The books of a period for the unified file (booksPeriod): 'single' → null (the file as before); 'straddle' → throws
 * BOOKS_PERIOD_SPLIT; 'books' → the books, or throws a Hebrew message — never a file with part of the books:
 *   1. nothing unposted from the books' start to the period's end — 1414 is the balance of everything before the period, not only
 *      the period's own (gl_unposted, source_date start..to);
 *   2. the two reports (the database's sums), the accounts and the entries' people (every row);
 *   3. booksFileOf → booksFileProblems (whole, balanced, 1414 + 1415 − 1416 = the database's closing);
 *   4. docs given: every document entry's document is among them (booksDocsMissing → BOOKS_DOCS_CHANGED).
 */
export async function readBooksForFile(src: BooksSource, from: string, to: string, start: string | null,
  docs?: Pick<Doc, 'docType' | 'docNumber' | 'docDate'>[]): Promise<BooksFile | null> {
  const kind = booksPeriod(from, to, start);
  if (kind === 'single' || !start) return null;
  if (kind === 'straddle') throw new BooksError(BOOKS_PERIOD_SPLIT(start));
  try {
    const n = await src.unposted(start, to);
    if (!Number.isSafeInteger(n) || n < 0) throw new BooksError(BOOKS_READ_FAILED);
    if (n > 0) throw new BooksError(BOOKS_UNPOSTED(n));
    const [journal, trialBalance] = await Promise.all([src.journal(from, to), src.trialBalance(from, to)]);
    const [acc, users] = await Promise.all([src.accounts(), src.users(from, to)]);
    if (acc.truncated || users.truncated) throw new BooksError(BOOKS_TOO_MANY);
    let books: BooksFile | null = null;
    try {
      const r = booksFileOf({ start, journal, trialBalance, accounts: acc.rows, users: users.rows });
      if (r.ok && !booksFileProblems(r.books).length) books = r.books;
    } catch { /* an answer of an unexpected shape — below */ }
    if (!books) throw new BooksError(BOOKS_FILE_BROKEN);
    if (docs && booksDocsMissing(books, docs, from, to)) throw new BooksError(BOOKS_DOCS_CHANGED);
    return books;
  } catch (e) {
    throw e instanceof BooksError && e.message ? e : new BooksError(BOOKS_READ_FAILED);
  }
}
