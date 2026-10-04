/**
 * Comments and messages from Meta → the leads board ("פנייה" column). Pure (no database, no network).
 * Four channels: Facebook comments, Instagram comments, Messenger, Instagram Direct.
 * A person is ONE contact per business and platform: external_id 'fb:<id>' or 'ig:<id>'.
 */
export type Channel = 'fb_comment' | 'ig_comment' | 'messenger' | 'ig_dm';
export const SOCIAL_SOURCE = 'meta_social';
export const INBOX_STAGE = 'פנייה';
export const INBOX_TAG = 'תגובות';

export const CHANNEL_HE: Record<Channel, string> = {
  fb_comment: 'תגובה בפייסבוק', ig_comment: 'תגובה באינסטגרם', messenger: 'מסנג׳ר', ig_dm: 'הודעה באינסטגרם',
};
export const CHANNEL_ICON: Record<Channel, string> = { fb_comment: '👍', ig_comment: '📷', messenger: '💬', ig_dm: '✉️' };

export type InboxItem = {
  channel: Channel; externalId: string; threadId: string; parentId: string; postUrl: string; postText: string;
  authorId: string; authorName: string; direction: 'in' | 'out'; body: string; sentAt: string;
  /** the post's picture as Meta gives it (a temporary link — the server keeps a copy) */
  postImage?: string;
  /** the person this is about (for an outgoing message: the one it was sent to) */
  contactId: string; contactName: string;
};

const iso = (t?: string) => (t ? new Date(t).toISOString() : new Date().toISOString());
const short = (s: string | undefined, n = 120) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
export const platformOf = (c: Channel) => (c === 'fb_comment' || c === 'messenger' ? 'fb' : 'ig');
export const contactKey = (c: Channel, personId: string) => `${platformOf(c)}:${personId}`;

type FbComment = { id: string; message?: string; created_time?: string; from?: { id: string; name?: string }; parent?: { id: string } };
type FbPost = { id: string; message?: string; permalink_url?: string; full_picture?: string; comments?: { data?: FbComment[] } };

/** /{page}/posts with nested comments → items; the Page's own replies are 'out' and belong to the comment they answer */
export function fbCommentItems(pageId: string, posts: FbPost[], sinceIso: string): InboxItem[] {
  const out: InboxItem[] = [];
  for (const p of posts) {
    const comments = p.comments?.data ?? [];
    const byId = new Map(comments.map((c) => [c.id, c]));
    for (const c of comments) {
      if (!c.from?.id || iso(c.created_time) <= sinceIso) continue;
      const mine = c.from.id === pageId;
      const parent = c.parent?.id ? byId.get(c.parent.id) : undefined;
      const person = mine ? parent?.from : c.from;
      if (!person?.id || person.id === pageId) continue; // a Page talking to itself is nobody's conversation
      out.push({
        channel: 'fb_comment', externalId: c.id, threadId: p.id, parentId: c.parent?.id ?? '', postUrl: p.permalink_url ?? '', postImage: p.full_picture ?? '',
        postText: short(p.message), authorId: c.from.id, authorName: c.from.name ?? '', direction: mine ? 'out' : 'in',
        body: c.message ?? '', sentAt: iso(c.created_time), contactId: person.id, contactName: person.name ?? '',
      });
    }
  }
  return out;
}

type IgComment = { id: string; text?: string; timestamp?: string; username?: string; from?: { id: string; username?: string }; replies?: { data?: IgComment[] } };
type IgMedia = { id: string; caption?: string; permalink?: string; media_type?: string; media_url?: string; thumbnail_url?: string; comments?: { data?: IgComment[] } };

/** /{ig}/media with comments and replies → items; replies by the account itself are 'out' */
export function igCommentItems(igId: string, igUsername: string, media: IgMedia[], sinceIso: string): InboxItem[] {
  const out: InboxItem[] = [];
  const me = igUsername.replace(/^@/, '').toLowerCase();
  const push = (m: IgMedia, c: IgComment, parent?: IgComment) => {
    if (iso(c.timestamp) <= sinceIso) return;
    const who = c.from?.id ?? '', name = c.from?.username ?? c.username ?? '';
    const mine = who === igId || (me !== '' && name.toLowerCase() === me);
    const person = mine ? parent : c;
    const personId = person?.from?.id ?? '';
    if (!personId || personId === igId) return;
    out.push({
      channel: 'ig_comment', externalId: c.id, threadId: m.id, parentId: parent?.id ?? '', postUrl: m.permalink ?? '',
      postImage: (m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url) ?? m.thumbnail_url ?? '',
      postText: short(m.caption), authorId: who, authorName: name ? `@${name}` : '', direction: mine ? 'out' : 'in',
      body: c.text ?? '', sentAt: iso(c.timestamp), contactId: personId,
      contactName: (person?.from?.username ?? person?.username) ? `@${person?.from?.username ?? person?.username}` : '',
    });
  };
  for (const m of media) for (const c of m.comments?.data ?? []) {
    push(m, c);
    for (const r of c.replies?.data ?? []) push(m, r, c);
  }
  return out;
}

type ConvMessage = { id: string; message?: string; created_time?: string; from?: { id: string; name?: string; username?: string }; sticker?: string; attachments?: { data?: { mime_type?: string }[] } };

/** a message with no text: a picture, a file or a sticker — still part of the conversation */
const noTextBody = (m: ConvMessage) => {
  if (m.sticker) return '🙂 (מדבקה)';
  const t = m.attachments?.data?.[0]?.mime_type ?? '';
  if (!m.attachments?.data?.length) return '';
  return t.startsWith('image/') ? '🖼️ (תמונה)' : t.startsWith('video/') ? '🎬 (סרטון)' : t.startsWith('audio/') ? '🎤 (הקלטה)' : '📎 (קובץ)';
};
type Conversation = { id: string; updated_time?: string; participants?: { data?: { id: string; name?: string; username?: string }[] }; messages?: { data?: ConvMessage[] } };

/** /{page}/conversations (Messenger or Instagram) → items; the other participant is the contact */
export function conversationItems(channel: 'messenger' | 'ig_dm', selfIds: string[], convs: Conversation[], sinceIso: string): InboxItem[] {
  const out: InboxItem[] = [];
  const self = new Set(selfIds.filter(Boolean));
  for (const cv of convs) {
    const msgs = cv.messages?.data ?? [];
    const other = (cv.participants?.data ?? []).find((p) => !self.has(p.id))
      ?? msgs.map((m) => m.from).find((f) => f?.id && !self.has(f.id));
    if (!other?.id) continue;
    const otherName = other.name ?? (other.username ? `@${other.username}` : '');
    for (const m of msgs) {
      const body = m.message || noTextBody(m);
      if (!m.from?.id || iso(m.created_time) <= sinceIso || !body) continue;
      const mine = self.has(m.from.id);
      out.push({
        channel, externalId: m.id, threadId: cv.id, parentId: '', postUrl: '', postText: '',
        authorId: m.from.id, authorName: m.from.name ?? (m.from.username ? `@${m.from.username}` : ''), direction: mine ? 'out' : 'in',
        body, sentAt: iso(m.created_time), contactId: other.id, contactName: otherName,
      });
    }
  }
  return out;
}

/** words that alone are only a compliment or a greeting, not an enquiry ("מהממתתת 😍", "תותחית על", "שנה טובה") */
const PRAISE_WORDS = ['מהמם', 'מהממת', 'מהממים', 'וואו', 'יפה', 'יפהפה', 'יפיפה', 'מדהים', 'מדהימה', 'מושלם', 'מושלמת', 'אהבתי', 'אהובה',
  'תותחית', 'תותח', 'על', 'אלופה', 'אלוף', 'אליפות', 'שלי', 'כל', 'הכבוד', 'מספר', 'אחת', 'אחד', 'בהצלחה', 'הצלחה', 'שנה', 'טובה', 'חג', 'שמח',
  'חיים', 'מטורף', 'מטורפת', 'וואי', 'wow', 'nice', 'amazing', 'beautiful', 'love', 'it', 'perfect', 'gorgeous', 'cute', 'queen'];
/** "מהממתתתת" = "מהממת": letters repeated for emphasis are collapsed, on both sides */
const squeeze = (w: string) => w.replace(/(.)\1+/gu, '$1');
const PRAISE = new Set(PRAISE_WORDS.map(squeeze));

/**
 * A comment or message that is not an enquiry: only emojis / punctuation, only tagging friends ("@noa @dana"),
 * or only praise / a greeting. It is still stored, but does not open a card in "💬 תגובות".
 */
export function isNoise(_channel: Channel, body: string): boolean {
  const words = body.replace(/@[\w.]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => /^\d$/.test(w) || w.length < 2 || PRAISE.has(squeeze(w)));
}

/**
 * Which contacts to create: one per person who WROTE something new and relevant and has no card yet in this business.
 * A person who only got a reply from the business, or only wrote noise (emojis, tags, praise), is not a new contact.
 */
export function contactsToCreate(items: InboxItem[], existingKeys: Set<string>): { key: string; channel: Channel; name: string; firstAt: string }[] {
  const want = new Map<string, { key: string; channel: Channel; name: string; firstAt: string }>();
  for (const it of items) {
    if (it.direction !== 'in' || isNoise(it.channel, it.body)) continue;
    const key = contactKey(it.channel, it.contactId);
    if (existingKeys.has(key)) continue;
    const cur = want.get(key);
    if (!cur || it.sentAt < cur.firstAt) want.set(key, { key, channel: it.channel, name: it.contactName || cur?.name || '', firstAt: it.sentAt });
  }
  return [...want.values()];
}

export const sourceOf = (c: Channel) => ({ fb_comment: 'Facebook · תגובה', ig_comment: 'Instagram · תגובה', messenger: 'Messenger', ig_dm: 'Instagram · הודעה' }[c]);
export const fallbackName = (c: Channel) => (platformOf(c) === 'fb' ? 'משתמש/ת פייסבוק' : 'משתמש/ת אינסטגרם');

/** "על הפוסט: …" — the post a comment was written on, shortened, with its link */
const onPost = (it: InboxItem) => (it.postText || it.postUrl ? ` על הפוסט: "${it.postText.slice(0, 80)}${it.postText.length > 80 ? '…' : ''}"${it.postUrl ? ` (${it.postUrl})` : ''}` : '');

/** The card's "הערות": how this person came in and how the conversation started (their first message). */
export function introNote(first: InboxItem): string {
  return [`נכנס/ה דרך: ${CHANNEL_HE[first.channel]}${onPost(first)}`, `כתב/ה: ${first.body}`].join('\n');
}

/** One history entry per comment / message — theirs and the business's replies — in time order on the card. */
export function historyEntry(it: InboxItem): string {
  if (it.direction === 'out') return `↩️ תשובה של העסק (${CHANNEL_HE[it.channel]}):\n${it.body}`;
  return `${CHANNEL_ICON[it.channel]} ${CHANNEL_HE[it.channel]}${onPost(it)}:\n${it.body}`;
}

/** which inbox channel a contact came from, by its source ("Messenger", "Facebook · תגובה", "Instagram · תגובה") */
export function channelOfSource(source: string | undefined): 'messenger' | 'fb' | 'ig' | null {
  if (!source) return null;
  if (source === sourceOf('messenger')) return 'messenger';
  if (source === sourceOf('fb_comment')) return 'fb';
  if (source === sourceOf('ig_comment')) return 'ig';
  return null;
}
/** where a contact came from, for the filter row: a paid lead (Meta Lead Ads form) or one of the inbox channels */
export function channelOf(l: { source?: string; tags?: string[] }): 'leads' | 'messenger' | 'fb' | 'ig' | null {
  if ((l.source ?? '').startsWith('Meta · ') || (l.tags ?? []).includes('ליד ממומן')) return 'leads';
  return channelOfSource(l.source);
}
export const INBOX_FILTERS = [
  { id: 'leads', label: '💰 לידים' },
  { id: 'messenger', label: '💬 מסנג׳ר' }, { id: 'fb', label: '👍 תגובות בפייסבוק' }, { id: 'ig', label: '📷 תגובות באינסטגרם' },
] as const;
