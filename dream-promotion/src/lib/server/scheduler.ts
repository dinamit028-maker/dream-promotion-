import { adminDb } from './admin';
import { createIgContainer, igContainerStep, metaAccount, publishToPage, type IgTarget } from './meta';
import { accessTokenFor, uploadToInbox } from './tiktok';
import { safeFetch } from './safe-fetch';
import { LOCKED_REASON, businessOpen } from './business';

/**
 * Scheduled publishing. A post (public.scheduled_posts) has a time and destinations; the timer
 * (/api/cron/publish-due, every 5 minutes) publishes each one that is due:
 *   Facebook Page  → published in one call
 *   Instagram      → container created, then checked on each run until Instagram finished
 *                    processing, then published
 *   TikTok         → sent to the creator's TikTok drafts (TikTok does not allow direct posting
 *                    for unaudited apps) — reported as "sent_to_drafts", never as "published"
 * Every destination keeps its own result; one failing never blocks the others, and a
 * destination that already succeeded is never sent twice.
 * A post whose business is locked when its time comes is cancelled ("העסק נעול") — never published;
 * unlocking the business does not bring it back by itself (the owner schedules it again).
 */
export type Destination = { accountId: string; provider: 'facebook' | 'instagram' | 'tiktok'; target?: 'feed' | 'story'; coverMs?: number };
export type DestState = 'waiting' | 'processing' | 'published' | 'sent_to_drafts' | 'failed';
export type DestResult = { state: DestState; containerId?: string; externalId?: string; error?: string; at?: string; tries?: number };

const TERMINAL: DestState[] = ['published', 'sent_to_drafts', 'failed'];
const GIVE_UP_MS = 2 * 3600 * 1000;   // Instagram still processing two hours after the time → failed
const EXPIRE_MS = 24 * 3600 * 1000;   // nothing is published more than a day late (the timer was down) — it fails visibly instead
const MAX_TRIES = 3;                   // a passing network / provider hiccup is retried on the next runs, then it fails

/** Errors worth another try on the next run (never: bad input, no permission, expired login, policy). */
const TRANSIENT = /timeout|timed out|network|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket|5\d\d|temporar|try again|rate limit|too many|unavailable|meta_(1|2|4|17|32|341|613)\b/i;
const PERMANENT = /reconnect_required|permission|read only|משיכה בלבד|invalid parameter|meta_100\b|not supported|accepts videos only|נמחק/i;

/** retry: try again on the next timer run · fail: stop now (exported for tests). */
export function classifyFailure(error: string): 'retry' | 'fail' {
  return TRANSIENT.test(error) && !PERMANENT.test(error) ? 'retry' : 'fail';
}

type Row = {
  id: string; user_id: string; business_id?: string | null; content_id: string | null; media_id: string; caption: string;
  destinations: Destination[]; run_at: string; status: string; results: Record<string, DestResult>; attempts: number;
};

async function publishOne(row: Row, d: Destination, media: { url: string; kind: string }, prev: DestResult): Promise<DestResult> {
  const at = new Date().toISOString();
  try {
    if (d.provider === 'tiktok') {
      if (media.kind !== 'video') return { state: 'failed', error: 'TikTok accepts videos only', at };
      const token = await accessTokenFor(row.user_id, d.accountId);
      const file = await safeFetch(media.url, { maxBytes: 500 * 1024 * 1024 });
      if (!file.ok) throw new Error(`video_download_${file.status}`);
      const id = await uploadToInbox(token, Buffer.from(await file.arrayBuffer()));
      await adminDb().from('social_posts').insert({
        user_id: row.user_id, business_id: row.business_id, account_id: d.accountId, provider: 'tiktok', content_id: row.content_id,
        media_id: row.media_id, mode: 'draft', status: 'uploaded', external_id: id,
      });
      return { state: 'sent_to_drafts', externalId: id, at };
    }

    const acc = await metaAccount(row.user_id, d.accountId);
    if (acc.mode === 'read') return { state: 'failed', error: 'החשבון מחובר למשיכה בלבד', at };

    if (d.provider === 'facebook') {
      const id = await publishToPage(acc, media, row.caption);
      return { state: 'published', externalId: id, at };
    }

    // Instagram: create once, then step on every run until it is live
    let containerId = prev.containerId;
    if (!containerId) {
      const target: IgTarget = d.target === 'story' ? 'story' : media.kind === 'video' ? 'reel' : 'feed';
      containerId = await createIgContainer(acc, media, row.caption, target, d.coverMs);
    }
    const st = await igContainerStep(acc, containerId);
    if (st.state === 'published') return { state: 'published', containerId, externalId: 'id' in st ? st.id : undefined, at };
    if (st.state === 'failed') return { state: 'failed', containerId, error: `Instagram: ${st.reason}`, at };
    if (Date.now() - new Date(row.run_at).getTime() > GIVE_UP_MS) {
      return { state: 'failed', containerId, error: 'אינסטגרם לא סיימה לעבד את הקובץ תוך שעתיים', at };
    }
    return { state: 'processing', containerId, at };
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 300);
    const tries = (prev.tries ?? 0) + 1;
    // a hiccup is retried on the next timer run; a real refusal fails at once
    if (classifyFailure(error) === 'retry' && tries < MAX_TRIES) {
      return { ...prev, state: 'waiting', error: `${error} (ניסיון ${tries} מתוך ${MAX_TRIES})`, at, tries };
    }
    return { ...prev, state: 'failed', error, at, tries };
  }
}

function overall(dests: Destination[], results: Record<string, DestResult>): Row['status'] {
  const states = dests.map((d) => results[d.accountId]?.state ?? 'waiting');
  if (!states.every((s) => TERMINAL.includes(s))) return 'publishing';
  const ok = states.filter((s) => s !== 'failed').length;
  return ok === states.length ? 'done' : ok === 0 ? 'failed' : 'partial';
}

/** One timer run: claims due posts (a row is locked for 4 minutes) and moves each forward. */
export async function publishDue(opts: { deadline: number; limit?: number }) {
  const db = adminDb();
  const nowIso = new Date().toISOString();
  const { data: due, error } = await db.from('scheduled_posts').select('id')
    .in('status', ['scheduled', 'publishing']).lte('run_at', nowIso)
    .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
    .order('run_at').limit(opts.limit ?? 10);
  if (error) throw new Error(error.message);

  const summary = { claimed: 0, done: 0, partial: 0, failed: 0, publishing: 0, cancelled: 0 };
  for (const { id } of due ?? []) {
    if (Date.now() > opts.deadline) break;
    // claim: only one run may work on a row at a time
    const lock = new Date(Date.now() + 4 * 60_000).toISOString();
    const { data: claimed } = await db.from('scheduled_posts').update({ locked_until: lock, status: 'publishing' })
      .eq('id', id).in('status', ['scheduled', 'publishing']).or(`locked_until.is.null,locked_until.lt.${new Date().toISOString()}`)
      .select('*').maybeSingle();
    if (!claimed) continue;
    summary.claimed++;
    const row = claimed as Row;
    const results: Record<string, DestResult> = { ...(row.results ?? {}) };

    if (!(await businessOpen(row.business_id))) {
      const at = new Date().toISOString();
      for (const d of row.destinations ?? []) {
        const prev = results[d.accountId] ?? { state: 'waiting' as DestState };
        if (!TERMINAL.includes(prev.state)) results[d.accountId] = { ...prev, state: 'failed', error: LOCKED_REASON, at };
      }
      await db.from('scheduled_posts').update({
        results, status: 'cancelled', cancel_reason: LOCKED_REASON, last_run_at: at, locked_until: null,
      }).eq('id', row.id);
      console.log(`[publish] ${row.id} cancelled: ${LOCKED_REASON}`);
      summary.cancelled++;
      continue;
    }

    const { data: media } = await db.from('media').select('url, kind').eq('id', row.media_id).eq('business_id', row.business_id).maybeSingle();
    const late = Date.now() - new Date(row.run_at).getTime() > EXPIRE_MS;
    for (const d of row.destinations ?? []) {
      const prev = results[d.accountId] ?? { state: 'waiting' as DestState };
      if (TERMINAL.includes(prev.state)) continue; // never sent twice
      if (late && prev.state === 'waiting') {
        results[d.accountId] = { ...prev, state: 'failed', error: 'לא פורסם — עברו יותר מ-24 שעות מהזמן שנקבע', at: new Date().toISOString() };
        continue;
      }
      results[d.accountId] = media
        ? await publishOne(row, d, media as { url: string; kind: string }, prev)
        : { state: 'failed', error: 'הקובץ נמחק מהספרייה', at: new Date().toISOString() };
      const res = results[d.accountId];
      console.log(`[publish] ${row.id} ${d.provider}${d.target ? `/${d.target}` : ''} ${d.accountId.slice(0, 8)} → ${res.state}${res.error ? `: ${res.error}` : ''}`);
    }
    const status = overall(row.destinations ?? [], results);
    await db.from('scheduled_posts').update({
      results, status, attempts: (row.attempts ?? 0) + 1, last_run_at: new Date().toISOString(), locked_until: null,
    }).eq('id', row.id);
    if (row.content_id && (status === 'done' || status === 'partial')) {
      await db.from('content').update({ status: 'published' }).eq('id', row.content_id).eq('business_id', row.business_id);
    }
    summary[status as 'done' | 'partial' | 'failed' | 'publishing']++;
  }
  return summary;
}
