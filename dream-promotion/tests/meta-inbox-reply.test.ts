/**
 * Answering from the card: Messenger inside the 24 hours, refused after; an Instagram comment answered under it;
 * a Facebook comment without the permission → a clear message; the answer lands in the card's history.
 * Also: a Messenger conversation is stored with its earlier messages, and the channel filter of the board.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';
import { channelOfSource, contactsToCreate, conversationItems, fbCommentItems, igCommentItems, isNoise } from '../src/features/crm/meta-inbox';

process.env.TOKEN_ENCRYPTION_KEY = 'test-key-for-meta-inbox-reply';
const SG = 'biz-sg', FM = 'biz-fm';
const NOW = Date.parse('2026-10-04T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600e3).toISOString();

const tables: Record<string, any[]> = {
  businesses: [{ id: SG, status: 'active', paid_until: null, grace_days: 0 }],
  business_members: [{ business_id: SG, user_id: 'sagit', role: 'owner' }],
  social_accounts: [], social_messages: [], lead_activities: [],
  leads: [
    { id: 'L-msg', business_id: SG, name: 'רון', source: 'Messenger' },
    { id: 'L-old', business_id: SG, name: 'מיכל', source: 'Messenger' },
    { id: 'L-ig', business_id: SG, name: '@noa', source: 'Instagram · תגובה' },
    { id: 'L-fb', business_id: SG, name: 'דנה', source: 'Facebook · תגובה' },
  ],
};
const msg = (lead: string, channel: string, external: string, author: string, sentAt: string, extra: Record<string, unknown> = {}) => ({
  id: `sm-${external}`, business_id: SG, social_account_id: 'acc-sg', lead_id: lead, channel, external_id: external,
  thread_id: 't', parent_id: '', post_url: '', post_text: '', author_id: author, direction: 'in', body: 'היי', sent_at: sentAt, ...extra,
});

const posts: { path: string; body: Record<string, string> }[] = [];
before(async () => {
  const { seal } = await import('../src/lib/server/secrets');
  tables.social_accounts.push({ id: 'acc-sg', provider: 'facebook', external_id: 'page-sg', business_id: SG, status: 'active', access_token: seal('tok') });
  tables.social_messages.push(
    msg('L-msg', 'messenger', 'mm1', 'psid-9', hoursAgo(2)),
    msg('L-old', 'messenger', 'mm2', 'psid-7', hoursAgo(30)),
    msg('L-ig', 'ig_comment', 'k1', 'igu1', hoursAgo(50), { post_text: 'לפני ואחרי' }),
    msg('L-fb', 'fb_comment', 'c1', 'u1', hoursAgo(1)),
  );
  (globalThis as any).__DP_TEST_ADMIN_DB__ = fakeDb(tables);
  globalThis.fetch = (async (u: any, init?: RequestInit) => {
    const path = new URL(String(u)).pathname.replace(/^\/v[\d.]+/, '');
    posts.push({ path, body: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))) });
    if (path === '/c1/comments') return new Response(JSON.stringify({ error: { code: 200, message: '(#200) Permissions error' } }), { status: 403 });
    if (path === '/page-sg/messages') return new Response(JSON.stringify({ recipient_id: 'psid-9', message_id: 'm_out1' }), { status: 200 });
    return new Response(JSON.stringify({ id: 'reply-1' }), { status: 200 });
  }) as any;
});

test('Messenger within 24 hours: sent to the person, stored as "out" and written in the history', async () => {
  const { sendReply } = await import('../src/lib/server/meta-inbox');
  const r = await sendReply(SG, 'sagit', 'L-msg', '  בטח, מחר ב-10?  ', NOW);
  assert.deepEqual(r, { ok: true });
  const sent = posts.find((p) => p.path === '/page-sg/messages')!;
  assert.equal(JSON.parse(sent.body.recipient).id, 'psid-9');
  assert.equal(JSON.parse(sent.body.message).text, 'בטח, מחר ב-10?');
  const out = tables.social_messages.find((m) => m.external_id === 'm_out1');
  assert.deepEqual([out.direction, out.lead_id, out.business_id, out.channel], ['out', 'L-msg', SG, 'messenger']);
  const h = tables.lead_activities.filter((a) => a.lead_id === 'L-msg');
  assert.equal(h.length, 1);
  assert.match(h[0].body, /↩️ תשובה של העסק \(מסנג׳ר\):\nבטח, מחר ב-10\?/);
  assert.equal(h[0].business_id, SG);
  assert.equal(tables.leads.find((l) => l.id === 'L-msg').last_contact_at, new Date(NOW).toISOString());
});

test('Messenger after 24 hours: refused with an explanation, nothing sent', async () => {
  const { sendReply } = await import('../src/lib/server/meta-inbox');
  const before = posts.length;
  const r = await sendReply(SG, 'sagit', 'L-old', 'היי', NOW);
  assert.equal(r.ok, false);
  assert.match((r as any).message, /24 שעות/);
  assert.equal(posts.length, before, 'Meta was not even asked');
});

test('Instagram comment: answered under the comment (no 24-hour limit)', async () => {
  const { sendReply } = await import('../src/lib/server/meta-inbox');
  const r = await sendReply(SG, 'sagit', 'L-ig', 'תודה 💜', NOW);
  assert.deepEqual(r, { ok: true });
  assert.ok(posts.some((p) => p.path === '/k1/replies' && p.body.message === 'תודה 💜'));
  const out = tables.social_messages.find((m) => m.lead_id === 'L-ig' && m.direction === 'out');
  assert.equal(out.parent_id, 'k1');
});

test('Facebook comment without the permission: the clear message, nothing stored', async () => {
  const { sendReply } = await import('../src/lib/server/meta-inbox');
  const r = await sendReply(SG, 'sagit', 'L-fb', 'שלחנו לך הודעה', NOW);
  assert.equal(r.ok, false);
  assert.match((r as any).message, /pages_manage_engagement/);
  assert.ok(!tables.social_messages.some((m) => m.lead_id === 'L-fb' && m.direction === 'out'));
});

test('another business cannot answer this business\'s contact', async () => {
  const { sendReply } = await import('../src/lib/server/meta-inbox');
  const r = await sendReply(FM, 'aviv', 'L-ig', 'היי', NOW);
  assert.equal(r.ok, false);
});

test('a Messenger conversation keeps its earlier messages (the whole recent thread)', () => {
  const items = conversationItems('messenger', ['page-1'], [{ id: 't1', participants: { data: [{ id: 'page-1' }, { id: 'psid-9', name: 'רון' }] }, messages: { data: [
    { id: 'new', message: 'אפשר תור?', created_time: '2026-10-04T10:00:00+0000', from: { id: 'psid-9' } },
    { id: 'old-out', message: 'שמחים לעזור', created_time: '2026-09-28T09:00:00+0000', from: { id: 'page-1' } },
    { id: 'old-in', message: 'שלום', created_time: '2026-09-28T08:00:00+0000', from: { id: 'psid-9' } },
  ] } }], '1970-01-01T00:00:00.000Z');
  assert.deepEqual(items.map((i) => [i.externalId, i.direction]), [['new', 'in'], ['old-out', 'out'], ['old-in', 'in']]);
});

test('the board\'s channel filter: Messenger / Facebook comments / Instagram comments', () => {
  assert.equal(channelOfSource('Messenger'), 'messenger');
  assert.equal(channelOfSource('Facebook · תגובה'), 'fb');
  assert.equal(channelOfSource('Instagram · תגובה'), 'ig');
  assert.equal(channelOfSource('Meta · טופס גבות'), null);
  assert.equal(channelOfSource(undefined), null);
});

test('irrelevant comments (emojis, tagging friends, only praise) do not open a card; questions and Messenger do', () => {
  for (const b of ['😍😍', '🔥🔥🔥🔥', '@noa @dana', 'מהמם!!', 'וואווו 🔥', 'Wow amazing', 'כל הכבוד ❤️', '', 'תותחית על🪬🩷🪬', '👏👏👏 אליפות', 'מספר אחת !!!☝️', 'שנה טובה מהמממתתתת', 'חיים ב♥️']) assert.equal(isNoise('ig_comment', b), true, b);
  for (const b of ['כמה עולה?', '@noa תראי, בא לי', 'מהמם, יש תור לשבוע הבא?', 'מחיר']) assert.equal(isNoise('fb_comment', b), false, b);
  assert.equal(isNoise('messenger', 'כמה עולה לעשות גבות?'), false);
  const base = { threadId: '', parentId: '', postUrl: '', postText: '', authorId: '', authorName: '', contactName: '', direction: 'in' as const, sentAt: '2026-10-04T10:00:00Z' };
  const plan = contactsToCreate([
    { ...base, channel: 'ig_comment', externalId: '1', body: '😍', contactId: 'fan' },
    { ...base, channel: 'ig_comment', externalId: '2', body: 'כמה עולה?', contactId: 'buyer' },
  ], new Set());
  assert.deepEqual(plan.map((p) => p.key), ['ig:buyer']);
});

test('the post\'s picture comes with each comment (Facebook: full_picture, Instagram: the image or the video\'s cover)', () => {
  const fb = fbCommentItems('page-1', [{ id: 'p', full_picture: 'https://cdn/fb.jpg', comments: { data: [{ id: 'c', message: 'כמה?', created_time: '2026-10-04T10:00:00Z', from: { id: 'u' } }] } }], '1970-01-01T00:00:00Z');
  assert.equal(fb[0].postImage, 'https://cdn/fb.jpg');
  const ig = igCommentItems('ig-1', '', [
    { id: 'm1', media_type: 'IMAGE', media_url: 'https://cdn/img.jpg', comments: { data: [{ id: 'k1', text: 'מחיר?', timestamp: '2026-10-04T10:00:00Z', from: { id: 'x', username: 'x' } }] } },
    { id: 'm2', media_type: 'VIDEO', media_url: 'https://cdn/v.mp4', thumbnail_url: 'https://cdn/v.jpg', comments: { data: [{ id: 'k2', text: 'מחיר?', timestamp: '2026-10-04T10:00:00Z', from: { id: 'y', username: 'y' } }] } },
  ], '1970-01-01T00:00:00Z');
  assert.deepEqual(ig.map((i) => i.postImage), ['https://cdn/img.jpg', 'https://cdn/v.jpg']);
});

test('Messenger: a picture or a sticker with no text is still part of the conversation', () => {
  const items = conversationItems('messenger', ['page-1'], [{ id: 't', participants: { data: [{ id: 'page-1' }, { id: 'p' }] }, messages: { data: [
    { id: 'a', created_time: '2026-07-07T06:19:00Z', from: { id: 'p' }, attachments: { data: [{ mime_type: 'image/jpeg' }] } },
    { id: 'b', created_time: '2026-07-08T23:38:00Z', from: { id: 'p' }, sticker: 'https://sticker' },
    { id: 'c', created_time: '2026-07-09T10:00:00Z', from: { id: 'p' } },
  ] } }], '1970-01-01T00:00:00Z');
  assert.deepEqual(items.map((i) => i.body), ['🖼️ (תמונה)', '🙂 (מדבקה)']);
});
