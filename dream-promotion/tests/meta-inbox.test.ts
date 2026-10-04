/**
 * Comments and messages from Meta → the "💬 תגובות" column of the leads board.
 * Parsing of the four channels, one contact per person, nothing stored twice, business isolation,
 * a locked business skipped, and a missing permission shown clearly.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';
import { contactsToCreate, conversationItems, fbCommentItems, igCommentItems } from '../src/features/crm/meta-inbox';

process.env.TOKEN_ENCRYPTION_KEY = 'test-key-for-meta-inbox';
const OLD = '2026-01-01T00:00:00.000Z';

test('Facebook comments: the Page\'s own reply is "out" and belongs to the person it answered', () => {
  const items = fbCommentItems('page-1', [{ id: 'post-1', message: 'מבצע מיקרובליידינג', permalink_url: 'https://fb/p1', comments: { data: [
    { id: 'c1', message: 'כמה עולה?', created_time: '2026-10-04T10:00:00+0000', from: { id: 'u1', name: 'דנה' } },
    { id: 'c2', message: 'שלחנו לך הודעה 💜', created_time: '2026-10-04T10:05:00+0000', from: { id: 'page-1', name: 'SaGabot' }, parent: { id: 'c1' } },
    { id: 'c0', message: 'ישן', created_time: '2025-12-01T10:00:00+0000', from: { id: 'u2', name: 'ישן' } },
  ] } }], OLD);
  assert.deepEqual(items.map((i) => [i.externalId, i.direction, i.contactId, i.contactName]), [['c1', 'in', 'u1', 'דנה'], ['c2', 'out', 'u1', 'דנה']]);
  assert.equal(items[0].postText, 'מבצע מיקרובליידינג');
  assert.equal(items[0].postUrl, 'https://fb/p1');
});

test('Instagram comments and replies: the account\'s reply is "out"', () => {
  const items = igCommentItems('ig-1', '@sagit_sagabot', [{ id: 'm1', caption: 'לפני ואחרי', permalink: 'https://ig/m1', comments: { data: [
    { id: 'k1', text: 'מהמם!', timestamp: '2026-10-04T10:00:00+0000', from: { id: 'igu1', username: 'noa' }, replies: { data: [
      { id: 'k2', text: 'תודה 💜', timestamp: '2026-10-04T10:01:00+0000', from: { id: 'ig-1', username: 'sagit_sagabot' } },
    ] } },
  ] } }], OLD);
  assert.deepEqual(items.map((i) => [i.externalId, i.direction, i.contactId, i.contactName]), [['k1', 'in', 'igu1', '@noa'], ['k2', 'out', 'igu1', '@noa']]);
});

test('Messenger / Instagram Direct: the other participant is the contact, both directions kept', () => {
  const items = conversationItems('messenger', ['page-1'], [{ id: 't1', participants: { data: [{ id: 'page-1', name: 'SaGabot' }, { id: 'psid-9', name: 'רון' }] }, messages: { data: [
    { id: 'mm2', message: 'בטח, מתי נוח?', created_time: '2026-10-04T10:02:00+0000', from: { id: 'page-1' } },
    { id: 'mm1', message: 'אפשר תור?', created_time: '2026-10-04T10:00:00+0000', from: { id: 'psid-9', name: 'רון' } },
  ] } }], OLD);
  assert.deepEqual(items.map((i) => [i.externalId, i.direction, i.contactId]), [['mm2', 'out', 'psid-9'], ['mm1', 'in', 'psid-9']]);
});

test('contacts: one per person who wrote; a person with a card is not created again', () => {
  const base = { threadId: '', parentId: '', postUrl: '', postText: '', authorId: '', authorName: '', body: 'כמה עולה?', contactName: 'דנה' };
  const items = [
    { ...base, channel: 'fb_comment' as const, externalId: '1', direction: 'in' as const, sentAt: '2026-10-04T10:00:00Z', contactId: 'u1' },
    { ...base, channel: 'messenger' as const, externalId: '2', direction: 'in' as const, sentAt: '2026-10-04T09:00:00Z', contactId: 'u1' },
    { ...base, channel: 'ig_comment' as const, externalId: '3', direction: 'in' as const, sentAt: '2026-10-04T10:00:00Z', contactId: 'x' },
    { ...base, channel: 'fb_comment' as const, externalId: '4', direction: 'out' as const, sentAt: '2026-10-04T10:00:00Z', contactId: 'only-answered' },
  ];
  const plan = contactsToCreate(items, new Set(['ig:x']));
  assert.deepEqual(plan.map((p) => [p.key, p.firstAt]), [['fb:u1', '2026-10-04T09:00:00Z']]);
});

// ---------------------------------------------------------------- end to end --
const FM = 'biz-fm', SG = 'biz-sg';
const tables: Record<string, any[]> = {
  businesses: [{ id: FM, status: 'active', paid_until: null, grace_days: 0 }, { id: SG, status: 'active', paid_until: null, grace_days: 0 }],
  business_members: [{ business_id: FM, user_id: 'aviv', role: 'owner' }, { business_id: SG, user_id: 'sagit', role: 'owner' }],
  social_accounts: [], leads: [], social_messages: [], meta_inbox_sync: [], lead_activities: [],
};
const graphData: Record<string, any> = {
  '/page-sg/posts': { data: [{ id: 'post-1', message: 'מבצע', permalink_url: 'https://fb/p1' }] },
  '/post-1/comments': { data: [{ id: 'c1', message: 'כמה עולה?', created_time: new Date().toISOString(), from: { id: 'u1', name: 'דנה' } }] },
  '/page-sg/conversations': { data: [{ id: 't1', updated_time: new Date().toISOString(), participants: { data: [{ id: 'page-sg' }, { id: 'u1', name: 'דנה' }] } }] },
  '/t1/messages': { data: [{ id: 'mm1', message: 'שלום', created_time: new Date().toISOString(), from: { id: 'u1', name: 'דנה' } }] },
  '/page-sg': { instagram_business_account: null },
  '/page-fm/posts': { data: [] }, '/page-fm/conversations': { data: [] }, '/page-fm': {},
};
let calls: string[] = [];
before(async () => {
  const { seal } = await import('../src/lib/server/secrets');
  tables.social_accounts.push(
    { id: 'acc-sg', provider: 'facebook', external_id: 'page-sg', business_id: SG, user_id: 'aviv', display_name: 'SaGabot', status: 'active', inbox_enabled: true, access_token: seal('tok') },
    { id: 'acc-fm', provider: 'facebook', external_id: 'page-fm', business_id: FM, user_id: 'aviv', display_name: 'FollowMe', status: 'active', inbox_enabled: true, access_token: seal('tok-fm') },
  );
  (globalThis as any).__DP_TEST_ADMIN_DB__ = fakeDb(tables);
  globalThis.fetch = (async (u: any) => {
    const url = new URL(String(u)); const path = url.pathname.replace(/^\/v[\d.]+/, '');
    calls.push(path); if (url.searchParams.get('platform') === 'instagram') calls.push('IG_DIRECT');
    if (path === '/page-sg/posts' && Number(url.searchParams.get('limit')) > 10) {
      return new Response(JSON.stringify({ error: { code: 1, message: "Please reduce the amount of data you're asking for, then retry your request" } }), { status: 500 });
    }
    if (url.searchParams.get('access_token') === 'tok-denied') return new Response(JSON.stringify({ error: { code: 10, message: '(#10) Requires pages_messaging permission' } }), { status: 403 });
    return new Response(JSON.stringify(graphData[path] ?? { data: [] }), { status: 200 });
  }) as any;
});

test('sync: one "פנייה" card for Dana in SaGabot (comment + message), nothing in FollowMe; never twice', async () => {
  const { syncInbox } = await import('../src/lib/server/meta-inbox');
  await syncInbox({ deadline: Date.now() + 30_000 });
  await syncInbox({ deadline: Date.now() + 30_000 });
  const cards = tables.leads.filter((l) => l.business_id === SG);
  assert.equal(cards.length, 1, 'comment and message of the same person → one card');
  assert.deepEqual([cards[0].name, cards[0].status, cards[0].tags, cards[0].external_id, cards[0].user_id], ['דנה', 'פנייה', ['תגובות'], 'fb:u1', 'sagit']);
  assert.equal(tables.social_messages.length, 2, 'stored once even after two syncs');
  assert.ok(tables.social_messages.every((m) => m.business_id === SG && m.lead_id === cards[0].id));
  assert.equal(tables.leads.filter((l) => l.business_id === FM).length, 0, 'nothing leaks into FollowMe');
  assert.match(cards[0].notes, /נכנס\/ה דרך: (תגובה בפייסבוק על הפוסט: "מבצע" \(https:\/\/fb\/p1\)|מסנג׳ר)/, 'how they came in');
  assert.match(cards[0].notes, /כתב\/ה: /, 'how the conversation started');
  const hist = tables.lead_activities.filter((a) => a.lead_id === cards[0].id);
  assert.equal(hist.length, 2, 'the comment and the message are on the card\'s history — once each');
  assert.ok(hist.every((a) => a.business_id === SG && a.kind === 'note'));
  assert.ok(hist.some((a) => /👍 תגובה בפייסבוק על הפוסט: "מבצע"/.test(a.body) && /כמה עולה\?/.test(a.body)));
  assert.ok(!calls.includes('IG_DIRECT'), 'Instagram Direct is not read');
  assert.ok(calls.filter((c) => c === '/page-sg/posts').length >= 2, 'Meta said "too much data" — asked again smaller, and it worked');
});

test('a locked business is skipped; a missing permission shows the reconnect message', async () => {
  const { syncInbox, RECONNECT_FOR_INBOX } = await import('../src/lib/server/meta-inbox');
  const { seal } = await import('../src/lib/server/secrets');
  tables.businesses[1].paid_until = '2020-01-01';
  calls = [];
  const r = await syncInbox({ deadline: Date.now() + 30_000 });
  assert.equal(r.lockedSkipped, 1);
  assert.ok(!calls.some((c) => c.includes('page-sg')), 'Meta is not even asked for a locked business');
  tables.businesses[1].paid_until = null;

  tables.social_accounts.find((a) => a.id === 'acc-fm').access_token = seal('tok-denied');
  const r2 = await syncInbox({ deadline: Date.now() + 30_000, businessId: FM });
  assert.equal(r2.results[0].error, RECONNECT_FOR_INBOX);
});
