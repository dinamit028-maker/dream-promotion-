'use client';
import { supabase } from '@/lib/supabase/client';
import { financeError } from './rows';
import { isFunctionMissing } from './delivery';
import { toBooksState, type BooksState } from './books';

/**
 * 2.121 — the books from the browser (migration 20261128007100). Before the migration the function is not there (PGRST202 /
 * 42883): `ready: false` — the card is not shown. Read: gl_books_state() and the number of sources that did not post (the view
 * gl_unposted, through the RLS of the business — a count only). The one write: the owner's gl_books_start_set.
 */
export type BooksLoad = { ok: true; ready: false } | { ok: true; ready: true; state: BooksState; unposted: number | null } | { ok: false; error: string };
export async function loadBooks(): Promise<BooksLoad> {
  try {
    const { data, error } = await supabase().rpc('gl_books_state');
    if (error) return isFunctionMissing(error) ? { ok: true, ready: false } : { ok: false, error: financeError(error) };
    const state = toBooksState(data);
    if (!state) return { ok: false, error: financeError(null) };
    const u = await supabase().from('gl_unposted').select('source_id', { count: 'exact', head: true });
    return { ok: true, ready: true, state, unposted: u.error || u.count == null ? null : u.count };
  } catch (e) { return { ok: false, error: financeError(e) }; }
}
/** the owner moves the start to the 1st of a month — what was posted since then (the database's answer) */
export async function moveBooksStart(day: string): Promise<{ ok: true; posted: number; failed: number } | { ok: false; error: string }> {
  const { data, error } = await supabase().rpc('gl_books_start_set', { p_start: day });
  if (error) return { ok: false, error: financeError(error) };
  const n = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  return { ok: true, posted: n((data as any)?.posted), failed: n((data as any)?.failed) };
}
