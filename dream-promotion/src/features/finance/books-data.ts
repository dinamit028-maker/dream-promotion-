'use client';
import { supabase } from '@/lib/supabase/client';
import { financeError } from './rows';
import { pageAll } from './paging';
import { isFunctionMissing } from './delivery';
import { SUSPENSE_TO, replayLeft, suspenseOf, toBooksState, toGlAccounts, type BooksState, type GlAccount } from './books';

/**
 * 2.121 — the books from the browser (migration 20261128007100). Before the migration the function is not there (PGRST202 /
 * 42883): `ready: false` — the card is not shown. Read: gl_books_state() and the number of sources that did not post (the view
 * gl_unposted, through the RLS of the business — a count only). The one write: the owner's gl_books_start_set.
 */
export type BooksLoad = { ok: true; ready: false } | { ok: true; ready: true; state: BooksState; unposted: number | null; suspense: number | null } | { ok: false; error: string };
export async function loadBooks(): Promise<BooksLoad> {
  try {
    const { data, error } = await supabase().rpc('gl_books_state');
    if (error) return isFunctionMissing(error) ? { ok: true, ready: false } : { ok: false, error: financeError(error) };
    const state = toBooksState(data);
    if (!state) return { ok: false, error: financeError(null) };
    const [u, tb] = await Promise.all([
      supabase().from('gl_unposted').select('source_id', { count: 'exact', head: true }),
      // the suspense account's balance (9100 — what had no account): the trial balance from the start, every date after it
      supabase().rpc('gl_trial_balance', { p_from: state.startDate, p_to: SUSPENSE_TO }),
    ]);
    return { ok: true, ready: true, state, unposted: u.error || u.count == null ? null : u.count, suspense: tb.error ? null : suspenseOf(tb.data) };
  } catch (e) { return { ok: false, error: financeError(e) }; }
}
/** the owner moves the start to the 1st of a month — what was posted since then (the database's answer) */
export async function moveBooksStart(day: string): Promise<{ ok: true; posted: number; failed: number } | { ok: false; error: string }> {
  const { data, error } = await supabase().rpc('gl_books_start_set', { p_start: day });
  if (error) return { ok: false, error: financeError(error) };
  const n = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  return { ok: true, posted: n((data as any)?.posted), failed: n((data as any)?.failed) };
}

/** a business whose books start could not be read: the file is not made (never a key of the wrong kind in 1225) */
export const BOOKS_START_MISSING = 'לא הצלחנו לקרוא את תאריך תחילת הספרים — הקובץ לרשות המסים לא הופק. רעננו את הדף ונסו שוב.';
/**
 * 2.121 — the books' start for the unified file (openformat.ts, customerKeyField): documents from it on get the books' customer
 * key in 1225; null — a database before 7100 (every key exactly as before). Any other failure throws BOOKS_START_MISSING.
 */
export async function loadBooksStart(): Promise<string | null> {
  // gl_books_state only — never the trial balance or the unposted list (an export needs the date, nothing else)
  let res: { data: unknown; error: { code?: string } | null };
  try { res = await supabase().rpc('gl_books_state'); } catch { throw new Error(BOOKS_START_MISSING); }
  if (res.error) { if (isFunctionMissing(res.error)) return null; throw new Error(BOOKS_START_MISSING); }
  const state = toBooksState(res.data);
  if (!state) throw new Error(BOOKS_START_MISSING);
  return state.startDate;
}

/**
 * "לרשום עכשיו" (the owner — retry: true, the owner asks explicitly: the sources that failed for good today are tried again) and
 * the posting after a moved start (retry: false): gl_replay(business, null, p_limit, p_retry) of the current business, a few
 * batches (REPLAY_BATCHES × limit); what is still left is posted by the night's timer (replayPending, retry false). A database
 * with an older gl_replay (no p_retry, or no p_limit): the same call without them. The business is the one the person works in
 * (the database checks it again — finance_guard, journal_writer).
 */
export const REPLAY_LIMIT = 100;
export const REPLAY_BATCHES = 3;
export type ReplayResult = { ok: true; posted: number; failed: number; skipped: number; left: number | null } | { ok: false; error: string };
export async function replayNow(business: string, o: { retry?: boolean } = {}): Promise<ReplayResult> {
  let posted = 0, failed = 0, skipped = 0, left: number | null = null;
  const tries = [
    { p_business: business, p_from: null, p_limit: REPLAY_LIMIT, p_retry: o.retry === true },
    { p_business: business, p_from: null, p_limit: REPLAY_LIMIT },
    { p_business: business, p_from: null },
  ];
  for (let i = 0; i < REPLAY_BATCHES; i++) {
    let r = await supabase().rpc('gl_replay', tries[0]);
    for (let t = 1; r.error && isFunctionMissing(r.error) && t < tries.length; t++) r = await supabase().rpc('gl_replay', tries[t]);
    if (r.error) return posted || failed || skipped ? { ok: true, posted, failed, skipped, left } : { ok: false, error: financeError(r.error) };
    const x = replayLeft(r.data);
    posted += x.posted; failed += x.failed; skipped += x.skipped; left = x.left;
    if (left === 0 || left == null || x.posted === 0) break;
  }
  return { ok: true, posted, failed, skipped, left };
}

/** whether migration 7100 is in the database (gl_books_state answers — anything but "no such function"); asked once a page */
let readyOnce: Promise<boolean> | null = null;
export function booksReady(): Promise<boolean> {
  readyOnce ??= Promise.resolve(supabase().rpc('gl_books_state')).then(({ error }) => !error || !isFunctionMissing(error), () => false)
    .then((v) => { if (!v) readyOnce = null; return v; });
  return readyOnce;
}

/**
 * 2.122 — is migration 7200 in the database, and from when are the books? Its table gl_bank_line_accounts answers (a read of one
 * id — through the RLS: a member who may not see it gets no row, never an error). Before 7200 (no such table — PGRST205 / 42P01)
 * or on any failure: null — the bank and the journal behave exactly as before (and if the database is 7200 after all, its own
 * refusal — bank_line_account_required / journal_books_started — is said in Hebrew). Then gl_books_state: the start and the owner.
 * Only "7200 is there" is kept for the page (asked again while it is not); the start date is read again on every load — the owner
 * may move it (gl_books_start_set) while the page is open.
 */
export interface BooksMore { startDate: string; owner: boolean }
let moreReady: Promise<boolean> | null = null;
export async function loadBooksMore(): Promise<BooksMore | null> {
  moreReady ??= Promise.resolve(supabase().from('gl_bank_line_accounts').select('id').limit(1)).then(({ error }) => !error, () => false)
    .then((v) => { if (!v) moreReady = null; return v; });
  if (!(await moreReady)) return null;
  try {
    const { data, error } = await supabase().rpc('gl_books_state');
    if (error) return null;
    const st = toBooksState(data);
    return st ? { startDate: st.startDate, owner: st.owner } : null;
  } catch { return null; }
}
/** 2.123 — the whole state of the books (gl_books_state) once 7200 is in the database (the same check as loadBooksMore); null before
 *  it, or when it cannot be read (a member who may not see the money) — the area "הנהלת חשבונות" is then not shown */
export async function loadBooksMoreState(): Promise<BooksState | null> {
  moreReady ??= Promise.resolve(supabase().from('gl_bank_line_accounts').select('id').limit(1)).then(({ error }) => !error, () => false)
    .then((v) => { if (!v) moreReady = null; return v; });
  if (!(await moreReady)) return null;
  try {
    const { data, error } = await supabase().rpc('gl_books_state');
    return error ? null : toBooksState(data);
  } catch { return null; }
}
/** the active accounts of the chart (for the bank's picker) — [] when they cannot be read (the picker then takes a key) */
export async function loadAccounts(): Promise<GlAccount[]> {
  try {
    // every active account, in pages (PostgREST's max_rows cuts one long answer — paging.ts)
    const { data, error } = await pageAll((from, to) => supabase().from('gl_accounts').select('key, name, kind, role, active').eq('active', true).order('key').range(from, to));
    return error ? [] : toGlAccounts(data);
  } catch { return []; }
}
/** the account each handled line was posted to (gl_bank_line_accounts, active) — line id → account key; empty on a failure */
export async function loadLineAccounts(lineIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!lineIds.length) return out;
  try {
    const sb = supabase();
    const batches = Array.from({ length: Math.ceil(lineIds.length / 100) }, (_, i) => lineIds.slice(i * 100, i * 100 + 100));
    const rows = await Promise.all(batches.map((ids) => sb.from('gl_bank_line_accounts').select('bank_line_id, account_id').eq('active', true).in('bank_line_id', ids)));
    const all = rows.flatMap((r) => (r.error ? [] : (r.data ?? []))) as { bank_line_id: string; account_id: string }[];
    const accIds = [...new Set(all.map((r) => String(r.account_id)))];
    if (!accIds.length) return out;
    const acc = await sb.from('gl_accounts').select('id, key').in('id', accIds.slice(0, 500));
    const keyOf = new Map(((acc.data ?? []) as { id: string; key: string }[]).map((a) => [String(a.id), String(a.key)]));
    for (const r of all) { const k = keyOf.get(String(r.account_id)); if (k) out.set(String(r.bank_line_id), k); }
  } catch { /* the label is a help only */ }
  return out;
}
/** a line of the books' time posted to an account (bank_line_classify — whoever may handle a bank line: the whole business's
 *  money, writing — bank_guard(true), the owner's decision of 27.11.2026; the database checks the line, the account, the note) */
export async function classifyLine(line: string, account: string, note: string): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  try {
    const { data, error } = await supabase().rpc('bank_line_classify', { p_line: line, p_account: account.trim(), p_note: note.trim().slice(0, 300) });
    if (error || data == null) return { ok: false, error: financeError(error) };
    return { ok: true, account: String((data as any).account ?? account.trim()) };
  } catch (e) { return { ok: false, error: financeError(e) }; }
}
