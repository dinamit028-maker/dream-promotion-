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
export const SCOPE_CHANGED = 'בחירת הסניף השתנתה בזמן ההכנה (אולי בטלפון או בחלון אחר), ולכן הקובץ לרשות המסים לא הופק. נסו שוב.';
export const SCOPE_SHOW_ALL = 'להציג את כל הסניפים';
/** the message of a hole in the numbering: which documents are missing (type and number — never an amount or a customer) */
export const gapMessage = (missing: { docType: number; docNumber: number }[], label: (t: number) => string) =>
  `חסרים מסמכים במספור של התקופה (${missing.slice(0, 3).map((m) => `${label(m.docType)} מס׳ ${m.docNumber}`).join(', ')}${missing.length > 3 ? ' ועוד' : ''}), `
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
/**
 * One more guard of a whole file: every document type's numbers of the period run without a hole from its lowest to its highest
 * (one series per type — a document is found by type and number). A number between them may belong to a document dated outside
 * the period (a date in the past is allowed): `gaps` lists the candidates, the caller looks them up (lookupNumbers) — what is
 * still missing means documents the caller cannot see.
 */
export function numberGaps(docs: { docType: number; docNumber: number }[]): { docType: number; docNumber: number }[] {
  const by = new Map<number, Set<number>>();
  for (const d of docs) { if (!by.has(d.docType)) by.set(d.docType, new Set()); by.get(d.docType)!.add(d.docNumber); }
  const out: { docType: number; docNumber: number }[] = [];
  for (const [t, set] of [...by].sort((a, z) => a[0] - z[0])) {
    const ns = [...set].sort((a, z) => a - z);
    for (let n = ns[0] + 1; n < ns[ns.length - 1]; n++) if (!set.has(n)) out.push({ docType: t, docNumber: n });
  }
  return out;
}
/** the candidates of numberGaps that are not found outside the period either */
export const stillMissing = (gaps: { docType: number; docNumber: number }[], found: { docType: number; docNumber: number }[]) => {
  const k = new Set(found.map((f) => `${f.docType}:${f.docNumber}`));
  return gaps.filter((g) => !k.has(`${g.docType}:${g.docNumber}`));
};
/** a hole in the numbering → no file; the numbers between are looked up first (dated outside the period). Errors: no file */
export async function confirmNoGaps(docs: { docType: number; docNumber: number }[], label: (t: number) => string,
  db: () => Pick<SupabaseClient, 'from'> = supabase): Promise<ExportScope> {
  const gaps = numberGaps(docs);
  if (!gaps.length) return { ok: true };
  if (gaps.length > 2000) return { ok: false, message: gapMessage(gaps, label) };
  try {
    const found: { docType: number; docNumber: number }[] = [];
    for (const t of [...new Set(gaps.map((g) => g.docType))]) {
      const nums = gaps.filter((g) => g.docType === t).map((g) => g.docNumber);
      for (let i = 0; i < nums.length; i += 500) {
        const { data, error } = await db().from('documents').select('doc_type, doc_number').eq('doc_type', t).in('doc_number', nums.slice(i, i + 500));
        if (error) return { ok: false, message: SCOPE_ERROR };
        found.push(...((data ?? []) as any[]).map((r) => ({ docType: Number(r.doc_type), docNumber: Number(r.doc_number) })));
      }
    }
    const left = stillMissing(gaps, found);
    return left.length ? { ok: false, message: gapMessage(left, label) } : { ok: true };
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
