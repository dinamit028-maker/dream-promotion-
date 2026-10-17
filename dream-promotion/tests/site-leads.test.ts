/**
 * The site's requests (2.102, migration 20261017005400): "בקשת הצעת מחיר" of a product sold by a quote, and the contact form.
 * Pure rules (features/crm/site-leads.ts): what a department's rule sees, the message's details, which department. Then the
 * server end to end with an in-memory database and a fake WhatsApp Cloud API: a request recorded by the storefront is routed
 * once — the contact gets its department and person, one message goes to that person only, the owners get a push — whether the
 * storefront's call or the cron comes first; a known contact keeps its person; without the token nothing is sent; the route
 * answers the storefront's server only. And a product sold by a quote: the editor's rules and columns (catalog.ts).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { fakeDb } from './fakedb';
import { NO_DEPARTMENT, leadTemplateParams, type RoutingDept } from '../src/features/crm/lead-routing';
import { routeSite, siteDetails, siteFacts, siteFormName, type SiteRequest } from '../src/features/crm/site-leads';
import { draftError, emptyDraft, itemColumns, itemColumnsOf, toCatalogItem, draftOf } from '../src/features/catalog/catalog';

const DEPTS: RoutingDept[] = [
  { id: 'pack', name: 'אריזות וסורסינג', staffId: 'gal', position: 0, rules: [] },
  { id: 'src', name: 'סורסינג', staffId: 'sagit', position: 1, rules: [{ kind: 'answer', question: 'נושא', answer: 'סורסינג ומוצרים' }] },
];
const req = (p: Partial<SiteRequest> = {}): SiteRequest => ({
  id: 'r1', business_id: 'biz', kind: 'quote', item_id: 'item-1', model: 'bag-001', item_name: 'שקית נייר עם ידית חבל – דגם 001', lead_id: 'lead-1',
  new_contact: true, name: 'דנה כהן', phone: '0501234567', email: '', qty: 1000, topic: '', notes: 'לוגו בזהב', page: '/products/bag-001', preview: false,
  created_at: new Date().toISOString(), ...p,
});

// ------------------------------------------------------------------------------------------------------------ pure --
test('what a department\'s rule sees of a request: its source, its kind, a topic and a model when given', () => {
  assert.deepEqual(siteFacts(req()).fields, [
    { key: 'source', label: 'מקור', values: ['אתר'] }, { key: 'kind', label: 'סוג הפנייה', values: ['הצעת מחיר'] },
    { key: 'model', label: 'דגם', values: ['bag-001'] },
  ]);
  assert.deepEqual(siteFacts(req({ kind: 'contact', model: '', topic: 'סורסינג ומוצרים' })).fields.map((f) => f.values[0]), ['אתר', 'פנייה', 'סורסינג ומוצרים']);
  assert.equal(siteFacts(req()).formName, siteFormName('quote'));
});

test('the department: a rule first, then the site\'s department, then the default recipient', () => {
  const contact = req({ kind: 'contact', model: '', topic: 'סורסינג ומוצרים' });
  assert.equal(routeSite(DEPTS, contact, DEPTS[0], null).departmentId, 'src', 'the rule "נושא" wins over the site\'s department');
  const r = routeSite(DEPTS, req(), DEPTS[0], 'sagit');
  assert.deepEqual([r.departmentId, r.staffId, r.by], ['pack', 'gal', 'פנייה מהאתר'], 'no rule: the department chosen for the site');
  const none = routeSite(DEPTS, req(), null, 'sagit');
  assert.deepEqual([none.departmentId, none.departmentName, none.staffId, none.viaDefault], [null, NO_DEPARTMENT, 'sagit', true], 'else the default recipient');
  assert.equal(routeSite(DEPTS, req(), null, null).staffId, null, 'else nobody');
});

test('the message: what was asked, in one line of the template ({{4}})', () => {
  const details = siteDetails(req({ email: 'dana@example.com' }));
  assert.equal(details.split('\n')[0], 'בקשת הצעת מחיר מהאתר');
  assert.match(details, /דגם: bag-001 — שקית נייר עם ידית חבל – דגם 001/);
  assert.match(details, /כמות: 1,000/);
  const params = leadTemplateParams({ department: 'אריזות וסורסינג', name: 'דנה כהן', phone: '0501234567', details });
  assert.equal(params.length, 5);
  assert.ok(!/\n/.test(params[3]), 'one line');
  assert.match(params[3], /בקשת הצעת מחיר מהאתר · דגם: bag-001/);
  assert.equal(params[4], 'https://wa.me/972501234567', 'the customer\'s phone is a value in the message, never the recipient');
  assert.match(siteDetails(req({ preview: true })), /בדיקה מהתצוגה המקדימה/);
});

// ---------------------------------------------------------------------------------------------- the server, end to end --
type Row = Record<string, any>;
const BIZ = 'biz';
const tables: Record<string, Row[]> = {};
let wa: { to: string; params: string[] }[] = [];
let pushes: { endpoint: string; title: string; body: string }[] = [];
function reset() {
  for (const k of Object.keys(tables)) delete tables[k];
  Object.assign(tables, {
    business_members: [{ business_id: BIZ, user_id: 'owner', role: 'owner', access: 'full' }],
    push_subscriptions: [{ id: 'ps1', user_id: 'owner', endpoint: 'https://push.test/owner', keys: { p256dh: 'x', auth: 'y' } }],
    lead_staff: [
      { id: 'gal', business_id: BIZ, name: 'גל', phone: '972501110988', active: true, member_user_id: null },
      { id: 'sagit', business_id: BIZ, name: 'שגית', phone: '972501110969', active: true, member_user_id: null },
    ],
    lead_departments: [{ id: 'pack', business_id: BIZ, name: 'אריזות וסורסינג', staff_id: 'gal', position: 0, active: true }],
    lead_department_rules: [],
    lead_routing: [{ business_id: BIZ, default_staff_id: null, site_department_id: 'pack' }],
    lead_notifications: [],
    leads: [
      { id: 'lead-1', business_id: BIZ, name: 'דנה כהן', phone: '0501234567', assigned_staff_id: null, department_id: null },
      { id: 'lead-2', business_id: BIZ, name: 'רינה', phone: '0527778888', assigned_staff_id: 'sagit', department_id: null },
    ],
    site_requests: [
      { ...req(), routed_at: null },
      { ...req({ id: 'r2', kind: 'contact', model: '', item_id: null, item_name: '', lead_id: 'lead-2', new_contact: false, name: 'רינה', phone: '0527778888', qty: null }), routed_at: null },
    ],
  });
}
const unique = (t: string, r: Row, all: Row[]) =>
  t === 'lead_notifications' && all.some((x) => x.business_id === r.business_id && x.dedupe_key === r.dedupe_key)
    ? { code: '23505', message: 'duplicate key value violates unique constraint "lead_notifications_once"' } : null;

before(async () => {
  const keys = webpush.generateVAPIDKeys();
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = keys.publicKey; process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  (webpush as any).sendNotification = async (sub: { endpoint: string }, payload: string) => { const p = JSON.parse(payload); pushes.push({ endpoint: sub.endpoint, title: p.title, body: p.body }); return {}; };
  (globalThis as any).__DP_TEST_ADMIN_DB__ = fakeDb(tables, { onInsert: unique });
  globalThis.fetch = (async (u: any, init: any = {}) => {
    const path = new URL(String(u)).pathname.replace(/^\/v[\d.]+/, '');
    assert.equal(path, '/PNID/messages', 'only WhatsApp is called');
    const b = JSON.parse(init.body);
    wa.push({ to: b.to, params: b.template.components[0].parameters.map((x: any) => x.text) });
    return new Response(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: b.to, wa_id: b.to }], messages: [{ id: `wamid.${wa.length}` }] }), { status: 200 });
  }) as any;
});
beforeEach(() => {
  reset();
  process.env.WHATSAPP_TOKEN = 'EAAG-test-token'; process.env.WHATSAPP_PHONE_NUMBER_ID = 'PNID'; process.env.WHATSAPP_WABA_ID = 'WABA';
  process.env.COMMERCE_SECRET = 'site-leads-test-secret-0123456789';
  wa = []; pushes = [];
});

test('a quote request: the department chosen for the site, its person on the contact, one WhatsApp to them, the owners told — once', async () => {
  const { routeSiteRequest } = await import('../src/lib/server/site-leads');
  const r = await routeSiteRequest('r1');
  assert.equal(r.status, 'routed');
  assert.equal(r.sent, 'sent');
  const lead = tables.leads.find((l) => l.id === 'lead-1')!;
  assert.deepEqual([lead.department_id, lead.assigned_staff_id, lead.routed_by], ['pack', 'gal', 'פנייה מהאתר']);
  assert.equal(wa.length, 1);
  assert.equal(wa[0].to, '972501110988', 'to גל — the person responsible, never the customer');
  assert.equal(wa[0].params[0], 'אריזות וסורסינג');
  assert.match(wa[0].params[3], /בקשת הצעת מחיר מהאתר · דגם: bag-001/);
  assert.equal(tables.lead_notifications[0].dedupe_key, 'site:r1:gal');
  assert.ok(tables.site_requests.find((x) => x.id === 'r1')!.routed_at, 'marked routed');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /בקשת הצעת מחיר מהאתר/);
  // the cron (or a retry of the storefront's call) after it: nothing more
  assert.equal((await routeSiteRequest('r1')).status, 'already');
  const { siteRequestsCron } = await import('../src/lib/server/site-leads');
  const cron = await siteRequestsCron(Date.now() + 30_000);
  assert.equal(cron?.routed, 1, 'the cron routes only the request still waiting (r2)');
  assert.equal(tables.lead_notifications.filter((n) => n.dedupe_key.startsWith('site:r1:')).length, 1, 'r1 was never sent twice');
});

test('a known contact keeps its person; the routed person still gets the message (as with a Meta lead)', async () => {
  const { routeSiteRequest } = await import('../src/lib/server/site-leads');
  const r = await routeSiteRequest('r2');
  assert.equal(r.status, 'routed');
  const lead = tables.leads.find((l) => l.id === 'lead-2')!;
  assert.equal(lead.assigned_staff_id, 'sagit', 'not moved to the site\'s department');
  assert.equal(wa.length, 1);
  assert.equal(wa[0].to, '972501110988', 'the message goes by the routing (the department\'s person)');
});

test('two at once (the storefront\'s call and the cron): routed once, one message', async () => {
  const { routeSiteRequest } = await import('../src/lib/server/site-leads');
  const [a, b] = await Promise.all([routeSiteRequest('r1'), routeSiteRequest('r1')]);
  assert.deepEqual([a.status, b.status].sort(), ['already', 'routed']);
  assert.equal(wa.length, 1);
  assert.equal(pushes.length, 1);
});

test('WhatsApp not connected: the contact is still routed; the message waits as "skipped" for the owner', async () => {
  delete process.env.WHATSAPP_TOKEN;
  const { routeSiteRequest } = await import('../src/lib/server/site-leads');
  const r = await routeSiteRequest('r1');
  assert.equal(r.status, 'routed');
  assert.equal(wa.length, 0);
  assert.deepEqual([tables.lead_notifications[0].status, tables.lead_notifications[0].reason], ['skipped', 'not_connected']);
  assert.equal(tables.leads.find((l) => l.id === 'lead-1')!.assigned_staff_id, 'gal');
});

test('no department and no default recipient: the request is marked, nobody is messaged, the owners still hear', async () => {
  tables.lead_departments.length = 0; tables.lead_routing[0].site_department_id = null;
  const { routeSiteRequest } = await import('../src/lib/server/site-leads');
  const r = await routeSiteRequest('r1');
  assert.equal(r.status, 'routed');
  assert.equal(wa.length, 0);
  assert.equal(pushes.length, 1);
});

test('the route answers the storefront\'s server only', async () => {
  const { POST } = await import('../src/app/api/leads/site/route');
  const call = (body: unknown, secret?: string) => POST(new Request('http://dash.test/api/leads/site', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-commerce-secret': secret } : {}) }, body: JSON.stringify(body),
  }));
  assert.equal((await call({ requestId: '6f1d2c3b-4a59-4e7f-8a1b-2c3d4e5f6a7b' })).status, 403, 'no secret');
  assert.equal((await call({ requestId: '6f1d2c3b-4a59-4e7f-8a1b-2c3d4e5f6a7b' }, 'wrong-secret-0123456789abcdefgh')).status, 403, 'a wrong secret');
  assert.equal((await call({ requestId: 'x' }, process.env.COMMERCE_SECRET)).status, 400);
  const r = await call({ requestId: '6f1d2c3b-4a59-4e7f-8a1b-2c3d4e5f6a7b' }, process.env.COMMERCE_SECRET);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'not_found');
});

// ------------------------------------------------------------------------------------- a product sold by a quote --
test('the editor: a quote\'s "from" price, currency and minimum — checked, and written only when the database has them', () => {
  const d = emptyDraft({ name: 'שקית נייר עם ידית חבל – דגם 001', price: '0', quoteMode: true, quoteFrom: '3.50', quoteCurrency: 'USD', quoteMinQty: '' });
  assert.equal(draftError(d), null);
  assert.equal(draftError({ ...d, quoteFrom: '-1' }), '"החל מ-" צריך להיות מספר, 0 או יותר (עד 2 ספרות אחרי הנקודה) — או ריק.');
  assert.equal(draftError({ ...d, quoteFrom: '3.555' }) !== null, true, 'two digits after the point');
  assert.equal(draftError({ ...d, quoteCurrency: 'GBP' }), 'המטבע של "החל מ-" לא מוכר.');
  assert.equal(draftError({ ...d, quoteMinQty: '0' }), 'כמות מינימום: מספר שלם, 1 ומעלה — או ריק.');
  assert.equal(draftError({ ...d, quoteMinQty: '1,000' }), null, 'a thousands comma is fine');
  assert.equal(draftError({ ...d, kind: 'package' }), 'חבילה לא נמכרת בהצעת מחיר.');
  const cols = itemColumns({ ...d, quoteMinQty: '1,000' }, [], { quote: true });
  assert.deepEqual([cols.quote_mode, cols.quote_from, cols.quote_currency, cols.quote_min_qty], [true, 3.5, 'USD', 1000]);
  assert.equal('quote_mode' in itemColumns(d, []), false, 'before the migration nothing of it is written');
  // a row of the database → the draft → the same columns (nothing changes on a save that changed nothing)
  const row = toCatalogItem({ id: 'i', name: d.name, price: 0, kind: 'product', quote_mode: true, quote_from: 3.5, quote_currency: 'USD', quote_min_qty: null });
  assert.deepEqual(itemColumns(draftOf(row), [], { quote: true }).quote_from, itemColumnsOf(row, { quote: true }).quote_from);
  assert.equal(toCatalogItem({ id: 'j', name: 'x', price: 1 }).quoteMode, false, 'a row from before the migration: sold as before');
});
