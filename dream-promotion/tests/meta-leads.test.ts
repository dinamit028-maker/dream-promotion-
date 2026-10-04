/**
 * Leads from Meta Lead Ads forms → the CRM.
 * Pure rules (form fields, Israeli phone format, duplicates) and the sync end to end with an
 * in-memory database and a fake Meta: each lead lands in its Page's business, never twice,
 * an existing customer gets a note instead of a duplicate, a locked business is skipped, and a
 * missing permission shows one clear message.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';
import { ilPhone, leadNote, mapMetaLead, planImport, RECONNECT_FOR_LEADS } from '../src/features/crm/meta-leads';

process.env.TOKEN_ENCRYPTION_KEY = 'test-key-for-meta-leads';

test('phone: every common way of writing it becomes the Israeli format', () => {
  assert.equal(ilPhone('+972501234567'), '050-1234567');
  assert.equal(ilPhone('+972 50-123-4567'), '050-1234567');
  assert.equal(ilPhone('0501234567'), '050-1234567');
  assert.equal(ilPhone('00972 52 111 2233'), '052-1112233');
  assert.equal(ilPhone('03-1234567'), '03-1234567');
  assert.equal(ilPhone('+972 77-1234567'), '077-1234567');
  assert.equal(ilPhone('+1 415 555 0100'), '+14155550100', 'a foreign number keeps its country code');
  assert.equal(ilPhone(''), '');
});

test('form fields: name, phone, email and every answer with the question the customer saw', () => {
  const m = mapMetaLead({
    id: 'L1', created_time: '2026-10-04T08:00:00+0000', ad_name: 'גבות סתיו',
    field_data: [
      { name: 'full_name', values: ['דנה כהן'] }, { name: 'phone_number', values: ['+972501234567'] },
      { name: 'email', values: ['Dana@Example.com'] }, { name: 'did_eyebrows_before?', values: ['כן'] },
      { name: 'preferred_time', values: ['בוקר'] },
    ],
  }, { 'did_eyebrows_before?': 'עשית בעבר טיפול גבות?' });
  assert.deepEqual([m.name, m.phone, m.email, m.externalId], ['דנה כהן', '050-1234567', 'dana@example.com', 'L1']);
  assert.deepEqual(m.answers, [{ q: 'עשית בעבר טיפול גבות?', a: 'כן' }, { q: 'preferred time', a: 'בוקר' }]);
  assert.equal(m.createdAt, '2026-10-04T08:00:00.000Z');
  const note = leadNote('טופס גבות', m);
  assert.match(note, /ליד מטופס Meta · טופס גבות · מודעה: גבות סתיו/);
  assert.match(note, /עשית בעבר טיפול גבות\?: כן/);
  assert.match(note, /\(Meta lead L1\)/);
  // first + last name when there is no full name
  assert.equal(mapMetaLead({ id: 'L2', field_data: [{ name: 'first_name', values: ['רון'] }, { name: 'last_name', values: ['לוי'] }] }).name, 'רון לוי');
});

test('duplicates: same Meta id skipped, same phone becomes a note, twice in one batch too', () => {
  const lead = (id: string, phone: string) => mapMetaLead({ id, field_data: [{ name: 'full_name', values: ['x'] }, { name: 'phone_number', values: [phone] }] });
  const plan = planImport(
    [lead('A', '0501111111'), lead('B', '+972 52-222-2222'), lead('C', '0533333333'), lead('D', '053-3333333'), lead('A', '0501111111'), lead('E', '0544444444')],
    [{ id: 'old-1', phone: '052-2222222', external_id: null }, { id: 'old-2', phone: '', external_id: 'A' }],
    new Set(['E']),
  );
  assert.deepEqual(plan.map((s) => s.kind), ['skip', 'existing', 'new', 'same_batch', 'skip', 'skip']);
  assert.equal((plan[1] as any).leadId, 'old-1');
});

// ---------------------------------------------------------------- end to end --
const FM = 'biz-followme', SG = 'biz-sagabot';
let seal: (s: string) => string;
const tables: Record<string, any[]> = {
  businesses: [{ id: FM, status: 'active', paid_until: null, grace_days: 0 }, { id: SG, status: 'active', paid_until: null, grace_days: 0 }],
  business_members: [{ business_id: FM, user_id: 'aviv', role: 'owner', created_at: '1' }, { business_id: SG, user_id: 'sagit', role: 'owner', created_at: '1' }],
  social_accounts: [],
  leads: [{ id: 'fm-dana', business_id: FM, user_id: 'aviv', name: 'דנה (FollowMe)', phone: '050-1234567', external_id: null }],
  lead_activities: [], meta_lead_sync: [],
};
// Meta: SaGabot's Page has one form with one lead whose phone ALSO exists in FollowMe's CRM
const meta: Record<string, any> = {
  '/page-sg/leadgen_forms': { data: [{ id: 'form-sg', name: 'טופס גבות', questions: [{ key: 'did_eyebrows_before?', label: 'עשית בעבר טיפול גבות?' }] }] },
  '/form-sg/leads': { data: [{ id: 'meta-lead-1', created_time: '2026-10-04T08:00:00+0000', field_data: [
    { name: 'full_name', values: ['דנה כהן'] }, { name: 'phone_number', values: ['+972501234567'] }, { name: 'did_eyebrows_before?', values: ['כן'] }] }] },
  '/page-fm/leadgen_forms': { data: [] },
};
let calls: string[] = [];
before(async () => {
  ({ seal } = await import('../src/lib/server/secrets'));
  tables.social_accounts.push(
    { id: 'acc-sg', provider: 'facebook', external_id: 'page-sg', business_id: SG, user_id: 'aviv', display_name: 'SaGabot', status: 'active', leads_enabled: true, access_token: seal('tok-sg') },
    { id: 'acc-fm', provider: 'facebook', external_id: 'page-fm', business_id: FM, user_id: 'aviv', display_name: 'FollowMe', status: 'active', leads_enabled: true, access_token: seal('tok-fm') },
    { id: 'acc-off', provider: 'facebook', external_id: 'page-off', business_id: FM, user_id: 'aviv', display_name: 'כבוי', status: 'active', leads_enabled: false, access_token: seal('x') },
  );
  const unique = (t: string, r: any, all: any[]) => t === 'leads' && r.external_id
    && all.some((x) => x.business_id === r.business_id && x.external_source === r.external_source && x.external_id === r.external_id)
    ? { code: '23505', message: 'duplicate key value violates unique constraint "leads_external_uq"' } : null;
  (globalThis as any).__DP_TEST_ADMIN_DB__ = fakeDb(tables, { onInsert: unique });
  globalThis.fetch = (async (u: any) => {
    const url = new URL(String(u));
    const path = url.pathname.replace(/^\/v[\d.]+/, '');
    calls.push(path);
    if (url.searchParams.get('access_token') === 'tok-denied') {
      return new Response(JSON.stringify({ error: { code: 200, message: '(#200) Requires leads_retrieval permission' } }), { status: 403 });
    }
    return new Response(JSON.stringify(meta[path] ?? { data: [] }), { status: 200 });
  }) as any;
});

test('sync: a SaGabot lead lands in SaGabot only — even when FollowMe has the same phone', async () => {
  const { syncLeads } = await import('../src/lib/server/meta-leads');
  const r = await syncLeads({ deadline: Date.now() + 30_000 });
  assert.equal(r.pages, 2, 'only switched-on Pages');
  assert.ok(!calls.some((c) => c.includes('page-off')), 'a Page with the switch off is never read');
  const sg = tables.leads.filter((l) => l.business_id === SG);
  assert.equal(sg.length, 1);
  assert.deepEqual([sg[0].name, sg[0].phone, sg[0].source, sg[0].status, sg[0].tags, sg[0].user_id],
    ['דנה כהן', '050-1234567', 'Meta · טופס גבות', 'חדש', ['ליד ממומן'], 'sagit']);
  assert.equal(tables.leads.find((l) => l.id === 'fm-dana').name, 'דנה (FollowMe)', 'FollowMe\'s contact untouched');
  const act = tables.lead_activities[0];
  assert.deepEqual([act.business_id, act.lead_id, act.kind], [SG, sg[0].id, 'note'], 'the note gets the lead\'s business');
  assert.match(act.body, /עשית בעבר טיפול גבות\?: כן/);
  assert.ok(tables.meta_lead_sync.find((s) => s.social_account_id === 'acc-sg').last_synced_at);
});

test('sync again: nothing imported twice; an existing customer gets a note, not a duplicate', async () => {
  const { syncLeads } = await import('../src/lib/server/meta-leads');
  tables.meta_lead_sync.length = 0; // even re-reading the whole month
  await syncLeads({ deadline: Date.now() + 30_000 });
  assert.equal(tables.leads.filter((l) => l.business_id === SG).length, 1);
  assert.equal(tables.lead_activities.length, 1);

  // a new lead in FollowMe's form with Dana's phone → a note on FollowMe's existing card
  meta['/page-fm/leadgen_forms'] = { data: [{ id: 'form-fm', name: 'טופס קולקציה' }] };
  meta['/form-fm/leads'] = { data: [{ id: 'meta-lead-2', field_data: [{ name: 'full_name', values: ['דנה'] }, { name: 'phone_number', values: ['0501234567'] }] }] };
  await syncLeads({ deadline: Date.now() + 30_000 });
  await syncLeads({ deadline: Date.now() + 30_000 });
  assert.equal(tables.leads.filter((l) => l.business_id === FM).length, 1, 'no duplicate contact');
  const notes = tables.lead_activities.filter((a) => a.lead_id === 'fm-dana');
  assert.equal(notes.length, 1, 'one note, even after two syncs');
  assert.equal(notes[0].business_id, FM);
});

test('a locked business is skipped; a missing permission shows the reconnect message', async () => {
  const { syncLeads } = await import('../src/lib/server/meta-leads');
  tables.businesses[1].paid_until = '2020-01-01'; // SaGabot locked
  meta['/form-sg/leads'] = { data: [{ id: 'meta-lead-3', field_data: [{ name: 'full_name', values: ['חדש'] }, { name: 'phone_number', values: ['0529998888'] }] }] };
  calls = [];
  const r = await syncLeads({ deadline: Date.now() + 30_000 });
  assert.equal(r.lockedSkipped, 1);
  assert.ok(!calls.some((c) => c.includes('page-sg') || c.includes('form-sg')), 'Meta is not even asked');
  assert.ok(!tables.leads.some((l) => l.external_id === 'meta-lead-3'));
  tables.businesses[1].paid_until = null;

  tables.social_accounts.find((a) => a.id === 'acc-fm').access_token = seal('tok-denied');
  const r2 = await syncLeads({ deadline: Date.now() + 30_000, businessId: FM });
  assert.equal(r2.errors, 1);
  assert.equal(r2.results[0].error, RECONNECT_FOR_LEADS);
  assert.equal(tables.meta_lead_sync.find((s) => s.social_account_id === 'acc-fm').last_error, RECONNECT_FOR_LEADS);
});
