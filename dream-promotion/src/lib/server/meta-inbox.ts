import { adminDb } from './admin';
import { open } from './secrets';
import { businessOpen } from './business';
import { igMediaWithComments, keepPostImage, pageConversations, pagePostsWithComments, replyToComment, sendMessengerText } from './meta';
import { isLeadsPermissionError } from '@/features/crm/meta-leads';
import {
  INBOX_STAGE, INBOX_TAG, SOCIAL_SOURCE, contactKey, contactsToCreate, conversationItems, fallbackName, fbCommentItems,
  historyEntry, igCommentItems, introNote, isNoise, sourceOf, type InboxItem,
} from '@/features/crm/meta-inbox';

/**
 * Comments and messages from Meta → the business's leads board (every 10 minutes, and "סנכרון עכשיו").
 * A switched-on Facebook Page brings its post comments and its Messenger conversations; a switched-on
 * Instagram account brings its comments. (Instagram Direct is not read — a chat, not an enquiry.)
 * Everything lands in the account's business (business_id set explicitly). A locked business is skipped.
 * Nothing is stored twice (unique business + channel + Meta id); a person is one contact ('פנייה' column).
 */
const FIRST_SYNC_DAYS = 30;
/** a conversation with something new is stored with its recent thread (Meta's latest ~25 messages, at
 *  least a week back) — the card shows how the conversation went, not only the newest line */
const HISTORY_FROM = () => '1970-01-01T00:00:00.000Z';
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
  await step('מסנג׳ר', async () => conversationItems('messenger', [acc.external_id], await pageConversations(token, acc.external_id, 'messenger', sinceIso, deadline), HISTORY_FROM()));
  // Instagram Direct is deliberately not read: it is a chat, not an enquiry (business decision, 4.10.2026)
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
  const imageOf = await postImages(businessId, owner, items);
  if (!fresh.length) return out;

  // contacts: existing cards of these people, then a 'פנייה' card for each new person who wrote
  const keys = [...new Set(fresh.map((i) => contactKey(i.channel, i.contactId)))];
  const { data: leads } = await db.from('leads').select('id, external_id').eq('business_id', businessId).eq('external_source', SOCIAL_SOURCE).in('external_id', keys);
  const leadOf = new Map(((leads ?? []) as { id: string; external_id: string }[]).map((l) => [l.external_id, l.id]));
  const firstIn = (key: string) => fresh.filter((i) => i.direction === 'in' && !isNoise(i.channel, i.body) && contactKey(i.channel, i.contactId) === key)
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt))[0];
  for (const c of contactsToCreate(fresh, new Set(leadOf.keys()))) {
    const first = firstIn(c.key);
    const ins = await db.from('leads').insert({
      user_id: owner, business_id: businessId, name: (c.name || fallbackName(c.channel)).slice(0, 120), phone: '',
      notes: first ? introNote(first) : '',
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
      post_text: i.postText, post_image: imageOf.get(i.threadId) ?? '', author_id: i.authorId, author_name: i.authorName, direction: i.direction, body: i.body.slice(0, 4000), sent_at: i.sentAt,
      ...(i.direction === 'out' ? { read_at: i.sentAt } : {}),
    });
    if (ins.error) { if (ins.error.code === '23505') continue; throw new Error(`insert_message: ${ins.error.message}`); }
    out.stored++;
    // the conversation on the card's history, in time order (written once — with the message itself)
    const leadId = leadOf.get(contactKey(i.channel, i.contactId));
    if (leadId) {
      await db.from('lead_activities').insert({
        user_id: owner, business_id: businessId, lead_id: leadId, kind: 'note', body: historyEntry(i).slice(0, 4000), created_at: i.sentAt,
      });
    }
  }
  return out;
}

/**
 * The picture of each post that was commented on: copied once into storage and remembered on its messages
 * (also filled in on messages stored before pictures were kept). Never stops the sync — no picture is fine.
 */
async function postImages(businessId: string, owner: string, items: InboxItem[]) {
  const db = adminDb();
  const want = new Map<string, string>();
  for (const i of items) if (i.postImage && !want.has(i.threadId)) want.set(i.threadId, i.postImage);
  const out = new Map<string, string>();
  if (!want.size) return out;
  const { data: have } = await db.from('social_messages').select('thread_id, post_image').eq('business_id', businessId)
    .in('thread_id', [...want.keys()]).neq('post_image', '');
  for (const h of (have ?? []) as { thread_id: string; post_image: string }[]) out.set(h.thread_id, h.post_image);
  for (const [thread, url] of want) {
    if (out.has(thread)) continue;
    const kept = await keepPostImage(owner, thread, url);
    if (!kept) continue;
    out.set(thread, kept);
    await db.from('social_messages').update({ post_image: kept }).eq('business_id', businessId).eq('thread_id', thread).eq('post_image', '');
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



export const REPLY_WINDOW_MS = 24 * 3600 * 1000;
export type ReplyResult = { ok: true } | { ok: false; status: number; message: string };

/**
 * Answers a contact from the card, on the channel they last wrote on: Messenger → a message (Meta allows
 * it within 24 hours of their last message); a comment → a public reply under that comment. The reply is
 * stored like any message (conversation + card history). Only within the business being worked in.
 */
export async function sendReply(businessId: string, userId: string, leadId: string, text: string, now = Date.now()): Promise<ReplyResult> {
  const db = adminDb();
  const body = text.trim().slice(0, 2000);
  if (!body) return { ok: false, status: 400, message: 'נא לכתוב תשובה' };
  const { data: last } = await db.from('social_messages').select('*').eq('business_id', businessId).eq('lead_id', leadId)
    .eq('direction', 'in').order('sent_at', { ascending: false }).limit(1).maybeSingle();
  if (!last) return { ok: false, status: 404, message: 'אין הודעה או תגובה של איש הקשר הזה לענות עליה' };
  const { data: acc } = await db.from('social_accounts').select('id, provider, external_id, access_token, status').eq('id', last.social_account_id).eq('business_id', businessId).maybeSingle();
  if (!acc || acc.status !== 'active') return { ok: false, status: 409, message: 'החשבון נותק מהחיבור ל-Meta — צריך חיבור מחדש במסך הניהול' };
  if (last.channel === 'messenger' && now - +new Date(last.sent_at) > REPLY_WINDOW_MS) {
    return { ok: false, status: 409, message: 'עברו יותר מ-24 שעות מההודעה האחרונה שלו/ה — Meta מאפשרת לענות במסנג׳ר רק כשהלקוח כותב שוב. אפשר להתקשר או לשלוח וואטסאפ.' };
  }
  let externalId: string;
  try {
    const token = open(acc.access_token);
    externalId = last.channel === 'messenger'
      ? await sendMessengerText(token, acc.external_id, last.author_id, body)
      : await replyToComment(token, last.external_id, body, last.channel === 'ig_comment' ? 'instagram' : 'facebook');
  } catch (e: any) {
    const m = String(e?.message ?? e);
    if (last.channel === 'fb_comment' && isLeadsPermissionError(m)) return { ok: false, status: 403, message: 'כדי לענות לתגובות בפייסבוק צריך להוסיף ב-Meta את ההרשאה pages_manage_engagement ולחבר מחדש' };
    if (isLeadsPermissionError(m) || /reconnect_required/.test(m)) return { ok: false, status: 403, message: RECONNECT_FOR_INBOX };
    return { ok: false, status: 502, message: `Meta לא קיבלה את התשובה: ${m.replace(/^[a-z_0-9]+:\s*/i, '').slice(0, 200)}` };
  }
  const sentAt = new Date(now).toISOString();
  const item: InboxItem = {
    channel: last.channel, externalId: externalId || `sent-${now}`, threadId: last.thread_id, parentId: last.channel === 'messenger' ? '' : last.external_id,
    postUrl: last.post_url, postText: last.post_text, authorId: acc.external_id, authorName: '', direction: 'out', body, sentAt,
    contactId: last.author_id, contactName: '',
  };
  await db.from('social_messages').insert({
    business_id: businessId, social_account_id: acc.id, lead_id: leadId, channel: item.channel, external_id: item.externalId,
    thread_id: item.threadId, parent_id: item.parentId, post_url: item.postUrl, post_text: item.postText, author_id: item.authorId,
    direction: 'out', body, sent_at: sentAt, read_at: sentAt,
  });
  await db.from('lead_activities').insert({ user_id: userId, business_id: businessId, lead_id: leadId, kind: 'note', body: historyEntry(item), created_at: sentAt });
  await db.from('leads').update({ last_contact_at: sentAt }).eq('id', leadId).eq('business_id', businessId);
  return { ok: true };
}
