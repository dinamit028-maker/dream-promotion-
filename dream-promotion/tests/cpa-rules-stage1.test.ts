/**
 * 2.118 — the accountant's answers of 25.11.2026, stage 1 (docs/ita-registration/CPA_ANSWERS_HE.md; the database side is migration
 * 20261125006800 and tests/sql/cpa-rules-stage1.check.sql):
 *   16 a document is dated the day it is issued (Israel time — also between 00:00 and 03:00, and across a month)
 *    8 a receipt (400) is not cancelled — the money back is a refund receipt
 *   15 an exempt dealer's refund = a receipt (400) below zero on the receipt it refunds
 *   12 Bit / PayBox = 4 (bank transfer) in field 1306
 *   13 a card payment names its credit transaction kind (field 1315)
 *   17 the deductions file number in field 1016
 * And: a document issued before this version looks exactly as before (HTML, PDF, and its records in the unified file).
 * Demo data only (fictitious numbers: 000000…, 050-00000NN).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { israelParts } from '../src/lib/il-time';
import {
  PAY_CODE, docFromSale, docPayLabel, isRefundReceipt, refundLeft, refundReceiptFor, refundReceiptForRefund, toDoc, totalLabel, baseDocLine,
} from '../src/features/documents/documents';
import { A000, B110, C100, D120, accountsOf, buildOpenFormat, cardKindField, deductionsFileField, docTypeReport, type Doc } from '../src/features/documents/openformat';
import { CARD_KIND_MISSING, composeDocument, composeReceipt, composeRefundReceipt, docDateErrors, docInvariants, paymentErrors } from '../src/features/finance/compose';
import { CARD_KINDS, isCardKind, payCode, toDocPayment } from '../src/features/finance/payments';
import { REFUND_RECEIPT_WAITS, financeError, refundReceiptError, refundReceiptWaits } from '../src/features/finance/rows';
import { cancelLeft, cancelReceiptDoc, missingSaleReceipts, refundReceiptDoc } from '../src/features/finance/sale-receipts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
/** the old database's (20261011005000) own refusals of a refund receipt, read from the migration as it is */
const M5000 = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261011005000_cash_bank_goods.sql'), 'utf8');
const oldRefusal = (start: string) => { const m = new RegExp(`raise exception '(${start}[^']*)'`).exec(M5000); assert.ok(m, start); return m![1]; };
const OLD_BASE = oldRefusal('only a credit invoice points to a base document');
const OLD_TOTALS = oldRefusal('totals: amounts are positive');
import { documentFailure } from '../src/features/store/commerce';
import { followKey } from '../src/features/finance/keys';
import { fakeDb } from './fakedb';

const h = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const SW = { regNumber: '00000000', name: 'Dream Promotion', version: '', vendorVat: '000000000', vendorName: 'Dream Promotion' };

// ---- demo documents as issued before 2.118 (a Bit payment with code 9, card payments without a kind) --------------------------
const BIZ = { dealerNumber: '000000018', companyNumber: '', name: 'עסק דמו', street: 'הדמו', houseNo: '1', city: 'עיר דמו', zip: '', entityType: 'exempt_dealer' };
const issuer = { name: 'עסק דמו', dealerNumber: '000000018', entityType: 'exempt_dealer', street: 'הדמו', houseNo: '1', city: 'עיר דמו' };
const row = { user_id: 'u1', link_no: 1, issued_at: '2026-10-05T07:30:00Z', doc_date: '2026-10-05', customer_name: 'לקוחה דמו', customer_phone: '0500000001',
  customer_dealer: '', customer_street: '', customer_city: '', print_count: 1, share_token: 't', issuer, notes: '' };
const OLD: Record<string, any> = {
  bit400: { ...row, id: 'A', doc_type: 400, doc_number: 11, lines: [{ name: 'טיפול פנים', qty: 1, unitPriceExVat: 250, discountExVat: 0, totalExVat: 250, vatRate: 0, kind: 1 }],
    payments: [{ method: 9, amount: 150, date: '2026-10-05', m: 'bit' }, { method: 3, amount: 100, date: '2026-10-05', m: 'card' }], before_discount: 250, discount: 0, after_discount: 250, vat_amount: 0, total: 250, vat_rate: 0 },
  card320: { ...row, id: 'B', doc_type: 320, doc_number: 7, issuer: { ...issuer, entityType: 'licensed_dealer' },
    lines: [{ name: 'קרם', qty: 2, unitPriceExVat: 84.75, discountExVat: 0, totalExVat: 169.5, vatRate: 18, kind: 2 }],
    payments: [{ method: 3, amount: 100, date: '2026-10-05', m: 'card' }, { method: 2, amount: 100, date: '2026-10-05', m: 'cheque', cheque: { bank: '12', branch: '345', account: '678', number: '1001', dueDate: '2026-11-01' } }],
    before_discount: 169.5, discount: 0, after_discount: 169.5, vat_amount: 30.5, total: 200, vat_rate: 18 },
  credit330: { ...row, id: 'C', doc_type: 330, doc_number: 2, base_doc_type: 320, base_doc_number: 7, issuer: { ...issuer, entityType: 'licensed_dealer' },
    lines: [{ name: 'קרם', qty: 1, unitPriceExVat: 84.75, discountExVat: 0, totalExVat: 84.75, vatRate: 18, kind: 2 }],
    payments: [], before_discount: 84.75, discount: 0, after_discount: 84.75, vat_amount: 15.26, total: 100.01, vat_rate: 18 },
  pay400: { ...row, id: 'D', doc_type: 400, doc_number: 12, paid_document_id: 'X', lines: [{ name: 'תשלום עבור חשבונית מס מס׳ 3', qty: 1, unitPriceExVat: 500, discountExVat: 0, totalExVat: 500, vatRate: 0, kind: 1 }],
    payments: [{ method: 4, amount: 500, date: '2026-10-05', m: 'transfer' }], before_discount: 500, discount: 0, after_discount: 500, vat_amount: 0, total: 500, vat_rate: 0 },
};
/** sha256 of each, taken with the code of 2.117.4 (before any change of 2.118) — scratch run, 25.11.2026 */
const BEFORE: Record<string, string> = {
  'html:bit400:מקור': 'd1a24dbd23ea8e11d8a4b78218f38cec7538387ee3b8e167a24692ebb6f6269c',
  'html:bit400:העתק נאמן למקור': '2fe7f215407af162f35e8f619dbebf2938c9fbb9354ad1c22ccb6609bac88a17',
  'c100:bit400': 'cfb4d01e0308bd746753a45dd7bbe8fb95f2bf7e15e60995236352cf46ed786f',
  'd120:bit400': '4e5255506f6b2b036d99ba965fb65704dbd4ebc841a59b362694e957b548b19c',
  'pdf:bit400:מקור': '4abee3e519976b0a09d8a6313f6a68ec43b9e2e59ad307aef03082d6401f66bf',
  'pdf:bit400:העתק נאמן למקור': 'd805096f1251b7973dd1ba82decc4081c0d9a0a70eeb4b181adb199b2affad5c',
  'html:card320:מקור': 'd971e59e4c5a01dfad5db3fefb71ca4f22f6ea3d421061dfb9ae58332e7d0924',
  'html:card320:העתק נאמן למקור': '9a2b4c754d09b3e2f04903f371030951eb959e110af769ade475e82fb9c3aea6',
  'c100:card320': 'f05cb5181edcd2542a8841e7dae825734d257bc8782221c1a9d9a372f9ed6216',
  'd120:card320': 'e1bb7bbabdd94d6e05e3300c6cd3f380a3b8101ee7f40bc9e92e99bb4c01d624',
  'pdf:card320:מקור': '3c527219a5b7d55d18cd628bb4865b889445891b32d64bd3d198c7b614aefb0b',
  'pdf:card320:העתק נאמן למקור': '0f51e021adf31f8a35c0a485bff4ab6b95f12d3289db7e27aaea868a51356725',
  'html:credit330:מקור': '7a5236ee6cdb7ec933db1c0c2afe07be0aee71ec002f468e6c12bdacda208525',
  'html:credit330:העתק נאמן למקור': 'e42b4bcd8bd4e484958ad98713de2e1430bea00928425641f67ec32e283f315c',
  'c100:credit330': 'ffb512fcdd3c58a6f2a157ee87520998389a10356ed48125b07ab37c1b077841',
  'd120:credit330': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'pdf:credit330:מקור': '86ee795764e2c91d531559e10b50855a3c5559dd7195a01ff4470b476b73263a',
  'pdf:credit330:העתק נאמן למקור': '0bb257177f5c53e90ee8b1ad533453d801db26f62c90e42acb80d45ad118f27d',
  'html:pay400:מקור': 'a864bebffc7b4b155312be81e153836d97af7e57ce9a2db3a3bfc4fc594f902d',
  'html:pay400:העתק נאמן למקור': 'a01bc4278fd5ec606c69644e7434ff80b3039c7242fdd01e2574996652fe357e',
  'c100:pay400': '81126dd550dd394e71f7c9686e87c626eb3877002bf6b06576bdf3cfca17fe52',
  'd120:pay400': '6d92cf1e5bcf061fe4758249f9c0a80ff92b01b5eec7b7b3df72979c128ea552',
  'pdf:pay400:מקור': '68a65db58c0a17f3c8d24b100a894e5ff5246db786dc8ecb4c4fd2aa092a7dea',
  'pdf:pay400:העתק נאמן למקור': 'bd72718fff98d4d8bae03cd11d4f945ae7a8b53982e602ebf2a4bebd5f7974cf',
  a000: '4564ebfd2511e96ba27a9c665252a24bc46eed8a9d9749c9c5c9cf6366747309',
};

test('a document issued before 2.118 looks exactly as before: HTML (original and copy), PDF, C100, D120 and A000 without a deductions file', async () => {
  process.env.NEXT_PUBLIC_APP_VERSION = '';
  const { docBody } = await import('../src/features/documents/DocumentsTab');
  const { buildDocPdf } = await import('../src/lib/server/doc-pdf');
  const b = { dealerNumber: BIZ.dealerNumber, companyNumber: BIZ.companyNumber, name: BIZ.name };
  for (const [k, r] of Object.entries(OLD)) {
    const d = toDoc(r);
    for (const mark of ['מקור', 'העתק נאמן למקור']) {
      assert.equal(h(docBody(d, BIZ, mark)), BEFORE[`html:${k}:${mark}`], `html ${k} ${mark}`);
      const pdf = await buildDocPdf(d, BIZ, { mark, software: 'Dream Promotion', signed: false });
      pdf.setCreationDate(new Date('2026-01-01T00:00:00Z')); pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
      assert.equal(h(await pdf.save({ useObjectStreams: false })), BEFORE[`pdf:${k}:${mark}`], `pdf ${k} ${mark}`);
    }
    assert.equal(h(C100(5, b, d)), BEFORE[`c100:${k}`], `C100 ${k}`);
    assert.equal(h(d.payments.map((p, i) => D120(6 + i, b, d, p, i + 1)).join('|')), BEFORE[`d120:${k}`], `D120 ${k}`);
  }
  const a = A000({ dealerNumber: '000000018', name: 'עסק דמו', companyNumber: '' }, SW,
    { id: '123456789012345', totalRecords: 9, path: 'X', from: '2026-01-01', to: '2026-12-31', startedAt: '2026-11-25T10:00:00Z' });
  assert.equal(h(a), BEFORE.a000, 'A000 of a business without a deductions file');
  // the old labels stay: Bit with code 9 → "אחר", a card without a kind → "כרטיס אשראי", a receipt's total "סה״כ שולם"
  assert.equal(docPayLabel({ method: 9, m: 'bit' }), 'אחר');
  assert.equal(docPayLabel({ method: 3, m: 'card' }), 'כרטיס אשראי');
  assert.equal(totalLabel(400, 250), 'סה״כ שולם');
  assert.equal(totalLabel(400), 'סה״כ שולם');
});

// ---- answer 16: the day it is issued, Israel time ---------------------------------------------------------------------------
test('answer 16: a document is dated today (Israel) — a past day is refused, a future one too; 00:00–03:00 and a new month are Israel\'s day', () => {
  assert.deepEqual(docDateErrors('2026-11-25', '2026-11-25'), []);
  assert.match(docDateErrors('2026-11-24', '2026-11-25').join(), /יום ההפקה/);
  assert.match(docDateErrors('2026-11-26', '2026-11-25').join(), /בעתיד/);
  assert.match(docDateErrors('25/11/2026', '2026-11-25').join(), /בעתיד/);
  // 01:30 in Israel on 1 December (winter, UTC+2) is 23:30 UTC of 30 November: the document's day is 1 December
  const t = Date.parse('2026-11-30T23:30:00Z');
  const today = israelParts(t).date;
  assert.equal(today, '2026-12-01', 'Israel time, not UTC');
  const base = { docType: 305, entity: 'licensed_dealer' as const, vatRate: 18, pricesIncludeVat: true, lines: [{ name: 'טיפול', qty: 1, unitPrice: 118 }], customer: { name: 'לקוחה דמו' } };
  assert.ok(composeDocument({ ...base, docDate: today, today }).ok);
  assert.ok(!composeDocument({ ...base, docDate: '2026-11-30', today }).ok, 'the UTC day (yesterday in Israel) is refused');
  // 02:59 in Israel in summer (UTC+3) — 23:59 UTC of the day before; and a month's last day just before midnight
  assert.equal(israelParts(Date.parse('2026-06-30T23:59:00Z')).date, '2026-07-01');
  assert.equal(israelParts(Date.parse('2026-10-31T21:59:00Z')).date, '2026-10-31');
  assert.equal(israelParts(Date.parse('2026-10-31T22:00:00Z')).date, '2026-11-01');
  // the register's document takes the day it is given, which the register gives from israelParts(now)
  const sale = { items: [{ name: 'קרם', price: 100, qty: 1 }], discount: 0, total: 100, vatAmount: 0, vatRate: 0, method: 'cash' as const, customerName: 'x', customerPhone: '', payments: [] };
  assert.equal(docFromSale(sale as any, { licensed: false, docDate: today }).docDate, '2026-12-01');
  // a receipt for an invoice and a credit invoice: the same rule
  const open = { docType: 305, docNumber: 1, customerName: 'x', lines: [], beforeDiscount: 100, discount: 0, afterDiscount: 100, vatAmount: 18, total: 118, balance: 118 };
  assert.ok(!composeReceipt(open as any, { entity: 'licensed_dealer', vatRate: 18, payments: [{ method: 'cash', amount: 118, date: '2026-11-30' }], docDate: '2026-11-30', today }).ok);
  assert.match(financeError({ message: 'doc_date_not_today: תאריך המסמך הוא תמיד יום ההפקה (01/12/2026)', code: '22008' }), /יום ההפקה/);
  // a server path whose day turned between computing the date and the insert waits and tries again (not "blocked")
  assert.equal(documentFailure({ message: 'doc_date_not_today: …', code: '22008' }).blocked, false);
});

// ---- answer 12: Bit / PayBox = 4 ------------------------------------------------------------------------------------------
test('answer 12: Bit / PayBox is 4 (bank transfer) in field 1306 — in the money screens and the register; the ledger keeps "bit"', () => {
  assert.equal(payCode('bit'), 4);
  assert.equal(PAY_CODE.bit, 4);
  assert.equal(PAY_CODE.link, 9, 'a payment link is not part of the answer — as before');
  assert.deepEqual(toDocPayment({ method: 'bit', amount: 50, date: '2026-11-25' }), { method: 4, amount: 50, date: '2026-11-25', m: 'bit' });
  const sale = { items: [{ name: 'טיפול', price: 200, qty: 1 }], discount: 0, total: 200, vatAmount: 0, vatRate: 0, method: 'bit' as const, customerName: 'x', customerPhone: '', payments: [] };
  const d = docFromSale(sale as any, { licensed: false, docDate: '2026-11-25' });
  assert.deepEqual(d.payments, [{ method: 4, amount: 200, date: '2026-11-25', m: 'bit' }]);
  assert.equal(docPayLabel(d.payments[0]), 'Bit / PayBox', 'a new receipt says Bit, not "העברה בנקאית"');
  const rec = D120(3, { dealerNumber: '000000018', name: 'x' }, { ...d, docNumber: 1, linkNo: 1, issuedAt: '2026-11-25T08:00:00Z' } as Doc, d.payments[0], 1);
  assert.equal(rec[49], '4', 'field 1306 (position 50)');
});

// ---- answer 13: a card payment's kind ---------------------------------------------------------------------------------------
test('answer 13: a card payment names its kind (1–5) — the form asks (no default), the servers say "regular"; field 1315', () => {
  assert.deepEqual(CARD_KINDS.map((k) => [k.id, k.label]), [[1, 'רגיל'], [2, 'תשלומים'], [3, 'קרדיט'], [4, 'חיוב נדחה'], [5, 'אחר']]);
  assert.ok(isCardKind(3) && !isCardKind(0) && !isCardKind(6) && !isCardKind('2') && !isCardKind(1.5));
  // the form: no kind → refused, in Hebrew
  assert.deepEqual(paymentErrors([{ method: 'card', amount: 100, date: '2026-11-25' }], 10000, '2026-11-25'), [CARD_KIND_MISSING]);
  assert.deepEqual(paymentErrors([{ method: 'card', amount: 100, date: '2026-11-25', cardKind: 2 }], 10000, '2026-11-25'), []);
  assert.deepEqual(paymentErrors([{ method: 'cash', amount: 100, date: '2026-11-25' }], 10000, '2026-11-25'), [], 'no kind on cash');
  // the document keeps the kind on the card payment only
  assert.equal((toDocPayment({ method: 'card', amount: 1, date: '2026-11-25', cardKind: 4 }) as any).cardKind, 4);
  assert.ok(!('cardKind' in toDocPayment({ method: 'cash', amount: 1, date: '2026-11-25', cardKind: 4 })), 'switched from card to cash: the kind is not sent');
  const doc = composeDocument({ docType: 320, entity: 'licensed_dealer', vatRate: 18, pricesIncludeVat: true, lines: [{ name: 'טיפול', qty: 1, unitPrice: 200 }], customer: { name: 'x' },
    payments: [{ method: 'card', amount: 150, date: '2026-11-25', cardKind: 2 }, { method: 'cash', amount: 50, date: '2026-11-25' }], docDate: '2026-11-25', today: '2026-11-25' });
  assert.ok(doc.ok);
  if (doc.ok) {
    assert.deepEqual(doc.doc.payments.map((p) => p.cardKind), [2, undefined]);
    assert.deepEqual(docInvariants(doc.doc, 18), []);
    assert.equal(docPayLabel(doc.doc.payments[0]), 'כרטיס אשראי (תשלומים)');
  }
  // the register / an online order: one charge → regular (1)
  const sale = { items: [{ name: 'טיפול', price: 200, qty: 1 }], discount: 0, total: 200, vatAmount: 0, vatRate: 0, method: 'split' as const, customerName: 'x', customerPhone: '',
    payments: [{ method: 'card' as const, amount: 120 }, { method: 'cash' as const, amount: 80 }] };
  const reg = docFromSale(sale as any, { licensed: false, docDate: '2026-11-25' });
  assert.deepEqual(reg.payments.map((p) => [p.method, p.cardKind]), [[3, 1], [1, undefined]]);
  assert.deepEqual(docInvariants({ ...reg }, 0), []);
  // the database invariants: a card without a kind, a kind on cash
  assert.ok(docInvariants({ ...reg, payments: [{ method: 3, amount: 200, date: '2026-11-25' }] }, 0).includes('card payment without its kind'));
  assert.ok(docInvariants({ ...reg, payments: [{ method: 1, amount: 200, date: '2026-11-25', cardKind: 1 }] }, 0).includes('a kind on a payment that is not a card'));
  // field 1315 (position 140): the kind; an old card payment without one — 1, as before; not a card — 0
  assert.deepEqual([cardKindField({ method: 3, cardKind: 3 }), cardKindField({ method: 3 }), cardKindField({ method: 3, cardKind: 9 }), cardKindField({ method: 1 }), cardKindField({ method: 4, cardKind: 2 })], [3, 1, 1, 0, 0]);
  const d = { ...reg, docNumber: 1, linkNo: 1, issuedAt: '2026-11-25T08:00:00Z' } as Doc;
  const r120 = D120(3, { dealerNumber: '000000018', name: 'x' }, d, { method: 3, amount: 120, date: '2026-11-25', cardKind: 5 }, 1);
  assert.equal(r120.length, 222);
  assert.equal(r120[139], '5');
  assert.match(financeError({ message: 'card_kind_missing: …' }), /סוג העסקה/);
  assert.match(financeError({ message: 'card_kind_not_card: …' }), /רק בתשלום בכרטיס/);
});

// ---- answer 17: field 1016 ----------------------------------------------------------------------------------------------------
test('answer 17: the deductions file number goes into field 1016 (positions 196–204 of A000); none or not 9 digits — 0 as before', () => {
  const o = { id: '123456789012345', totalRecords: 9, path: 'X', from: '2026-01-01', to: '2026-12-31', startedAt: '2026-11-25T10:00:00Z' };
  const at = (deductionsFile: string | null | undefined) => A000({ dealerNumber: '000000018', name: 'עסק דמו', deductionsFile }, SW, o).slice(195, 204);
  assert.equal(at('000000935'), '000000935');
  assert.equal(at(null), '000000000');
  assert.equal(at(''), '000000000');
  assert.equal(at('12345'), '000000000', 'not 9 digits — not written');
  assert.equal(A000({ dealerNumber: '000000018', name: 'x', deductionsFile: '000000935' }, SW, o).length, 466);
  assert.deepEqual([deductionsFileField({ deductionsFile: ' 000000935 ' }), deductionsFileField({})], ['000000935', 0]);
  assert.match(financeError({ message: 'new row for relation "register_settings" violates check constraint "register_settings_deductions_file_check"' }), /תיק ניכויים/);
});

// ---- answers 8 + 15: the refund receipt ----------------------------------------------------------------------------------------
const RECEIPT = { ...toDoc({ ...OLD.bit400, doc_number: 21, id: 'R1', payments: [{ method: 3, amount: 250, date: '2026-11-20', m: 'card', cardKind: 2 }] }) };
test('answer 15: a refund receipt — a 400 below zero on the receipt it refunds; what the database checks, in code', () => {
  const r = refundReceiptFor(RECEIPT, { payments: [{ method: 1, amount: 100, m: 'cash' }], docDate: '2026-11-25' });
  assert.equal(r.docType, 400);
  assert.deepEqual([r.total, r.beforeDiscount, r.afterDiscount, r.discount, r.vatAmount], [-100, -100, -100, 0, 0]);
  assert.deepEqual([r.baseDocType, r.baseDocNumber], [400, 21]);
  assert.deepEqual(r.payments, [{ method: 1, amount: -100, date: '2026-11-25', m: 'cash' }]);
  assert.deepEqual(r.lines.map((l) => [l.name, l.totalExVat]), [['החזר כספי — קבלה מס׳ 21', -100]]);
  assert.deepEqual(docInvariants(r, 0), []);
  assert.ok(isRefundReceipt(r) && !isRefundReceipt(RECEIPT));
  assert.equal(totalLabel(r.docType, r.total), 'סה״כ הוחזר');
  assert.equal(baseDocLine(r), 'החזר כספי על קבלה מס׳ 21');
  // to the card: its kind — the receipt's own card payment's (installments here), else regular
  const card = refundReceiptFor(RECEIPT, { payments: [{ method: 3, amount: 50, m: 'card' }], docDate: '2026-11-25' });
  assert.equal(card.payments[0].cardKind, 2);
  const plain = refundReceiptFor({ ...RECEIPT, payments: [{ method: 1, amount: 250, date: '2026-11-20' }] }, { payments: [{ method: 3, amount: 50, m: 'card' }], docDate: '2026-11-25' });
  assert.equal(plain.payments[0].cardKind, 1);
  assert.throws(() => refundReceiptFor({ ...RECEIPT, docType: 320 }, { payments: [{ method: 1, amount: 1 }], docDate: '2026-11-25' }), /receipt/);
  assert.throws(() => refundReceiptFor(RECEIPT, { payments: [{ method: 9, amount: 5, m: 'withholding' }], docDate: '2026-11-25' }), /withheld/);
  // what is left: the receipt less the refund receipts on it (another receipt's do not count)
  const others = [r, { docType: 400, total: -30, baseDocType: 400, baseDocNumber: 99 }, { docType: 400, total: 70, baseDocType: null, baseDocNumber: null }];
  assert.equal(refundLeft(RECEIPT, others), 150);
  assert.equal(refundLeft(RECEIPT, [r, r, r]), 0, 'never below zero');
  // the money screens' form
  const ok = composeRefundReceipt(RECEIPT, { entity: 'exempt_dealer', left: 150, payments: [{ method: 'bit', amount: 150, date: '2026-11-25' }], docDate: '2026-11-25', today: '2026-11-25', notes: 'החזר' });
  assert.ok(ok.ok);
  if (ok.ok) { assert.deepEqual(ok.doc.payments, [{ method: 4, amount: -150, date: '2026-11-25', m: 'bit' }]); assert.deepEqual(docInvariants(ok.doc, 0), []); assert.equal(ok.doc.notes, 'החזר'); }
  const bad = (o: Partial<Parameters<typeof composeRefundReceipt>[1]>) => {
    const x = composeRefundReceipt(RECEIPT, { entity: 'exempt_dealer', left: 150, payments: [{ method: 'cash', amount: 100, date: '2026-11-25' }], docDate: '2026-11-25', today: '2026-11-25', ...o });
    return x.ok ? '' : x.errors.join(' | ');
  };
  assert.match(bad({ entity: 'licensed_dealer' }), /רק לעוסק פטור/);
  assert.match(bad({ payments: [{ method: 'cash', amount: 151, date: '2026-11-25' }] }), /גדול ממה שנשאר/);
  assert.match(bad({ payments: [{ method: 'card', amount: 100, date: '2026-11-25' }] }), /סוג העסקה/);
  assert.match(bad({ payments: [{ method: 'withholding', amount: 100, date: '2026-11-25' }] }), /ניכוי במקור/);
  assert.match(bad({ docDate: '2026-11-24' }), /יום ההפקה/);
  assert.match(bad({ payments: [] }), /גדול מאפס/);
  // its key: the receipt's n-th refund — never one of a register refund (refund:<uuid>)
  assert.equal(followKey('refund', 'doc-1', 0), 'refund:doc-1:1');
});

test('answer 15: the register\'s / an order\'s refund — the returned items (their share of the discount), no VAT, agorot-exact', () => {
  const sale = { subtotal: 300, total: 270 };
  const r = refundReceiptForRefund({ ...RECEIPT, total: 270 }, { amount: 90, method: 'cash', items: [{ name: 'קרם', price: 100, qty: 1 }] as any }, sale, '2026-11-25');
  assert.deepEqual(r.lines.map((l) => [l.name, l.qty, l.totalExVat, l.vatRate, l.restock]), [['קרם', 1, -90, 0, undefined]]);
  assert.deepEqual([r.total, r.payments[0].amount, r.payments[0].method, r.baseDocNumber], [-90, -90, 1, 21]);
  assert.deepEqual(docInvariants(r, 0), []);
  const sum = refundReceiptForRefund({ ...RECEIPT, total: 270 }, { amount: 33.33, method: 'bit', items: [] }, sale, '2026-11-25');
  assert.deepEqual([sum.lines.length, sum.total, sum.payments[0].method, sum.payments[0].m], [1, -33.33, 4, 'bit']);
  const card = refundReceiptForRefund(RECEIPT, { amount: 10, method: 'card', items: [] }, sale, '2026-11-25');
  assert.equal(card.payments[0].cardKind, 2, 'the kind of the receipt\'s card payment');
});

test('answers 8 + 15: the refusals in Hebrew; before migration 6800 the refund receipt is refused by the old checks — a plain message', () => {
  assert.match(financeError({ message: 'cancel_receipt_not_allowed: קבלה לא מבטלים' }), /קבלה לא מבטלים/);
  assert.match(financeError({ message: 'refund_receipt_not_exempt: …' }), /רק לעוסק פטור/);
  assert.match(financeError({ message: 'refund_receipt_over: על הקבלה נשארו להחזר 40.00 ש״ח' }), /נשארו ₪40/);
  assert.match(financeError({ message: 'refund_receipt_base: הקבלה שעליה ההחזר בוטלה' }), /בוטלה/);
  assert.match(financeError({ message: 'refund_receipt_base: הקבלה שעליה ההחזר לא נמצאה בעסק הזה' }), /לא נמצאה/);
  assert.match(financeError({ message: 'refund_receipt_alone: …' }), /לא משלמת חשבונית/);
  assert.match(financeError({ message: 'refund_receipt_payments: …' }), /כסף שהוחזר/);
  assert.match(financeError({ message: 'refund_receipt_refund: …' }), /לא תואמת/);
  // the old database refuses a refund receipt first for its base (5000's documents_validate), and one without a base for its totals
  assert.equal(refundReceiptError({ message: OLD_BASE, code: '23514' }), REFUND_RECEIPT_WAITS);
  assert.equal(refundReceiptError({ message: OLD_TOTALS, code: '23514' }), REFUND_RECEIPT_WAITS);
  assert.ok(refundReceiptWaits({ message: OLD_BASE }) && !refundReceiptWaits({ message: 'refund_receipt_over: 5' }));
  // the message says where to complete it — it never promises that it happens by itself
  assert.match(REFUND_RECEIPT_WAITS, /כספים ← מסמכים/);
  assert.match(REFUND_RECEIPT_WAITS, /החזר כספי/);
  assert.match(refundReceiptError({ message: 'refund_receipt_over: על הקבלה נשארו להחזר 5 ש״ח' }), /נשארו ₪5/);
});

test('the unified file: a refund receipt is C100 + D120 below zero (1219 / 1221 / 1223, 1312), its customer\'s money back a debit (B110)', () => {
  const b = { dealerNumber: '000000018', name: 'עסק דמו' };
  const back = { ...refundReceiptFor(RECEIPT, { payments: [{ method: 1, amount: 100, m: 'cash' }], docDate: '2026-11-25' }), docNumber: 22, linkNo: 2, issuedAt: '2026-11-25T08:00:00Z' } as Doc;
  const c = C100(2, b, back);
  assert.equal(c.length, 444);
  // 1219 starts after 4+9+9+3+20+8+4+50+50+10+30+8+30+2+15+9+8+15+3 = 287: 1219, 1220, 1221, 1222, 1223 — 15 each
  const amt = (i: number) => c.slice(287 + 15 * i, 302 + 15 * i);
  assert.deepEqual([0, 1, 2, 3, 4].map(amt), ['-00000000010000', '+00000000000000', '-00000000010000', '+00000000000000', '-00000000010000']);
  const d = D120(3, b, back, back.payments[0], 1);
  assert.equal(d.slice(103, 118), '-00000000010000', '1312 below zero');
  // no D110 for a receipt (as every 400); the printout sums field 1223 with its sign
  const f = buildOpenFormat(b, SW, [RECEIPT, back], { from: '2026-01-01', to: '2026-12-31', startedAt: '2026-11-25T10:00:00Z', id: '123456789012345' });
  const n = f.counts as Record<string, number>;
  assert.deepEqual([n.C100, n.D110, n.D120], [2, 0, 2]);
  assert.equal(docTypeReport([RECEIPT, back], '2026-01-01', '2026-12-31').find((x) => x.code === 400)!.total, 150);
  // the customer's card: the receipt is credit (250), the money given back a debit (100) — movements positive
  const [acc] = accountsOf([RECEIPT, back]);
  assert.deepEqual([acc.debitA, acc.creditA], [10000, 25000]);
  assert.equal(B110(1, b, acc).length, 376);
});

// ---- the server: an online order's refund for an exempt dealer ----------------------------------------------------------------
test('an online order\'s refund of an exempt dealer: a refund receipt with the refund (key refund:<id>); before 6800 — the refund stays, a plain reason', async () => {
  const BIZ_ID = 'b0000000-0000-4000-8000-000000000068';
  const SALE = 's0000000-0000-4000-8000-000000000068';
  const tables = (entity = 'exempt_dealer'): Record<string, any[]> => ({
    register_settings: [{ business_id: BIZ_ID, entity_type: entity, business_type: 'exempt', dealer_number: '000000018', legal_name: 'עסק דמו' }],
    sales: [{ id: SALE, business_id: BIZ_ID, user_id: 'u1', lead_id: null, customer_name: 'לקוחה דמו', customer_phone: '0500000002', items: [{ name: 'קרם', price: 120, qty: 1 }],
      subtotal: 120, discount: 0, total: 120, vat_rate: 0, vat_amount: 0, method: 'card', status: 'paid', payments: [] }],
    documents: [{ ...OLD.bit400, id: 'D400', business_id: BIZ_ID, sale_id: SALE, doc_number: 31, total: 120, before_discount: 120, after_discount: 120,
      lines: [{ name: 'קרם', qty: 1, unitPriceExVat: 120, discountExVat: 0, totalExVat: 120, vatRate: 0, kind: 2 }], payments: [{ method: 3, amount: 120, date: '2026-11-20', m: 'card', cardKind: 1 }] }],
    sale_refunds: [],
  });
  const { recordOrderRefund } = await import('../src/lib/server/commerce');
  const plan = { saleId: SALE, amount: 120, vatAmount: 0, method: 'card' as const, items: [{ name: 'קרם', price: 120, qty: 1 }] as any, restock: true, reason: 'החזרה', employeeName: '' };

  // migration 6800 in the database: the refund receipt is issued
  const now = tables();
  (globalThis as any).__DP_TEST_ADMIN_DB__ = fakeDb(now);
  const r = await recordOrderRefund(BIZ_ID, 'u1', SALE, plan);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.credit, 'refund_issued');
  const back = now.documents.find((d) => d.idempotency_key === `refund:${r.refundId}`)!;
  assert.deepEqual([back.doc_type, back.total, back.base_doc_type, back.base_doc_number, back.refund_id, back.sale_id, back.source], [400, -120, 400, 31, r.refundId, SALE, 'refund']);
  assert.deepEqual(back.payments, [{ method: 3, amount: -120, date: back.doc_date, m: 'card', cardKind: 1 }]);
  assert.ok(back.lines.every((l: any) => !l.restock), 'the refund moves its own stock');
  assert.equal(back.doc_date, israelParts(Date.now()).date);

  // before 6800: the old checks refuse a total below zero — the refund is recorded, the reason is plain Hebrew
  const old = tables();
  (globalThis as any).__DP_TEST_ADMIN_DB__ = fakeDb(old, {
    // as 5000's documents_validate refuses it: a base document on a receipt comes first
    onInsert: (t, row) => (t === 'documents' && Number(row.total) <= 0 ? { code: '23514', message: row.base_doc_type != null ? OLD_BASE : OLD_TOTALS } : null) });
  const o = await recordOrderRefund(BIZ_ID, 'u1', SALE, plan);
  assert.ok(o.ok);
  if (o.ok) { assert.equal(o.credit, REFUND_RECEIPT_WAITS); assert.equal(o.receipt, true); }
  assert.equal(old.sale_refunds.length, 1, 'the refund itself stays');
  assert.equal(old.documents.length, 1, 'no document');
  // a nonprofit (עמותה): the answer was an exempt dealer's — no refund receipt (an open question), the refund stays
  const np = tables('nonprofit');
  (globalThis as any).__DP_TEST_ADMIN_DB__ = fakeDb(np);
  const n = await recordOrderRefund(BIZ_ID, 'u1', SALE, plan);
  assert.ok(n.ok && n.credit === 'not_required');
  assert.deepEqual([np.sale_refunds.length, np.documents.length], [1, 1]);
  delete (globalThis as any).__DP_TEST_ADMIN_DB__;
});

test('a refund receipt prints its amounts left to right ("-80.00", not "80.00-") — HTML and PDF; amounts above zero as before', async () => {
  process.env.NEXT_PUBLIC_APP_VERSION = '';
  const { n2, docBody } = await import('../src/features/documents/DocumentsTab');
  const { money, drawn, buildDocPdf } = await import('../src/lib/server/doc-pdf');
  assert.equal(n2(80), '80.00');
  assert.equal(n2(-80), '<span dir="ltr">-80.00</span>');
  assert.equal(n2('x'), '');
  assert.equal(money(80), '80.00');
  assert.equal(drawn(money(80)), '80.00');
  assert.equal(drawn(money(-80)), '-80.00');
  assert.equal(drawn(`${money(-80)} ₪`), '₪ -80.00', 'the total line, as drawn in the PDF');
  const back = { ...refundReceiptFor(RECEIPT, { payments: [{ method: 1, amount: 80, m: 'cash' }], docDate: '2026-11-25' }), docNumber: 22, linkNo: 2, issuedAt: '2026-11-25T08:00:00Z' } as Doc;
  const html = docBody(back, BIZ, 'מקור');
  assert.ok(html.includes('<span dir="ltr">-80.00</span> ₪'), 'the total');
  assert.ok(!/[0-9]-</.test(html), 'no amount with its minus after it');
  const pdf = await buildDocPdf(back, BIZ, { mark: 'מקור', software: 'Dream Promotion', signed: false });
  assert.ok((await pdf.save()).length > 1000, 'the PDF of a refund receipt is drawn (the isolates are not glyphs of the font)');
});

test('a sale\'s refund receipts (sale-receipts.ts): what is missing, and the same documents the register issues — so DocView can complete one', () => {
  const r400 = { ...RECEIPT, docNumber: 21, total: 250, payments: [{ method: 1, amount: 150, date: '2026-11-20', m: 'cash' }, { method: 3, amount: 100, date: '2026-11-20', m: 'card', cardKind: 2 }] };
  // a cancelled sale: what is left, as the receipt was paid
  const c = cancelReceiptDoc(r400, [], '2026-11-25')!;
  assert.deepEqual(c.payments.map((p) => [p.method, p.amount, p.cardKind]), [[1, -150, undefined], [3, -100, 2]]);
  assert.equal(c.total, -250);
  assert.deepEqual(docInvariants(c, 0), []);
  // refunded in part before: one payment of what is left
  const part = { docType: 400, total: -50, baseDocType: 400, baseDocNumber: 21, refundId: 'R1' };
  // (a refund receipt of a refund counts through its refund — sale_refunds; the receipt alone is not the money twice)
  assert.equal(cancelReceiptDoc(r400, [part], '2026-11-25', [{ amount: 50 }])!.total, -200);
  assert.equal(cancelReceiptDoc(r400, [{ ...part, total: -250 }], '2026-11-25', [{ amount: 250 }]), null, 'nothing left');
  // the sale's refunds count once — with their refund receipt or without (its money went out on the refund's own row)
  const cancelPart = { ...part, refundId: null };
  assert.equal(cancelLeft(r400, [], [{ amount: 50 }]), 200, 'a refund with no refund receipt yet');
  assert.equal(cancelLeft(r400, [part], [{ amount: 50 }]), 200, 'a refund and its refund receipt: the same money, once');
  assert.equal(cancelLeft(r400, [cancelPart], [{ amount: 30 }]), 170, 'an earlier cancellation\'s refund receipt and a refund');
  assert.equal(cancelLeft(r400, [], [{ amount: 300 }]), 0, 'never below zero');
  assert.equal(cancelReceiptDoc(r400, [], '2026-11-25', [{ amount: 50 }])!.total, -200);
  assert.equal(cancelReceiptDoc(r400, [], '2026-11-25', [{ amount: 250 }]), null);
  // a refund: never beyond what is left
  const sale = { subtotal: 250, total: 250 };
  assert.equal(refundReceiptDoc(r400, [], { amount: 50, method: 'cash', items: [] }, sale, '2026-11-25')!.total, -50);
  assert.equal(refundReceiptDoc(r400, [{ ...part, total: -220 }], { amount: 50, method: 'cash', items: [] }, sale, '2026-11-25'), null);
  // missing: a refund with no refund receipt; a cancelled sale whose receipt was neither refunded nor marked "בוטל"
  const back = { docType: 400, total: -50, baseDocType: 400, baseDocNumber: 21, refundId: 'R1' };
  assert.deepEqual(missingSaleReceipts({ saleStatus: 'paid', refunds: [{ id: 'R1' }, { id: 'R2' }], docs: [r400, back], receiptCancelled: false }).refunds.map((r) => r.id), ['R2']);
  assert.equal(missingSaleReceipts({ saleStatus: 'cancelled', refunds: [], docs: [r400], receiptCancelled: false }).cancel, true);
  assert.equal(missingSaleReceipts({ saleStatus: 'cancelled', refunds: [], docs: [r400], receiptCancelled: true }).cancel, false, 'cancelled before 6800 — nothing to do');
  assert.equal(missingSaleReceipts({ saleStatus: 'cancelled', refunds: [], docs: [r400, { ...back, refundId: null }], receiptCancelled: false }).cancel, false, 'already refunded');
  assert.equal(missingSaleReceipts({ saleStatus: 'paid', refunds: [], docs: [r400], receiptCancelled: false }).cancel, false);
});
