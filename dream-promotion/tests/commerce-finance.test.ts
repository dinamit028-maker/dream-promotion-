/**
 * Dream Commerce stage 4 (2.57.0) in the dashboard — the rules the server runs on a paid order of the site:
 *   - the phone key: crm.ts phoneDigits and the database's phone_key() give the same key on one table of examples
 *     (the table lives in tests/sql/commerce-finance.check.sql; this test reads it from there);
 *   - the VAT of an order, its document (the same amounts the SQL test issues with the service role), a refused document
 *     that waits for the business ("blocked") vs. a temporary error (tried again);
 *   - a refund only after the owner confirmed it was done at the payment company;
 *   - the customer's emails (escaped, no advertising, a test says so), the sender, the owner's alerts, the order link.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { phoneDigits } from '@/features/crm/crm';
import {
  alertPush, documentFailure, emailDomainOf, emailDomainStatus, emailFrom, orderDocument, orderEmail, orderVat, planOrderRefund, saleFromRow,
  type EmailOrder, type EmailStore,
} from '@/features/store/commerce';
import { eventText, toOrder } from '@/features/store/checkout';
import { orderRef, orderRefOk } from '@/lib/server/order-link';

const sqlFile = fileURLToPath(new URL('./sql/commerce-finance.check.sql', import.meta.url));

test('phone key: phoneDigits = phone_key() on every example of the SQL test', () => {
  const sql = readFileSync(sqlFile, 'utf8');
  const block = sql.split('-- phone examples: begin')[1]?.split('-- phone examples: end')[0] ?? '';
  const rows = [...block.matchAll(/\('((?:[^']|'')*)', '((?:[^']|'')*)'\)/g)].map((m) => [m[1].replace(/''/g, "'"), m[2]]);
  assert.ok(rows.length >= 10, `the table of examples was found (${rows.length})`);
  for (const [raw, key] of rows) assert.equal(phoneDigits(raw), key, `"${raw}"`);
});

// the sale commerce_record_sale writes for 2 totes at ₪40 + delivery ₪30 (tests/sql/commerce-finance.check.sql, order A)
const saleRow = {
  id: '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b', lead_id: 'lead-1', customer_name: 'Dana Cohen', customer_phone: '0501234567',
  items: [{ name: 'שקית בד', price: 40, qty: 2, itemId: 'i1', kind: 'product' }, { name: 'משלוח', price: 30, qty: 1, kind: 'service' }],
  subtotal: '110.00', discount: '0.00', total: '110.00', vat_rate: '18.00', vat_amount: '16.78', method: 'card', status: 'paid', note: 'הזמנה באתר #1001',
  paid_at: '2026-10-06T10:00:00Z', created_at: '2026-10-06T10:00:00Z', payments: [],
};

test('VAT of an order: the business\'s rate through vat.ts; an exempt business: none', () => {
  assert.deepEqual(orderVat(110, { businessType: 'licensed', vatRate: 18 }), { rate: 18, amount: 16.78 });
  assert.deepEqual(orderVat(90, { businessType: 'licensed', vatRate: 18 }), { rate: 18, amount: 13.73 });
  assert.deepEqual(orderVat(110, { businessType: 'exempt', vatRate: 18 }), { rate: 0, amount: 0 });
});

test('the document of an online sale: the register\'s docFromSale — the amounts the SQL test issues', () => {
  const d = orderDocument(saleFromRow(saleRow), { licensed: true, docDate: '2026-10-06', email: 'dana@x.co' });
  assert.equal(d.docType, 320);
  assert.deepEqual(d.lines.map((l) => [l.name, l.qty, l.unitPriceExVat, l.totalExVat]), [['שקית בד', 2, 33.9, 67.8], ['משלוח', 1, 25.42, 25.42]]);
  assert.deepEqual([d.beforeDiscount, d.afterDiscount, d.vatAmount, d.total], [93.22, 93.22, 16.78, 110]);
  assert.deepEqual(d.payments.map((p) => [p.method, p.amount]), [[3, 110]]);
  assert.equal(d.customerEmail, 'dana@x.co');
  const exempt = orderDocument(saleFromRow({ ...saleRow, vat_rate: 0, vat_amount: 0 }), { licensed: false, docDate: '2026-10-06' });
  assert.equal(exempt.docType, 400);
  assert.equal(exempt.vatAmount, 0);
});

test('a refused document waits for the business; a temporary error is tried again', () => {
  const blocked = documentFailure({ message: 'business_details_missing', code: 'P0001' });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /פרטי העסק/);
  assert.equal(documentFailure({ message: 'period_locked' }).blocked, true);
  assert.equal(documentFailure({ message: 'fetch failed' }).blocked, false);
  assert.equal(documentFailure(new Error('timeout')).blocked, false);
});

test('a refund only after the owner confirmed it at the payment company; the register\'s plan (to the card)', () => {
  const sale = saleFromRow(saleRow);
  assert.deepEqual(planOrderRefund(sale, [], { mode: 'full' }, { confirmed: false }), { ok: false, error: 'צריך לאשר שההחזר בוצע בממשק של חברת הסליקה.' });
  const full = planOrderRefund(sale, [], { mode: 'full' }, { confirmed: true, restock: true });
  assert.ok(full.ok);
  if (full.ok) { assert.equal(full.refund.amount, 110); assert.equal(full.refund.vatAmount, 16.78); assert.equal(full.refund.method, 'card'); assert.equal(full.refund.restock, true); }
  const one = planOrderRefund(sale, [], { mode: 'items', qty: [1, 0] }, { confirmed: true, restock: true });
  assert.ok(one.ok && one.refund.amount === 40 && one.refund.vatAmount === 6.1 && one.refund.items.length === 1);
  const tooMuch = planOrderRefund(sale, [], { mode: 'amount', amount: 111 }, { confirmed: true });
  assert.deepEqual(tooMuch, { ok: false, error: 'הסכום גדול ממה שנשאר להחזיר על העסקה.' });
});

const store: EmailStore = { name: 'Shop', phone: '03-5555555', email: 'hi@shop.co.il', address: 'הרצל 1, תל אביב', pickupNote: 'א׳–ה׳ 10–18', baseUrl: 'https://shop.co.il' };
const order: EmailOrder = {
  number: 1001, isTest: false, currency: 'ILS', subtotal: 80, discount: 0, shipping: 30, total: 110, customerName: 'Dana <script>alert(1)</script>',
  deliveryMethod: 'delivery', address: { city: 'תל אביב', street: 'הרצל', house: '1', apartment: '' },
  lines: [{ name: 'שקית בד', variantLabel: '', qty: 2, lineTotal: 80 }], trackingNumber: '', trackingUrl: '',
};

test('the confirmation email: the order, the seller, the returns policy; every value escaped; no advertising', () => {
  const m = orderEmail('order_confirmation', store, order, { orderUrl: 'https://shop.co.il/orders/abc.def' });
  assert.equal(m.subject, 'אישור הזמנה #1001 — Shop');
  assert.ok(!m.html.includes('<script>') && m.html.includes('&lt;script&gt;'), 'the name is escaped');
  assert.match(m.text, /שקית בד × 2 · ₪80/);
  assert.match(m.text, /משלוח: ₪30/);
  assert.match(m.text, /סה״כ ששולם: ₪110/);
  assert.match(m.text, /פרטי המוכר: Shop · טלפון 03-5555555/);
  assert.match(m.html, /<a href="https:\/\/shop\.co\.il\/policies\/returns">/);
  assert.match(m.html, /<a href="https:\/\/shop\.co\.il\/orders\/abc\.def">/);
  assert.ok(!/dream/i.test(m.html + m.subject), 'the platform\'s name never reaches the customer');
  assert.ok(!/מבצע|הנחה מיוחדת|פרסומת/.test(m.text), 'a service email advertises nothing');
  const t = orderEmail('order_confirmation', store, { ...order, isTest: true }, { orderUrl: null });
  assert.match(t.subject, /\(הזמנת בדיקה\)$/);
  assert.ok(!t.text.includes('לצפייה בהזמנה'), 'no link when there is none');
});

test('shipped, ready, refunded', () => {
  assert.match(orderEmail('order_shipped', store, { ...order, trackingNumber: 'RR1', trackingUrl: 'https://t.example/RR1' }, { orderUrl: null }).text, /מספר מעקב: RR1/);
  assert.match(orderEmail('order_ready', store, { ...order, deliveryMethod: 'pickup' }, { orderUrl: null }).text, /א׳–ה׳ 10–18/);
  assert.match(orderEmail('order_refunded', store, order, { orderUrl: null, refundAmount: 40 }).text, /החזר של ₪40/);
});

test('the sender: the store\'s verified domain, else the platform\'s address, else none (the email waits)', () => {
  assert.equal(emailFrom('Shop', { domain: 'shop.co.il', status: 'verified', fromName: '' }, undefined), 'Shop <orders@shop.co.il>');
  assert.equal(emailFrom('Shop', { domain: 'shop.co.il', status: 'pending', fromName: '' }, 'orders@mail.example.com'), 'Shop <orders@mail.example.com>');
  assert.equal(emailFrom('Sh"op<x>', null, undefined), null);
  assert.equal(emailFrom('Sh"op<x>', null, 'a@b.co'), 'Shopx <a@b.co>');
  assert.equal(emailDomainOf(' https://Shop.CO.il/ '), 'shop.co.il');
  assert.equal(emailDomainOf('shop'), null);
  assert.equal(emailDomainOf('a b.com'), null);
  assert.equal(emailDomainStatus('verified'), 'verified');
  assert.equal(emailDomainStatus('temporary_failure'), 'pending');
});

test('the owner\'s alerts', () => {
  const p = alertPush({ id: 1, business: 'b', order: 'o1', kind: 'new_order', body: '', number: 1001, total: 110, name: 'Dana', test: false });
  assert.equal(p.title, '🛍️ הזמנה חדשה באתר #1001 · ₪110');
  assert.equal(p.url, '/store/orders/o1');
  assert.match(alertPush({ id: 2, business: 'b', order: 'o1', kind: 'document_blocked', body: 'חסרים פרטים', number: 1001, total: 110, name: 'Dana', test: true }).title, /המסמך לא הופק \(בדיקה\)$/);
});

test('the order link in an email: an HMAC of the order id (the storefront checks the same example)', () => {
  const id = '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
  const ref = orderRef(id, 'test-secret-0123456789');
  assert.equal(ref, `${id}.i0PORRpTW-5HQ4PuVM_J47zzXhuXRnnL`);
  assert.equal(orderRefOk(ref!, 'test-secret-0123456789'), id);
  assert.equal(orderRefOk(`${id}.i0PORRpTW-5HQ4PuVM_J47zzXhuXRnnX`, 'test-secret-0123456789'), null);
  assert.equal(orderRef(id, 'short'), null, 'no link without a real secret');
});

test('the order\'s stage-4 fields and timeline', () => {
  const o = toOrder({ id: 'o', number: 1001, payment_status: 'paid', document_status: 'blocked', document_error: 'x', request_kind: 'return', refunded_total: '40.00' });
  assert.equal(o.documentStatus, 'blocked');
  assert.equal(o.requestKind, 'return');
  assert.equal(o.refundedTotal, 40);
  assert.match(eventText({ kind: 'fulfillment', data: { to: 'shipped', tracking: 'RR1' }, at: '' }), /נשלח · מספר מעקב RR1/);
  assert.match(eventText({ kind: 'paid', data: { late: true }, at: '' }), /כדאי לבדוק מלאי/);
});

test('the register counts its own sales only; a row from before 3600 is the register\'s', async () => {
  const { isPosSale } = await import('@/features/register/money');
  assert.equal(isPosSale({ channel: 'pos' }), true);
  assert.equal(isPosSale({}), true);
  assert.equal(isPosSale({ channel: 'online' }), false);
});

test('a change of a contact sends only what changed (never the whole card over a change made elsewhere)', async () => {
  const { leadPatchRow } = await import('@/features/crm/crm');
  assert.deepEqual(leadPatchRow({ status: 'נסגר' }), { status: 'נסגר' });
  assert.deepEqual(leadPatchRow({ lastContact: '2026-10-06T10:00:00Z', notes: undefined }), { last_contact_at: '2026-10-06T10:00:00Z' });
  assert.deepEqual(leadPatchRow({ nextFollowup: null, notes: null as any }), { next_followup_at: null, notes: '' });
  assert.deepEqual(leadPatchRow({ id: 'x' } as any), {}, 'the id is not a change');
});
