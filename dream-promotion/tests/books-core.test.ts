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
import { latestStart, nextMonth, replayLeft, replayMessage, showBooks, startMonthProblem, startMoveExplain, suspenseOf, toBooksState } from '../src/features/finance/books';
import { replayPending } from '../src/lib/server/books';
import { TAX_FROM_300_LINK, TAX_FROM_300_NOT_VAT, TAX_FROM_300_RATE, composeTaxFrom300, taxFrom300Extra, taxFrom300Key } from '../src/features/finance/tax-from-300';

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
  assert.match(he('invoice_from_300_closed: על חשבון העסקה הזה כבר הופקה חשבונית מס'), /כבר הופקה חשבונית מס/);
  assert.equal(he('invoice_from_300: חשבון העסקה בוטל'), 'חשבון העסקה בוטל — לא מפיקים ממנו חשבונית מס.');
  assert.equal(he('invoice_from_300_paylink: open link'), 'יש לינק תשלום פתוח על חשבון העסקה — מבטלים אותו קודם או מחכים לתשלום.');
  assert.equal(he('invoice_from_300: חשבון העסקה לא נמצא בעסק הזה'), 'חשבון העסקה לא נמצא בעסק הזה.');
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
  // moving back: the warning about field 1225 of the documents of those months (a file already delivered); forward — none
  const warn = startMoveExplain('2026-06-01', '2026-11-27', '2026-12-01');
  assert.ok(warn.some((x) => /שדה 1225/.test(x) && x.includes('01/06/2026') && /כבר נמסר/.test(x)));
  assert.ok(!startMoveExplain('2027-01-01', '2026-12-05', '2026-12-01').some((x) => /1225/.test(x)));
  assert.ok(!startMoveExplain('2026-06-01', '2026-11-27').some((x) => /1225/.test(x)), 'no current start given — no warning');
});

// ---- review of 2.121 (the brain, 27.11.2026): what did not post — the night's timer and "לרשום עכשיו"; the suspense account --------
test('the night: replayPending calls gl_replay_pending with a limit, a few times while there is time; an old database — nothing', async () => {
  const calls: unknown[] = [];
  let left = 450;
  const db = { rpc: async (fn: string, a: { p_limit: number }) => { calls.push([fn, a]); const n = Math.min(a.p_limit, left); left -= n; return { data: { posted: n, failed: 0, left }, error: null }; } };
  const r = await replayPending(db as never, Date.now() + 10_000, { limit: 200 });
  assert.deepEqual(r, { ready: true, posted: 450, failed: 0, skipped: 0, left: 0, calls: 3 });
  assert.deepEqual(calls[0], ['gl_replay_pending', { p_limit: 200 }]);
  // at most maxCalls; a call that posted nothing stops (what is left fails again — tomorrow)
  left = 10_000;
  assert.equal((await replayPending(db as never, Date.now() + 10_000, { limit: 100, maxCalls: 2 })).calls, 2);
  const stuck = { rpc: async () => ({ data: { posted: 0, failed: 3, left: 3 }, error: null }) };
  assert.deepEqual(await replayPending(stuck as never, Date.now() + 10_000), { ready: true, posted: 0, failed: 3, skipped: 0, left: 3, calls: 1 });
  // a call that posted nothing but skipped some (a busy business) with more left goes on; skipped with nothing left stops
  let k = 0;
  const busy = { rpc: async () => { k++; return { data: k < 3 ? { posted: 0, failed: 0, skipped: 5, left: 5 } : { posted: 5, failed: 0, skipped: 0, left: 0 }, error: null }; } };
  assert.deepEqual(await replayPending(busy as never, Date.now() + 10_000), { ready: true, posted: 5, failed: 0, skipped: 10, left: 0, calls: 3 });
  const busyDone = { rpc: async () => ({ data: { posted: 0, failed: 0, skipped: 2, left: 0 }, error: null }) };
  assert.equal((await replayPending(busyDone as never, Date.now() + 10_000)).calls, 1);
  // no time: no call
  assert.equal((await replayPending(db as never, Date.now() - 1)).calls, 0);
  // before 7100 (or before the function): silently nothing
  const old = { rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.gl_replay_pending' } }) };
  assert.deepEqual(await replayPending(old as never, Date.now() + 10_000), { ready: false, posted: 0, failed: 0, skipped: 0, left: null, calls: 1 });
  // any other error: logged by its code only, no message (it may name a document)
  const logged: unknown[][] = []; const orig = console.error; console.error = (...a: unknown[]) => { logged.push(a); };
  try { await replayPending({ rpc: async () => ({ data: null, error: { code: '57014', message: 'canceling statement — 305 1234 לקוחה' } }) } as never, Date.now() + 10_000); }
  finally { console.error = orig; }
  assert.deepEqual(logged, [['[cron/books] replay', '57014']]);
});

test('the card: the suspense balance (9100) from the trial balance; gl_replay\'s answer and what the owner reads', () => {
  assert.equal(suspenseOf([{ key: '1100', closing: 50 }, { key: '9100', closing: 12.3 }, { key: '9100', closing: 0.1 }]), 12.4);
  assert.equal(suspenseOf([{ key: '1100', closing: 50 }]), 0);
  assert.equal(suspenseOf(null), null);
  assert.deepEqual(replayLeft({ posted: 3, failed: 1, skipped: 2, left: 7 }), { posted: 3, failed: 1, skipped: 2, left: 7 });
  assert.deepEqual(replayLeft({ business: 'x', from: '2026-12-01', posted: 2, failed: 0 }), { posted: 2, failed: 0, skipped: 0, left: null }, 'the first gl_replay — no "left"');
  assert.deepEqual(replayLeft('x'), { posted: 0, failed: 0, skipped: 0, left: null });
  assert.equal(replayMessage({ posted: 1, failed: 0, left: 0 }), 'נרשמה פקודה אחת.');
  assert.equal(replayMessage({ posted: 300, failed: 0, left: 120 }), 'נרשמו 300 פקודות. עוד 120 יירשמו הלילה, לבד.');
  assert.equal(replayMessage({ posted: 4, failed: 0, skipped: 3, left: 3 }), 'נרשמו 4 פקודות. 3 נכשלו היום ויטופלו מחר, או בלחיצה על "לרשום עכשיו".');
  assert.equal(replayMessage({ posted: 4, failed: 0, skipped: 3, left: 10 }), 'נרשמו 4 פקודות. עוד 7 יירשמו הלילה, לבד. 3 נכשלו היום ויטופלו מחר, או בלחיצה על "לרשום עכשיו".');
  assert.equal(replayMessage({ posted: 0, failed: 2, left: 2 }), 'לא נרשם דבר חדש. עוד 2 יירשמו הלילה, לבד. 2 לא נרשמו גם הפעם — נשארים ב"ממתינים לרישום".');
});

// ---- answer 19: a tax invoice (305) from a transaction invoice (300) ------------------------------------------------------------
test('answer 19: the 305 of a 300 — its lines and amounts as they are, today, linked (base or paid — the database\'s contract)', () => {
  const t300 = { docType: 300, docNumber: 12, linkNo: 40, issuedAt: '2026-11-20T08:00:00Z', docDate: '2026-11-20', customerName: 'לקוחה דמו', customerPhone: '050-0000001',
    customerDealer: '000000109', customerStreet: 'רחוב דמו 1', customerCity: 'עיר דמו',
    beforeDiscount: 200, discount: 20, afterDiscount: 180, vatAmount: 32.4, total: 212.4, issuedBy: '',
    lines: [{ name: 'קרם דמו', qty: 2, unitPriceExVat: 100, discountExVat: 0, totalExVat: 200, vatRate: 18, kind: 2 as const, itemId: 'item-1', variantId: 'v-1' }], payments: [] } as Doc;
  assert.equal(TAX_FROM_300_LINK, 'base', 'the database\'s contract (7100): base_doc_type 300 + its number');
  const base = composeTaxFrom300(t300, { entity: 'licensed_dealer', vatRate: 18, docDate: '2026-11-27', link: 'base' });
  assert.ok(base.ok);
  if (!base.ok) return;
  const d = base.doc;
  assert.deepEqual([d.docType, d.docDate, d.customerName, d.customerDealer, d.beforeDiscount, d.discount, d.afterDiscount, d.vatAmount, d.total, d.baseDocType, d.baseDocNumber],
    [305, '2026-11-27', 'לקוחה דמו', '000000109', 200, 20, 180, 32.4, 212.4, 300, 12]);
  assert.deepEqual(d.lines, t300.lines, 'the 300\'s lines exactly (the database moves no stock for it — the 300 did)');
  assert.deepEqual(d.payments, []);
  assert.match(d.notes ?? '', /על פי חשבונית עסקה מס׳ 12/);
  assert.deepEqual(docInvariants(d, 18), []);
  const paid = composeTaxFrom300(t300, { entity: 'company', vatRate: 18, docDate: '2026-11-27', link: 'paid' });
  assert.ok(paid.ok && paid.doc.baseDocType == null && paid.doc.baseDocNumber == null);
  assert.deepEqual(taxFrom300Extra('paid', 'id-300'), { paidDocumentId: 'id-300' });
  assert.deepEqual(taxFrom300Extra('base', 'id-300'), {});
  assert.equal(taxFrom300Key('id-300'), 'tax300:id-300');
  // refused: an exempt dealer, another VAT rate today (a question to the accountant), not a 300, cancelled
  const no = (o: Partial<Parameters<typeof composeTaxFrom300>[1]>, doc: Doc = t300) => {
    const r = composeTaxFrom300(doc, { entity: 'licensed_dealer', vatRate: 18, docDate: '2026-11-27', link: 'base', ...o });
    return r.ok ? [] : r.errors;
  };
  assert.ok(no({ entity: 'exempt_dealer' }).includes(TAX_FROM_300_NOT_VAT));
  assert.ok(no({ vatRate: 17 }).includes(TAX_FROM_300_RATE));
  assert.ok(no({}, { ...t300, docType: 305 }).length > 0);
  assert.ok(no({ cancelled: true }).length > 0);
  // the 300 itself is not changed
  assert.equal(t300.lines[0].itemId, 'item-1');
  assert.ok(d.lines[0] !== t300.lines[0], 'copies, not the same objects');
});
