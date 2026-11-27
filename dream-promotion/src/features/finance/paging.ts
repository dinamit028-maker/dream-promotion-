/**
 * 2.123 — reading every row of a list through PostgREST: its max_rows (1000 by default on Supabase) cuts a longer answer silently,
 * whatever `.limit()` asks. pageAll reads pages of PAGE rows (`.range(from, to)`) until a short page — with a stable order given by
 * the caller (a unique column last) — up to `max` rows. A failed page fails the whole read (never a list cut in the middle).
 */
export const PAGE = 1000;
export async function pageAll<T>(fetch: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, max = 50_000):
  Promise<{ data: T[]; error: unknown }> {
  const out: T[] = [];
  for (let from = 0; from < max; from += PAGE) {
    const { data, error } = await fetch(from, Math.min(from + PAGE, max) - 1);
    if (error) return { data: out, error };
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return { data: out, error: null };
}
