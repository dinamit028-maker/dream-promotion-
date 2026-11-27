/**
 * 2.121 — stage 4ב (migration 20261128007100, docs/ita-registration/STAGE4_PLAN_HE.md): a card payment in installments (answer 8)
 * as the form asks it and the document keeps it — the same rules as documents_installments (tests/sql/books-core.check.sql), in
 * Israel time; the Hebrew of the database's refusals; the books' card in the money settings (gl_books_state, the move of the
 * start date — the rules of gl_books_start_set). Demo data only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { israelParts } from '../src/lib/il-time';
import { FIRST_DUE_BAD, INSTALLMENTS_MISSING, addDaysISO, installmentsErrors, isInstallments, toDocPayment, type PaymentEntry } from '../src/features/finance/payments';
import { composeDocument, composeReceipt, composeRefundReceipt, docInvariants, paymentErrors } from '../src/features/finance/compose';
import { financeError } from '../src/features/finance/rows';
import { D120, cardKindField, type Doc } from '../src/features/documents/openformat';
import { latestStart, nextMonth, showBooks, startMonthProblem, startMoveExplain, toBooksState } from '../src/features/finance/books';

const card = (o: Partial<PaymentEntry> = {}): PaymentEntry => ({ method: 'card', amount: 600, date: '2026-11-25', cardKind: 2, ...o });

test('answer 8: "תשלומים" asks how many — 2 to 36, a whole number, required', () => {
  assert.deepEqual(installmentsErrors(card()), [INSTALLMENTS_MISSING]);
  for (const n of [2, 3, 12, 36]) assert.deepEqual(installmentsErrors(card({ installments: n })), [], String(n));
  for (const n of [0, 1, 37, 2.5, Number.NaN, -3]) assert.deepEqual(installmentsErrors(card({ installments: n })), [INSTALLMENTS_MISSING], String(n));
  assert.ok(!isInstallments('3') && isInstallments(3));
  // another kind, another method: nothing asked (and the count, if left over, is not sent — below)
  assert.deepEqual(installmentsErrors(card({ cardKind: 1 })), []);
  assert.deepEqual(installmentsErrors({ method: 'cash', amount: 1, date: '2026-11-25', cardKind: 2 } as PaymentEntry), []);
});

test('answer 8: the first charge (optional) — from the payment\'s day to 366 days after it, a real day', () => {
  assert.deepEqual(installmentsErrors(card({ installments: 3, firstDue: '2026-11-25' })), [], 'the payment\'s day');
  assert.deepEqual(installmentsErrors(card({ installments: 3, firstDue: '2026-11-24' })), [FIRST_DUE_BAD], 'not before it');
  assert.deepEqual(installmentsErrors(card({ installments: 3, firstDue: addDaysISO('2026-11-25', 366) })), [], 'pd + 366 — the database\'s last day');
  assert.deepEqual(installmentsErrors(card({ installments: 3, firstDue: addDaysISO('2026-11-25', 367) })), [FIRST_DUE_BAD]);
  assert.deepEqual(installmentsErrors(card({ installments: 3, firstDue: '2026-02-30' })), [FIRST_DUE_BAD], 'not a day');
  // the month and the year roll over as calendar days (no time of day): Jan 31 + 366 = Feb 1 next year; a leap year
  assert.equal(addDaysISO('2026-01-31', 1), '2026-02-01');
  assert.equal(addDaysISO('2026-01-31', 366), '2027-02-01');
  assert.equal(addDaysISO('2028-02-28', 1), '2028-02-29');
  assert.equal(addDaysISO('2028-02-29', 366), '2029-03-01');
  assert.equal(addDaysISO('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(installmentsErrors(card({ date: '2026-01-31', installments: 6, firstDue: '2027-02-01' })), []);
  assert.deepEqual(installmentsErrors(card({ date: '2026-01-31', installments: 6, firstDue: '2027-02-02' })), [FIRST_DUE_BAD]);
});

test('answer 8, Israel time: a payment made between 00:00 and 03:00 (UTC still the day before), and at a change of month', () => {
  // 01:30 on Dec 1 in Israel = 23:30 UTC on Nov 30 — the payment's day (the form's "today") is Dec 1
  const today = israelParts(new Date('2026-11-30T23:30:00Z')).date;
  assert.equal(today, '2026-12-01');
  const p = card({ date: today, installments: 3 });
  assert.deepEqual(paymentErrors([p], 60000, today), [], 'a payment of today, in installments');
  assert.deepEqual(paymentErrors([{ ...p, firstDue: '2026-11-30' }], 60000, today), [FIRST_DUE_BAD], 'the UTC day (Nov 30) is before the payment');
  assert.deepEqual(paymentErrors([{ ...p, firstDue: '2026-12-01' }], 60000, today), []);
  // 02:59 on Jan 1 (summer time does not apply in winter): the year rolls over in Israel first
  const ny = israelParts(new Date('2026-12-31T22:59:00Z')).date;
  assert.equal(ny, '2027-01-01');
  assert.deepEqual(installmentsErrors(card({ date: ny, installments: 2, firstDue: '2027-01-01' })), []);
  assert.deepEqual(installmentsErrors(card({ date: ny, installments: 2, firstDue: '2026-12-31' })), [FIRST_DUE_BAD]);
  // 00:30 in summer (UTC+3): Jul 1 in Israel, Jun 30 in UTC
  assert.equal(israelParts(new Date('2026-06-30T21:30:00Z')).date, '2026-07-01');
});

test('answer 8: the document keeps "installments" (a JSON number) and "firstDue" only on a card payment of kind 2', () => {
  const d = toDocPayment(card({ installments: 3, firstDue: '2026-12-25' })) as Record<string, unknown>;
  assert.deepEqual([d.method, d.cardKind, d.installments, d.firstDue], [3, 2, 3, '2026-12-25']);
  assert.equal(typeof d.installments, 'number');
  assert.ok(!('firstDue' in (toDocPayment(card({ installments: 3 })) as object)), 'no first charge given — none sent (the database: the payment\'s day)');
  assert.ok(!('firstDue' in (toDocPayment(card({ installments: 3, firstDue: '' })) as object)));
  // left over after the kind or the method changed — never sent (the database refuses them on anything but kind 2: installments_card_only)
  for (const p of [card({ cardKind: 1, installments: 3, firstDue: '2026-12-25' }), { ...card({ installments: 3 }), method: 'cash' as const }, card({ installments: 1 })]) {
    const x = toDocPayment(p) as Record<string, unknown>;
    assert.ok(!('installments' in x) && !('firstDue' in x), JSON.stringify(p));
  }
  // a whole document: the invariants hold; the unified file's D120 is as before (1315 = 2 — 1.31 has no field for the count)
  const r = composeDocument({ docType: 320, entity: 'licensed_dealer', vatRate: 18, pricesIncludeVat: true, lines: [{ name: 'טיפול', qty: 1, unitPrice: 600 }],
    customer: { name: 'לקוחה דמו' }, payments: [card({ installments: 6, firstDue: '2026-12-10' })], docDate: '2026-11-25', today: '2026-11-25' });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(docInvariants(r.doc, 18), []);
  assert.deepEqual(r.doc.payments.map((p) => [p.installments, p.firstDue]), [[6, '2026-12-10']]);
  const doc = { ...r.doc, docNumber: 1, linkNo: 1, issuedAt: '2026-11-25T08:00:00Z' } as Doc;
  const plain = { ...doc.payments[0] }; delete plain.installments; delete plain.firstDue;
  assert.equal(D120(3, { dealerNumber: '000000109', name: 'עסק דמו' }, doc, doc.payments[0], 1), D120(3, { dealerNumber: '000000109', name: 'עסק דמו' }, doc, plain, 1),
    'the count changes nothing in the file');
  assert.equal(cardKindField(doc.payments[0]), 2);
  // without the count the form refuses — in Hebrew
  const no = composeDocument({ docType: 320, entity: 'licensed_dealer', vatRate: 18, pricesIncludeVat: true, lines: [{ name: 'טיפול', qty: 1, unitPrice: 600 }],
    customer: { name: 'לקוחה דמו' }, payments: [card()], docDate: '2026-11-25', today: '2026-11-25' });
  assert.ok(!no.ok && no.errors.includes(INSTALLMENTS_MISSING));
  // a receipt on an invoice: the same
  const rc = composeReceipt({ id: 'i1', docType: 305, docNumber: 7, total: 600, balance: 600, customerName: 'לקוחה דמו' } as any,
    { entity: 'licensed_dealer', vatRate: 18, payments: [card({ installments: 4 })], docDate: '2026-11-25', today: '2026-11-25' });
  assert.ok(rc.ok);
  if (rc.ok) assert.equal(rc.doc.payments[0].installments, 4);
});

test('answer 8: money back is never in installments — the refund receipt neither asks nor sends a count', () => {
  const base = { docType: 400, docNumber: 21, linkNo: 21, issuedAt: '2026-11-20T08:00:00Z', docDate: '2026-11-20', customerName: 'לקוחה דמו', customerPhone: '',
    beforeDiscount: 250, discount: 0, afterDiscount: 250, vatAmount: 0, total: 250, lines: [], payments: [{ method: 3, amount: 250, date: '2026-11-20', m: 'card', cardKind: 2 }] } as Doc;
  const r = composeRefundReceipt(base, { entity: 'exempt_dealer', left: 250, payments: [card({ amount: 100, cardKind: 2, installments: 3, firstDue: '2026-12-01' })],
    docDate: '2026-11-25', today: '2026-11-25' });
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' | '));
  if (r.ok) assert.deepEqual(r.doc.payments.map((p) => [p.cardKind, 'installments' in p, 'firstDue' in p]), [[2, false, false]]);
  assert.ok(composeRefundReceipt(base, { entity: 'exempt_dealer', left: 250, payments: [card({ amount: 100 })], docDate: '2026-11-25', today: '2026-11-25' }).ok, 'no count asked');
});

test('the database\'s refusals in Hebrew (documents_installments, gl_books_start_set)', () => {
  const he = (m: string) => financeError({ message: m, code: '23514' });
  assert.equal(he('installments_card_only: מספר תשלומים — רק בתשלום בכרטיס אשראי מסוג "תשלומים" (cardKind 2)'), 'מספר תשלומים — רק בתשלום בכרטיס אשראי מסוג "תשלומים".');
  assert.equal(he('installments_count: מספר התשלומים — 2 עד 36'), 'מספר התשלומים — 2 עד 36.');
  assert.equal(he('installments_refund: החזר לא מחולק לתשלומים'), 'החזר כספי לא מחולק לתשלומים.');
  assert.equal(he('installments_first_due: מועד התשלום הראשון — תאריך מיום התשלום ועד שנה אחריו'), 'מועד החיוב הראשון — מיום התשלום ועד שנה אחריו.');
  assert.equal(he('books_start_date: תחילת הספרים — ה-1 בחודש, עד החודש הבא'), 'תחילת הספרים — ה-1 בחודש, לכל המאוחר החודש הבא.');
  assert.equal(he('books_started: כבר נרשמו פקודות בספרים — אי אפשר להזיז את תאריך ההתחלה'), 'כבר נרשמו פקודות בספרים — אי אפשר להזיז את תאריך ההתחלה.');
  assert.match(he('period_locked: the books are closed until 2026-10-31'), /הספרים סגורים/);
  for (const m of ['installments_count: x', 'books_started: x']) assert.ok(!/[0-9]{9}|₪/.test(he(m)), 'no number, no amount');
});

test('the books\' card: the state as gl_books_state gives it — the owner only; nothing on a wrong answer', () => {
  const s = toBooksState({ startDate: '2026-12-01', started: false, transactions: 0, openingEntered: false, canMoveStart: true, owner: true });
  assert.deepEqual(s, { startDate: '2026-12-01', started: false, transactions: 0, openingEntered: false, canMoveStart: true, owner: true });
  assert.ok(showBooks(s));
  assert.ok(!showBooks(toBooksState({ startDate: '2026-12-01', transactions: 3, owner: false })), 'a member who is not the owner — nothing');
  for (const bad of [null, 'x', {}, { startDate: '1.12.2026', transactions: 0 }, { startDate: '2026-12-01', transactions: -1 }, { startDate: '2026-12-01', transactions: 1.5 }]) {
    assert.equal(toBooksState(bad), null, JSON.stringify(bad));
  }
  assert.equal(toBooksState({ startDate: '2026-12-01', transactions: 2, owner: 'yes' })?.owner, false, 'only true is true');
});

test('moving the start: the 1st of a month, from 2000, up to next month (Israel time — the night and the change of month)', () => {
  assert.equal(nextMonth('2026-12'), '2027-01');
  assert.equal(latestStart('2026-11-27'), '2026-12-01');
  assert.equal(latestStart('2026-12-31'), '2027-01-01');
  assert.equal(startMonthProblem('2026-12', '2026-11-27', '2027-01-01'), null, 'next month');
  assert.equal(startMonthProblem('2026-06', '2026-11-27', '2026-12-01'), null, 'an earlier month');
  assert.match(startMonthProblem('2027-01', '2026-11-27', '2026-12-01')!, /לכל המאוחר החודש הבא/);
  assert.match(startMonthProblem('1999-12', '2026-11-27', '2026-12-01')!, /משנת 2000/);
  assert.match(startMonthProblem('2026-12', '2026-11-27', '2026-12-01')!, /כבר תאריך ההתחלה/);
  assert.match(startMonthProblem('', '2026-11-27', '2026-12-01')!, /בוחרים חודש/);
  assert.match(startMonthProblem('2026-13', '2026-11-27', '2026-12-01')!, /בוחרים חודש/);
  // 01:00 on Dec 1 in Israel (23:00 UTC on Nov 30): "next month" is already January
  const night = israelParts(new Date('2026-11-30T23:00:00Z')).date;
  assert.equal(night, '2026-12-01');
  assert.equal(startMonthProblem('2027-01', night, '2026-12-01'), null);
  assert.match(startMonthProblem('2027-02', night, '2026-12-01')!, /לכל המאוחר/);
  // what the owner reads: the day, what posts now (a start in the past) or nothing yet (in the future), and that it is final
  const back = startMoveExplain('2026-06-01', '2026-11-27');
  assert.ok(back[0].includes('01/06/2026') && /נרשם עכשיו/.test(back[1]) && /אי אפשר להזיז/.test(back[2]));
  assert.match(startMoveExplain('2026-12-01', '2026-11-27')[1], /לא נרשם כלום/);
});
