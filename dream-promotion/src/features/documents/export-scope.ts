import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase/client';

/**
 * The file to the Tax Authority (INI.TXT + BKMVDATA, the printout by document type §2.6ב and the export summary, נספח 4) is
 * the file of the whole business: one dealer number in A000 / A100 / Z900 and one running series of document numbers. The screens
 * read `documents` through the location policies (`documents_location_gate`, migration 4600): with one location picked at the
 * top, or for a member limited to some locations, they would get part of the documents — a file with holes in the numbering
 * that looks like the whole business's. So it is made only when the caller sees every location (`location_filter()` = null).
 * Marking the location of each document in the file (clarification 3, spec p. 21: 1034 / 1231 / 1270 / 1320) is a separate fix.
 * A business with one active location: location_filter() is null — everything exactly as before.
 * The owner of the system (22.11.2026, option א): only the Tax Authority part stops; the rest of the accountant's package
 * (expenses, payments, receivables, CSV, journal) follows the switch as before.
 */
export const SCOPE_PICK_ALL = "הקובץ לרשות המסים הוא של כל העסק — בחרו 'כל הסניפים' במתג";
export const SCOPE_LIMITED = 'רק מי שרואה את כל הסניפים יכול להפיק את הקובץ לרשות המסים';
export const SCOPE_ERROR = 'לא הצלחנו לבדוק שנבחרו כל הסניפים, ולכן הקובץ לרשות המסים לא הופק. נסו שוב.';

export type ExportScope = { ok: true } | { ok: false; message: string };
type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null };

/** the function is not in the database (before migration 4600): there are no locations, and no location policy either */
const noFunction = (e: RpcAnswer['error']) => Boolean(e && (e.code === 'PGRST202' || e.code === '42883'));

/**
 * The decision, from the database's answers: location_filter() (null = every location) and, only when it is not null,
 * my_locations() (null = the person may pick "all locations"; else they are limited to some). Any other failure — no file.
 */
export function exportScope(filter: RpcAnswer, mine?: RpcAnswer | null): ExportScope {
  if (filter.error) return noFunction(filter.error) ? { ok: true } : { ok: false, message: SCOPE_ERROR };
  if (filter.data == null) return { ok: true };
  if (!mine || mine.error) return { ok: false, message: SCOPE_ERROR };
  return { ok: false, message: mine.data == null ? SCOPE_PICK_ALL : SCOPE_LIMITED };
}

/** asks the database (the caller's own view — the same policies the documents are read through) */
export async function loadExportScope(db: () => Pick<SupabaseClient, 'rpc'> = supabase): Promise<ExportScope> {
  try {
    const filter = (await db().rpc('location_filter')) as RpcAnswer;
    if (filter.error || filter.data == null) return exportScope(filter);
    return exportScope(filter, (await db().rpc('my_locations')) as RpcAnswer);
  } catch {
    return { ok: false, message: SCOPE_ERROR };
  }
}
