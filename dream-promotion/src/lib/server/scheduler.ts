import { adminDb } from './admin';
import { createIgContainer, igContainerStep, metaAccount, publishToPage, type IgTarget } from './meta';
import { accessTokenFor, uploadToInbox } from './tiktok';
import { safeFetch } from './safe-fetch';

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
 */
export type Destination = { accountId: string; provider: 'facebook' | 'instagram' | 'tiktok'; target?: 'feed' | 'story'; coverMs?: number };
export type DestState = 'waiting' | 'processing' | 'published' | 'sent_to_drafts' | 'failed';
export type DestResult = { state: DestState; containerId?: string; externalId?: string; error?: string; at?: string };

const TERMINAL: DestState[] = ['published', 'sent_to_drafts', 'failed'];
const GIVE_UP_MS = 2 * 3600 * 1000; // Instagram still processing two hours after the time → failed

type Row = {
  id: string; user_id: string; content_id: string | null; media_id: string; caption: string;
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
        user_id: row.user_id, account_id: d.accountId, provider: 'tiktok', content_id: row.content_id,
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
    return { ...prev, state: 'failed', error: String(e?.message ?? e).slice(0, 300), at };
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

  const summary = { claimed: 0, done: 0, partial: 0, failed: 0, publishing: 0 };
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

    const { data: media } = await db.from('media').select('url, kind').eq('id', row.media_id).eq('user_id', row.user_id).maybeSingle();
    for (const d of row.destinations ?? []) {
      const prev = results[d.accountId] ?? { state: 'waiting' as DestState };
      if (TERMINAL.includes(prev.state)) continue; // never sent twice
      results[d.accountId] = media
        ? await publishOne(row, d, media as { url: string; kind: string }, prev)
        : { state: 'failed', error: 'הקובץ נמחק מהספרייה', at: new Date().toISOString() };
    }
    const status = overall(row.destinations ?? [], results);
    await db.from('scheduled_posts').update({
      results, status, attempts: (row.attempts ?? 0) + 1, last_run_at: new Date().toISOString(), locked_until: null,
    }).eq('id', row.id);
    if (row.content_id && (status === 'done' || status === 'partial')) {
      await db.from('content').update({ status: 'published' }).eq('id', row.content_id).eq('user_id', row.user_id);
    }
    summary[status as 'done' | 'partial' | 'failed' | 'publishing']++;
  }
  return summary;
}
