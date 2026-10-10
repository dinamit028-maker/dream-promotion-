/**
 * Recurring charges (docs/FINANCE_ADDITIONS_HE.md T4; 2.90, migration 20261010004500): the pure rules of the screens and the
 * server — the schedule (the same examples as tests/sql/recurring.check.sql, which holds recurring_date / recurring_on_or_after
 * to them), the labels, the checks before saving, a period's invoice (only for the amount the owner approved) and its draft — and
 * the server with an in-memory database: THE TIMER TWICE MAKES ONE DOCUMENT (and one draft), the link with it (a test link is
 * never emailed), what is held and why. The SQL itself is checked on Postgres (recurring.check.sql, concurrency.sh §16).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';
import { docInvariants } from '../src/features/finance/compose';
import {
  EVERY, chargeKey, chargeLine, chargeNote, composeCharge, customerOfLead, draftBody, everyLabel, firstCharge, newPlanInput, onOrAfter, periodLabel,
  planError, planInputOf, planLine, planTotal, recurringDate, recurringErrorHe, scheduleLabel, toCharge, toRecurringPlan, upcoming, type PlanInput,
} from '../src/features/finance/recurring';

type Row = Record<string, any>;
const TODAY = '2026-10-11';

test('the schedule: the same dates as the database (recurring_date / recurring_on_or_after)', () => {
  assert.equal(recurringDate('2026-01-31', 1, 5, 0), '2026-01-05');
  assert.equal(recurringDate('2026-01-31', 1, 5, 1), '2026-02-05');
  assert.equal(recurringDate('2026-11-10', 3, 28, 1), '2027-02-28');
  assert.equal(recurringDate('2026-03-01', 12, 1, 2), '2028-03-01');
  assert.equal(onOrAfter('2026-01-15', 1, 5, '2026-01-15'), '2026-02-05', 'never before the start');
  assert.equal(onOrAfter('2026-01-05', 1, 5, '2026-01-05'), '2026-01-05', 'a start on the day is the first date');
  assert.equal(onOrAfter('2026-11-10', 3, 28, '2027-01-01'), '2027-02-28', 'every 3 months');
  assert.equal(onOrAfter('2026-03-01', 12, 1, '2026-03-02'), '2027-03-01', 'every year');
  assert.equal(onOrAfter('2026-12-20', 2, 10, '2027-01-11'), '2027-02-10', 'every 2 months, across a year');
  assert.equal(onOrAfter('2026-01-31', 1, 28, '2026-02-01'), '2026-02-28', 'the 28th is in every month');
  assert.equal(onOrAfter('2026-01-15', 1, 5, '2027-01-06'), '2027-02-05');
  assert.equal(onOrAfter('2026-03-31', 1, 28, '2026-03-30'), '2026-04-28');
  assert.equal(recurringDate('2026-10-25', 1, 1, 0), '2026-10-01');
  assert.equal(onOrAfter('2026-01-15', 1, 29, '2026-01-15'), null, 'no day past the 28th');
  // a year of months in a row, every day of a month: each date is the k-th, in order, on the day
  let d = onOrAfter('2026-01-01', 1, 28, '2026-01-01')!;
  for (let k = 0; k < 24; k++) { assert.equal(d, recurringDate('2026-01-01', 1, 28, k)); d = onOrAfter('2026-01-01', 1, 28, d.replace(/28$/, '29'))!; }
});

test('a new plan\'s first charge is never in the past; the next ones stop at the end', () => {
  assert.equal(firstCharge(TODAY, 1, 11, TODAY), '2026-10-11', 'today, on the day');
  assert.equal(firstCharge(TODAY, 1, 5, TODAY), '2026-11-05', 'the 5th passed: next month');
  assert.equal(firstCharge('2026-08-01', 1, 5, TODAY), '2026-11-05', 'a start in the past: from today on');
  assert.equal(firstCharge('2026-12-20', 1, 5, TODAY), '2027-01-05', 'a start ahead: from the start');
  assert.deepEqual(upcoming({ startDate: TODAY, every: 1, day: 11, nextDate: '2026-10-11', endDate: null }, 3), ['2026-10-11', '2026-11-11', '2026-12-11']);
  assert.deepEqual(upcoming({ startDate: TODAY, every: 3, day: 11, nextDate: '2026-10-11', endDate: '2027-02-01' }, 5), ['2026-10-11', '2027-01-11'], 'up to the end');
});

test('the words: how often, the period, the document\'s note and key', () => {
  assert.deepEqual(EVERY.map((e) => e.months), [1, 2, 3, 6, 12]);
  assert.equal(everyLabel(3), 'כל 3 חודשים');
  assert.equal(scheduleLabel(1, 5), 'כל חודש ב-5 לחודש');
  assert.equal(scheduleLabel(12, 5, '2027-03-05'), 'כל שנה ב-5 במרץ');
  assert.equal(periodLabel('2026-11-05', 1), 'נובמבר 2026');
  assert.equal(periodLabel('2026-11-05', 3), 'נובמבר 2026 – ינואר 2027');
  assert.equal(periodLabel('2026-10-05', 12), 'אוקטובר 2026 – ספטמבר 2027');
  assert.equal(chargeNote(' ריטיינר שיווק ', '2026-11-05', 1), 'חיוב חוזר: ריטיינר שיווק · נובמבר 2026');
  assert.equal(chargeKey('p1', '2026-11-05'), 'recurring:p1:2026-11-05');
  assert.ok(chargeKey('00000000-0000-4000-8000-000000000001', '2026-11-05').length <= 120, 'within the documents\' key');
});

test('a period comes to the lines with the business\'s VAT; the checks before saving', () => {
  const lines = [{ name: 'ריטיינר', qty: 1, unitPrice: 1000 }, { name: '', qty: 1, unitPrice: 0 }];
  assert.equal(planTotal(lines, true, 'company', 18), 1000, 'prices with VAT: as typed (the empty row is ignored)');
  assert.equal(planTotal(lines, false, 'company', 18), 1180, 'prices before VAT: + 18%');
  assert.equal(planTotal(lines, false, 'exempt_dealer', 18), 1000, 'an exempt dealer adds no VAT');
  const ok: PlanInput = { ...newPlanInput(TODAY, 'lead-1'), name: 'ריטיינר', lines };
  assert.equal(ok.day, 11, 'today\'s day');
  assert.equal(newPlanInput('2026-10-31').day, 28, 'at most the 28th');
  assert.equal(planError(ok, 1000, TODAY), null);
  assert.match(planError({ ...ok, leadId: null }, 1000, TODAY)!, /לקוח/);
  assert.match(planError({ ...ok, name: '  ' }, 1000, TODAY)!, /שם/);
  assert.match(planError({ ...ok, lines: [{ name: '', qty: 1, unitPrice: 0 }] }, 0, TODAY)!, /לפחות שורה/);
  assert.match(planError({ ...ok, lines: [{ name: 'x', qty: 0, unitPrice: 10 }] }, 0, TODAY)!, /כמות/);
  assert.match(planError(ok, 0, TODAY)!, /גדול מאפס/);
  assert.match(planError(ok, 1_000_001, TODAY)!, /גדול מדי/);
  assert.match(planError({ ...ok, every: 4 }, 1000, TODAY)!, /כל כמה זמן/);
  assert.match(planError({ ...ok, day: 29 }, 1000, TODAY)!, /בין 1 ל-28/);
  assert.match(planError({ ...ok, startDate: '2025-09-01' }, 1000, TODAY)!, /עד שנה/);
  assert.equal(planError({ ...ok, startDate: '2025-09-01' }, 1000, TODAY, { charged: true, startWas: '2025-09-01' }), null, 'a plan that charged keeps its old start');
  assert.match(planError({ ...ok, endDate: '2026-10-01' }, 1000, TODAY)!, /לפני ההתחלה/);
  assert.match(planError({ ...ok, day: 5, endDate: '2026-10-31' }, 1000, TODAY)!, /05\/11\/2026 — אחרי תאריך הסיום/, 'the first charge after the end');
  assert.match(planError({ ...ok, note: 'x'.repeat(301) }, 1000, TODAY)!, /הערה/);
});

test('the database\'s refusals in Hebrew', () => {
  assert.match(recurringErrorHe({ message: 'recurring_schedule: a plan that charged keeps its schedule' }), /מסיימים את החיוב החוזר ופותחים חדש/);
  assert.match(recurringErrorHe({ message: 'recurring_customer: a plan keeps its customer (a new plan for another)' }), /אותו לקוח/);
  assert.match(recurringErrorHe({ message: 'recurring_customer: a customer of this business' }), /לא נמצא/);
  assert.match(recurringErrorHe({ message: 'recurring_end: no charge before the end date' }), /אחרי תאריך הסיום/);
  assert.match(recurringErrorHe({ message: 'recurring_lines: line 2 — the item' }), /קטלוג/);
  assert.match(recurringErrorHe({ message: 'recurring_ended: an ended plan does not change' }), /הסתיים/);
  assert.match(recurringErrorHe({ message: 'not allowed', code: '42501' }), /הרשאה/);
  assert.match(recurringErrorHe({ message: 'something else' }), /לא נשמר/);
});

const plan = (o: Row = {}) => toRecurringPlan({
  id: 'p1', lead_id: 'lead-1', user_id: 'u1', name: 'ריטיינר שיווק', lines: [{ name: 'ריטיינר שיווק', qty: 1, unitPrice: 1180 }], prices_include_vat: true,
  amount: 1180, every_months: 1, day_of_month: 11, start_date: TODAY, end_date: null, next_date: TODAY, mode: 'issue', send_link: true, status: 'active', note: '',
  paused_at: null, ended_at: null, end_reason: '', created_at: '2026-10-11T08:00:00Z', ...o,
});
const ctx = { entity: 'company' as const, vatRate: 18, terms: 'net_30', customer: customerOfLead({ name: 'נועה לוי', phone: '0501111111', email: 'noa@x.test' }), today: TODAY };

test('a period\'s invoice: the business\'s invoice, due by its terms, with the note — only for the approved amount', () => {
  const res = composeCharge(plan(), '2026-10-11', ctx);
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.doc.docType, 305, 'a VAT business: a tax invoice');
  assert.equal(res.doc.total, 1180);
  assert.equal(res.doc.vatAmount, 180);
  assert.equal(res.doc.dueDate, '2026-11-10', 'net 30');
  assert.equal(res.doc.notes, 'חיוב חוזר: ריטיינר שיווק · אוקטובר 2026');
  assert.equal(res.doc.customerEmail, 'noa@x.test');
  assert.deepEqual(docInvariants(res.doc, 18), [], 'inside the database\'s rules');
  const exempt = composeCharge(plan({ amount: 1180 }), '2026-10-11', { ...ctx, entity: 'exempt_dealer' });
  assert.ok(exempt.ok && exempt.doc.docType === 300 && exempt.doc.vatAmount === 0, 'an exempt dealer: a transaction invoice, no VAT');
  const moved = composeCharge(plan({ prices_include_vat: false, lines: [{ name: 'ריטיינר', qty: 1, unitPrice: 1000 }], amount: 1180 }), '2026-10-11', { ...ctx, vatRate: 19 });
  assert.ok(!moved.ok);
  assert.match(!moved.ok ? moved.errors[0] : '', /הסכום יצא ₪1,190 ולא ₪1,180/, 'a VAT rate that moved: held for the owner, never an amount nobody saw');
  const badDealer = composeCharge(plan(), '2026-10-11', { ...ctx, customer: customerOfLead({ name: 'חברה', billing_dealer: '123456789' }) });
  assert.ok(!badDealer.ok && /מספר העוסק/.test(badDealer.errors.join(' ')), 'a customer\'s dealer number that is not one');
  const body = draftBody(plan(), '2026-10-11', ctx);
  assert.deepEqual([body.lines.length, body.pricesIncludeVat, body.discount, body.notes, body.terms, body.dueDate, body.payments],
    [1, true, { kind: 'sum', value: 0 }, 'חיוב חוזר: ריטיינר שיווק · אוקטובר 2026', 'net_30', '2026-11-10', []], 'the draft the composer opens');
});

test('the customer on the document: the card\'s billing details first; a broken email is left out', () => {
  assert.deepEqual(customerOfLead({ name: 'דנה', phone: '050', email: 'not-an-email', billing_name: 'דנה בע"מ', billing_dealer: '514000004', billing_street: 'הרצל 1', billing_city: 'חיפה' }),
    { name: 'דנה בע"מ', phone: '050', email: '', dealer: '514000004', street: 'הרצל 1', city: 'חיפה' });
  assert.equal(customerOfLead({ name: 'נועה' }).name, 'נועה');
});

test('the screens\' lines: a charge and a plan', () => {
  assert.deepEqual(chargeLine({ status: 'issued', draftId: null, error: '' }), { text: 'הופק', tone: 'ok' });
  assert.deepEqual(chargeLine({ status: 'draft', draftId: 'd1', error: '' }), { text: 'טיוטה לאישור', tone: 'warn' });
  assert.deepEqual(chargeLine({ status: 'draft', draftId: null, error: '' }), { text: 'הטיוטה נמחקה — לא חויב', tone: 'default' });
  assert.deepEqual(chargeLine({ status: 'blocked', draftId: null, error: 'חסר מספר עוסק' }), { text: 'לא הופק: חסר מספר עוסק', tone: 'bad' });
  assert.equal(chargeLine({ status: 'pending', draftId: null, error: '' }).text, 'ממתין להפקה');
  assert.equal(planLine(plan()), 'החיוב הבא: 11/10/2026');
  assert.equal(planLine(plan({ status: 'paused', paused_at: 'x' })), 'מושהה — לא מחייב עד שממשיכים');
  assert.equal(planLine(plan({ status: 'ended', ended_at: 'x', end_reason: 'הגיע תאריך הסיום' })), 'הסתיים · הגיע תאריך הסיום');
  assert.deepEqual(planInputOf(plan()).lines, [{ name: 'ריטיינר שיווק', qty: 1, unitPrice: 1180 }]);
  const c = toCharge({ id: 'c1', plan_id: 'p1', period_date: TODAY, status: 'issued', document_id: 'd1', draft_id: null, paylink_id: 'l1', note: 'n', error: '', attempts: 1,
    created_at: 'a', updated_at: 'b' });
  assert.deepEqual([c.documentId, c.paylinkId, c.attempts], ['d1', 'l1', 1]);
});

// ---- the server, with an in-memory database --------------------------------------------------------------------------------------
const B1 = '00000000-0000-4000-8000-0000000000b1';
const LEAD = '00000000-0000-4000-8000-00000000c001';
const OWN = 'user-own';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tables: Record<string, Row[]> = {};
let answerFails = 0;
const rpcCalls: { fn: string; args: Row }[] = [];
function reset() {
  for (const k of Object.keys(tables)) delete tables[k];
  rpcCalls.length = 0; answerFails = 0;
  Object.assign(tables, {
    businesses: [{ id: B1, name: 'Clinic A', status: 'active', paid_until: null, grace_days: 0 }],
    business_members: [{ business_id: B1, user_id: OWN, role: 'owner', access: 'full', created_at: '2026-01-01' }],
    register_settings: [{ business_id: B1, entity_type: 'company', business_type: 'licensed', vat_rate: 18, legal_name: 'קליניקה א בע"מ' }],
    business_finance_profile: [{ business_id: B1, trading_name: 'לייזר א', payment_terms: 'net_30' }],
    leads: [{ id: LEAD, business_id: B1, name: 'נועה לוי', phone: '0501111111', email: 'noa@x.test', billing_name: '', billing_dealer: '', billing_street: '', billing_city: '' }],
    recurring_plans: [{ id: id(1), business_id: B1, lead_id: LEAD, user_id: OWN, name: 'ריטיינר שיווק', lines: [{ name: 'ריטיינר שיווק', qty: 1, unitPrice: 1180 }],
      prices_include_vat: true, amount: 1180, every_months: 1, day_of_month: 11, start_date: TODAY, end_date: null, next_date: '2026-11-11', mode: 'issue',
      send_link: true, status: 'active', note: '', paused_at: null, ended_at: null, end_reason: '', created_at: '2026-10-01T08:00:00Z' }],
    recurring_charges: [{ id: id(11), business_id: B1, plan_id: id(1), period_date: TODAY, status: 'pending', document_id: null, draft_id: null, paylink_id: null,
      note: '', error: '', attempts: 0 }],
    documents: [], document_drafts: [], payment_requests: [], email_outbox: [], push_subscriptions: [], brands: [],
  });
}
const db = () => fakeDb(tables, {
  onInsert: (table, row, all) => {
    if (table === 'documents') {
      if (all.some((d) => d.business_id === row.business_id && d.idempotency_key === row.idempotency_key)) {
        return { code: '23505', message: 'duplicate key value violates unique constraint "documents_idempotency_uq"', details: 'Key (business_id, idempotency_key)' } as any;
      }
      row.id ??= id(9000 + all.length); row.doc_number ??= all.length + 1;
    }
    if (table === 'document_drafts' && all.some((d) => d.id === row.id)) return { code: '23505', message: 'duplicate key value violates unique constraint "document_drafts_pkey"' };
    return null;
  },
}).from;
function rpc(fn: string, a: Row): { data: any; error: any } {
  rpcCalls.push({ fn, args: a });
  const charge = (x: string) => tables.recurring_charges.find((c) => c.id === x);
  switch (fn) {
    case 'recurring_due': return { data: tables.recurring_charges.filter((c) => c.status === 'pending').map((c) => { c.attempts += 1; return c.id; }), error: null };
    case 'recurring_charge_done': {
      if (answerFails > 0) { answerFails -= 1; return { data: null, error: { message: 'connection reset' } }; }
      const c = charge(a.p_charge);
      if (!c) return { data: 'not_found', error: null };
      if (c.status === 'issued' || (c.status === 'draft' && a.p_status !== 'issued')) { if (c.status === a.p_status) c.paylink_id ??= a.p_paylink; return { data: c.status, error: null }; }
      Object.assign(c, { status: a.p_status, document_id: a.p_document ?? c.document_id, draft_id: a.p_draft ?? c.draft_id, paylink_id: a.p_paylink ?? c.paylink_id,
        note: a.p_note, error: a.p_status === 'blocked' ? a.p_error || 'לא הופק' : '' });
      return { data: a.p_status, error: null };
    }
    case 'paylink_create': {
      if (!tables.documents.some((d) => d.id === a.p_target && d.business_id === a.p_business)) return { data: null, error: { message: 'paylink_not_found', code: '42501' } };
      const live = tables.payment_accounts?.some((x) => x.business_id === a.p_business && x.mode === 'live');
      const row = { id: id(100 + tables.payment_requests.length), business_id: a.p_business, user_id: a.p_user, kind: a.p_kind, document_id: a.p_target, amount: a.p_amount,
        status: 'sent', is_test: !live, link_origin: a.p_origin, sent_via: a.p_via, sends: 1, customer_email: 'noa@x.test', customer_name: 'נועה לוי', label: 'חשבונית מס',
        expires_at: new Date(Date.now() + a.p_days * 864e5).toISOString() };
      tables.payment_requests.push(row);
      return { data: row, error: null };
    }
    case 'paylink_sent': { const r = tables.payment_requests.find((x) => x.id === a.p_request); if (!r) return { data: false, error: null }; r.sends += 1; r.sent_via = a.p_via; return { data: true, error: null }; }
    case 'paylink_email': { tables.email_outbox.push({ request_id: a.p_request, kind: 'payment_link', ref: a.p_ref }); return { data: true, error: null }; }
    case 'email_outbox_claim': return { data: [], error: null };
    default: return { data: null, error: { message: `function ${fn} not found`, code: 'PGRST202' } };
  }
}
before(() => {
  (globalThis as any).__DP_TEST_ADMIN_DB__ = { from: (t: string) => db()(t), rpc: async (fn: string, a: Row) => rpc(fn, a ?? {}) };
});
beforeEach(() => {
  reset();
  process.env.ORDER_LINK_SECRET = 'order-link-secret-0123456789';
  process.env.APP_URL = 'https://app.test';
  delete process.env.RESEND_API_KEY; delete process.env.VAPID_PRIVATE_KEY; delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
});

test('THE TIMER TWICE → ONE DOCUMENT: a lost answer, then the next run finds the invoice by its key (DoD)', async () => {
  const { recurringCron } = await import('../src/lib/server/recurring');
  answerFails = 1;                                                      // the database did not hear the first answer
  const first = await recurringCron();
  assert.equal(first?.waiting, 1, 'the answer was lost: it waits for the next run');
  assert.equal(tables.documents.length, 1, 'the invoice was issued');
  const second = await recurringCron();
  assert.equal(second?.issued, 1);
  const docs = tables.documents.filter((d) => d.idempotency_key === `recurring:${id(1)}:${TODAY}`);
  assert.equal(docs.length, 1, 'one invoice for the plan and period, however many runs');
  assert.equal(tables.payment_requests.length, 1, 'one link for it too');
  const c = tables.recurring_charges[0];
  assert.deepEqual([c.status, c.document_id, c.paylink_id], ['issued', docs[0].id, tables.payment_requests[0].id]);
  assert.equal(docs[0].doc_type, 305); assert.equal(Number(docs[0].total), 1180); assert.equal(docs[0].lead_id, LEAD); assert.equal(docs[0].user_id, OWN);
  assert.equal(docs[0].notes, 'חיוב חוזר: ריטיינר שיווק · אוקטובר 2026');
  assert.equal(await recurringCron().then((r) => r?.charges), 0, 'a third run: nothing is waiting');
});

test('a test link is never emailed to the customer; a real one is (when the card has an email)', async () => {
  const { recurringCron } = await import('../src/lib/server/recurring');
  await recurringCron();
  assert.match(tables.recurring_charges[0].note, /לינק בדיקה/);
  assert.equal(tables.email_outbox.length, 0, 'no email for a test link');
  // a real terminal (and the switch, in the database): the link goes by email
  reset();
  tables.payment_accounts = [{ business_id: B1, mode: 'live' }];
  await recurringCron();
  assert.equal(tables.recurring_charges[0].note, 'הלינק נשלח ללקוח/ה במייל.');
  assert.deepEqual(tables.email_outbox.map((e) => e.kind), ['payment_link']);
  assert.equal(rpcCalls.find((c) => c.fn === 'paylink_create')?.args.p_via, 'link', 'made as a link, then sent by email');
  // no email on the card: ready, sent from the document
  reset();
  tables.payment_accounts = [{ business_id: B1, mode: 'live' }];
  tables.leads[0].email = '';
  await recurringCron();
  assert.match(tables.recurring_charges[0].note, /אין מייל בכרטיס/);
  assert.equal(tables.email_outbox.length, 0);
});

test('no link asked (a standing order), or none possible: the invoice is issued anyway, with why', async () => {
  const { recurringCron } = await import('../src/lib/server/recurring');
  tables.recurring_plans[0].send_link = false;
  await recurringCron();
  assert.deepEqual([tables.recurring_charges[0].status, tables.recurring_charges[0].paylink_id, tables.payment_requests.length], ['issued', null, 0]);
  reset();
  delete process.env.APP_URL;
  await recurringCron();
  assert.equal(tables.recurring_charges[0].status, 'issued');
  assert.match(tables.recurring_charges[0].note, /APP_URL/);
  reset();
  process.env.APP_URL = 'https://app.test';
  delete process.env.ORDER_LINK_SECRET;
  await recurringCron();
  assert.equal(tables.recurring_charges[0].status, 'issued');
  assert.match(tables.recurring_charges[0].note, /לא נוצר לינק לתשלום: .*ORDER_LINK_SECRET/);
});

test('a draft for the owner: one draft with the charge\'s id, however many runs', async () => {
  const { recurringCron } = await import('../src/lib/server/recurring');
  tables.recurring_plans[0].mode = 'draft';
  answerFails = 1;
  await recurringCron();
  await recurringCron();
  assert.equal(tables.document_drafts.length, 1, 'one draft');
  const d = tables.document_drafts[0];
  assert.deepEqual([d.id, d.doc_type, Number(d.total), d.lead_id, d.business_id, d.user_id], [id(11), 305, 1180, LEAD, B1, OWN]);
  assert.equal(d.body.notes, 'חיוב חוזר: ריטיינר שיווק · אוקטובר 2026');
  assert.deepEqual([tables.recurring_charges[0].status, tables.recurring_charges[0].draft_id], ['draft', id(11)]);
  assert.equal(tables.documents.length, 0, 'no document until the owner issues it');
});

test('held with why: an amount that moved, a customer that is gone, a business without its details', async () => {
  const { recurringCron } = await import('../src/lib/server/recurring');
  tables.recurring_plans[0].amount = 1000;
  await recurringCron();
  assert.equal(tables.recurring_charges[0].status, 'blocked');
  assert.match(tables.recurring_charges[0].error, /^לא הופק: הסכום יצא ₪1,180 ולא ₪1,000/);
  assert.equal(tables.documents.length, 0, 'nothing issued');
  reset();
  tables.leads.length = 0;
  await recurringCron();
  assert.equal(tables.recurring_charges[0].error, 'הלקוח/ה של החיוב החוזר לא נמצא/ה.');
  reset();
  tables.recurring_plans[0].user_id = null; tables.business_members.length = 0;
  await recurringCron();
  assert.equal(tables.recurring_charges[0].error, 'לא נמצא בעל/ת העסק להפקת המסמך.');
  // the database refuses the document for a reason only the business can fix: held; a passing failure: waits
  reset();
  const saved = (globalThis as any).__DP_TEST_ADMIN_DB__.from;
  (globalThis as any).__DP_TEST_ADMIN_DB__.from = (t: string) => (t === 'documents'
    ? { ...db()(t), insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'business_details_missing', code: '23514' } }) }) }) }
    : db()(t));
  try {
    await recurringCron();
    assert.equal(tables.recurring_charges[0].status, 'blocked');
    assert.match(tables.recurring_charges[0].error, /פרטי העסק/);
    reset();
    (globalThis as any).__DP_TEST_ADMIN_DB__.from = (t: string) => (t === 'documents'
      ? { ...db()(t), insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }) }) }) }
      : db()(t));
    const r = await recurringCron();
    assert.deepEqual([r?.waiting, tables.recurring_charges[0].status], [1, 'pending'], 'a passing failure: the next run tries again');
  } finally { (globalThis as any).__DP_TEST_ADMIN_DB__.from = saved; }
});

test('who issues it: the one who made the plan while they still write the money — else the business\'s owner', async () => {
  const { recurringCron } = await import('../src/lib/server/recurring');
  tables.business_members.push({ business_id: B1, user_id: 'user-staff', role: 'editor', access: 'full', created_at: '2026-02-01' });
  tables.recurring_plans[0].user_id = 'user-staff';
  await recurringCron();
  assert.equal(tables.documents[0].user_id, 'user-staff', 'the staff member who made it');
  reset();
  tables.recurring_plans[0].user_id = 'user-left';                      // no longer a member of the business
  await recurringCron();
  assert.equal(tables.documents[0].user_id, OWN, 'one who left: the owner');
  reset();
  tables.business_members.push({ business_id: B1, user_id: 'user-viewer', role: 'viewer', access: 'full', created_at: '2026-02-01' });
  tables.recurring_plans[0].user_id = 'user-viewer';                    // now only reads
  await recurringCron();
  assert.equal(tables.documents[0].user_id, OWN, 'one who only reads now: the owner');
});

test('a locked business waits; before migration 4500 the timer does nothing; a real failure is reported', async () => {
  const { recurringCron } = await import('../src/lib/server/recurring');
  tables.businesses[0].status = 'locked';
  const r = await recurringCron();
  assert.deepEqual([r?.waiting, tables.recurring_charges[0].status, tables.documents.length], [1, 'pending', 0]);
  const saved = (globalThis as any).__DP_TEST_ADMIN_DB__.rpc;
  (globalThis as any).__DP_TEST_ADMIN_DB__.rpc = async () => ({ data: null, error: { message: 'Could not find the function public.recurring_due in the schema cache', code: 'PGRST202' } });
  try {
    assert.equal(await recurringCron(), null, 'not an error every 2 minutes');
    (globalThis as any).__DP_TEST_ADMIN_DB__.rpc = async () => ({ data: null, error: { message: 'boom' } });
    await assert.rejects(recurringCron(), /boom/);
  } finally { (globalThis as any).__DP_TEST_ADMIN_DB__.rpc = saved; }
});
