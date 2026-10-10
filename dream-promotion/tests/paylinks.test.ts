/**
 * Payment links (docs/FINANCE_ADDITIONS_HE.md T2; 2.88, migration 20261010004300) on the dashboard: the pure rules (statuses —
 * a failure is never shown as paid —, the gate "חבר ספק תשלום", the WhatsApp text, the signed address, a deposit offset), and
 * the server with an in-memory database: THE SAME WEBHOOK TWICE MAKES ONE RECEIPT (the link's own key), the receipt of each
 * kind through the existing documents, a blocked one waits for the owner, who may send and who may not, and the customer's
 * page (nothing internal leaves it; only the storefront's server opens the provider's page). The SQL itself is checked on
 * Postgres (tests/sql/payment-links.check.sql, concurrency.sh §14).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';
import {
  afterDeposit, amountError, depositDays, paylinkEmail, paylinkError, paylinkGate, paylinkMessage, paylinkPill, paylinkState, receiptLine, toPaylink,
} from '../src/features/finance/paylinks';
import { orderRef, paylinkRef, paylinkRefOk } from '../src/lib/server/order-link';
import { docInvariants } from '../src/features/finance/compose';

const SECRET = 'order-link-secret-0123456789';
const COMMERCE = 'commerce-secret-0123456789';
const OWN = 'user-own', VIEW = 'user-view', CASH = 'user-cash';
const B1 = '00000000-0000-4000-8000-0000000000b1', B2 = '00000000-0000-4000-8000-0000000000b2';
const INV = '00000000-0000-4000-8000-00000000d305';
const QUOTE = '00000000-0000-4000-8000-00000000a590';
const LEAD = '00000000-0000-4000-8000-00000000c001';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ---- the pure rules ---------------------------------------------------------------------------------------------------------
test('statuses: an open link past its time reads "פג תוקף"; a failure is red, never paid; a test payment says so', () => {
  const past = new Date(Date.now() - 60_000).toISOString(), soon = new Date(Date.now() + 864e5).toISOString();
  assert.equal(paylinkState({ status: 'sent', expiresAt: past }), 'expired');
  assert.equal(paylinkState({ status: 'failed', expiresAt: past }), 'expired');
  assert.equal(paylinkState({ status: 'paid', expiresAt: past }), 'paid', 'a paid link stays paid');
  assert.deepEqual(paylinkPill({ status: 'failed', expiresAt: soon, isTest: true, paidLate: false }), { text: 'נכשל', tone: 'bad' });
  assert.deepEqual(paylinkPill({ status: 'paid', expiresAt: soon, isTest: true, paidLate: false }), { text: 'שולם (בדיקה)', tone: 'info' });
  assert.deepEqual(paylinkPill({ status: 'paid', expiresAt: soon, isTest: false, paidLate: false }), { text: 'שולם', tone: 'ok' });
  assert.equal(paylinkPill({ status: 'paid', expiresAt: soon, isTest: false, paidLate: true }).text, 'שולם (באיחור)');
  assert.deepEqual(paylinkPill({ status: 'sent', expiresAt: soon, isTest: false, paidLate: false }), { text: 'נשלח', tone: 'warn' });
  assert.equal(paylinkPill({ status: 'cancelled', expiresAt: soon, isTest: false, paidLate: false }).text, 'בוטל');
  assert.equal(receiptLine({ status: 'paid', isTest: true, receiptStatus: 'none', receiptError: '' }), 'תשלום בדיקה — לא כסף אמיתי, בלי קבלה');
  assert.equal(receiptLine({ status: 'paid', isTest: false, receiptStatus: 'awaiting', receiptError: '' }), 'ממתין לאישור הפקת הקבלה');
  assert.match(receiptLine({ status: 'paid', isTest: false, receiptStatus: 'blocked', receiptError: 'חסר מספר עוסק' }), /לא הופקה: חסר מספר עוסק/);
  assert.equal(receiptLine({ status: 'failed', isTest: false, receiptStatus: 'none', receiptError: '' }), '');
});

test('the gate: a link only on a connected AND checked terminal — otherwise "חבר ספק תשלום"; a live one only with the switch', () => {
  const t = { connected: true, provider: 'payplus' as const, mode: 'test' as const, hint: 'ab12', connectedAt: null, ready: true };
  assert.equal(paylinkGate(null).ok, false);
  const none = paylinkGate({ ...t, connected: false });
  assert.ok(!none.ok && none.reason === 'connect' && /חבר ספק תשלום/.test(none.message));
  const unchecked = paylinkGate({ ...t, verifiedAt: null });
  assert.ok(!unchecked.ok && unchecked.reason === 'verify' && /בדיקת חיבור/.test(unchecked.message));
  assert.deepEqual(paylinkGate({ ...t, verifiedAt: '2026-10-10T10:00:00Z' }), { ok: true, test: true });
  const live = paylinkGate({ ...t, mode: 'live', verifiedAt: '2026-10-10T10:00:00Z', linksLive: false });
  assert.ok(!live.ok && live.reason === 'live_closed');
  assert.deepEqual(paylinkGate({ ...t, mode: 'live', verifiedAt: '2026-10-10T10:00:00Z', linksLive: true }), { ok: true, test: false });
});

test('the WhatsApp text, the amount typed, the Hebrew of a refusal', () => {
  const m = paylinkMessage({ name: 'נועה לוי', business: 'לייזר א', label: 'חשבונית מס מס׳ 7', amount: 300, url: 'https://app.test/pay/x.y', expiresAt: '2026-10-17T10:00:00Z', test: true });
  assert.match(m, /^שלום נועה, לתשלום חשבונית מס מס׳ 7 ללייזר א: ₪300/);
  assert.match(m, /https:\/\/app\.test\/pay\/x\.y/);
  assert.match(m, /בתוקף עד 17\.10/);
  assert.match(m, /תשלום בדיקה/);
  assert.equal(amountError('300', 1180), null);
  assert.equal(amountError('299.90', 1180), null);
  assert.match(amountError('1181', 1180)!, /עד ₪1,180/);
  assert.match(amountError('0', 10)!, /גדול מאפס/);
  assert.match(amountError('12.345', 100)!, /סכום בשקלים/);
  assert.match(paylinkError({ message: 'paylink_over_balance: 680.00 left to ask for' }), /עד ₪680/);
  assert.match(paylinkError({ message: 'paylink_over_balance: 0 left to ask for' }), /אין יתרה/);
  assert.match(paylinkError({ message: 'paylink_not_verified: the terminal was not checked yet' }), /בדיקת חיבור/);
  assert.match(paylinkError({ message: 'Could not find the function public.paylink_create', code: 'PGRST202' }), /20261010004300/);
  assert.match(paylinkError({ message: 'paylink_deposit_exists' }), /כבר נשלח לינק למקדמה/);
});

test('the customer\'s address: signed for a link only — an order\'s link never opens it, a changed one opens nothing', () => {
  const ref = paylinkRef(INV, SECRET)!;
  assert.match(ref, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/);
  assert.equal(paylinkRefOk(ref, SECRET), INV);
  assert.equal(paylinkRefOk(orderRef(INV, SECRET)!, SECRET), null, 'an order\'s signature is not a link\'s');
  assert.equal(paylinkRefOk(`${ref.slice(0, -1)}${ref.endsWith('A') ? 'B' : 'A'}`, SECRET), null);
  assert.equal(paylinkRefOk(ref, `${SECRET}-other`), null);
  assert.equal(paylinkRef(INV, 'short'), null, 'no secret: no link at all');
  assert.equal(paylinkRef('not-a-uuid', SECRET), null);
});

test('a deposit offset: the price less what was really paid, named so; a deposit link lives until the appointment', () => {
  assert.deepEqual(afterDeposit('לייזר רגליים', 400, 100), { name: 'לייזר רגליים (יתרה אחרי מקדמה ₪100)', price: 300 });
  assert.deepEqual(afterDeposit('לייזר רגליים', 400, 0), { name: 'לייזר רגליים', price: 400 });
  assert.equal(afterDeposit('x', 50, 100).price, 0, 'never below zero');
  const now = Date.parse('2026-10-10T10:00:00Z');
  assert.equal(depositDays('2026-10-11T09:00:00Z', now), 1);
  assert.equal(depositDays('2026-10-13T12:00:00Z', now), 4);
  assert.equal(depositDays('2026-12-01T12:00:00Z', now), 7);
  assert.equal(depositDays('2026-10-10T08:00:00Z', now), 1);
});

test('the link\'s email: escaped, the link a link, no advertising', () => {
  const e = paylinkEmail({ business: 'לייזר <א>', phone: '03-1234567', email: 'a@b.co', customerName: 'נועה לוי', label: 'הצעת מחיר מס׳ 3', amount: 590,
    url: 'https://app.test/pay/abc.def', expiresAt: '2026-10-17T10:00:00Z', test: false });
  assert.match(e.subject, /^לתשלום: הצעת מחיר מס׳ 3 — לייזר <א>$/);
  assert.ok(!e.html.includes('<א>') && e.html.includes('&lt;א&gt;'), 'escaped');
  assert.match(e.html, /<a href="https:\/\/app\.test\/pay\/abc\.def">/);
  assert.match(e.text, /שלום נועה,/);
  assert.ok(!/בדיקה/.test(e.text), 'a real link says nothing of a test');
});

// ---- the server, with an in-memory database ----------------------------------------------------------------------------------
type Row = Record<string, any>;
const tables: Record<string, Row[]> = {};
const rpcCalls: { fn: string; args: Row }[] = [];
let fetched: { url: string; init: any }[] = [];
let storefrontAnswer: (body: any) => { status: number; json: any } = () => ({ status: 200, json: { ok: true, url: 'https://pay.test/page' } });
const current: Record<string, string> = { [OWN]: B1, [VIEW]: B1, [CASH]: B1 };

function invoiceRow(over: Row = {}): Row {
  return { id: INV, business_id: B1, user_id: OWN, doc_type: 305, doc_number: 7, link_no: 1, issued_at: '2026-10-01T08:00:00Z', doc_date: '2026-10-01',
    customer_name: 'נועה לוי', customer_phone: '0501111111', customer_dealer: '', customer_email: 'noa@x.test', lead_id: LEAD,
    lines: [{ name: 'לייזר', qty: 1, unitPriceExVat: 1000, discountExVat: 0, totalExVat: 1000, vatRate: 18, kind: 1 }], payments: [],
    before_discount: 1000, discount: 0, after_discount: 1000, vat_amount: 180, total: 1180, vat_rate: 18, idempotency_key: 'direct:1', ...over };
}
function linkRow(over: Row = {}): Row {
  return { id: id(1), business_id: B1, user_id: OWN, kind: 'document', document_id: INV, package_id: null, quote_id: null, appointment_id: null, lead_id: LEAD,
    label: 'חשבונית מס מס׳ 7', customer_name: 'נועה לוי', customer_phone: '0501111111', customer_email: 'noa@x.test', amount: 300, currency: 'ILS',
    is_test: false, provider: 'payplus', status: 'paid', expires_at: new Date(Date.now() + 864e5).toISOString(), link_origin: 'https://app.test', sent_via: 'whatsapp',
    sends: 1, pages: [], paid_at: new Date().toISOString(), paid_amount: 300, provider_txn: 'txn-1', paid_late: false, failed_at: null, fail_reason: '',
    cancelled_at: null, receipt_status: 'pending', receipt_document_id: null, receipt_error: '', created_at: new Date().toISOString(), ...over };
}
function reset() {
  for (const k of Object.keys(tables)) delete tables[k];
  rpcCalls.length = 0; fetched = [];
  Object.assign(tables, {
    profiles: [{ id: OWN, is_super_admin: false }, { id: VIEW, is_super_admin: false }, { id: CASH, is_super_admin: false }],
    businesses: [{ id: B1, name: 'Clinic A', status: 'active', paid_until: null, grace_days: 0 }, { id: B2, name: 'Clinic B', status: 'active', paid_until: null, grace_days: 0 }],
    business_members: [{ business_id: B1, user_id: OWN, role: 'owner', access: 'full', created_at: '2026-01-01' },
      { business_id: B1, user_id: VIEW, role: 'viewer', access: 'full', created_at: '2026-01-02' }, { business_id: B1, user_id: CASH, role: 'editor', access: 'register', created_at: '2026-01-03' }],
    finance_access_grants: [],
    register_settings: [{ business_id: B1, entity_type: 'company', business_type: 'licensed', vat_rate: 18, legal_name: 'קליניקה א בע"מ' }],
    business_finance_profile: [{ business_id: B1, trading_name: 'לייזר א', phone: '03-1234567', email: 'clinic@a.test', paylink_receipt: 'auto' }],
    brands: [], documents: [invoiceRow()], payments: [], quotes: [], payment_requests: [], email_outbox: [], push_subscriptions: [],
  });
}
/** the database's own rules that the server leans on: one document per key (23505), a receipt's money in the ledger, a quote converted once */
const db = () => fakeDb(tables, {
  onInsert: (table, row, all) => {
    if (table !== 'documents') return null;
    if (all.some((d) => d.business_id === row.business_id && d.idempotency_key === row.idempotency_key)) {
      return { code: '23505', message: 'duplicate key value violates unique constraint "documents_idempotency_uq"', details: 'Key (business_id, idempotency_key)' } as any;
    }
    if (row.quote_id) {
      const q = tables.quotes.find((x) => x.id === row.quote_id && x.business_id === row.business_id);
      if (!q || !['draft', 'sent', 'accepted'].includes(q.status)) return { code: '23514', message: 'the quote was not found in this business (or was already used)' } as any;
      q.status = 'converted'; q.converted_document_id = row.id;
    }
    row.id ??= id(9000 + all.length); row.doc_number ??= 0;
    if ([320, 400].includes(row.doc_type)) {
      for (const p of row.payments ?? []) tables.payments.push({ business_id: row.business_id, direction: 'in', amount: p.amount, applies_to: row.paid_document_id ?? null, document_id: row.id });
    }
    return null;
  },
}).from;
function rpc(fn: string, a: Row): { data: any; error: any } {
  rpcCalls.push({ fn, args: a });
  const req = (x: string) => tables.payment_requests.find((r) => r.id === x);
  switch (fn) {
    case 'business_for_user': return { data: current[a.uid] ?? null, error: null };
    case 'paylink_create': {
      if (a.p_kind === 'document' && !tables.documents.some((d) => d.id === a.p_target && d.business_id === a.p_business)) return { data: null, error: { message: 'paylink_not_found', code: '42501' } };
      if (a.p_amount > 880) return { data: null, error: { message: 'paylink_over_balance: 880.00 left to ask for', code: '23514' } };
      const row = linkRow({ id: id(100 + tables.payment_requests.length), business_id: a.p_business, user_id: a.p_user, kind: a.p_kind, amount: a.p_amount, status: 'sent',
        paid_at: null, paid_amount: null, provider_txn: '', receipt_status: 'none', is_test: true, link_origin: a.p_origin, sent_via: a.p_via,
        expires_at: new Date(Date.now() + a.p_days * 864e5).toISOString() });
      tables.payment_requests.push(row);
      return { data: row, error: null };
    }
    case 'paylink_email': { const r = req(a.p_request); if (!r?.customer_email) return { data: false, error: null }; tables.email_outbox.push({ request_id: r.id, kind: 'payment_link', ref: a.p_ref }); return { data: true, error: null }; }
    case 'paylink_sent': { const r = req(a.p_request); if (!r || r.business_id !== a.p_business || !['sent', 'failed'].includes(r.status)) return { data: false, error: null }; r.sends += 1; r.sent_via = a.p_via; return { data: true, error: null }; }
    case 'paylink_cancel': { const r = req(a.p_request); if (!r || r.business_id !== a.p_business) return { data: { result: 'not_found' }, error: null };
      if (!['sent', 'failed'].includes(r.status)) return { data: { result: 'ignored', status: r.status }, error: null }; r.status = 'cancelled'; return { data: { result: 'ok', status: 'cancelled' }, error: null }; }
    case 'paylink_receipt_approve': { const r = req(a.p_request); if (!r || r.business_id !== a.p_business) return { data: { result: 'not_found' }, error: null };
      if (!['awaiting', 'blocked'].includes(r.receipt_status)) return { data: { result: 'ignored', receipt: r.receipt_status }, error: null };
      r.receipt_status = 'pending'; r.receipt_error = ''; return { data: { result: 'ok', receipt: 'pending' }, error: null }; }
    case 'paylink_receipt_done': {
      const r = req(a.p_request);
      if (!r || r.status !== 'paid' || r.is_test) return { data: { result: 'not_found' }, error: null };
      if (a.p_document) {
        const d = tables.documents.find((x) => x.id === a.p_document);
        if (!d || d.business_id !== r.business_id || d.idempotency_key !== `paylink:${r.id}`) return { data: null, error: { message: "the document is not this link's receipt", code: '23514' } };
        if (r.receipt_status === 'issued') return { data: { result: r.receipt_document_id === a.p_document ? 'already' : 'other' }, error: null };
        r.receipt_status = 'issued'; r.receipt_document_id = a.p_document; return { data: { result: 'ok', receipt: 'issued' }, error: null };
      }
      r.receipt_status = 'blocked'; r.receipt_error = a.p_error; return { data: { result: 'ok', receipt: 'blocked' }, error: null };
    }
    case 'paylinks_expire': { let n = 0; for (const r of tables.payment_requests) if (['sent', 'failed'].includes(r.status) && Date.parse(r.expires_at) <= Date.now()) { r.status = 'expired'; n++; } return { data: n, error: null }; }
    case 'paylinks_receipts_pending': return { data: tables.payment_requests.filter((r) => r.receipt_status === 'pending' && r.status === 'paid' && !r.is_test).map((r) => r.id), error: null };
    case 'email_outbox_claim': return { data: [], error: null };
    default: return { data: null, error: { message: `function ${fn} not found`, code: 'PGRST202' } };
  }
}

before(() => {
  (globalThis as any).__DP_TEST_ADMIN_DB__ = {
    from: (t: string) => db()(t),
    auth: { getUser: async (t: string) => ({ data: { user: [OWN, VIEW, CASH].includes(t) ? { id: t } : null } }) },
    rpc: async (fn: string, a: Row) => rpc(fn, a ?? {}),
  };
  (globalThis as any).fetch = async (url: string, init: any) => {
    fetched.push({ url: String(url), init });
    if (String(url).startsWith('https://sf.test/api/paylink')) { const a = storefrontAnswer(JSON.parse(init.body)); return new Response(JSON.stringify(a.json), { status: a.status }); }
    throw new Error(`network call in a test: ${url}`);
  };
});
beforeEach(async () => {
  reset();
  Object.assign(process.env, { ORDER_LINK_SECRET: SECRET, COMMERCE_SECRET: COMMERCE, STOREFRONT_URL: 'https://sf.test' });
  delete process.env.APP_URL; delete process.env.RESEND_API_KEY; delete process.env.VAPID_PRIVATE_KEY;
  storefrontAnswer = () => ({ status: 200, json: { ok: true, url: 'https://pay.test/page' } });
  (await import('../src/lib/server/rate-limit')).resetRateLimits();
});
const finalize = async (requestId: string, secret = COMMERCE) => {
  const route = await import('../src/app/api/finance/paylinks/finalize/route');
  return route.POST(new Request('https://app.test/api/finance/paylinks/finalize', { method: 'POST', headers: { 'x-commerce-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify({ requestId }) }));
};

test('THE SAME WEBHOOK TWICE → ONE RECEIPT: the storefront tells the dashboard twice; the link\'s own key keeps one document', async () => {
  tables.payment_requests.push(linkRow());
  assert.equal((await finalize(id(1), 'wrong-secret-0123456789')).status, 401, 'only the storefront (the shared secret)');
  const a = await (await finalize(id(1))).json();
  const b = await (await finalize(id(1))).json();
  assert.equal(a.receipt, 'issued'); assert.equal(b.receipt, 'issued');
  const receipts = tables.documents.filter((d) => d.idempotency_key === `paylink:${id(1)}`);
  assert.equal(receipts.length, 1, 'one receipt');
  const r = receipts[0];
  assert.equal(r.doc_type, 400, 'a tax invoice (305) is paid with a receipt (400)');
  assert.equal(r.paid_document_id, INV);
  assert.equal(Number(r.total), 300);
  assert.deepEqual(r.payments.map((p: any) => [p.amount, p.m ?? p.method]), [[300, 'card']], 'paid by card');
  assert.deepEqual(docInvariants({ docType: r.doc_type, lines: r.lines, payments: r.payments, beforeDiscount: r.before_discount, discount: r.discount, afterDiscount: r.after_discount,
    vatAmount: r.vat_amount, total: r.total }, 0), [], 'inside the database\'s rules');
  assert.equal(tables.payments.filter((p) => p.applies_to === INV).length, 1, 'one payment in the ledger (from the receipt)');
  const req = tables.payment_requests[0];
  assert.equal(req.receipt_status, 'issued'); assert.equal(req.receipt_document_id, r.id);
  // a lost answer: the receipt is there, the link was not told — the next run finds it by its key, never a second one
  req.receipt_status = 'pending'; req.receipt_document_id = null;
  const { issuePaylinkReceipt } = await import('../src/lib/server/paylinks');
  assert.equal((await issuePaylinkReceipt(id(1))).receipt, 'issued');
  assert.equal(tables.documents.filter((d) => d.idempotency_key === `paylink:${id(1)}`).length, 1);
});

test('a test payment: the owner\'s alert only — no receipt, nothing in the ledger', async () => {
  tables.payment_requests.push(linkRow({ is_test: true, receipt_status: 'none' }));
  const a = await (await finalize(id(1))).json();
  assert.equal(a.receipt, 'none');
  assert.equal(tables.documents.length, 1, 'only the invoice');
  assert.equal(tables.payments.length, 0);
});

test('a transaction invoice of a VAT business is paid with a tax invoice-receipt (320), of an exempt one with a receipt (400)', async () => {
  tables.documents[0] = invoiceRow({ doc_type: 300, lines: [{ name: 'טיפול', qty: 1, unitPriceExVat: 1180, discountExVat: 0, totalExVat: 1180, vatRate: 0, kind: 1 }],
    before_discount: 1180, after_discount: 1180, vat_amount: 0, total: 1180, vat_rate: 0 });
  tables.payment_requests.push(linkRow());
  await finalize(id(1));
  const r = tables.documents.find((d) => d.idempotency_key === `paylink:${id(1)}`)!;
  assert.equal(r.doc_type, 320);
  assert.equal(Number(r.vat_amount), 45.76, 'the VAT inside ₪300 at 18%');
  reset();
  tables.register_settings[0] = { business_id: B1, entity_type: 'exempt_dealer', business_type: 'exempt', vat_rate: 0 };
  tables.documents[0] = invoiceRow({ doc_type: 300, vat_amount: 0, total: 1180, after_discount: 1180, before_discount: 1180, vat_rate: 0,
    lines: [{ name: 'טיפול', qty: 1, unitPriceExVat: 1180, discountExVat: 0, totalExVat: 1180, vatRate: 0, kind: 1 }] });
  tables.payment_requests.push(linkRow());
  await finalize(id(1));
  assert.equal(tables.documents.find((d) => d.idempotency_key === `paylink:${id(1)}`)!.doc_type, 400);
});

test('a deposit: its own tax invoice-receipt (the deposit line, VAT inside), offset later at the register', async () => {
  tables.payment_requests.push(linkRow({ kind: 'deposit', document_id: null, appointment_id: id(77), amount: 100, paid_amount: 100, label: 'מקדמה לתור: לייזר רגליים · 12/10 10:00' }));
  const a = await (await finalize(id(1))).json();
  assert.equal(a.receipt, 'issued');
  const r = tables.documents.find((d) => d.idempotency_key === `paylink:${id(1)}`)!;
  assert.equal(r.doc_type, 320);
  assert.equal(r.lines[0].name, 'מקדמה — לייזר רגליים · 12/10 10:00');
  assert.equal(Number(r.total), 100); assert.equal(Number(r.vat_amount), 15.25);
  assert.equal(r.paid_document_id, null, 'a document of its own');
  assert.equal(r.lead_id, LEAD);
});

test('an accepted quote: paid whole → one tax invoice-receipt that converts it; paid in part → its invoice once, and a receipt on it', async () => {
  const quote = (over: Row = {}) => ({ id: QUOTE, business_id: B1, quote_number: 3, status: 'accepted', customer_name: 'דנה', customer_phone: '0502222222', customer_email: '',
    lead_id: LEAD, total: 590, vat_rate: 18, body: { lines: [{ name: 'טיפול פנים', qty: 1, unitPrice: 590 }], pricesIncludeVat: true, discount: { kind: 'sum', value: 0 }, customer: { name: 'דנה' } }, ...over });
  tables.quotes.push(quote());
  tables.payment_requests.push(linkRow({ kind: 'quote', document_id: null, quote_id: QUOTE, amount: 590, paid_amount: 590, label: 'הצעת מחיר מס׳ 3', customer_name: 'דנה' }));
  await finalize(id(1));
  const whole = tables.documents.find((d) => d.idempotency_key === `paylink:${id(1)}`)!;
  assert.equal(whole.doc_type, 320); assert.equal(whole.quote_id, QUOTE); assert.equal(Number(whole.total), 590);
  assert.equal(tables.quotes[0].status, 'converted');

  reset();
  tables.quotes.push(quote());
  tables.payment_requests.push(linkRow({ kind: 'quote', document_id: null, quote_id: QUOTE, amount: 300, paid_amount: 300, label: 'הצעת מחיר מס׳ 3', customer_name: 'דנה' }));
  tables.payment_requests.push(linkRow({ id: id(2), kind: 'quote', document_id: null, quote_id: QUOTE, amount: 290, paid_amount: 290, label: 'הצעת מחיר מס׳ 3', customer_name: 'דנה', provider_txn: 'txn-2' }));
  await finalize(id(1));
  await finalize(id(2));
  const inv = tables.documents.filter((d) => d.idempotency_key === `quote:${QUOTE}`);
  assert.equal(inv.length, 1, 'the quote becomes ONE invoice (its own key — the same one as "הפיכה למסמך")');
  assert.equal(inv[0].doc_type, 305); assert.equal(Number(inv[0].total), 590);
  const r1 = tables.documents.find((d) => d.idempotency_key === `paylink:${id(1)}`)!, r2 = tables.documents.find((d) => d.idempotency_key === `paylink:${id(2)}`)!;
  assert.deepEqual([r1.doc_type, r1.paid_document_id, Number(r1.total)], [400, inv[0].id, 300]);
  assert.deepEqual([r2.doc_type, r2.paid_document_id, Number(r2.total)], [400, inv[0].id, 290], 'the second payment: a receipt on the same invoice');
});

test('a receipt the business has to fix is blocked with the reason; the owner\'s approval tries it again', async () => {
  tables.payments.push({ business_id: B1, direction: 'in', amount: 1000, applies_to: INV });     // ₪1,000 recorded by hand meanwhile: ₪180 left
  tables.payment_requests.push(linkRow());
  const a = await (await finalize(id(1))).json();
  assert.equal(a.receipt, 'blocked');
  assert.match(tables.payment_requests[0].receipt_error, /הסכום גדול מהיתרה/);
  assert.equal(tables.documents.length, 1, 'no receipt beyond the balance');
  const route = await import('../src/app/api/finance/paylinks/route');
  const call = (u: string, body: Row) => route.POST(new Request('https://app.test/api/finance/paylinks', { method: 'POST', headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  tables.payments.length = 0;                                                                    // the owner cancelled the wrong one
  const r = await call(OWN, { action: 'receipt', id: id(1) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).receipt, 'issued');
  assert.equal(tables.payment_requests[0].receipt_status, 'issued');
  // the "awaiting" setting: the receipt waits for the owner; a viewer or a cashier approves nothing
  tables.payment_requests.push(linkRow({ id: id(2), receipt_status: 'awaiting', provider_txn: 'txn-2' }));
  assert.equal((await call(VIEW, { action: 'receipt', id: id(2) })).status, 403);
  assert.equal((await call(CASH, { action: 'receipt', id: id(2) })).status, 403);
  assert.equal(tables.payment_requests[1].receipt_status, 'awaiting');
});

test('an invoice cancelled after the link was sent: the payment is kept, its receipt blocked with the reason — never a receipt on it', async () => {
  tables.document_cancellations = [{ document_id: INV, reason: 'הופקה בטעות' }];
  tables.payment_requests.push(linkRow());
  const a = await (await finalize(id(1))).json();
  assert.equal(a.receipt, 'blocked');
  assert.match(tables.payment_requests[0].receipt_error, /החשבונית בוטלה/);
  assert.equal(tables.documents.length, 1, 'no receipt on a cancelled invoice');
});

test('sending: the business is the server\'s, the address the dashboard\'s; the text carries the signed link', async () => {
  const route = await import('../src/app/api/finance/paylinks/route');
  const call = (u: string, body: Row, url = 'https://app.test/api/finance/paylinks') =>
    route.POST(new Request(url, { method: 'POST', headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const r = await call(OWN, { action: 'send', kind: 'document', target: INV, amount: 300, days: 7, via: 'whatsapp', business: B2 });
  assert.equal(r.status, 200);
  const j = await r.json();
  const create = rpcCalls.find((c) => c.fn === 'paylink_create')!.args;
  assert.equal(create.p_business, B1, 'never the body\'s business');
  assert.equal(create.p_user, OWN);
  assert.equal(create.p_origin, 'https://app.test');
  assert.equal(j.url, `https://app.test/pay/${paylinkRef(j.link.id, SECRET)}`);
  assert.ok(j.text.includes(j.url) && /שלום נועה/.test(j.text) && /ללייזר א/.test(j.text), 'the WhatsApp text: the customer, the business as she knows it, the link');
  process.env.APP_URL = 'https://dash.example.co.il';
  const r2 = await (await call(OWN, { action: 'send', kind: 'document', target: INV, amount: 100, days: 3, via: 'email' })).json();
  assert.match(r2.url, /^https:\/\/dash\.example\.co\.il\/pay\//, 'APP_URL wins when set');
  assert.equal(tables.email_outbox.length, 1, 'by email: the one outbox');
  // refused, in Hebrew; not for a viewer or a cashier; not for an invalid request
  const over = await call(OWN, { action: 'send', kind: 'document', target: INV, amount: 900, days: 7, via: 'link' });
  assert.equal(over.status, 400); assert.match((await over.json()).message, /עד ₪880/);
  assert.equal((await call(VIEW, { action: 'send', kind: 'document', target: INV, amount: 10, days: 7 })).status, 403);
  assert.equal((await call(CASH, { action: 'send', kind: 'document', target: INV, amount: 10, days: 7 })).status, 403);
  assert.equal((await call(OWN, { action: 'send', kind: 'document', target: INV, amount: 10, days: 31 })).status, 400);
  assert.equal((await call(OWN, { action: 'send', kind: 'gift', target: INV, amount: 10, days: 7 })).status, 400);
  // again, and cancelled
  const lid = j.link.id;
  const again = await (await call(OWN, { action: 'resend', id: lid, via: 'link' })).json();
  assert.equal(again.url, j.url, 'the same link');
  assert.equal(tables.payment_requests.find((x) => x.id === lid)!.sends, 2);
  assert.equal((await call(OWN, { action: 'cancel', id: lid })).status, 200);
  assert.equal((await call(OWN, { action: 'cancel', id: lid })).status, 409, 'closed once');
  assert.equal((await call(OWN, { action: 'resend', id: lid, via: 'link' })).status, 409, 'a cancelled link is not sent again');
});

test('the customer\'s page: nothing internal; "לתשלום" asks the storefront\'s server (the shared secret), back from paying it asks again', async () => {
  tables.payment_requests.push(linkRow({ status: 'sent', paid_at: null, paid_amount: null, provider_txn: '', receipt_status: 'none', is_test: true }));
  const route = await import('../src/app/api/pay/[ref]/route');
  const ref = paylinkRef(id(1), SECRET)!;
  const ctx = (r: string) => ({ params: Promise.resolve({ ref: r }) });
  const get = (r: string) => route.GET(new Request(`https://app.test/api/pay/${r}`), ctx(r));
  const post = (r: string, action: string) => route.POST(new Request(`https://app.test/api/pay/${r}`, { method: 'POST', body: JSON.stringify({ action }) }), ctx(r));
  assert.equal((await get('x.y')).status, 404);
  assert.equal((await get(`${id(1)}.${'A'.repeat(32)}`)).status, 404, 'a guessed signature');
  const v = await (await get(ref)).json();
  assert.deepEqual(Object.keys(v.link).sort(), ['amount', 'business', 'currency', 'customer', 'expiresAt', 'label', 'late', 'paidAt', 'phone', 'status', 'test']);
  assert.deepEqual([v.link.status, v.link.amount, v.link.business, v.link.customer, v.link.test], ['sent', 300, 'לייזר א', 'נועה', true]);
  assert.ok(!JSON.stringify(v).includes('0501111111') && !JSON.stringify(v).includes('noa@x.test') && !JSON.stringify(v).includes(B1), 'nothing internal');
  const s = await post(ref, 'start');
  assert.equal(s.status, 200);
  assert.equal((await s.json()).url, 'https://pay.test/page');
  const call = fetched.find((f) => f.url === 'https://sf.test/api/paylink')!;
  assert.equal(call.init.headers['x-commerce-secret'], COMMERCE);
  assert.deepEqual(JSON.parse(call.init.body), { action: 'page', request: id(1), returnUrl: `https://app.test/pay/${ref}` });
  // back to the address the link was sent with — not the one a request names
  fetched.length = 0;
  await route.POST(new Request(`https://evil.test/api/pay/${ref}`, { method: 'POST', body: JSON.stringify({ action: 'start' }) }), ctx(ref));
  assert.equal(JSON.parse(fetched[0].init.body).returnUrl, `https://app.test/pay/${ref}`);
  // the storefront says it was paid meanwhile (another tab): no page, the status
  storefrontAnswer = () => ({ status: 200, json: { ok: false, error: 'paid' } });
  tables.payment_requests[0].status = 'paid';
  const paid = await post(ref, 'start');
  assert.equal(paid.status, 409);
  // back from paying: the provider is asked (confirm), then the database's status — a failure shows as a failure
  storefrontAnswer = (b) => { if (b.action === 'confirm') tables.payment_requests[0].status = 'failed'; return { status: 200, json: { ok: true, status: 'failed' } }; };
  tables.payment_requests[0].status = 'sent';
  const back = await (await post(ref, 'check')).json();
  assert.equal(back.link.status, 'failed');
  // a locked business: "השירות אינו זמין"
  tables.businesses[0].status = 'locked';
  assert.equal((await get(ref)).status, 403);
});

test('the cron: links past their time expire; receipts waiting for the server are issued', async () => {
  tables.payment_requests.push(linkRow({ id: id(5), status: 'sent', paid_at: null, paid_amount: null, provider_txn: '', receipt_status: 'none', expires_at: new Date(Date.now() - 1000).toISOString() }));
  tables.payment_requests.push(linkRow());
  const { paylinksCron } = await import('../src/lib/server/paylinks');
  const r = await paylinksCron(Date.now() + 10_000);
  assert.equal(r.expired, 1);
  assert.deepEqual(r.receipts.map((x) => x.receipt), ['issued']);
  assert.equal(tables.payment_requests.find((x) => x.id === id(5))!.status, 'expired');
  // before migration 4300 the cron does nothing (and does not fail)
  const saved = (globalThis as any).__DP_TEST_ADMIN_DB__.rpc;
  (globalThis as any).__DP_TEST_ADMIN_DB__.rpc = async () => ({ data: null, error: { message: 'function paylinks_expire() does not exist', code: '42883' } });
  try { assert.deepEqual(await paylinksCron(Date.now() + 1000), { expired: 0, receipts: [] }); }
  finally { (globalThis as any).__DP_TEST_ADMIN_DB__.rpc = saved; }
});

test('the screens read a link as the database keeps it', () => {
  const l = toPaylink(linkRow({ paid_amount: '300.00', amount: '300.00', sends: 2 }));
  assert.equal(l.amount, 300); assert.equal(l.paidAmount, 300); assert.equal(l.sends, 2); assert.equal(l.receiptStatus, 'pending');
});
