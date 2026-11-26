'use client';
import { supabase } from '@/lib/supabase/client';
import type { BranchInfo, Doc } from '@/features/documents/openformat';
import { financeError } from './rows';
import { isFunctionMissing } from './delivery';
import { branchInfoOf, normalizeCode, toNumberingState, type NumberingState } from './numbering';

/**
 * 2.120 — numbering per location from the browser (migration 20261127007000). Before the migration the functions are not there
 * (PGRST202 / 42883): `ready: false` — the settings card is not shown, and the unified file is written as before (1034 = 0, no
 * branch fields). Every write is one function of the database (the owner only — location_owner()).
 */
/** a switched business whose branch codes could not be read: the file is not made (never 1034 = 0 with 8-digit numbers) */
export const BRANCH_INFO_MISSING = 'העסק ממספר מסמכים לפי סניף, ולא הצלחנו לקרוא את קודי הסניפים — הקובץ לרשות המסים לא הופק. רעננו את הדף ונסו שוב.';
export type NumberingLoad = { ok: true; ready: false } | { ok: true; ready: true; state: NumberingState } | { ok: false; error: string };
export async function loadNumbering(): Promise<NumberingLoad> {
  try {
    const { data, error } = await supabase().rpc('document_numbering_state');
    if (error) return isFunctionMissing(error) ? { ok: true, ready: false } : { ok: false, error: financeError(error) };
    const state = toNumberingState(data);
    return state ? { ok: true, ready: true, state } : { ok: false, error: financeError(null) };
  } catch (e) { return { ok: false, error: financeError(e) }; }
}
/** the owner's one-way switch — the state after it (the same answer again when already switched) */
export async function switchPerLocation(): Promise<{ ok: true; state: NumberingState } | { ok: false; error: string }> {
  const { data, error } = await supabase().rpc('document_numbering_per_location');
  const state = error ? null : toNumberingState(data);
  return state ? { ok: true, state } : { ok: false, error: financeError(error) };
}
/** a location's branch code (01–99; '1' → '01') — until the location's first document of its series */
export async function setBranchCode(location: string, code: string): Promise<{ ok: true; code: string | null } | { ok: false; error: string }> {
  const { data, error } = await supabase().rpc('location_branch_code_set', { p_location: location, p_code: normalizeCode(code) });
  if (error) return { ok: false, error: financeError(error) };
  return { ok: true, code: typeof (data as any)?.branchCode === 'string' ? (data as any).branchCode : null };
}

/**
 * The unified file's branch fields (openformat.ts, BranchInfo) for an export of these documents: null — the business did not
 * switch, or the database is before 7000 (the file exactly as before). A base document (1256 / 1257) of the business's series
 * (below 1,000,000) that is not among the documents: its location is read (one query per base type, by its numbers).
 */
export async function loadBranchInfo(docs: Pick<Doc, 'docType' | 'docNumber' | 'baseDocType' | 'baseDocNumber'>[], businessId: string | null): Promise<BranchInfo | null> {
  const st = await loadNumbering();
  if (!st.ok) throw new Error(st.error);
  if (!st.ready || !st.state.perLocation) return null;
  // a business that numbers per location is never written without its branch fields (1034 = 1, 1231 …) — no silent file
  const info = branchInfoOf(st.state, businessId);
  if (!info || !info.codes.size) throw new Error(BRANCH_INFO_MISSING);
  const have = new Set(docs.map((d) => `${d.docType}:${d.docNumber}`));
  const want = new Map<number, Set<number>>();
  for (const d of docs) {
    if (!d.baseDocType || !d.baseDocNumber || Number(d.baseDocNumber) >= 1_000_000 || have.has(`${d.baseDocType}:${d.baseDocNumber}`)) continue;
    if (!want.has(d.baseDocType)) want.set(d.baseDocType, new Set());
    want.get(d.baseDocType)!.add(Number(d.baseDocNumber));
  }
  const baseLocations = new Map<string, string | null>();
  for (const [type, set] of want) {
    const nums = [...set];
    for (let i = 0; i < nums.length; i += 200) {
      const { data, error } = await supabase().from('documents').select('doc_type, doc_number, location_id').eq('doc_type', type).in('doc_number', nums.slice(i, i + 200));
      if (error) throw new Error(financeError(error));
      for (const r of (data ?? []) as any[]) baseLocations.set(`${r.doc_type}:${Number(r.doc_number)}`, r.location_id ?? null);
    }
  }
  return { ...info, baseLocations };
}
