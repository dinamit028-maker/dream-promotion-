/**
 * Why a server job failed, in one short line that is safe to return to its caller (the pg_cron job keeps the answer in
 * net._http_response, where the system owner can read it): the error's name and message and its cause's, never a key.
 * Anything that looks like a key or a token (sb_secret_…, sb_publishable_…, a JWT, a long run of letters) is cut out.
 */
export function failureReason(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 3 && cur; i++) {
    if (cur instanceof Error) parts.push(`${cur.name}: ${cur.message}`);
    else { parts.push(String(cur)); break; }
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' ← ')
    .replace(/sb_(secret|publishable)_[A-Za-z0-9_\-•.]*/g, 'sb_$1_…')
    .replace(/eyJ[A-Za-z0-9_\-.]+/g, 'eyJ…')
    .replace(/[A-Za-z0-9_\-]{32,}/g, '…')
    .slice(0, 300) || 'unknown';
}
