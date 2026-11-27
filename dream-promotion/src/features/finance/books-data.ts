'use client';
import { supabase } from '@/lib/supabase/client';
import { financeError } from './rows';
import { isFunctionMissing } from './delivery';
import { SUSPENSE_TO, replayLeft, suspenseOf, toBooksState, type BooksState } from './books';

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
 * the owner's "לרשום עכשיו": gl_replay(business, null, p_limit) of the current business, a few batches (REPLAY_BATCHES × limit);
 * what is still left after them is posted by the night's timer (replayPending). A database whose gl_replay takes no limit (the
 * first version of 7100): one call, all of it. The business is the one the person works in (the database checks it again —
 * finance_guard, journal_writer).
 */
export const REPLAY_LIMIT = 100;
export const REPLAY_BATCHES = 3;
export async function replayNow(business: string): Promise<{ ok: true; posted: number; failed: number; left: number | null } | { ok: false; error: string }> {
  let posted = 0, failed = 0, left: number | null = null;
  for (let i = 0; i < REPLAY_BATCHES; i++) {
    let r = await supabase().rpc('gl_replay', { p_business: business, p_from: null, p_limit: REPLAY_LIMIT });
    if (r.error && isFunctionMissing(r.error)) r = await supabase().rpc('gl_replay', { p_business: business, p_from: null });
    if (r.error) return posted || failed ? { ok: true, posted, failed, left } : { ok: false, error: financeError(r.error) };
    const x = replayLeft(r.data);
    posted += x.posted; failed += x.failed; left = x.left;
    if (left === 0 || left == null || x.posted === 0) break;
  }
  return { ok: true, posted, failed, left };
}

/** whether migration 7100 is in the database (gl_books_state answers — anything but "no such function"); asked once a page */
let readyOnce: Promise<boolean> | null = null;
export function booksReady(): Promise<boolean> {
  readyOnce ??= Promise.resolve(supabase().rpc('gl_books_state')).then(({ error }) => !error || !isFunctionMissing(error), () => false)
    .then((v) => { if (!v) readyOnce = null; return v; });
  return readyOnce;
}
