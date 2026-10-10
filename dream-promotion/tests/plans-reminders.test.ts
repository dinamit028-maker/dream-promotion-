/**
 * Payment plans, scheduled debt reminders and a duplicate expense (docs/FINANCE_ADDITIONS_HE.md T3 + T5 + T6; 2.89, migration
 * 20261010004400): the pure rules of the screens and the server — a plan adds up to the balance to the agora, its payments are
 * paid in order (the same arithmetic as the view receivable_lines: the examples of tests/sql/plans-reminders.check.sql), an
 * invoice with a plan is late by its payments; the reminders' days, tones and words; the duplicate's reasons (the same rule as
 * expense_duplicates) — and the server with an in-memory database: the timer, and a reminder's email that is asked again just
 * before it goes (A PAYMENT STOPS IT). The SQL itself is checked on Postgres (plans-reminders.check.sql, concurrency.sh §15).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, byInvoice, draftPlan, lineLabel, lineStatus, nextOpen, planError, planErrorHe, planLines, rebalance, splitEven, toLine, type Line,
} from '../src/features/finance/plans';
import { agingByLines, byLines, type Receivable } from '../src/features/finance/receivables';
import { receivablesCsv } from '../src/features/finance/reports';
import {
  CANCEL_HE, daysText, normalizeDays, reminderDoc, reminderEmail, reminderErrorHe, reminderLine, reminderText, toneForStep, toSettings,
} from '../src/features/finance/reminders';
import {
  duplicateAck, duplicateMessage, duplicateReasons, fileSha256, normalizeDocNumber, normalizeSupplier, toDuplicate, toExpense,
} from '../src/features/finance/expenses';

const TODAY = '2026-10-11';
const recv = (o: Partial<Receivable>): Receivable => ({
  id: 'd1', docType: 305, docNumber: 12, docDate: '2026-09-01', dueDate: '2026-09-10', customerName: 'נועה לוי', customerPhone: '0501111111', customerEmail: '',
  leadId: 'l1', total: 2950, credited: 0, paid: 0, balance: 2950, cancelled: false, shareToken: 'tok', ...o,
});
const line = (o: Partial<Line>): Line => ({
  documentId: 'd1', leadId: 'l1', docType: 305, docNumber: 12, docDate: '2026-09-01', customerName: 'נועה', customerPhone: '', customerEmail: '', shareToken: 'tok',
  docBalance: 2950, planId: 'p1', itemId: 'i1', n: 1, ofN: 3, dueDate: '2026-10-11', amount: 1000, open: 1000, ...o,
});

// ---- T3: a plan ---------------------------------------------------------------------------------------------------------------
test('equal parts to the agora: what does not divide goes on the first payments; the parts add up to the balance', () => {
  assert.deepEqual(splitEven(1000, 3), [333.34, 333.33, 333.33]);
  assert.deepEqual(splitEven(2950, 3), [983.34, 983.33, 983.33]);
  assert.deepEqual(splitEven(0.05, 2), [0.03, 0.02]);
  for (const [t, n] of [[1180, 7], [99.99, 12], [0.02, 2], [12345.67, 36]] as const) {
    assert.equal(Math.round(splitEven(t, n).reduce((a, x) => a + x * 100, 0)), Math.round(t * 100), `${t} / ${n}`);
  }
});

test('dates: the same day each month — the month\'s last day when it is shorter', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-10-10', 3), '2027-01-10');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.deepEqual(draftPlan(2950, 3, '2026-10-10').map((i) => `${i.n}:${i.dueDate}:${i.amount}`), ['1:2026-10-10:983.34', '2:2026-11-10:983.33', '3:2026-12-10:983.33']);
});

test('a changed payment: the ones after it share what is left; the earlier ones stay', () => {
  const p = rebalance(draftPlan(2950, 3, '2026-10-10').map((i, k) => (k === 0 ? { ...i, amount: 1000 } : i)), 2950, 0);
  assert.deepEqual(p.map((i) => i.amount), [1000, 975, 975]);
  const last = draftPlan(100, 2, '2026-10-10');
  assert.deepEqual(rebalance(last, 100, 1), last, 'the last one has nobody after it');
});

test('the screen\'s check (the database checks the same again): the sum to the agora, dates ahead and in order', () => {
  const ok = [{ dueDate: TODAY, amount: 1000 }, { dueDate: '2026-11-11', amount: 1000 }, { dueDate: '2026-12-11', amount: 950 }];
  assert.equal(planError(ok, 2950, TODAY), null);
  assert.match(planError([{ dueDate: TODAY, amount: 1000 }, { dueDate: '2026-11-11', amount: 1949.99 }], 2950, TODAY)!, /חסרים ₪0\.01/);
  assert.match(planError([{ dueDate: TODAY, amount: 2000 }, { dueDate: '2026-11-11', amount: 1000 }], 2950, TODAY)!, /עודף של ₪50/);
  assert.match(planError([{ dueDate: TODAY, amount: 2950 }], 2950, TODAY)!, /לפחות 2/);
  assert.match(planError(Array.from({ length: 37 }, (_, i) => ({ dueDate: addMonths(TODAY, i), amount: 1 })), 37, TODAY)!, /עד 36/);
  assert.match(planError([{ dueDate: '2026-10-10', amount: 1000 }, { dueDate: '2026-11-11', amount: 1950 }], 2950, TODAY)!, /כבר עבר/);
  assert.match(planError([{ dueDate: '2026-11-11', amount: 1000 }, { dueDate: '2026-11-11', amount: 1950 }], 2950, TODAY)!, /אחרי התשלום הקודם/);
  assert.match(planError([{ dueDate: TODAY, amount: 1000 }, { dueDate: '2031-12-31', amount: 1950 }], 2950, TODAY)!, /5 שנים/);
  assert.match(planError([{ dueDate: TODAY, amount: 1000.005 }, { dueDate: '2026-11-11', amount: 1949.995 }], 2950, TODAY)!, /עד אגורות/);
  assert.match(planError(ok, 0, TODAY)!, /אין יתרה/);
});

test('the lines, as the view makes them (the SQL check\'s examples): paid in order; more owed than the plan is a line of its own', () => {
  const plan = { total: 2950, items: [{ n: 1, amount: 1000, dueDate: '2026-10-11' }, { n: 2, amount: 1000, dueDate: '2026-11-10' }, { n: 3, amount: 950, dueDate: '2026-12-10' }] };
  const s = (b: number, p: typeof plan | null = plan) => planLines(b, p, '2026-10-11', '2026-10-11').map((l) => `${l.n ?? '-'}:${l.open}`).join(' ');
  assert.equal(s(1180, null), '-:1180', 'no plan: the invoice\'s own line');
  assert.equal(s(2950), '1:1000 2:1000 3:950');
  assert.equal(s(1450), '1:0 2:500 3:950', '₪1,500 paid: the first payment and half the second');
  assert.equal(s(0), '1:0 2:0 3:0');
  assert.equal(s(-50), '1:0 2:0 3:0', 'a credit beyond the invoice closes everything, never below zero');
  const small = { total: 1000, items: [{ n: 1, amount: 500, dueDate: '2026-10-21' }, { n: 2, amount: 500, dueDate: '2026-11-20' }] };
  assert.deepEqual(planLines(1180, small, null, '2026-10-11').map((l) => [l.n, l.open, l.dueDate]), [[1, 500, '2026-10-21'], [2, 500, '2026-11-20'], [null, 180, '2026-10-11']],
    'money given back after the plan: ₪180 more, due at the invoice\'s date');
  assert.equal(planLines(1450, plan, null, TODAY).reduce((a, l) => a + l.open, 0), 1450, 'the lines add up to the balance');
});

test('a line\'s status and words; the next payment; lines by invoice', () => {
  assert.equal(lineStatus(line({ open: 0 }), TODAY), 'paid');
  assert.equal(lineStatus(line({ open: 500, dueDate: '2026-11-10' }), TODAY), 'partial');
  assert.equal(lineStatus(line({ dueDate: '2026-11-10' }), TODAY), 'open');
  assert.equal(lineStatus(line({ dueDate: '2026-10-10' }), TODAY), 'overdue');
  assert.equal(lineStatus(line({ dueDate: TODAY }), TODAY), 'open', 'due today is not late');
  assert.equal(lineLabel(line({ n: 2, ofN: 3 })), 'תשלום 2 מתוך 3');
  assert.equal(lineLabel(line({ n: null, itemId: null })), 'מעבר לפריסה');
  assert.equal(lineLabel(line({ n: null, itemId: null, planId: null })), '');
  const ls = [line({ n: 1, open: 0, dueDate: '2026-10-01' }), line({ n: 2, itemId: 'i2', open: 500, dueDate: '2026-11-10' }), line({ n: 3, itemId: 'i3', open: 950, dueDate: '2026-12-10' })];
  assert.equal(nextOpen(ls)?.n, 2);
  assert.deepEqual(byInvoice(ls).map((g) => [g.documentId, g.open, g.next?.n]), [['d1', 1450, 2]]);
  assert.equal(toLine({ document_id: 'd', doc_type: 305, doc_number: '7', doc_balance: '10.5', n: null, of_n: null, amount: '10.5', open_amount: '10.5' }).open, 10.5);
});

test('an invoice with a plan is late by its payments: its own date passed but the payments are ahead → not late; a late payment → late from its date', () => {
  const r = recv({ dueDate: '2026-09-10' });
  assert.equal(byLines(r, undefined, TODAY).status, 'overdue', 'without a plan: by its own date, as before');
  const ahead = [line({ dueDate: '2026-10-20' }), line({ n: 2, itemId: 'i2', dueDate: '2026-11-20' })];
  assert.deepEqual(byLines(r, ahead, TODAY), { status: 'open', dueDate: '2026-10-20', late: 0, planned: true });
  const late = [line({ dueDate: '2026-10-01' }), line({ n: 2, itemId: 'i2', dueDate: '2026-11-20' })];
  assert.deepEqual(byLines(r, late, TODAY), { status: 'overdue', dueDate: '2026-10-01', late: 10, planned: true });
  assert.equal(byLines(recv({ balance: 0, paid: 2950 }), [], TODAY).status, 'paid', 'no open line: as the invoice is');
  const a = agingByLines([line({ open: 1000, dueDate: '2026-10-01' }), line({ open: 500, dueDate: '2026-11-20' }), line({ open: 200, dueDate: '2026-08-01' })], TODAY);
  assert.deepEqual([a.current, a.d30, a.d90, a.total], [500, 1000, 200, 1700], 'each payment in its own bucket');
  const csv = receivablesCsv([r], TODAY, new Map([['d1', late]]));
  assert.match(csv, /"באיחור \(פריסה\)"/);
  assert.match(csv, /01\/10\/2026/, 'the date of the payment that is late');
});

test('the database\'s refusals of a plan, in Hebrew', () => {
  assert.match(planErrorHe({ message: 'plan_sum: the payments add up to 1, the balance is 2' }), /לא שווה ליתרה/);
  assert.match(planErrorHe({ message: 'plan_exists: x' }), /פריסה מחדש/);
  assert.match(planErrorHe({ message: 'plan_paid: x' }), /כבר שולם/);
  assert.match(planErrorHe({ message: 'not allowed', code: '42501' }), /אין לך הרשאה/);
  assert.equal(planErrorHe(null), 'הפריסה לא נשמרה. נסו שוב.');
});

// ---- T5: reminders ----------------------------------------------------------------------------------------------------------
test('the days: once each, ascending, 1–120, at most 5; the words of the rule', () => {
  assert.deepEqual(normalizeDays([14, 3, 7, 7]), { days: [3, 7, 14], error: null });
  assert.equal(normalizeDays([0]).error, 'כל יום בין 1 ל-120.');
  assert.equal(normalizeDays([121]).error, 'כל יום בין 1 ל-120.');
  assert.equal(normalizeDays([1.5]).error, 'כל יום בין 1 ל-120.');
  assert.equal(normalizeDays([1, 2, 3, 4, 5, 6]).error, 'עד 5 תזכורות לכל חוב.');
  assert.equal(normalizeDays([]).error, 'לפחות יום אחד.');
  assert.equal(daysText([3, 7, 14]), '3, 7 ו-14 ימים אחרי מועד התשלום');
  assert.equal(daysText([5]), '5 ימים אחרי מועד התשלום');
  assert.deepEqual(toSettings(null), { enabled: false, days: [3, 7, 14], channel: 'whatsapp', approvedBy: null, approvedAt: null, updatedAt: null }, 'off until approved');
});

test('the tone of a step, as the database chooses it: gentle first; the last of three or more is the final one', () => {
  assert.deepEqual([1, 2, 3].map((s) => toneForStep(s, 3)), ['friendly', 'firm', 'final']);
  assert.deepEqual([1, 2].map((s) => toneForStep(s, 2)), ['friendly', 'firm']);
  assert.equal(toneForStep(1, 1), 'friendly');
  assert.deepEqual([1, 2, 3, 4, 5].map((s) => toneForStep(s, 5)), ['friendly', 'firm', 'firm', 'firm', 'final']);
});

test('the words: a payment of a plan says which; the values are the line\'s as it is now; the email is the same text, no advertising', () => {
  assert.equal(reminderDoc(305, 12, null, null), 'חשבונית מס מס׳ 12');
  assert.equal(reminderDoc(300, 4, 2, 3), 'תשלום 2 מתוך 3 של חשבונית עסקה מס׳ 4');
  const t = reminderText({ tone: 'final', customerName: 'נועה לוי', docType: 305, docNumber: 12, n: 2, of: 3, open: 590, due: '2026-10-01', business: 'לייזר א', link: 'https://app.test/d/tok' });
  assert.match(t, /^שלום נועה, זו תזכורת אחרונה מלייזר א/);
  assert.match(t, /תשלום 2 מתוך 3 של חשבונית מס מס׳ 12/);
  assert.match(t, /₪590/);
  assert.match(t, /01\/10\/2026/);
  assert.match(t, /https:\/\/app\.test\/d\/tok/);
  const m = reminderEmail({ tone: 'friendly', business: 'לייזר <א>', phone: '03-1234567', email: 'a@b.test', customerName: 'נועה', docType: 305, docNumber: 12, n: null, of: null,
    open: 1180, due: '2026-09-10', link: 'https://app.test/d/tok' });
  assert.equal(m.subject, 'תזכורת תשלום — לייזר <א>');
  assert.match(m.html, /לייזר &lt;א&gt;/, 'escaped');
  assert.match(m.html, /<a href="https:\/\/app\.test\/d\/tok">/);
  assert.match(m.text, /פרטי העסק: לייזר <א> · טלפון 03-1234567 · מייל a@b\.test$/);
  assert.doesNotMatch(m.text, /מבצע|הנחה|קופון/);
});

test('a reminder\'s state in a line, and the database\'s refusals', () => {
  assert.deepEqual(reminderLine({ status: 'sent', channel: 'email', cancelReason: '', error: '', step: 2 }), { text: 'תזכורת 2 נשלחה במייל', tone: 'ok' });
  assert.equal(reminderLine({ status: 'queued', channel: 'whatsapp', cancelReason: '', error: '', step: 1 }).text, 'תזכורת 1 — מחכה לשליחה בוואטסאפ');
  assert.equal(reminderLine({ status: 'cancelled', channel: 'whatsapp', cancelReason: 'paid', error: '', step: 1 }).text, 'תזכורת 1: שולם לפני השליחה');
  assert.equal(reminderLine({ status: 'failed', channel: 'email', cancelReason: '', error: 'resend 422', step: 3 }).tone, 'bad');
  for (const k of ['paid', 'stopped', 'off', 'changed', 'superseded', 'skipped'] as const) assert.ok(CANCEL_HE[k], k);
  assert.match(reminderErrorHe({ message: 'reminders_owner: only the business owner turns reminders on' }), /רק הבעלים/);
  assert.match(reminderErrorHe({ message: 'reminders_days: x' }), /בין 1 ל-5/);
});

// ---- T6: a duplicate expense ------------------------------------------------------------------------------------------------
test('the supplier and the number, as the database compares them', () => {
  assert.equal(normalizeSupplier('אור ספקים בע"מ'), normalizeSupplier('אור  ספקים בע״מ'));
  assert.equal(normalizeSupplier('Or Supply Ltd.'), 'orsupplyltd');
  assert.equal(normalizeSupplier('ООО Ромашка'), '', 'letters the rule does not know: nothing (never a false "same supplier")');
  assert.equal(normalizeDocNumber('INV-0012'), 'inv0012');
  assert.equal(normalizeDocNumber('000345'), '345');
  assert.equal(normalizeDocNumber('000'), '0');
  assert.equal(normalizeDocNumber(' - '), '');
});

test('why an expense may repeat another — the SQL check\'s examples; a void one never counts', () => {
  const e1 = { fileSha256: 'a'.repeat(64), supplierDealer: '123456782', supplierName: 'אור ספקים בע"מ', supplierDocNumber: 'A-0012', total: 118, docDate: '2026-10-08', status: 'confirmed' };
  const e2 = { fileSha256: null, supplierDealer: '', supplierName: 'ספקי הצפון בע"מ', supplierDocNumber: '77', total: 236, docDate: '2026-10-09', status: 'confirmed' };
  const e3 = { fileSha256: null, supplierDealer: '', supplierName: 'דפוס הכרמל', supplierDocNumber: '000345', total: 50, docDate: '2026-10-10', status: 'confirmed' };
  const q = (o: Partial<Parameters<typeof duplicateReasons>[0]>) => ({ sha: null, dealer: '', supplier: '', docNumber: '', total: null, docDate: null, ...o });
  assert.deepEqual(duplicateReasons(q({ sha: 'a'.repeat(64), supplier: 'ספק אחר' }), e1), ['file']);
  assert.deepEqual(duplicateReasons(q({ dealer: '123456782', supplier: 'שם אחר', docNumber: 'a 0012', total: 50, docDate: TODAY }), e1), ['number']);
  assert.deepEqual(duplicateReasons(q({ supplier: 'דפוס  הכרמל', docNumber: '345' }), e3), ['number']);
  assert.deepEqual(duplicateReasons(q({ supplier: 'ספקי הצפון בע״מ', docNumber: '78', total: 236, docDate: '2026-10-09' }), e2), ['amount_date']);
  assert.deepEqual(duplicateReasons(q({ sha: 'a'.repeat(64), dealer: '123456782', supplier: 'אור ספקים בע"מ', docNumber: 'A-0012', total: 118, docDate: '2026-10-08' }), e1),
    ['file', 'number', 'amount_date']);
  assert.deepEqual(duplicateReasons(q({ dealer: '514000004', supplier: 'אור ספקים בע"מ', docNumber: 'A-0012', total: 118, docDate: '2026-10-08' }), e1), [],
    'two dealer numbers that differ: another supplier, even with the same name');
  assert.deepEqual(duplicateReasons(q({ supplier: 'ספקי הצפון', docNumber: '77', total: 235, docDate: '2026-10-09' }), e2), []);
  assert.deepEqual(duplicateReasons(q({ sha: 'a'.repeat(64) }), { ...e1, status: 'void' }), []);
  assert.deepEqual(duplicateReasons(q({ sha: 'not-a-sha' }), { ...e1, fileSha256: 'not-a-sha' }), [], 'only a real fingerprint');
});

test('the warning\'s words, what "זו הוצאה אחרת" keeps, and the file\'s fingerprint', async () => {
  const m = toDuplicate({ id: 'e1', expense_number: '7', doc_date: '2026-10-08', created_at: '', supplier_name: 'x', supplier_doc_number: '', total: '118', status: 'confirmed', reasons: ['file'] });
  assert.equal(duplicateMessage(m), 'הקובץ הזה כבר נקלט בהוצאה #7 מתאריך 08/10/2026.');
  assert.equal(duplicateMessage({ ...m, reasons: ['number'] }), 'נראה שההוצאה הזו כבר קיימת: אותו ספק ואותו מספר מסמך — הוצאה #7 מתאריך 08/10/2026.');
  assert.equal(duplicateMessage({ ...m, reasons: ['amount_date'] }), 'נראה שההוצאה הזו כבר קיימת: אותו ספק, אותו סכום ואותו תאריך — הוצאה #7 מתאריך 08/10/2026.');
  assert.deepEqual(duplicateAck([{ id: 'e1', reasons: ['file', 'number'] }, { id: 'e2', reasons: ['number'] }]), { of: ['e1', 'e2'], reasons: ['file', 'number'] });
  assert.equal(await fileSha256(new Blob(['abc'])), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const e = toExpense({ id: 'x', expense_number: 1, status: 'confirmed', doc_date: TODAY, amount_before_vat: 1, vat_amount: 0, total: 1, file_sha256: 'f'.repeat(64),
    duplicate_ack: { of: ['e1'], reasons: ['file'], by: 'u', at: '2026-10-11T08:00:00Z' } });
  assert.deepEqual([e.fileSha256, e.duplicateAck?.by], ['f'.repeat(64), 'u']);
});

// ---- the server: the timer, and a reminder's email that is asked again just before it goes ----------------------------------
type Row = Record<string, any>;
let calls: { fn: string; args: Row }[] = [];
let state: Row = {};
let queueAnswer: { data: any; error: any } = { data: null, error: null };
let resend: { url: string; body: any }[] = [];
const tables: Record<string, Row[]> = {};
before(() => {
  const from = (t: string) => {
    const filters: [string, any][] = [];
    const q: any = {
      select: () => q, order: () => q, limit: () => q, eq: (k: string, v: any) => { filters.push([k, v]); return q; },
      maybeSingle: async () => ({ data: (tables[t] ?? []).find((r) => filters.every(([k, v]) => r[k] === v)) ?? null, error: null }),
      then: (res: any) => Promise.resolve({ data: (tables[t] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v)), error: null }).then(res),
    };
    return q;
  };
  (globalThis as any).__DP_TEST_ADMIN_DB__ = {
    from,
    rpc: async (fn: string, args: Row) => {
      calls.push({ fn, args });
      if (fn === 'debt_reminders_queue') return queueAnswer;
      if (fn === 'debt_reminder_check') return { data: state, error: null };
      if (fn === 'email_outbox_claim') return { data: [{ id: 'mail-1', kind: 'debt_reminder', reminder_id: 'rem-1', business_id: 'b1', to_email: 'noa@x.test', order_id: null, store_id: null, ref: '' }], error: null };
      if (fn === 'email_outbox_done') return { data: 'sent', error: null };
      return { data: null, error: { message: `function ${fn} not found`, code: 'PGRST202' } };
    },
  };
  (globalThis as any).fetch = async (url: string, init: any) => {
    if (String(url).startsWith('https://api.resend.com/emails')) { resend.push({ url: String(url), body: JSON.parse(init.body) }); return new Response(JSON.stringify({ id: 're_1' }), { status: 200 }); }
    throw new Error(`network call in a test: ${url}`);
  };
});
beforeEach(() => {
  calls = []; resend = [];
  for (const k of Object.keys(tables)) delete tables[k];
  Object.assign(tables, {
    business_finance_profile: [{ business_id: 'b1', trading_name: 'לייזר א', phone: '03-1234567', email: 'clinic@a.test' }],
    brands: [], register_settings: [], businesses: [{ id: 'b1', name: 'Clinic A' }], stores: [], store_email_domains: [],
    business_members: [{ business_id: 'b1', user_id: 'owner', access: 'full' }],
  });
  state = { state: 'ok', open: 590, due: '2026-10-01', n: 2, of: 3, docType: 305, docNumber: 12, customer: 'נועה לוי', shareToken: 'tok', tone: 'firm' };
  queueAnswer = { data: { cancelled: 1, emails: 2, whatsapp: 3, quiet: false, businesses: { b1: 3 } }, error: null };
  Object.assign(process.env, { RESEND_API_KEY: 're_test', RESEND_FALLBACK_FROM: 'noreply@dream.test', APP_URL: 'https://app.test' });
  delete process.env.VAPID_PRIVATE_KEY;
});

test('the timer: what the database queued (each line and step once — the database\'s); no migration yet → nothing, quietly', async () => {
  const { remindersCron } = await import('../src/lib/server/reminders');
  assert.deepEqual(await remindersCron(new Date('2026-10-11T07:00:00Z')), { cancelled: 1, emails: 2, whatsapp: 3, quiet: false, pushed: 0 });
  assert.deepEqual(calls[0], { fn: 'debt_reminders_queue', args: { p_now: '2026-10-11T07:00:00.000Z', p_limit: 200 } });
  queueAnswer = { data: null, error: { message: 'Could not find the function public.debt_reminders_queue in the schema cache', code: 'PGRST202' } };
  assert.equal(await remindersCron(), null, 'before migration 4400: not an error every 2 minutes');
  queueAnswer = { data: null, error: { message: 'boom', code: 'XX000' } };
  await assert.rejects(remindersCron(), /boom/, 'a real failure is reported');
});

test('A PAYMENT STOPS IT: a reminder\'s email is asked again just before it goes — paid meanwhile, nothing is sent', async () => {
  const { sendReminderEmail } = await import('../src/lib/server/reminders');
  const db = (globalThis as any).__DP_TEST_ADMIN_DB__;
  state = { state: 'paid' };
  assert.deepEqual(await sendReminderEmail(db, { id: 'mail-1', reminder_id: 'rem-1', business_id: 'b1', to_email: 'noa@x.test' }), { error: 'לא נשלח: החוב שולם', final: true });
  state = { state: 'stopped' };
  assert.match(String((await sendReminderEmail(db, { id: 'mail-1', reminder_id: 'rem-1', business_id: 'b1', to_email: 'noa@x.test' }) as any).error), /לא לשלוח/);
  assert.equal(resend.length, 0, 'Resend was never called');
  assert.deepEqual(calls.map((c) => c.fn), ['debt_reminder_check', 'debt_reminder_check']);
});

test('a reminder\'s email that may go: the line\'s values now, the business\'s details, the link to the invoice, Resend\'s idempotency key', async () => {
  const { sendReminderEmail } = await import('../src/lib/server/reminders');
  const r = await sendReminderEmail((globalThis as any).__DP_TEST_ADMIN_DB__, { id: 'mail-1', reminder_id: 'rem-1', business_id: 'b1', to_email: 'noa@x.test' });
  assert.deepEqual(r, { id: 're_1' });
  assert.equal(resend.length, 1);
  const b = resend[0].body;
  assert.deepEqual([b.to, b.from, b.reply_to, b.subject], [['noa@x.test'], 'לייזר א <noreply@dream.test>', 'clinic@a.test', 'תזכורת תשלום — לייזר א']);
  assert.match(b.text, /^שלום נועה, לפי הרישומים שלנו בלייזר א, תשלום 2 מתוך 3 של חשבונית מס מס׳ 12 עדיין לא שולמה במלואה — יתרה של ₪590/);
  assert.match(b.text, /https:\/\/app\.test\/d\/tok/);
  delete process.env.RESEND_FALLBACK_FROM;
  assert.match(String((await sendReminderEmail((globalThis as any).__DP_TEST_ADMIN_DB__, { id: 'mail-2', reminder_id: 'rem-1', business_id: 'b1', to_email: 'noa@x.test' }) as any).error),
    /אין כתובת שליחה מאומתת/, 'no sending address: it says so, it does not pretend');
});

test('the outbox sends a reminder\'s email through the same worker as the orders\' (sendQueuedEmails → debt_reminder)', async () => {
  const { sendQueuedEmails } = await import('../src/lib/server/commerce');
  assert.deepEqual(await sendQueuedEmails(), { sent: 1, failed: 0 });
  assert.deepEqual(calls.map((c) => c.fn), ['email_outbox_claim', 'debt_reminder_check', 'email_outbox_done']);
  assert.deepEqual(calls[2].args, { p_id: 'mail-1', p_provider_id: 're_1', p_error: '', p_final: false });
});
