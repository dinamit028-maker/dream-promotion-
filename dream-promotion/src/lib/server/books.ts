import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 2.121 — the books (stage 4ב, migration 20261128007100): what did not post is posted again every night. A posting that fails never
 * blocks a sale (gl_post_safe records it, gl_unposted lists it); here the daily timer (/api/cron/backup, 01:15 UTC) asks the
 * database to post what is pending — gl_replay_pending(p_limit), the service role's (db-agent), every business, the oldest first,
 * at most p_limit sources per call — a few calls while time is left. A database without the function (before 7100, or before the
 * function was added): nothing, silently. The answer is counts only — never a business, a document or an amount.
 */
export interface ReplayReport { ready: boolean; posted: number; failed: number; skipped: number; left: number | null; calls: number }
const count = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
const missing = (e: { code?: string } | null | undefined) => Boolean(e && (e.code === 'PGRST202' || e.code === '42883'));

export async function replayPending(db: SupabaseClient, deadline: number, o: { limit?: number; maxCalls?: number; clock?: () => number } = {}): Promise<ReplayReport> {
  const clock = o.clock ?? Date.now, limit = o.limit ?? 200, maxCalls = o.maxCalls ?? 5;
  const r: ReplayReport = { ready: true, posted: 0, failed: 0, skipped: 0, left: null, calls: 0 };
  while (r.calls < maxCalls && clock() < deadline) {
    // retry false (the database's default): a source that failed for good today waits for tomorrow or the owner's button
    const { data, error } = await db.rpc('gl_replay_pending', { p_limit: limit });
    r.calls++;
    if (error) {
      if (missing(error)) return { ...r, ready: false };
      console.error('[cron/books] replay', error.code ?? 'error');      // the code only — never a message (it may name a document)
      break;
    }
    const d = (data ?? {}) as Record<string, unknown>;
    const posted = count(d.posted), failed = count(d.failed), skipped = count(d.skipped);
    r.posted += posted; r.failed += failed; r.skipped += skipped;
    r.left = d.left == null ? null : count(d.left);
    // nothing more to do: none left, or a call that posted nothing and skipped nothing (what is left fails again — tomorrow); a call
    // that skipped some (a business busy now — db-agent's "skipped") with more left goes on
    if (r.left === 0 || (posted === 0 && !(skipped > 0 && (r.left ?? 0) > 0))) break;
  }
  return r;
}
