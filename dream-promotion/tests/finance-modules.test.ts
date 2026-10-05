/**
 * Dream Finance 2.51 — receivables and smart collection, quotes, allocation numbers, expenses (incl. what an AI read),
 * report periods and the accountant's files, the audit log's Hebrew.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLACEHOLDERS, aging, aiDraftIsSafe, daysOverdue, dueDateFor, fillReminder, receivableStatus, reminderTemplate, termsLabel, toReceivable, type Receivable } from '../src/features/finance/receivables';
import { QUOTE_NEXT, canMove, editable, quoteMessage, quoteState, validUntilFor, type QuoteStatus } from '../src/features/finance/quotes';
import { SEED_RULES, allocationNeed, allocationPrintLine, allocationState, isRealAllocation, minimizedRequest, ruleOn, type AllocationRow } from '../src/features/finance/allocation';
import { EXPENSE_CATEGORIES, carriesVat, expenseError, sanitizeExtraction, splitTotal, vatDeductible, type ExpenseForm } from '../src/features/finance/expenses';
import { documentDateRateNote, pctOf } from '../src/features/finance/vat';
import { documentsCsv, expensesCsv, ledgerCsv, periodOf, previousPeriod, receivablesCsv, vatReportRows } from '../src/features/finance/reports';
import { auditLine, auditSeal } from '../src/features/finance/audit';
import { toDoc } from '../src/features/documents/documents';

const TODAY = '2026-10-04';
const recv = (o: Partial<Receivable>): Receivable => ({ id: 'r', docType: 305, docNumber: 1, docDate: '2026-09-01', dueDate: '2026-10-01', customerName: 'דנה', customerPhone: '', customerEmail: '',
  leadId: null, total: 1180, credited: 0, paid: 0, balance: 1180, cancelled: false, shareToken: 't', ...o });

test('receivables: payment terms, status, days late and aging', () => {
  assert.equal(dueDateFor('2026-10-04', 'immediate'), '2026-10-04');
  assert.equal(dueDateFor('2026-10-04', 'net_30'), '2026-11-03');
  assert.equal(dueDateFor('2026-10-04', 'eom_30'), '2026-11-30', 'שוטף + 30: end of October, then 30 days');
  assert.equal(dueDateFor('2026-01-31', 'eom_30'), '2026-03-02');
  assert.equal(dueDateFor('2028-02-10', 'eom_0'), '2028-02-29', 'a leap year');
  assert.equal(termsLabel('eom_60'), 'שוטף + 60');
  assert.equal(termsLabel('net_21'), '21 יום');
  assert.equal(receivableStatus(recv({}), TODAY), 'overdue');
  assert.equal(receivableStatus(recv({ dueDate: '2026-10-30' }), TODAY), 'open');
  assert.equal(receivableStatus(recv({ dueDate: '2026-10-30', paid: 100, balance: 1080 }), TODAY), 'partial');
  assert.equal(receivableStatus(recv({ paid: 1180, balance: 0 }), TODAY), 'paid');
  assert.equal(receivableStatus(recv({ paid: 1200, balance: -20 }), TODAY), 'credit');
  assert.equal(receivableStatus(recv({ cancelled: true }), TODAY), 'cancelled');
  assert.equal(daysOverdue(recv({}), TODAY), 3);
  assert.equal(daysOverdue(recv({ balance: 0 }), TODAY), 0);
  const a = aging([recv({ balance: 100, dueDate: '2026-10-10' }), recv({ balance: 200, dueDate: '2026-09-20' }), recv({ balance: 300, dueDate: '2026-08-01' }),
    recv({ balance: 400, dueDate: '2026-06-01' }), recv({ balance: 999, cancelled: true }), recv({ balance: 0 })], TODAY);
  assert.deepEqual(a, { current: 100, d30: 200, d60: 0, d90: 300, over90: 400, total: 1000 });
  assert.equal(toReceivable({ id: 'x', doc_type: 300, doc_number: '7', doc_date: TODAY, total: '50.5', credited: null, paid: '0', balance: '50.5', cancelled: false }).docNumber, 7);
});

test('smart collection: the facts come from the document, an AI may only reword around them', () => {
  const t = reminderTemplate('friendly');
  for (const p of ['{{name}}', '{{doc}}', '{{amount}}', '{{due}}', '{{business}}', '{{link}}']) assert.ok(t.includes(p), p);
  assert.ok(PLACEHOLDERS.length === 6);
  const text = fillReminder(t, { name: 'דנה', doc: 'חשבונית מס 12', amount: '₪1,180', due: '01/10/2026', business: 'FollowMe', link: 'https://x/d/abc' });
  assert.match(text, /₪1,180 על חשבונית מס 12/);
  assert.ok(!text.includes('{{'));
  assert.equal(aiDraftIsSafe('שלום {{name}}, רצינו להזכיר בעדינות את {{doc}} על סך {{amount}} — תודה רבה!'), true);
  assert.equal(aiDraftIsSafe('שלום {{name}}, נשאר לשלם ₪1,180 על {{doc}} {{amount}}'), false, 'an amount written by the AI');
  assert.equal(aiDraftIsSafe('שלום {{name}}, נשאר לשלם על {{doc}} {{amount}} עד ה-15 לחודש'), false, 'a date invented by the AI');
  assert.equal(aiDraftIsSafe('שלום {{name}}, יש לך חוב — תשלמו!'), false, 'the amount and the document must stay in placeholders');
  assert.equal(aiDraftIsSafe('שלום {{name}}, {{doc}} {{amount}} לתשלום: https://pay.example'), false, 'a link of its own');
  assert.equal(aiDraftIsSafe('{{doc}} {{amount}} {{foo}} ומשהו ארוך מספיק כדי לעבור'), false, 'an unknown placeholder');
  assert.equal(aiDraftIsSafe(42), false);
});

test('quotes: the same transitions as the database, expiry, the message', () => {
  const all: QuoteStatus[] = ['draft', 'sent', 'accepted', 'rejected', 'expired', 'converted', 'cancelled'];
  // mirror of quotes_guard()
  const sql: Record<QuoteStatus, QuoteStatus[]> = { draft: ['sent', 'cancelled', 'converted'], sent: ['draft', 'accepted', 'rejected', 'expired', 'cancelled', 'converted'],
    accepted: ['converted', 'cancelled'], expired: ['sent', 'cancelled'], rejected: [], converted: [], cancelled: [] };
  for (const f of all) for (const t of all) assert.equal(canMove(f, t), sql[f].includes(t), `${f} → ${t}`);
  assert.deepEqual(Object.keys(QUOTE_NEXT).sort(), [...all].sort());
  assert.equal(editable('accepted'), false);
  assert.equal(editable('sent'), true);
  assert.equal(quoteState({ status: 'sent', validUntil: '2026-10-01' }, TODAY), 'expired');
  assert.equal(quoteState({ status: 'accepted', validUntil: '2026-10-01' }, TODAY), 'accepted', 'an accepted quote does not expire');
  assert.equal(validUntilFor(TODAY, 30), '2026-11-03');
  assert.match(quoteMessage({ name: 'דנה כהן', number: 4, business: 'FollowMe', total: '₪1,180', validUntil: '2026-11-03', link: 'https://x/q/t' }), /^שלום דנה, מצורפת הצעת מחיר מס׳ 4 מFollowMe: ₪1,180 \(בתוקף עד 03\/11\/2026\)/);
});

test('allocation numbers: the rule of the document\'s date, what is required, and a test number is never real', () => {
  assert.equal(ruleOn(SEED_RULES, '2024-05-04'), null, 'before the model started');
  assert.equal(ruleOn(SEED_RULES, '2025-12-31')!.thresholdBeforeVat, 20000);
  assert.equal(ruleOn(SEED_RULES, '2026-05-31')!.thresholdBeforeVat, 10000);
  assert.equal(ruleOn(SEED_RULES, TODAY)!.thresholdBeforeVat, 5000);
  assert.ok(SEED_RULES.every((r) => !r.verified), 'nothing claims to be verified');
  const doc = { docType: 305, docDate: TODAY, afterDiscount: 6000, customerDealer: '514000012' };
  assert.equal(allocationNeed(doc, { entityType: 'company' }, SEED_RULES).required, true);
  assert.equal(allocationNeed({ ...doc, afterDiscount: 5000 }, { entityType: 'company' }, SEED_RULES).required, false, 'exactly the threshold: not above it');
  assert.equal(allocationNeed({ ...doc, customerDealer: '' }, { entityType: 'company' }, SEED_RULES).required, false, 'a private customer');
  assert.equal(allocationNeed({ ...doc, docType: 300 }, { entityType: 'company' }, SEED_RULES).required, false, 'not a tax invoice');
  assert.equal(allocationNeed(doc, { entityType: 'exempt_dealer' }, SEED_RULES).required, false);
  assert.equal(allocationNeed({ ...doc, docDate: '2026-05-01' }, { entityType: 'company' }, SEED_RULES).required, false, 'in May 2026 the threshold was 10,000');
  // what the gateway would send: identifiers and amounts only
  const req = minimizedRequest({ ...doc, docNumber: 12, vatAmount: 1080, total: 7080, customerName: 'שם', customerPhone: '050', lines: [{ name: 'x' }] } as any, { dealerNumber: '514000004', name: 'FollowMe' } as any);
  assert.deepEqual(Object.keys(req).sort(), ['amountBeforeVat', 'customerVatNumber', 'docDate', 'docNumber', 'docType', 'issuerVatNumber', 'total', 'vatAmount']);
  assert.ok(!JSON.stringify(req).includes('050') && !JSON.stringify(req).includes('שם'), 'no personal details');
  const row = (o: Partial<AllocationRow>): AllocationRow => ({ id: 'a', status: 'approved', isTest: false, number: '123456789', gateway: 'live', errorMessage: '', createdAt: '2026-10-04T10:00:00Z', ...o });
  assert.equal(isRealAllocation(row({})), true);
  assert.equal(isRealAllocation(row({ isTest: true, gateway: 'mock', number: 'TEST-1' })), false);
  assert.equal(isRealAllocation(row({ isTest: false, gateway: 'mock', number: '123' })), false, 'a mock gateway never gives a real number');
  assert.equal(isRealAllocation(row({ number: 'TEST-123' })), false);
  const need = allocationNeed(doc, { entityType: 'company' }, SEED_RULES);
  const test1 = allocationState([row({ isTest: true, gateway: 'mock', number: 'TEST-000123' })], need);
  assert.deepEqual(test1, { kind: 'test', number: 'TEST-000123' });
  assert.match(allocationPrintLine(test1)!, /מספר בדיקה TEST-000123 — סביבת בדיקות, לא מספר הקצאה של רשות המסים/);
  assert.equal(allocationPrintLine(allocationState([row({ status: 'manual', gateway: 'manual' })], need)), 'מספר הקצאה: 123456789 (הוזן ידנית)');
  assert.equal(allocationPrintLine(allocationState([], need)), 'מספר הקצאה: טרם התקבל');
  assert.equal(allocationPrintLine(allocationState([], allocationNeed({ ...doc, afterDiscount: 100 }, { entityType: 'company' }, SEED_RULES))), null);
  assert.deepEqual(allocationState([row({ status: 'error', number: null, errorMessage: 'אין חיבור' })], need), { kind: 'error', message: 'אין חיבור' });
});

test('expenses: categories, VAT that may be deducted, the form\'s rules', () => {
  assert.ok(new Set(EXPENSE_CATEGORIES.map((c) => c.id)).size === EXPENSE_CATEGORIES.length);
  assert.ok(EXPENSE_CATEGORIES.every((c) => /^[a-z_]{2,30}$/.test(c.id)), 'the database accepts every category id');
  assert.deepEqual(splitTotal(354, 18), { amountBeforeVat: 300, vatAmount: 54, total: 354 });
  assert.equal(vatDeductible({ vatAmount: 54, vatDeductiblePct: 66.67, supplierDocType: 'tax_invoice' }, true), 36, 'the same 36 as finance_summary() in the database');
  assert.equal(vatDeductible({ vatAmount: 54, vatDeductiblePct: 100, supplierDocType: 'tax_invoice' }, false), 0, 'an exempt dealer deducts nothing');
  // whole agorot, half away from zero — as round(vat × % / 100, 2) in the database (floating point gave 2.01 × 50% = 1.00)
  assert.equal(vatDeductible({ vatAmount: 2.01, vatDeductiblePct: 50, supplierDocType: 'tax_invoice' }, true), 1.01);
  assert.equal(vatDeductible({ vatAmount: 0.15, vatDeductiblePct: 66.67, supplierDocType: 'tax_invoice' }, true), 0.1);
  assert.equal(vatDeductible({ vatAmount: 180, vatDeductiblePct: 0, supplierDocType: 'tax_invoice' }, true), 0);
  // a back-dated document at today's rate: said before issuing, never changed by itself (a question for the accountant)
  assert.match(documentDateRateNote(18, '2024-12-31')!, /שונה מהשיעור החוקי בתאריך המסמך \(17%\)/);
  assert.equal(documentDateRateNote(18, '2025-01-01'), null);
  assert.equal(documentDateRateNote(0, '2024-12-31'), null, 'no VAT on the document');
  assert.equal(pctOf(201, 50), 101); assert.equal(pctOf(-201, 50), -101); assert.equal(pctOf(5400, 66.67), 3600); assert.equal(pctOf(12345, 12.5), 1543);
  assert.equal(carriesVat('receipt'), false);
  const f: ExpenseForm = { supplierName: 'ספק', supplierDealer: '', supplierDocType: 'tax_invoice', supplierDocNumber: '7', allocationNumber: '', docDate: TODAY, category: 'rent',
    description: '', amountBeforeVat: 1000, vatAmount: 180, total: 1180, vatDeductiblePct: 100, paidOn: null, paymentMethod: null };
  assert.equal(expenseError(f, TODAY), null);
  assert.match(expenseError({ ...f, supplierName: ' ' }, TODAY)!, /חסר שם הספק/);
  assert.match(expenseError({ ...f, supplierDealer: '123456789' }, TODAY)!, /ספרת ביקורת/);
  assert.match(expenseError({ ...f, docDate: '2026-10-05' }, TODAY)!, /בעתיד/);
  assert.match(expenseError({ ...f, total: 1181 }, TODAY)!, /שווה לסה״כ/);
  assert.match(expenseError({ ...f, supplierDocType: 'receipt' }, TODAY)!, /אין מע״מ לקיזוז/);
  assert.match(expenseError({ ...f, paidOn: TODAY }, TODAY)!, /אמצעי תשלום/);
  assert.match(expenseError(f, TODAY, '2026-10-31')!, /הספרים סגורים עד 31\/10\/2026/);
  assert.match(expenseError({ ...f, allocationNumber: '12a' }, TODAY)!, /ספרות בלבד/);
});

test('what an AI read from a supplier\'s file: only trusted values reach the form, nothing is guessed', () => {
  const ok = sanitizeExtraction({ supplierName: ' חברת החשמל ', supplierDealer: '514000017', supplierDocType: 'tax_invoice', supplierDocNumber: 'A-77', allocationNumber: '123456789',
    docDate: '2026-09-30', amountBeforeVat: '1,000.00', vatAmount: 180, total: '₪1,180', category: 'utilities', description: 'חשבון חודשי' }, TODAY);
  assert.deepEqual(ok.fields, { supplierName: 'חברת החשמל', supplierDealer: '514000017', supplierDocType: 'tax_invoice', supplierDocNumber: 'A-77', allocationNumber: '123456789',
    docDate: '2026-09-30', amountBeforeVat: 1000, vatAmount: 180, total: 1180, category: 'utilities', description: 'חשבון חודשי' });
  assert.deepEqual(ok.warnings, []);
  const bad = sanitizeExtraction({ supplierName: '', supplierDealer: '123456789', docDate: '2027-01-01', amountBeforeVat: 900, vatAmount: 180, total: 1180, category: 'casino', allocationNumber: '12' }, TODAY);
  assert.deepEqual(bad.fields, { total: 1180 }, 'only the total survives');
  assert.equal(bad.warnings.length, 4);
  assert.deepEqual(sanitizeExtraction('not json', TODAY), { fields: {}, warnings: [] });
  assert.deepEqual(sanitizeExtraction({ total: -5, docDate: '2026-02-31x' }, TODAY).fields, {});
});

test('report periods, the accountant\'s files and the VAT working paper', () => {
  assert.deepEqual(periodOf('month', '2026-02-14'), { from: '2026-02-01', to: '2026-02-28', label: 'פברואר 2026' });
  assert.deepEqual(periodOf('bimonth', '2026-10-04'), { from: '2026-09-01', to: '2026-10-31', label: 'ספטמבר–אוקטובר 2026' });
  assert.deepEqual(periodOf('bimonth', '2026-01-31'), { from: '2026-01-01', to: '2026-02-28', label: 'ינואר–פברואר 2026' });
  assert.deepEqual(periodOf('quarter', '2026-05-01'), { from: '2026-04-01', to: '2026-06-30', label: 'אפריל–יוני 2026' });
  assert.deepEqual(periodOf('year', '2028-07-07'), { from: '2028-01-01', to: '2028-12-31', label: '2028' });
  assert.deepEqual(previousPeriod('bimonth', '2026-01-10'), periodOf('bimonth', '2025-12-01'));
  const d = toDoc({ id: '1', doc_type: 305, doc_number: 12, link_no: 1, issued_at: '2026-10-04T08:00:00Z', doc_date: TODAY, customer_name: 'לקוח "גדול"', customer_dealer: '514000012',
    before_discount: 1000, discount: 0, after_discount: 1000, vat_amount: 180, total: 1180, lines: [], payments: [], due_date: '2026-11-03' });
  const docs = documentsCsv([{ ...d, allocation: '987654321' }]);
  assert.ok(docs.startsWith('﻿'), 'Excel sees Hebrew (BOM)');
  assert.match(docs, /"חשבונית מס","12","04\/10\/2026","לקוח ""גדול""","514000012","1000.00","0.00","1000.00","180.00","1180.00","","","03\/11\/2026","987654321",""/);
  const ex = expensesCsv([{ id: 'e', number: 3, status: 'confirmed', supplierName: 'דלק', supplierDealer: '', supplierDocType: 'tax_invoice', supplierDocNumber: '1', allocationNumber: '',
    docDate: TODAY, category: 'vehicle', description: '', amountBeforeVat: 300, vatAmount: 54, total: 354, vatDeductiblePct: 66.67, paidOn: null, paymentMethod: null,
    filePath: 'biz/e/receipt.pdf', fileMime: 'application/pdf', aiModel: '', aiExtracted: null, confirmedAt: null, stockLines: [], voidReason: '', voidedAt: null, createdAt: '' }], true);
  assert.match(ex, /"רכב ודלק","","300.00","54.00","354.00","66.67","36.00","","מאושרת","receipt.pdf"/);
  assert.match(ledgerCsv([{ id: 'l', direction: 'out', amount: 236, method: 'transfer', paidOn: TODAY, source: 'credit', documentId: null, appliesTo: null, saleId: null, refundId: null, expenseId: null, leadId: null, note: '', createdAt: '' }]),
    /"04\/10\/2026","יצא","-236.00","העברה בנקאית","החזר על זיכוי",""/);
  assert.match(receivablesCsv([recv({})], TODAY), /"באיחור"/);
  assert.deepEqual(vatReportRows({ revenue: { net: 1000, vat: 180 }, expenses: { net: 300, vat: 54, vatDeductible: 36 }, vatPayable: 144 }).map((r) => r[1]), [1000, 180, 300, 54, 36, 144]);
});

test('the audit log in Hebrew', () => {
  assert.equal(auditLine({ id: 1, actorId: null, actorKind: 'member', action: 'document.issued', entity: 'documents', entityId: 'x', details: { type: 320, number: 15, total: 236 }, at: '' }), 'מסמך הופק · 320-15 · ₪236');
  assert.equal(auditLine({ id: 2, actorId: 'a', actorKind: 'super_admin', action: 'support.access_opened', entity: '', entityId: '', details: { reason: 'בדיקת תקלה', until: '2026-10-04T12:30:00.000Z' }, at: '' }),
    'מנהל-על פתח גישה לנתונים הכספיים · סיבה: בדיקת תקלה · עד 2026-10-04 12:30');
  assert.equal(auditLine({ id: 3, actorId: null, actorKind: 'member', action: 'quote.status', entity: '', entityId: '', details: { number: 4, from: 'sent', to: 'accepted' }, at: '' }),
    'סטטוס הצעת מחיר השתנה · מס׳ 4 · sent ← accepted');
});

test('the audit seal in the accountant\'s package: the last hash, kept outside the system', () => {
  const seal = auditSeal({ business: 'FollowMe (515123456)', from: '2026-09-01', to: '2026-09-30', madeAt: '04/10/2026 10:00', rows: 42, ok: true,
    lastId: 77, lastHash: 'ab'.repeat(32), lastAt: '04/10/2026 09:59' });
  assert.match(seal, /רשומות ביומן \(כל התקופות\): 42/);
  assert.match(seal, /לא נמצא שינוי/);
  assert.match(seal, /לא מונע שינוי ממי ששולט ישירות במסד הנתונים/, 'the chain detects a change, it does not claim to prevent one');
  assert.ok(!/חתומה/.test(seal), 'not described as a signature');
  assert.ok(seal.includes(`Hash של הרשומה האחרונה: ${'ab'.repeat(32)}`));
  assert.ok(seal.endsWith('\r\n') && !seal.includes('\n\n'), 'Windows line ends, as the other files');
  const bad = auditSeal({ business: 'x', from: 'a', to: 'b', madeAt: 'c', rows: 3, ok: false, firstBad: 2, lastId: 3, lastHash: 'h', lastAt: 'd' });
  assert.match(bad, /נמצאה רשומה שהשתנתה \(מס׳ 2\)/);
  const empty = auditSeal({ business: 'x', from: 'a', to: 'b', madeAt: 'c', rows: 0, ok: true, lastId: null, lastHash: '', lastAt: '' });
  assert.match(empty, /היומן ריק/);
  assert.ok(!empty.includes('Hash של'), 'no hash line for an empty log');
});
