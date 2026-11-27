/**
 * 2.123 — reading every row of a list through PostgREST: its max_rows (1000 by default on Supabase — maybe less on another server)
 * cuts a longer answer silently, whatever `.limit()` asks. pageAll asks for pages of PAGE rows (`.range(from, to)`, with a stable
 * order given by the caller — a unique column last) and moves on by the rows it really got, until an empty page — so a server that
 * answers fewer rows than asked still pages right. Up to `max` rows: more than that — `truncated` (the screen says so). A failed page
 * fails the whole read (never a list cut in the middle without saying so).
 */
export const PAGE = 1000;
export async function pageAll<T>(fetch: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, max = 50_000):
  Promise<{ data: T[]; error: unknown; truncated: boolean }> {
  const out: T[] = [];
  let from = 0;
  while (from < max) {
    const { data, error } = await fetch(from, Math.min(from + PAGE, max) - 1);
    if (error) return { data: out, error, truncated: false };
    const rows = data ?? [];
    if (!rows.length) return { data: out, error: null, truncated: false };
    out.push(...rows);
    from += rows.length;
  }
  // max reached: is there more?
  const { data, error } = await fetch(max, max);
  return { data: out, error, truncated: !error && (data ?? []).length > 0 };
}
