'use client';
import { supabase } from '@/lib/supabase/client';
import { pageAll } from './paging';
import { isFunctionMissing } from './delivery';
import { BOOKS_FILE_BROKEN, BOOKS_PERIOD_SPLIT, booksFileProblems, booksPeriod, type BooksFile } from '@/features/documents/openformat';
import { booksFileOf } from '@/features/documents/openformat-books';

/**
 * 2.124 (stage 4ה) — the books of a period for the unified file, from the browser of the person who exports (the whole business
 * only — both export paths check the scope first, export-scope.ts, so the RLS of the locations hides nothing). The sums are the
 * database's (report_journal, report_trial_balance — security invoker, migration 7200); the lists are read in pages (pageAll —
 * PostgREST's max_rows): the accounts' details (gl_accounts) and the person of each entry (gl_transactions.user_id, for 1376).
 *   'single'   (before the books / no books) → null: the file exactly as before;
 *   'straddle' → throws BOOKS_PERIOD_SPLIT (split the period);
 *   'books'    → the books, or throws a Hebrew message — never a file with part of the books.
 * The messages carry no key, amount, dealer number or anything of a customer (privacy): a count of what did not post at most.
 */
export const BOOKS_READ_FAILED = 'לא הצלחנו לקרוא את הנהלת החשבונות של התקופה — הקובץ לרשות המסים לא הופק. רעננו את הדף ונסו שוב.';
export const BOOKS_DB_OLD = 'כדי להפיק קובץ מהנהלת החשבונות צריך עדכון של המסד (דוחות הספרים) — הקובץ לא הופק. פנו לתמיכה.';
export const BOOKS_TOO_MANY = 'בתקופה יש יותר שורות בספרים ממה שאפשר להפיק בקובץ אחד — מפיקים לתקופות קצרות יותר.';
export const BOOKS_UNPOSTED = (n: number) =>
  `${n === 1 ? 'פעולה אחת' : `${n} פעולות`} של התקופה עוד לא ${n === 1 ? 'נרשמה' : 'נרשמו'} בהנהלת החשבונות, והקובץ חייב להיות שלם — הוא לא הופק. `
  + 'בהגדרות הכספים ← "ספרים" ← "לרשום עכשיו", ואחר כך מפיקים שוב.';
export const BOOKS_ROWS_MAX = 200_000;

export async function loadBooksForFile(from: string, to: string, start: string | null): Promise<BooksFile | null> {
  const kind = booksPeriod(from, to, start);
  if (kind === 'single' || !start) return null;
  if (kind === 'straddle') throw new Error(BOOKS_PERIOD_SPLIT(start));
  const sb = supabase();
  let journal: unknown, trialBalance: unknown;
  try {
    // what should have posted in the period and did not (gl_unposted, 7100 — a count only): the file would miss its entries
    const u = await sb.from('gl_unposted').select('source_id', { count: 'exact', head: true }).gte('source_date', from).lte('source_date', to);
    if (u.error || u.count == null) throw new Error(BOOKS_READ_FAILED);
    if (u.count > 0) throw new Error(BOOKS_UNPOSTED(u.count));
    const [j, tb] = await Promise.all([sb.rpc('report_journal', { p_from: from, p_to: to }), sb.rpc('report_trial_balance', { p_from: from, p_to: to })]);
    if (isFunctionMissing(j.error) || isFunctionMissing(tb.error)) throw new Error(BOOKS_DB_OLD);
    if (j.error || tb.error || j.data == null || tb.data == null) throw new Error(BOOKS_READ_FAILED);
    journal = j.data; trialBalance = tb.data;
  } catch (e) { throw e instanceof Error && e.message ? e : new Error(BOOKS_READ_FAILED); }
  const [acc, users] = await Promise.all([
    // every account (by key — unique in the business, so the pages never overlap)
    pageAll((f, t) => sb.from('gl_accounts').select('key, name, tb_code, tb_name, parent_key, role, dealer_number, street, city, location_id').order('key').range(f, t), BOOKS_ROWS_MAX),
    // the entries of the period (by number — unique in the business)
    pageAll((f, t) => sb.from('gl_transactions').select('id, user_id').gte('tx_date', from).lte('tx_date', to).order('number').range(f, t), BOOKS_ROWS_MAX),
  ]).catch(() => { throw new Error(BOOKS_READ_FAILED); });
  if (acc.error || users.error) throw new Error(BOOKS_READ_FAILED);
  if (acc.truncated || users.truncated) throw new Error(BOOKS_TOO_MANY);
  const r = booksFileOf({ start, journal, trialBalance, accounts: acc.data, users: users.data });
  if (!r.ok || booksFileProblems(r.books).length) throw new Error(BOOKS_FILE_BROKEN);
  return r.books;
}
