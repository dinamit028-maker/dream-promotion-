'use client';
import { supabase } from '@/lib/supabase/client';
import { pageAll } from './paging';
import { isFunctionMissing } from './delivery';
import type { BooksFile, Doc } from '@/features/documents/openformat';
import {
  BOOKS_DB_OLD, BOOKS_READ_FAILED, BooksError, readBooksForFile, type BooksSource,
} from '@/features/documents/openformat-books';

export { BOOKS_DB_OLD, BOOKS_DOCS_CHANGED, BOOKS_READ_FAILED, BOOKS_TOO_MANY, BOOKS_UNPOSTED } from '@/features/documents/openformat-books';

/**
 * 2.124 (stage 4ה) — the books of a period for the unified file, from the browser of the person who exports (the whole business
 * only — the export checks the scope first, export-scope.ts, so the RLS of the locations hides nothing). What is read and checked
 * is readBooksForFile (openformat-books.ts — the same function scripts/ita-sample.mjs calls with the local database); here only
 * where it comes from: supabase-js. The sums are the database's (report_journal, report_trial_balance — security invoker,
 * migration 7200); the lists are read in pages (pageAll — PostgREST's max_rows). The messages carry no key, amount, dealer
 * number or anything of a customer (privacy): a count of what did not post at most.
 */
export const BOOKS_ROWS_MAX = 200_000;

export function supabaseBooksSource(): BooksSource {
  const sb = supabase();
  const rpc = async (fn: string, from: string, to: string) => {
    const r = await sb.rpc(fn, { p_from: from, p_to: to });
    if (isFunctionMissing(r.error)) throw new BooksError(BOOKS_DB_OLD);
    if (r.error || r.data == null) throw new BooksError(BOOKS_READ_FAILED);
    return r.data as unknown;
  };
  const rows = async (q: Promise<{ data: unknown[]; error: unknown; truncated: boolean }>) => {
    const r = await q;
    if (r.error) throw new BooksError(BOOKS_READ_FAILED);
    return { rows: r.data, truncated: r.truncated };
  };
  return {
    async unposted(from, to) {
      const u = await sb.from('gl_unposted').select('source_id', { count: 'exact', head: true }).gte('source_date', from).lte('source_date', to);
      if (u.error || u.count == null) throw new BooksError(BOOKS_READ_FAILED);
      return u.count;
    },
    journal: (from, to) => rpc('report_journal', from, to),
    trialBalance: (from, to) => rpc('report_trial_balance', from, to),
    // every account (by key — unique in the business, so the pages never overlap)
    accounts: () => rows(pageAll((f, t) => sb.from('gl_accounts').select('key, name, tb_code, tb_name, parent_key, role, dealer_number, street, city, location_id')
      .order('key').range(f, t), BOOKS_ROWS_MAX)),
    // the entries of the period (by number — unique in the business)
    users: (from, to) => rows(pageAll((f, t) => sb.from('gl_transactions').select('id, user_id').gte('tx_date', from).lte('tx_date', to).order('number').range(f, t), BOOKS_ROWS_MAX)),
  };
}

/** null — a period before the books (the file as before); throws a Hebrew message (BooksError) when the file may not be made */
export const loadBooksForFile = (from: string, to: string, start: string | null, docs?: Pick<Doc, 'docType' | 'docNumber' | 'docDate'>[]): Promise<BooksFile | null> =>
  readBooksForFile(supabaseBooksSource(), from, to, start, docs);
