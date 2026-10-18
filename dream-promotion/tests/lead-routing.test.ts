/**
 * Lead departments and WhatsApp to the team (2.99).
 * Pure rules (lead-routing.ts): which department, the five values of the template (one line, {{4}} at most 900), the team's
 * numbers, Meta's errors, the card's lines. Then the server end to end with an in-memory database, a fake Meta (Graph) and a
 * fake WhatsApp Cloud API: every new lead of a form gets its department and person and one message to that person only —
 * never to a customer, never twice (a second sync, two at once); a failure is tried once more, kept with Meta's whole error,
 * and the owners get a push; without the token nothing is sent; the screens' routes check the owner.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { fakeDb } from './fakedb';
import {
  DETAILS_MAX, NEW_LEAD_TEMPLATE, NO_DEPARTMENT, detailsLine, isFresh, leadTemplateParams, noticeLine, norm, oneLine, parseWaError, routeLead,
  staffPhone, staffPhoneShow, templateCategoryWarning, testTemplateParams, waErrorCode, waErrorHint, type LeadFacts, type RoutingDept,
} from '../src/features/crm/lead-routing';

process.env.TOKEN_ENCRYPTION_KEY = 'test-key-for-lead-routing';

// ------------------------------------------------------------------------------------------------------------ pure --
const facts = (p: Partial<LeadFacts> = {}): LeadFacts => ({ formId: '', formName: '', campaignId: '', campaignName: '', fields: [], ...p });
const DEPTS: RoutingDept[] = [
  { id: 'laser', name: 'לייזר', staffId: 'dana', position: 0, rules: [{ kind: 'form', formId: '111', formName: 'טופס לייזר' }, { kind: 'campaign', campaign: 'לייזר' }] },
  { id: 'micro', name: 'מיקרובליידינג', staffId: 'michal', position: 1, rules: [
    { kind: 'answer', question: 'איזה טיפול מעניין אותך?', answer: 'מיקרובליידינג' }, { kind: 'campaign', campaign: 'גבות' }, { kind: 'campaign', campaign: '120200000000001' }] },
  { id: 'lips', name: 'שפתיים', staffId: 'noa', position: 2, rules: [{ kind: 'campaign', campaign: 'לייזר שפתיים' }] },
];

test('the same question however it is written: case, "_", spaces and a closing mark', () => {
  assert.equal(norm('איזה_טיפול_מעניין_אותך?'), norm(' איזה  טיפול מעניין אותך '));
  assert.equal(norm('Laser  Hair_Removal.'), 'laser hair removal');
  assert.equal(norm('כן_אבל_מזמן'), 'כן אבל מזמן');
  assert.equal(norm(null), '');
});

test('the department: a question and its answer first, then the form, then the campaign; else the default recipient', () => {
  const answered = facts({ formId: '111', formName: 'טופס לייזר', fields: [{ key: 'איזה_טיפול_מעניין_אותך?', label: '', values: ['מיקרובליידינג'] }] });
  assert.deepEqual(routeLead(DEPTS, answered), { departmentId: 'micro', departmentName: 'מיקרובליידינג', staffId: 'michal',
    by: 'שאלה בטופס: איזה טיפול מעניין אותך? — מיקרובליידינג', viaDefault: false }, 'what the customer asked for wins over the form');
  assert.equal(routeLead(DEPTS, facts({ formId: '111', formName: 'טופס לייזר' })).by, 'טופס: טופס לייזר');
  assert.equal(routeLead(DEPTS, facts({ formId: '111' })).departmentId, 'laser');
  const camp = routeLead(DEPTS, facts({ formId: '999', campaignName: 'גבות | אוקטובר', campaignId: '5' }));
  assert.deepEqual([camp.departmentId, camp.by], ['micro', 'קמפיין: גבות | אוקטובר'], 'a campaign whose name contains the text');
  assert.equal(routeLead(DEPTS, facts({ campaignId: '120200000000001', campaignName: 'x' })).departmentId, 'micro', 'a campaign id: exactly');
  assert.equal(routeLead(DEPTS, facts({ campaignName: 'קמפיין 120200000000001' })).departmentId, null, 'an id never matches inside a name');
  assert.equal(routeLead(DEPTS, facts({ campaignName: 'לייזר שפתיים סתיו' })).departmentId, 'laser', 'two campaign rules match: the first department in the list');
  // the answer by its label (what the customer saw) or by its key; a checkbox question has several values
  assert.equal(routeLead(DEPTS, facts({ fields: [{ key: 'q1', label: 'איזה טיפול מעניין אותך?', values: ['לייזר', 'מיקרובליידינג'] }] })).departmentId, 'micro');
  assert.equal(routeLead(DEPTS, facts({ fields: [{ key: 'q1', label: 'איזה טיפול מעניין אותך?', values: ['לייזר'] }] })).departmentId, null, 'another answer: no');
  const none = routeLead(DEPTS, facts({ formId: '999' }));
  assert.deepEqual(none, { departmentId: null, departmentName: NO_DEPARTMENT, staffId: null, by: '', viaDefault: false });
  assert.deepEqual(routeLead(DEPTS, facts(), 'boss'), { departmentId: null, departmentName: NO_DEPARTMENT, staffId: 'boss', by: '', viaDefault: true });
  assert.equal(routeLead([], facts({ formId: '111' })).departmentId, null);
});

test('a lead older than 24 hours is not sent', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  assert.equal(isFresh('2026-10-11T13:00:00Z', now), true);
  assert.equal(isFresh('2026-10-11T11:00:00Z', now), false);
  assert.equal(isFresh(null, now), true);
  assert.equal(isFresh('2026-10-13T12:00:00Z', now), true, 'a clock ahead of ours: new');
});

test('the template\'s values: one line each, {{4}} at most 900, never empty, the link to the customer', () => {
  assert.equal(oneLine('שורה\nשנייה\t\tו      רווחים  ', 100), 'שורה שנייה ו רווחים');
  assert.equal(oneLine('abcdef', 4), 'abc…');
  const answers = [{ q: 'איזה טיפול?', a: 'לייזר' }, { q: 'הערות', a: 'שורה אחת\nשורה שתיים' }];
  assert.equal(detailsLine({ formName: 'טופס לייזר', email: 'a@b.co', answers }), 'טופס: טופס לייזר · אימייל: a@b.co · איזה טיפול?: לייזר · הערות: שורה אחת שורה שתיים');
  const long = detailsLine({ answers: Array.from({ length: 80 }, (_, i) => ({ q: `שאלה ${i}`, a: 'תשובה ארוכה למדי' })) });
  assert.equal(long.length, DETAILS_MAX);
  assert.ok(long.endsWith('…'));
  assert.equal(detailsLine({ answers: [] }), '—');
  const p = leadTemplateParams({ department: 'לייזר', name: 'דנה כהן', phone: '+972 52-123-4567', formName: 'טופס לייזר', answers });
  assert.deepEqual(p, ['לייזר', 'דנה כהן', '052-1234567', 'טופס: טופס לייזר · איזה טיפול?: לייזר · הערות: שורה אחת שורה שתיים', 'https://wa.me/972521234567']);
  for (const v of p) assert.ok(v && !/[\n\t]| {5}/.test(v), `a value WhatsApp accepts: ${v}`);
  assert.deepEqual(leadTemplateParams({ department: '', name: '  ', phone: '', answers: [] }), [NO_DEPARTMENT, 'ללא שם', '—', '—', 'אין מספר טלפון']);
  assert.equal(leadTemplateParams({ department: 'x', name: 'y', phone: '0501234567', details: 'איזה טיפול?: לייזר\n\nמתי?:  בוקר ' })[3], 'איזה טיפול?: לייזר · מתי?: בוקר', 'a moved lead: its notes, a line each');
  const t = testTemplateParams({ phone: '15550100123' }, '');
  assert.deepEqual(t.length, 5);
  assert.equal(t[2], '+15550100123');
  assert.equal(t[4], 'https://wa.me/15550100123', 'the test points at the person\'s own number');
});

test('the team\'s numbers: international digits, as Meta wants them', () => {
  assert.equal(staffPhone('050-123-4567'), '972501234567');
  assert.equal(staffPhone('+972 50 123 4567'), '972501234567');
  assert.equal(staffPhone('00972501234567'), '972501234567');
  assert.equal(staffPhone('501234567'), '972501234567', 'an Israeli mobile without its 0');
  assert.equal(staffPhone('+1 555 010 0123'), '15550100123');
  assert.equal(staffPhone('+44 20 7946 0958'), '442079460958');
  assert.equal(staffPhone('abc'), null);
  assert.equal(staffPhone('123'), null);
  assert.equal(staffPhoneShow('972501234567'), '050-1234567');
  assert.equal(staffPhoneShow('15550100123'), '+15550100123');
  // 2.105: a practitioner of the calendar may have no number
  assert.equal(staffPhoneShow(null), '');
  assert.equal(staffPhoneShow(''), '');
});

test('Meta\'s errors: the whole code, and what it means in Hebrew', () => {
  const e = parseWaError({ error: { message: '(#131030) Recipient phone number not in allowed list', type: 'OAuthException', code: 131030,
    error_data: { messaging_product: 'whatsapp', details: 'Recipient phone number not in allowed list: Add recipient phone number to recipient list and try again.' },
    fbtrace_id: 'AbC123' } }, 400);
  assert.deepEqual([e.code, e.subcode, e.type, e.fbtrace, e.http], ['131030', '', 'OAuthException', 'AbC123', 400]);
  assert.match(e.details, /recipient list/);
  assert.equal(waErrorCode(e), '131030');
  assert.match(waErrorHint('131030'), /רשימה המאושרת/);
  assert.equal(waErrorCode(parseWaError({ error: { code: 100, error_subcode: 33, message: 'x' } }, 400)), '100/33');
  assert.match(waErrorHint('100/33'), /WHATSAPP_PHONE_NUMBER_ID/);
  assert.match(waErrorHint('100/2494010'), /ערך לא תקין/, 'an unknown subcode: its code\'s hint');
  assert.match(waErrorHint('132001'), /lead_assigned/);
  assert.equal(waErrorHint('999999'), '');
  assert.equal(parseWaError(null, 502).code, 'http_502');
});

test('the template is lead_assigned; a warning on the screen while Meta keeps it as MARKETING ("שיווק")', () => {
  // 12.10.2026: new_lead, which Meta made MARKETING, was accepted (HTTP 200) and never reached a person who had not written to the number
  assert.deepEqual(NEW_LEAD_TEMPLATE, { name: 'lead_assigned', language: 'he', params: 5 });
  assert.match(templateCategoryWarning('MARKETING'), /שיווק/);
  assert.match(templateCategoryWarning('marketing'), /24 השעות האחרונות/);
  assert.match(templateCategoryWarning('MARKETING'), /שירות ציבורי/, 'and what it should be');
  assert.equal(templateCategoryWarning('UTILITY'), '');
  assert.equal(templateCategoryWarning(''), '');
});

test('the card\'s line for each message', () => {
  const base = { reason: '', staffName: 'דנה', errorCode: '', sentAt: null, claimedAt: null, kind: 'lead' as const };
  assert.match(noticeLine({ ...base, status: 'sent', sentAt: '2026-10-12T11:32:00Z' }).text, /^💬 נשלח בוואטסאפ לדנה · 12\.10\.2026, 14:32$/);
  const failed = noticeLine({ ...base, status: 'failed', errorCode: '131030' });
  assert.deepEqual([failed.text, failed.resend], ['❌ לא נשלח לדנה · קוד 131030', true]);
  assert.match(failed.hint, /API Setup/);
  assert.equal(noticeLine({ ...base, status: 'skipped', reason: 'not_connected' }).text, '⏸️ לא נשלח לדנה — וואטסאפ לא מחובר');
  assert.equal(noticeLine({ ...base, status: 'skipped', reason: 'staff_removed' }).resend, false);
  // 2.105: a person with no WhatsApp number — not sent, and sent once a number is added
  const noPhone = noticeLine({ ...base, status: 'skipped', reason: 'no_phone' });
  assert.deepEqual([noPhone.text, noPhone.resend], ['⏸️ לא נשלח לדנה — אין מספר וואטסאפ ברשימת הצוות', true]);
  const now = Date.parse('2026-10-12T12:00:00Z');
  assert.match(noticeLine({ ...base, status: 'sending', claimedAt: '2026-10-12T11:59:00Z' }, now).text, /נשלח עכשיו/);
  const stale = noticeLine({ ...base, status: 'sending', claimedAt: '2026-10-12T11:00:00Z' }, now);
  assert.deepEqual([stale.tone, stale.resend], ['bad', false], 'cut in the middle: maybe sent — never sent again by itself');
});

// --------------------------------------------------------------------------------------------- the server, end to end --
const BIZ = 'biz-studio', OTHER = 'biz-other';
const HOUR = 3600e3;
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
const tables: Record<string, any[]> = {
  businesses: [{ id: BIZ, status: 'active', paid_until: null, grace_days: 0 }, { id: OTHER, status: 'active', paid_until: null, grace_days: 0 }],
  business_members: [
    { business_id: BIZ, user_id: 'owner', role: 'owner', access: 'full', created_at: '1' },
    { business_id: BIZ, user_id: 'u-dana', role: 'editor', access: 'full', created_at: '2' },
    { business_id: BIZ, user_id: 'cashier', role: 'editor', access: 'register', created_at: '3' },
    { business_id: OTHER, user_id: 'stranger', role: 'owner', access: 'full', created_at: '1' },
  ],
  profiles: [{ id: 'owner', full_name: 'בעלת העסק', email: 'o@x.co' }, { id: 'u-dana', full_name: 'דנה', email: 'd@x.co' }],
  social_accounts: [], leads: [], lead_activities: [], meta_lead_sync: [],
  lead_staff: [
    { id: 'dana', business_id: BIZ, name: 'דנה', phone: '972501111111', active: true, member_user_id: 'u-dana', created_at: '1' },
    { id: 'michal', business_id: BIZ, name: 'מיכל', phone: '15550100123', active: true, member_user_id: null, created_at: '2' },
    { id: 'other-staff', business_id: OTHER, name: 'אור', phone: '972509999999', active: true, member_user_id: null, created_at: '1' },
  ],
  lead_departments: [
    { id: 'laser', business_id: BIZ, name: 'לייזר', staff_id: 'dana', position: 0, active: true },
    { id: 'micro', business_id: BIZ, name: 'מיקרובליידינג', staff_id: 'michal', position: 1, active: true },
  ],
  lead_department_rules: [
    { id: 'r1', business_id: BIZ, department_id: 'laser', kind: 'form', form_id: '111', form_name: 'טופס לייזר', campaign: '', question: '', answer: '' },
    { id: 'r2', business_id: BIZ, department_id: 'micro', kind: 'answer', form_id: '', form_name: '', campaign: '', question: 'איזה טיפול?', answer: 'מיקרובליידינג' },
  ],
  lead_routing: [], lead_notifications: [], push_subscriptions: [
    { id: 'p-owner', user_id: 'owner', endpoint: 'https://push.test/owner', keys: { p256dh: 'x', auth: 'y' } },
    { id: 'p-dana', user_id: 'u-dana', endpoint: 'https://push.test/dana', keys: { p256dh: 'x', auth: 'y' } },
  ],
};
const field = (name: string, v: string) => ({ name, values: [v] });
const meta: Record<string, any> = {
  '/page-studio/leadgen_forms': { data: [{ id: '111', name: 'טופס לייזר' }, { id: '222', name: 'טופס כללי', questions: [{ key: 'which', label: 'איזה טיפול?' }] }] },
  '/111/leads': { data: [{ id: 'L-A', created_time: ago(1), form_id: '111', campaign_name: 'לייזר סתיו', field_data: [field('full_name', 'נועה לוי'), field('phone_number', '+972521234567'), field('email', 'noa@x.co')] }] },
  '/222/leads': { data: [
    { id: 'L-B', created_time: ago(2), field_data: [field('full_name', 'רותם'), field('phone_number', '0532222222'), field('which', 'מיקרובליידינג')] },
    { id: 'L-C', created_time: ago(2), field_data: [field('full_name', 'שירה'), field('phone_number', '0543333333'), field('which', 'משהו אחר')] },
    { id: 'L-D', created_time: ago(72), field_data: [field('full_name', 'ותיקה'), field('phone_number', '0554444444'), field('which', 'מיקרובליידינג')] },
  ] },
};
/** what WhatsApp got: the number it was sent TO and the five values */
let wa: { to: string; params: string[]; auth: string }[] = [];
let waAnswer: (to: string, n: number) => { status: number; body: any } = () => ({ status: 200, body: {} });
let graphCalls: string[] = [];
let pushes: { endpoint: string; title: string; body: string }[] = [];
let campaignRefused = false;

const unique = (t: string, r: any, all: any[]) => {
  if (t === 'leads' && r.external_id && all.some((x) => x.business_id === r.business_id && x.external_source === r.external_source && x.external_id === r.external_id))
    return { code: '23505', message: 'duplicate key value violates unique constraint "leads_external_uq"' };
  if (t === 'lead_notifications' && all.some((x) => x.business_id === r.business_id && x.dedupe_key === r.dedupe_key))
    return { code: '23505', message: 'duplicate key value violates unique constraint "lead_notifications_once"' };
  if (t === 'lead_staff' && r.active !== false && r.phone && all.some((x) => x.business_id === r.business_id && (x.active ?? true) && x.phone === r.phone))
    return { code: '23505', message: 'duplicate key value violates unique constraint "lead_staff_phone_uq"' };
  return null;
};
let db: any;
before(async () => {
  const { seal } = await import('../src/lib/server/secrets');
  tables.social_accounts.push({ id: 'acc-studio', provider: 'facebook', external_id: 'page-studio', business_id: BIZ, user_id: 'owner', display_name: 'הסטודיו',
    status: 'active', leads_enabled: true, access_token: seal('tok-studio') });
  const keys = webpush.generateVAPIDKeys();
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = keys.publicKey; process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  (webpush as any).sendNotification = async (sub: { endpoint: string }, payload: string) => { const p = JSON.parse(payload); pushes.push({ endpoint: sub.endpoint, title: p.title, body: p.body }); return {}; };
  db = {
    ...fakeDb(tables, { onInsert: unique }),
    auth: { getUser: async (t: string) => ({ data: { user: ['owner', 'u-dana', 'cashier', 'stranger'].includes(t) ? { id: t } : null } }) },
    rpc: async (fn: string, a: any) => (fn === 'business_for_user' ? { data: tables.business_members.find((m) => m.user_id === a.uid)?.business_id ?? null, error: null } : { data: null, error: null }),
  };
  (globalThis as any).__DP_TEST_ADMIN_DB__ = db;
  globalThis.fetch = (async (u: any, init: any = {}) => {
    const url = new URL(String(u));
    const path = url.pathname.replace(/^\/v[\d.]+/, '');
    if (path === '/PNID/messages') {
      const b = JSON.parse(init.body);
      const params = b.template.components[0].parameters.map((x: any) => x.text);
      wa.push({ to: b.to, params, auth: String(init.headers?.Authorization ?? '') });
      assert.equal(b.template.name, 'lead_assigned'); assert.deepEqual(b.template.language, { code: 'he' });
      const r = waAnswer(b.to, wa.filter((x) => x.to === b.to).length);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    graphCalls.push(`${path}?${url.searchParams.get('fields') ?? ''}`);
    if (campaignRefused && /campaign_name/.test(url.searchParams.get('fields') ?? '')) {
      return new Response(JSON.stringify({ error: { code: 100, message: '(#100) Tried accessing nonexisting field (campaign_name)' } }), { status: 400 });
    }
    return new Response(JSON.stringify(meta[path] ?? { data: [] }), { status: 200 });
  }) as any;
});
const ok = (to: string, n: number) => ({ status: 200, body: { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id: `wamid.${to}.${n}`, message_status: 'accepted' }] } });
beforeEach(() => {
  process.env.WHATSAPP_TOKEN = 'EAAG-test-token'; process.env.WHATSAPP_PHONE_NUMBER_ID = 'PNID'; process.env.WHATSAPP_WABA_ID = 'WABA';
  wa = []; pushes = []; graphCalls = []; waAnswer = ok;
});
const lead = (ext: string) => tables.leads.find((l) => l.external_id === ext);
const notes = (leadId: string) => tables.lead_notifications.filter((n) => n.lead_id === leadId);

test('sync: each new lead → its department and person, one WhatsApp message to that person only; a failure is tried once more', async () => {
  // michal's first try: Meta's temporary error; the second goes out
  waAnswer = (to, n) => (to === '15550100123' && n === 1 ? { status: 500, body: { error: { code: 131000, message: 'Something went wrong', fbtrace_id: 'T1' } } } : ok(to, n));
  const { syncLeads } = await import('../src/lib/server/meta-leads');
  const r = await syncLeads({ deadline: Date.now() + 40_000 });
  assert.equal(r.imported, 4);
  assert.deepEqual(r.whatsapp, { sent: 2, failed: 0, skipped: 0 });

  const a = lead('L-A');
  assert.deepEqual([a.department_id, a.assigned_staff_id, a.routed_by], ['laser', 'dana', 'טופס: טופס לייזר'], 'the form → לייזר → דנה');
  const b = lead('L-B');
  assert.deepEqual([b.department_id, b.assigned_staff_id, b.routed_by], ['micro', 'michal', 'שאלה בטופס: איזה טיפול? — מיקרובליידינג']);
  const c = lead('L-C');
  assert.deepEqual([c.department_id, c.assigned_staff_id, c.routed_by, Boolean(c.routed_at)], [null, null, '', true], 'no department, no default: "ללא מחלקה", nobody gets it');
  assert.equal(notes(c.id).length, 0);
  const d = lead('L-D');
  assert.deepEqual([d.department_id, d.assigned_staff_id], ['micro', 'michal'], 'a lead of three days ago is assigned…');
  assert.deepEqual(notes(d.id).map((n) => [n.status, n.reason]), [['skipped', 'old_lead']], '…and not sent');

  // WhatsApp: to the team's numbers only — never a customer's
  const customers = tables.leads.map((l) => l.phone.replace(/\D/g, '').replace(/^0/, '972'));
  assert.ok(wa.every((m) => ['972501111111', '15550100123'].includes(m.to) && !customers.includes(m.to)), 'only the team');
  assert.ok(wa.every((m) => m.auth === 'Bearer EAAG-test-token'), 'the token in a header');
  const toDana = wa.filter((m) => m.to === '972501111111');
  assert.equal(toDana.length, 1);
  assert.deepEqual(toDana[0].params, ['לייזר', 'נועה לוי', '052-1234567', 'טופס: טופס לייזר · אימייל: noa@x.co', 'https://wa.me/972521234567']);
  assert.equal(wa.filter((m) => m.to === '15550100123').length, 2, 'מיכל: the failure and the one more try');
  const nb = notes(b.id)[0];
  assert.deepEqual([nb.status, nb.attempts, nb.wa_message_id, nb.error_code], ['sent', 2, 'wamid.15550100123.2', '']);
  const na = notes(a.id)[0];
  assert.deepEqual([na.status, na.attempts, na.kind, na.dedupe_key, na.to_phone], ['sent', 1, 'lead', 'lead:L-A:dana', '972501111111']);
  assert.ok(na.sent_at);
  assert.ok(graphCalls.some((g) => g.startsWith('/111/leads?') && g.includes('campaign_name')), 'the campaign is asked for');
});

test('never twice: the same leads again, and two syncs at once, send nothing more', async () => {
  const { syncLeads } = await import('../src/lib/server/meta-leads');
  tables.meta_lead_sync.length = 0; // re-reading the whole month
  await Promise.all([syncLeads({ deadline: Date.now() + 40_000 }), syncLeads({ deadline: Date.now() + 40_000 })]);
  assert.equal(wa.length, 0);
  assert.equal(tables.leads.length, 4);
  assert.equal(tables.lead_notifications.length, 3);

  // a new lead, two syncs at once: one message
  meta['/111/leads'].data.push({ id: 'L-E', created_time: ago(0.1), field_data: [field('full_name', 'אלה'), field('phone_number', '0565555555')] });
  tables.meta_lead_sync.length = 0;
  await Promise.all([syncLeads({ deadline: Date.now() + 40_000 }), syncLeads({ deadline: Date.now() + 40_000 })]);
  assert.equal(wa.length, 1, 'one message for one lead, whatever ran at once');
  assert.equal(notes(lead('L-E').id).length, 1);
});

test('an existing customer\'s new enquiry: its department\'s person hears of it; a person the customer has stays', async () => {
  const { syncLeads } = await import('../src/lib/server/meta-leads');
  // רותם (מיכל's) fills the laser form: דנה gets the enquiry, רותם stays מיכל's; a note on her card, no second contact
  meta['/111/leads'].data.push({ id: 'L-F', created_time: ago(0.2), field_data: [field('full_name', 'רותם'), field('phone_number', '053-2222222')] });
  tables.meta_lead_sync.length = 0;
  await syncLeads({ deadline: Date.now() + 40_000 });
  const b = lead('L-B');
  assert.equal(tables.leads.filter((l) => l.phone === b.phone).length, 1);
  assert.equal(b.assigned_staff_id, 'michal');
  assert.deepEqual(wa.map((m) => m.to), ['972501111111']);
  assert.equal(wa[0].params[1], 'רותם');
  assert.ok(notes(b.id).some((n) => n.dedupe_key === 'lead:L-F:dana' && n.status === 'sent'));
});

test('a failure: one more try, Meta\'s whole error on the row, a push to the owners only; a timeout is never tried again', async () => {
  const { syncLeads } = await import('../src/lib/server/meta-leads');
  waAnswer = () => ({ status: 400, body: { error: { message: '(#131030) Recipient phone number not in allowed list', type: 'OAuthException', code: 131030,
    error_data: { messaging_product: 'whatsapp', details: 'Recipient phone number not in allowed list' }, fbtrace_id: 'Fb1' } } });
  meta['/111/leads'].data.push({ id: 'L-G', created_time: ago(0.1), field_data: [field('full_name', 'גלי'), field('phone_number', '0577777777')] });
  tables.meta_lead_sync.length = 0;
  const r = await syncLeads({ deadline: Date.now() + 40_000 });
  assert.deepEqual(r.whatsapp, { sent: 0, failed: 1, skipped: 0 });
  assert.equal(wa.length, 2, 'the first try and one more');
  const n = notes(lead('L-G').id)[0];
  assert.deepEqual([n.status, n.attempts, n.error_code, n.error.code, n.error.fbtrace, n.error.details], ['failed', 2, '131030', '131030', 'Fb1', 'Recipient phone number not in allowed list']);
  assert.equal(n.error.response.error.code, 131030, 'Meta\'s answer as it came');
  assert.deepEqual(pushes.map((p) => p.endpoint), ['https://push.test/owner'], 'the owner — not דנה, not a cashier');
  assert.equal(pushes[0].title, '⚠️ ליד לא נשלח בוואטסאפ');
  assert.equal(pushes[0].body, 'גלי · לייזר → דנה · קוד 131030');

  // no answer in time: it may have arrived — not tried again
  const { sendNewLead } = await import('../src/lib/server/whatsapp');
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as any;
  const t = await sendNewLead('972501111111', ['a', 'b', 'c', 'd', 'e'], 30);
  globalThis.fetch = real;
  assert.equal(t.ok, false);
  assert.deepEqual(!t.ok && [t.error.code, t.definite], ['timeout', false]);
});

test('WhatsApp not connected: the leads are still assigned, nothing is sent, the message waits as "skipped"', async () => {
  const { syncLeads } = await import('../src/lib/server/meta-leads');
  delete process.env.WHATSAPP_TOKEN;
  meta['/222/leads'].data.push({ id: 'L-H', created_time: ago(0.1), field_data: [field('full_name', 'הדס'), field('phone_number', '0588888888'), field('which', 'מיקרובליידינג')] });
  tables.meta_lead_sync.length = 0;
  await syncLeads({ deadline: Date.now() + 40_000 });
  const h = lead('L-H');
  assert.equal(h.assigned_staff_id, 'michal');
  assert.deepEqual(notes(h.id).map((n) => [n.status, n.reason]), [['skipped', 'not_connected']]);
  assert.equal(wa.length, 0);
  const { sendNewLead } = await import('../src/lib/server/whatsapp');
  const r = await sendNewLead('972501111111', ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(!r.ok && r.error.code, 'not_connected');
});

test('a business with no departments: imported exactly as before (no department, no person, nothing queued)', async () => {
  const { importLeads } = await import('../src/lib/server/meta-leads');
  const { loadRouting } = await import('../src/lib/server/lead-routing');
  assert.equal(await loadRouting(OTHER), null, 'a team but no department and no default: nothing to route');
  const { mapMetaLead } = await import('../src/features/crm/meta-leads');
  const r = await importLeads(OTHER, 'stranger', 'טופס', [mapMetaLead({ id: 'O-1', created_time: ago(1), field_data: [field('full_name', 'אחר'), field('phone_number', '0591111111')] })], null);
  assert.equal(r.imported, 1);
  const o = lead('O-1');
  assert.deepEqual([o.department_id, o.assigned_staff_id, o.routed_at], [undefined, undefined, undefined]);

  // before migration 20261012005300 the tables are missing: no routing, and the queue reads nothing
  const missing = { then: (res: any) => res({ data: null, error: { message: 'relation "lead_staff" does not exist' } }) } as any;
  const chain: any = new Proxy(missing, { get: (t, k) => (k === 'then' ? t.then : () => chain) });
  (globalThis as any).__DP_TEST_ADMIN_DB__ = { ...db, from: (t: string) => (t.startsWith('lead_') && t !== 'lead_activities' ? chain : db.from(t)) };
  try {
    assert.equal(await loadRouting(BIZ), null);
    const { sendQueued } = await import('../src/lib/server/lead-routing');
    assert.deepEqual(await sendQueued({ deadline: Date.now() + 10_000 }), { sent: 0, failed: 0, skipped: 0 });
  } finally { (globalThis as any).__DP_TEST_ADMIN_DB__ = db; }
});

test('Meta refuses the campaign field: the leads come without it, as before', async () => {
  const { syncLeads } = await import('../src/lib/server/meta-leads');
  campaignRefused = true;
  meta['/111/leads'].data.push({ id: 'L-I', created_time: ago(0.1), field_data: [field('full_name', 'אילנה'), field('phone_number', '0501212121')] });
  tables.meta_lead_sync.length = 0;
  const r = await syncLeads({ deadline: Date.now() + 40_000 });
  campaignRefused = false;
  assert.equal(r.errors, 0);
  assert.ok(lead('L-I'), 'imported');
  assert.equal(lead('L-I').assigned_staff_id, 'dana');
  assert.ok(graphCalls.some((g) => g.startsWith('/111/leads?') && !g.includes('campaign')), 'asked again without the campaign');
});

// ------------------------------------------------------------------------------------------------- the screens' routes --
const call = async (mod: any, method: 'GET' | 'POST', path: string, who: string, body?: unknown) => {
  const res: Response = await mod[method](new Request(`http://x${path}`, { method, headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  return { status: res.status, body: await res.json() };
};

test('the departments screen: a member sees names; only the owner sees numbers and changes anything; a cashier nothing', async () => {
  const route = await import('../src/app/api/leads/departments/route');
  const asDana = await call(route, 'GET', '/api/leads/departments', 'u-dana');
  assert.equal(asDana.status, 200);
  assert.deepEqual(asDana.body.me, ['dana'], '"הלידים שלי": דנה is this member');
  assert.equal(asDana.body.owner, false);
  assert.ok(asDana.body.staff.every((s: any) => s.phone === undefined), 'no numbers for a member');
  assert.ok(asDana.body.departments.every((d: any) => d.rules === undefined));
  assert.equal((await call(route, 'GET', '/api/leads/departments', 'cashier')).status, 403);
  const own = await call(route, 'GET', '/api/leads/departments', 'owner');
  assert.equal(own.body.staff.find((s: any) => s.id === 'michal').phoneShown, '+15550100123');
  assert.equal(own.body.departments.find((d: any) => d.id === 'micro').rules[0].question, 'איזה טיפול?');
  assert.ok(!own.body.staff.some((s: any) => s.id === 'other-staff'), 'another business\'s team: never');

  const denied = await call(route, 'POST', '/api/leads/departments', 'u-dana', { action: 'staff.save', name: 'x', phone: '0501234567' });
  assert.deepEqual([denied.status, denied.body.code], [403, 'owner_only']);
  assert.equal((await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'staff.save', name: 'נוי', phone: '12' })).status, 400);
  const saved = await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'staff.save', name: ' נוי  ', phone: '052-999-8888' });
  assert.equal(saved.status, 200);
  const noy = tables.lead_staff.find((s) => s.name === 'נוי');
  assert.deepEqual([noy.phone, noy.business_id, noy.active ?? true], ['972529998888', BIZ, true]);
  const dup = await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'staff.save', name: 'עוד', phone: '0529998888' });
  assert.deepEqual([dup.status, dup.body.message], [409, 'המספר הזה כבר ברשימת הצוות.']);
  const stranger = await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'staff.save', name: 'זר', phone: '0521110000', memberUserId: 'stranger' });
  assert.deepEqual([stranger.status, stranger.body.message], [400, 'החשבון שנבחר הוא לא חבר בעסק.']);

  const badRule = await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'department.save', name: 'פנים', staffId: noy.id, rules: [{ kind: 'answer', question: 'q' }] });
  assert.equal(badRule.status, 400);
  const dept = await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'department.save', name: 'פנים', staffId: noy.id,
    rules: [{ kind: 'campaign', campaign: ' פנים\nסתיו ' }, { kind: 'form', formId: '333', formName: 'טופס פנים' }] });
  assert.equal(dept.status, 200);
  const face = dept.body.departments.find((d: any) => d.name === 'פנים');
  assert.deepEqual(face.rules.map((r: any) => r.kind === 'campaign' ? r.campaign : r.formId), ['פנים סתיו', '333']);
  assert.equal(face.position, 2, 'last in the list');
  const edited = await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'department.save', id: face.id, name: 'פנים', staffId: noy.id, rules: [{ kind: 'campaign', campaign: 'פנים' }] });
  assert.deepEqual(edited.body.departments.find((d: any) => d.id === face.id).rules.map((r: any) => r.campaign), ['פנים'], 'the rules replaced');
  const inUse = await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'staff.remove', id: noy.id });
  assert.deepEqual([inUse.status, inUse.body.message], [409, 'באחריות נוי: פנים. קודם להעביר את המחלקה לאדם אחר בצוות.']);
  assert.equal((await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'department.remove', id: face.id })).status, 200);
  assert.equal((await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'default.set', staffId: noy.id })).body.defaultStaffId, noy.id);
  const asDefault = await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'staff.remove', id: noy.id });
  assert.equal(asDefault.status, 409, 'the default recipient is not removed');
  await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'default.set', staffId: null });
  assert.equal((await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'staff.remove', id: noy.id })).status, 200);
  assert.equal(noy.active, false, 'removed, never deleted');
});

test('the test message: Meta\'s answer, or its error in full; "וואטסאפ לא מחובר" without the token', async () => {
  const route = await import('../src/app/api/leads/departments/route');
  const sent = await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'test', staffId: 'michal' });
  assert.equal(sent.status, 200);
  assert.deepEqual([sent.body.ok, sent.body.messageId, sent.body.status, sent.body.response.contacts[0].wa_id], [true, 'wamid.15550100123.1', 'accepted', '15550100123']);
  assert.deepEqual(wa.map((m) => m.to), ['15550100123'], 'to that person only');
  assert.equal(wa[0].params[0], 'מיקרובליידינג', 'with the person\'s department');
  waAnswer = () => ({ status: 400, body: { error: { message: 'Template name does not exist in the translation', type: 'OAuthException', code: 132001, error_data: { details: 'template name (lead_assigned) does not exist in he' }, fbtrace_id: 'Z9' } } });
  const failed = await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'test', staffId: 'dana' });
  assert.deepEqual([failed.body.ok, failed.body.code, failed.body.error.fbtrace, failed.body.error.details], [false, '132001', 'Z9', 'template name (lead_assigned) does not exist in he']);
  assert.match(failed.body.hint, /עוד לא אושרה/);
  assert.equal(wa.length, 2, 'a test is never tried again by itself');
  assert.equal((await call(route, 'POST', '/api/leads/departments', 'u-dana', { action: 'test', staffId: 'dana' })).status, 403);
  delete process.env.WHATSAPP_TOKEN;
  const off = await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'test', staffId: 'dana' });
  assert.deepEqual([off.status, off.body.message], [409, 'וואטסאפ לא מחובר']);
  assert.equal((await call(route, 'GET', '/api/leads/departments', 'owner')).body.connected, false);
});

test('the card: the owner moves a lead and sends it to the new person once; sends again what failed; a member only reads', async () => {
  const route = await import('../src/app/api/leads/assignment/route');
  const c = lead('L-C'); // no department, nobody
  const read = await call(route, 'GET', `/api/leads/assignment?lead=${c.id}`, 'u-dana');
  assert.deepEqual([read.status, read.body.lead.assignedStaffId, read.body.notifications.length], [200, null, 0]);
  assert.equal((await call(route, 'POST', '/api/leads/assignment', 'u-dana', { action: 'assign', leadId: c.id, staffId: 'dana', send: true })).status, 403, 'a member never moves a lead');

  const moved = await call(route, 'POST', '/api/leads/assignment', 'owner', { action: 'assign', leadId: c.id, staffId: 'dana', send: true });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.sent.status, 'sent');
  assert.equal(c.assigned_staff_id, 'dana');
  assert.deepEqual(wa.map((m) => [m.to, m.params[0], m.params[1]]), [['972501111111', NO_DEPARTMENT, 'שירה']]);
  assert.ok(tables.lead_activities.some((a) => a.lead_id === c.id && a.body === '👤 הליד הועבר לדנה'));
  // to מיכל and back to דנה: דנה is not sent the same lead again
  await call(route, 'POST', '/api/leads/assignment', 'owner', { action: 'assign', leadId: c.id, staffId: 'michal', send: false });
  const back = await call(route, 'POST', '/api/leads/assignment', 'owner', { action: 'assign', leadId: c.id, staffId: 'dana', send: true });
  assert.equal(back.body.sent.status, 'already');
  assert.equal(wa.length, 1);
  assert.ok(tables.lead_activities.some((a) => a.lead_id === c.id && a.body === '👤 הליד הועבר לדנה (במקום מיכל)'));

  // what failed (L-G, 131030) is sent again by the owner — once
  const g = notes(lead('L-G').id)[0];
  const again = await call(route, 'POST', '/api/leads/assignment', 'owner', { action: 'resend', id: g.id });
  assert.deepEqual([again.status, again.body.sent.status, g.status, g.attempts, g.error_code], [200, 'sent', 'sent', 3, '']);
  const twice = await call(route, 'POST', '/api/leads/assignment', 'owner', { action: 'resend', id: g.id });
  assert.equal(twice.status, 409, 'a message that went out is never sent again');
  // the skipped one (not connected) is sent from the card once WhatsApp is connected
  const h = notes(lead('L-H').id)[0];
  assert.equal((await call(route, 'POST', '/api/leads/assignment', 'owner', { action: 'resend', id: h.id })).body.sent.status, 'sent');
  const card = await call(route, 'GET', `/api/leads/assignment?lead=${lead('L-G').id}`, 'owner');
  assert.equal(card.body.notifications[0].status, 'sent');
  const other = await call(route, 'GET', `/api/leads/assignment?lead=${c.id}`, 'stranger');
  assert.equal(other.status, 404, 'another business\'s contact: not found');
});

test('the template waits for Meta\'s approval (132001): the lead is kept "failed"; after the approval "לשלוח שוב" sends it once — two at once, still once', async () => {
  const { syncLeads } = await import('../src/lib/server/meta-leads');
  const route = await import('../src/app/api/leads/assignment/route');
  // what Meta answers for a template that is not approved yet
  waAnswer = () => ({ status: 400, body: { error: { message: '(#132001) Template name does not exist in the translation', type: 'OAuthException', code: 132001,
    error_data: { messaging_product: 'whatsapp', details: 'template name (lead_assigned) does not exist in he' }, fbtrace_id: 'Tpl1' } } });
  meta['/111/leads'].data.push({ id: 'L-T', created_time: ago(0.1), field_data: [field('full_name', 'טל'), field('phone_number', '0521010101')] });
  tables.meta_lead_sync.length = 0;
  const r = await syncLeads({ deadline: Date.now() + 40_000 });
  assert.deepEqual(r.whatsapp, { sent: 0, failed: 1, skipped: 0 });
  const t = lead('L-T');
  assert.equal(t.assigned_staff_id, 'dana', 'assigned all the same');
  const [n] = notes(t.id);
  assert.deepEqual([n.status, n.attempts, n.error_code, n.error.code, n.error.fbtrace], ['failed', 2, '132001', '132001', 'Tpl1']);
  assert.equal(n.error.details, 'template name (lead_assigned) does not exist in he', 'Meta\'s whole error is kept');
  assert.equal(wa.length, 2, 'the first try and one more — then it waits');
  assert.deepEqual(pushes.map((p) => [p.endpoint, p.body]), [['https://push.test/owner', 'טל · לייזר → דנה · קוד 132001']]);

  // the timer, again and again: a failed message is never sent by itself, and never queued a second time
  for (let i = 0; i < 2; i++) { tables.meta_lead_sync.length = 0; await syncLeads({ deadline: Date.now() + 40_000 }); }
  assert.equal(wa.length, 2);
  assert.equal(notes(t.id).length, 1, 'one message for the lead');

  // Meta approves the template; the owner presses "לשלוח שוב" on two devices at the same moment — one message goes out
  waAnswer = ok;
  const resend = { action: 'resend', id: n.id };
  const both = await Promise.all([call(route, 'POST', '/api/leads/assignment', 'owner', resend), call(route, 'POST', '/api/leads/assignment', 'owner', resend)]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409], 'one sender takes it, the other is told it is taken');
  assert.equal(wa.length, 3, 'one more message — not two');
  assert.deepEqual(wa[2].params, wa[0].params, 'the same message that waited, to the same person');
  assert.equal(wa[2].to, '972501111111');
  assert.deepEqual([n.status, n.attempts, n.error_code, n.error, n.wa_message_id, Boolean(n.sent_at)], ['sent', 3, '', null, 'wamid.972501111111.3', true]);

  // once it went out: "לשלוח שוב" is refused, and the timer sends nothing more
  assert.equal((await call(route, 'POST', '/api/leads/assignment', 'owner', resend)).status, 409);
  tables.meta_lead_sync.length = 0;
  await syncLeads({ deadline: Date.now() + 40_000 });
  assert.equal(wa.length, 3);
});

test('2.105: a practitioner of the calendar on the team — her colour, and no WhatsApp number: assigned, never sent', async () => {
  const route = await import('../src/app/api/leads/departments/route');
  const karin = await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'staff.save', name: 'קרין בן ניזרי', phone: '', practitioner: true, color: 'pink' });
  assert.equal(karin.status, 200);
  const k = tables.lead_staff.find((s) => s.name === 'קרין בן ניזרי');
  assert.deepEqual([k.phone, k.practitioner, k.color, k.business_id], [null, true, 'pink', BIZ], 'no number: a person who gets no messages');
  // a second one with no number is not "the same number"
  assert.equal((await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'staff.save', name: 'גל שחר', practitioner: true, color: 'turquoise' })).status, 200);
  // a person of the team becomes a practitioner, with a colour — her name and number untouched
  const dana = tables.lead_staff.find((s) => s.id === 'dana');
  const set = await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'staff.calendar', id: 'dana', practitioner: true, color: 'yellow' });
  assert.equal(set.status, 200);
  assert.deepEqual([dana.practitioner, dana.color, dana.phone, dana.name], [true, 'yellow', '972501111111', 'דנה']);
  assert.equal((await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'staff.calendar', id: 'dana', color: 'purple' })).status, 400, 'a colour from the list only');
  assert.equal((await call(route, 'POST', '/api/leads/departments', 'u-dana', { action: 'staff.calendar', id: 'dana', color: 'pink' })).status, 403, 'the owner only');
  // a member sees who is a practitioner and her colour — never a number
  const seen = await call(route, 'GET', '/api/leads/departments', 'u-dana');
  const kv = seen.body.staff.find((s: any) => s.id === k.id);
  assert.deepEqual([kv.practitioner, kv.color, kv.phone], [true, 'pink', undefined]);
  assert.equal((await call(route, 'GET', '/api/leads/departments', 'owner')).body.staff.find((s: any) => s.id === k.id).phoneShown, '', 'the owner: no number to show');
  // the test message: there is no number to send it to
  const test1 = await call(route, 'POST', '/api/leads/departments', 'owner', { action: 'test', staffId: k.id });
  assert.deepEqual([test1.status, test1.body.code], [409, 'no_phone']);
  assert.equal(wa.length, 0);

  // a lead moved to her: assigned, and the line says no message went (sent once a number is added)
  const assignment = await import('../src/app/api/leads/assignment/route');
  tables.leads.push({ id: 'lead-k', business_id: BIZ, name: 'מירב', phone: '0500000001', notes: '', department_id: null, assigned_staff_id: null, routed_at: null });
  const moved = await call(assignment, 'POST', '/api/leads/assignment', 'owner', { action: 'assign', leadId: 'lead-k', staffId: k.id, send: true });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.sent.status, 'skipped');
  assert.match(moved.body.sent.message, /אין מספר וואטסאפ ברשימת הצוות — הליד הועבר בלי הודעה/);
  assert.deepEqual(notes('lead-k').map((n) => [n.status, n.reason, n.to_phone]), [['skipped', 'no_phone', '']]);
  assert.equal(tables.leads.find((l) => l.id === 'lead-k').assigned_staff_id, k.id);
  assert.equal(wa.length, 0, 'nothing went to WhatsApp');
  // "לשלוח שוב" with no number yet: still skipped, not sent
  const again = await call(assignment, 'POST', '/api/leads/assignment', 'owner', { action: 'resend', id: notes('lead-k')[0].id });
  assert.equal(again.body.sent?.status ?? again.body.code, 'skipped');
  assert.equal(wa.length, 0);
});
