import { adminDb } from './admin';
import { open } from './secrets';
import { businessOpen } from './business';
import { igMediaWithComments, linkedInstagram, pageConversations, pagePostsWithComments } from './meta';
import { isLeadsPermissionError } from '@/features/crm/meta-leads';
import {
  INBOX_STAGE, INBOX_TAG, SOCIAL_SOURCE, contactKey, contactsToCreate, conversationItems, fallbackName, fbCommentItems,
  igCommentItems, sourceOf, type InboxItem,
} from '@/features/crm/meta-inbox';

/**
 * Comments and messages from Meta → the business's leads board (every 10 minutes, and "סנכרון עכשיו").
 * A switched-on Facebook Page brings its comments, its Messenger conversations and — when an Instagram
 * account is linked to it — Instagram Direct; a switched-on Instagram account brings its comments.
 * Everything lands in the account's business (business_id set explicitly). A locked business is skipped.
 * Nothing is stored twice (unique business + channel + Meta id); a person is one contact ('פנייה' column).
 */
const FIRST_SYNC_DAYS = 30;
const OVERLAP_MS = 10 * 60_000;
export const RECONNECT_FOR_INBOX = 'צריך לחבר מחדש את Meta עם הרשאות התגובות וההודעות';

type AccountRow = { id: string; provider: 'facebook' | 'instagram'; external_id: string; access_token: string; business_id: string; user_id: string; display_name: string | null };
export type InboxResult = { accountId: string; account: string; stored: number; contacts: number; error?: string };

async function ownerOf(businessId: string, fallback: string) {
  const { data } = await adminDb().from('business_members').select('user_id, role').eq('business_id', businessId);
  const rows = (data ?? []) as { user_id: string; role: string }[];
  return (rows.find((r) => r.role === 'owner') ?? rows[0])?.user_id ?? fallback;
}

/** Reads one account's new comments / messages (pure parsing in features/crm/meta-inbox). Exported for tests.
 *  Each channel is read on its own: one refused channel (say Messenger) never blocks the others —
 *  its error is reported with the channel's name. */
export async function fetchItems(acc: AccountRow, sinceIso: string, deadline = Infinity): Promise<{ items: InboxItem[]; errors: string[]; partial: boolean }> {
  const token = open(acc.access_token);
  const sinceUnix = +new Date(sinceIso) / 1000;
  const items: InboxItem[] = []; const errors: string[] = [];
  const step = async (label: string, run: () => Promise<InboxItem[]>) => {
    try { items.push(...(await run())); }
    catch (e: any) { errors.push(`${label}: ${String(e?.message ?? e)}`); }
  };
  if (acc.provider === 'instagram') {
    await step('תגובות באינסטגרם', async () => igCommentItems(acc.external_id, acc.display_name ?? '', await igMediaWithComments(token, acc.external_id, sinceIso, deadline), sinceIso));
    return { items, errors, partial: Date.now() > deadline };
  }
  await step('תגובות בפייסבוק', async () => fbCommentItems(acc.external_id, await pagePostsWithComments(token, acc.external_id, Math.min(sinceUnix, Date.now() / 1000 - FIRST_SYNC_DAYS * 86400), deadline), sinceIso));
  await step('מסנג׳ר', async () => conversationItems('messenger', [acc.external_id], await pageConversations(token, acc.external_id, 'messenger', sinceIso, deadline), sinceIso));
  const ig = await linkedInstagram(token, acc.external_id).catch(() => null);
  if (ig) await step('הודעות אינסטגרם', async () => conversationItems('ig_dm', [ig.id, acc.external_id], await pageConversations(token, acc.external_id, 'instagram', sinceIso, deadline), sinceIso));
  return { items, errors, partial: Date.now() > deadline };
}

/** Stores a batch for one business: new messages only, one contact per new person. Exported for tests. */
export async function storeItems(businessId: string, owner: string, accountId: string, items: InboxItem[]) {
  const db = adminDb();
  const out = { stored: 0, contacts: 0 };
  if (!items.length) return out;

  const { data: have } = await db.from('social_messages').select('channel, external_id').eq('business_id', businessId)
    .in('external_id', items.map((i) => i.externalId));
  const seen = new Set(((have ?? []) as { channel: string; external_id: string }[]).map((h) => `${h.channel}|${h.external_id}`));
  const fresh = items.filter((i) => !seen.has(`${i.channel}|${i.externalId}`));
  if (!fresh.length) return out;

  // contacts: existing cards of these people, then a 'פנייה' card for each new person who wrote
  const keys = [...new Set(fresh.map((i) => contactKey(i.channel, i.contactId)))];
  const { data: leads } = await db.from('leads').select('id, external_id').eq('business_id', businessId).eq('external_source', SOCIAL_SOURCE).in('external_id', keys);
  const leadOf = new Map(((leads ?? []) as { id: string; external_id: string }[]).map((l) => [l.external_id, l.id]));
  for (const c of contactsToCreate(fresh, new Set(leadOf.keys()))) {
    const ins = await db.from('leads').insert({
      user_id: owner, business_id: businessId, name: (c.name || fallbackName(c.channel)).slice(0, 120), phone: '',
      source: sourceOf(c.channel), status: INBOX_STAGE, tags: [INBOX_TAG],
      external_source: SOCIAL_SOURCE, external_id: c.key, date: c.firstAt.slice(0, 10),
    }).select('id').single();
    if (ins.error) {
      if (ins.error.code !== '23505') throw new Error(`insert_contact: ${ins.error.message}`);
      const { data: again } = await db.from('leads').select('id').eq('business_id', businessId).eq('external_source', SOCIAL_SOURCE).eq('external_id', c.key).maybeSingle();
      if (again) leadOf.set(c.key, again.id);
      continue;
    }
    leadOf.set(c.key, ins.data.id); out.contacts++;
  }

  for (const i of fresh) {
    const ins = await db.from('social_messages').insert({
      business_id: businessId, social_account_id: accountId, lead_id: leadOf.get(contactKey(i.channel, i.contactId)) ?? null,
      channel: i.channel, external_id: i.externalId, thread_id: i.threadId, parent_id: i.parentId, post_url: i.postUrl,
      post_text: i.postText, author_id: i.authorId, author_name: i.authorName, direction: i.direction, body: i.body.slice(0, 4000), sent_at: i.sentAt,
      ...(i.direction === 'out' ? { read_at: i.sentAt } : {}),
    });
    if (ins.error) { if (ins.error.code === '23505') continue; throw new Error(`insert_message: ${ins.error.message}`); }
    out.stored++;
  }
  return out;
}

const friendly = (m: string) => (isLeadsPermissionError(m) || /reconnect_required/.test(m) ? RECONNECT_FOR_INBOX
  : m.replace(/\b[a-z_]+_\d+:\s*/gi, '').replace(/Please reduce the amount of data you're asking for, then retry your request/g, 'Meta ביקשה לקרוא פחות בבת אחת').slice(0, 300));

export async function syncAccount(acc: AccountRow, now = new Date(), deadline = Infinity): Promise<InboxResult> {
  const db = adminDb();
  const res: InboxResult = { accountId: acc.id, account: acc.display_name ?? acc.external_id, stored: 0, contacts: 0 };
  const { data: st } = await db.from('meta_inbox_sync').select('last_synced_at').eq('social_account_id', acc.id).maybeSingle();
  const since = new Date(st?.last_synced_at ? +new Date(st.last_synced_at) - OVERLAP_MS : +now - FIRST_SYNC_DAYS * 864e5).toISOString();
  const save = (patch: Record<string, unknown>) => db.from('meta_inbox_sync').upsert({ social_account_id: acc.id, business_id: acc.business_id, ...patch }, { onConflict: 'social_account_id' });
  try {
    const { items, errors, partial } = await fetchItems(acc, since, deadline);
    const r = await storeItems(acc.business_id, await ownerOf(acc.business_id, acc.user_id), acc.id, items);
    res.stored = r.stored; res.contacts = r.contacts;
    if (errors.length && !items.length) throw new Error(errors.join(' · '));
    // what worked is saved; a channel that failed is reported (and read again next time — the window does not move)
    if (errors.length) { res.error = friendly(errors.join(' · ')); await save({ last_error: res.error }); }
    // out of time: what was read is saved, and the next run reads the same window again (nothing is stored twice)
    else if (partial) await save({ last_error: '' });
    else await save({ last_synced_at: now.toISOString(), last_error: '' });
  } catch (e: any) {
    res.error = friendly(String(e?.message ?? e));
    await save({ last_error: res.error });
  }
  return res;
}

/** Accounts to read: switched on, assigned, connected — optionally of one business. */
export async function syncInbox(opts: { deadline: number; businessId?: string }) {
  const db = adminDb();
  let q = db.from('social_accounts').select('id, provider, external_id, access_token, business_id, user_id, display_name')
    .in('provider', ['facebook', 'instagram']).eq('inbox_enabled', true).eq('status', 'active').not('business_id', 'is', null);
  if (opts.businessId) q = q.eq('business_id', opts.businessId);
  const { data: accounts, error } = await q;
  if (error) throw new Error(error.message);
  const open_ = new Map<string, boolean>();
  const summary = { accounts: 0, stored: 0, contacts: 0, lockedSkipped: 0, errors: 0, results: [] as InboxResult[] };
  for (const a of (accounts ?? []) as AccountRow[]) {
    if (Date.now() > opts.deadline) break;
    if (!open_.has(a.business_id)) open_.set(a.business_id, await businessOpen(a.business_id));
    if (!open_.get(a.business_id)) { summary.lockedSkipped++; continue; }
    const r = await syncAccount(a, new Date(), opts.deadline);
    summary.accounts++; summary.stored += r.stored; summary.contacts += r.contacts;
    if (r.error) summary.errors++;
    summary.results.push(r);
  }
  return summary;
}


