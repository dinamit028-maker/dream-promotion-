/** Register extras: cash suggestions, the customer's document link, notification auth. */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakedb';
import { cashSuggestions } from '../src/features/register/PosView';

const TOKEN = 'a'.repeat(64);
const tables: Record<string, any[]> = {
  documents: [{ id: 'D1', user_id: 'biz', lead_id: 'L1', sale_id: 'S1', share_token: TOKEN, idempotency_key: 'sale:S1', quote_id: null, draft_id: null, paid_document_id: null, refund_id: null, doc_type: 320, doc_number: 7, link_no: 1, issued_at: '2026-10-05T07:30:00Z', doc_date: '2026-10-05',
    customer_name: 'דנה', customer_phone: '052', lines: [], payments: [], before_discount: 100, discount: 0, after_discount: 100, vat_amount: 18, total: 118, vat_rate: 18, print_count: 0 }],
  register_settings: [{ user_id: 'biz', dealer_number: '515123456', legal_name: 'SaGabot', street: '', house_no: '', city: 'תל אביב', zip: '' }],
  brands: [{ user_id: 'biz', name: 'SaGabot' }],
};
before(() => { (globalThis as any).__DP_TEST_ADMIN_DB__ = { ...fakeDb(tables), auth: { getUser: async () => ({ data: { user: null } }) } }; });

test('cash: quick amounts start at the exact total and round up', () => {
  assert.deepEqual(cashSuggestions(350), [350, 400, 500]);
  assert.deepEqual(cashSuggestions(87), [87, 90, 100, 200, 500]);
  assert.ok(cashSuggestions(1234).every((v) => v >= 1234));
});

test('customer document link: by token only, no private fields', async () => {
  const r = await import('../src/app/api/doc/[token]/route');
  const ok = await r.GET(new Request('http://x'), { params: { token: TOKEN } });
  const j = await ok.json();
  assert.equal(ok.status, 200); assert.equal(j.doc.doc_number, 7); assert.equal(j.business.dealerNumber, '515123456');
  for (const k of ['user_id', 'lead_id', 'sale_id', 'share_token', 'idempotency_key', 'paid_document_id', 'quote_id', 'draft_id', 'refund_id']) assert.ok(!(k in j.doc), `${k} must not be exposed`);
  assert.equal((await r.GET(new Request('http://x'), { params: { token: 'b'.repeat(64) } })).status, 404);
  assert.equal((await r.GET(new Request('http://x'), { params: { token: '../../etc' } })).status, 404, 'malformed token');
});

test('notifications need a logged-in owner', async () => {
  const sale = await import('../src/app/api/notify/sale/route');
  const t = await import('../src/app/api/notify/test/route');
  assert.equal((await sale.POST(new Request('http://x', { method: 'POST', body: '{"saleId":"S1"}' }))).status, 401);
  assert.equal((await t.POST(new Request('http://x', { method: 'POST' }))).status, 401);
});
