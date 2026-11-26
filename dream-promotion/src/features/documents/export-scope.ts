import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase/client';
import { docNumberLabel } from './documents';

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
export const SCOPE_CHANGED = 'בחירת הסניף השתנתה בזמן ההכנה (אולי בטלפון או בחלון אחר), ולכן הקובץ לרשות המסים לא הופק. נסו שוב.';
export const SCOPE_SHOW_ALL = 'להציג את כל הסניפים';
/** the message of a hole in the numbering: which type and between which numbers (never an amount or a customer) */
export const gapMessage = (holes: NumberRange[], label: (t: number) => string) =>
  `חסרים מסמכים במספור (${holes.slice(0, 3).map((h) => `${label(h.docType)} בין מס׳ ${docNumberLabel(h.min)} ל-${docNumberLabel(h.max)}`).join(', ')}${holes.length > 3 ? ' ועוד' : ''}), `
  + 'ולכן הקובץ לרשות המסים לא הופק — הקובץ חייב לכלול את כל המסמכים. פנו לתמיכה.';

export type ExportScope = { ok: true } | { ok: false; message: string };
type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null };

/**
 * The function is not in the database (before migration 4600) — PGRST202 (PostgREST: not in its schema cache) / 42883 (Postgres:
 * no such function). Safe to read as "every location": the only thing that limits the documents to a location is the policy
 * documents_location_gate, which calls this same function (location_filter()) and comes with it in 4600 — without the function
 * there is no such policy, and the documents read are the whole business's. Any other error: no file (fail closed).
 */
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

/**
 * The location picked is kept on the profile (profiles.current_location_id) — shared by every tab and device: it can change
 * while the documents are read (several pages). So it is asked before the documents are read and again after; the file is made
 * only if both answers say "every location".
 */
export function bothScopes(before: ExportScope, after: ExportScope): ExportScope {
  if (!before.ok) return before;
  if (!after.ok) return after.message === SCOPE_ERROR ? after : { ok: false, message: SCOPE_CHANGED };
  return { ok: true };
}
/** the numbers of one document type in the period: its lowest, its highest, and how many documents of it were read */
export interface NumberRange { docType: number; min: number; max: number; count: number }
/**
 * per series of a document type (a document is found by type and number): lowest, highest, how many. 2.120 (migration 7000): a
 * business that numbers per location has a series per location and type — the number's first two digits are the location's
 * branch code (code × 1,000,000 + n, docNumberLabel); numbers below 1,000,000 are the business's one series (every document
 * before the switch). Each series runs by itself — never one range from 1 to 02000003. A business that never switched: one
 * series per type, exactly as before.
 */
export function numberRanges(docs: { docType: number; docNumber: number }[]): NumberRange[] {
  const by = new Map<string, { docType: number; ns: Set<number> }>();
  for (const d of docs) {
    const k = `${d.docType}:${Math.floor(Number(d.docNumber) / 1_000_000)}`;
    if (!by.has(k)) by.set(k, { docType: d.docType, ns: new Set() });
    by.get(k)!.ns.add(d.docNumber);
  }
  return [...by.values()].map(({ docType, ns }) => {
    const list = [...ns];
    return { docType, min: Math.min(...list), max: Math.max(...list), count: ns.size };
  }).sort((a, z) => a.docType - z.docType || a.min - z.min);
}
/** the types whose numbers of the period do not run without a hole from the lowest to the highest */
export const holesOf = (ranges: NumberRange[]) => ranges.filter((r) => r.count !== r.max - r.min + 1);
/**
 * One more guard against the race (bothScopes) — only for a business with more than one active location (multiLocation, the
 * same rule as the switch at the top): only there can a location narrow what is read. A business with one location is exactly
 * as before 2.117.1 — an old hole in its numbering (a pilot, a counter fixed by hand) never blocks its file.
 * A type with a hole in the period: a number between may belong to a document dated outside the period (a past date is allowed),
 * so the database counts every document of that type between the lowest and the highest number (no date — one count query per
 * type, head only); fewer than max − min + 1 → documents the caller cannot see → no file. An error → no file.
 */
export async function confirmNoGaps(docs: { docType: number; docNumber: number }[], label: (t: number) => string, multi: boolean,
  db: () => Pick<SupabaseClient, 'from'> = supabase): Promise<ExportScope> {
  if (!multi) return { ok: true };
  const holes = holesOf(numberRanges(docs));
  if (!holes.length) return { ok: true };
  try {
    const still: NumberRange[] = [];
    for (const h of holes) {
      const { count, error } = await db().from('documents').select('id', { count: 'exact', head: true })
        .eq('doc_type', h.docType).gte('doc_number', h.min).lte('doc_number', h.max);
      if (error || count == null) return { ok: false, message: SCOPE_ERROR };
      if (count !== h.max - h.min + 1) still.push(h);
    }
    return still.length ? { ok: false, message: gapMessage(still, label) } : { ok: true };
  } catch {
    return { ok: false, message: SCOPE_ERROR };
  }
}
/** "להציג את כל הסניפים" next to the message: only when the switch at the top is not there to do it (one active location left,
 *  and a location — maybe one that was closed since — still picked on the profile) */
export const offerShowAll = (scope: ExportScope | null, switchShown: boolean) => Boolean(scope && !scope.ok && scope.message === SCOPE_PICK_ALL && !switchShown);

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
