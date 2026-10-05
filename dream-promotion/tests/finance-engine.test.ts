/**
 * Dream Finance 2.51 — the accounting engine: VAT, business-type rules, documents, receipts, credit invoices.
 * Property tests run thousands of random carts and documents through the builders and prove each result passes the
 * same checks the database runs on insert (docInvariants mirrors documents_validate in migration 20261004003100).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VAT_HISTORY, legalVatRate, netOfGross, rateWarning, vatMatches, vatOfGross, vatOfNet } from '../src/features/finance/vat';
import { allowedDocTypes, businessTypeOf, canIssue, chargesVat, entityOf, invoiceDocType, issuerIdLine, saleDocType, type EntityType } from '../src/features/finance/rules';
import { composeCredit, composeDocument, composeReceipt, computeLines, docInvariants, type ComposeLine } from '../src/features/finance/compose';
import { chequeError, ledgerTotals, payCode, toDocPayment } from '../src/features/finance/payments';
import { docFromSale } from '../src/features/documents/documents';
import { computeSale } from '../src/features/register/money';

const TODAY = '2026-10-04';
// a small deterministic random generator, so a failure is reproducible
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

test('VAT: the legal rate by date, with its history (17% until 2024, 18% from 2025)', () => {
  assert.equal(legalVatRate('2024-12-31'), 17);
  assert.equal(legalVatRate('2025-01-01'), 18);
  assert.equal(legalVatRate('2015-09-30'), 18);
  assert.equal(legalVatRate('2015-10-01'), 17);
  assert.equal(legalVatRate('2013-06-02'), 18);
  assert.deepEqual(VAT_HISTORY.map((v) => v.from), [...VAT_HISTORY.map((v) => v.from)].sort(), 'history is in date order');
  assert.equal(rateWarning(18, TODAY, true), null);
  assert.match(rateWarning(17, TODAY, true)!, /שונה מהשיעור החוקי היום \(18%\)/);
  assert.match(rateWarning(0, TODAY, true)!, /אילת/);
  assert.equal(rateWarning(0, TODAY, false), null, 'an exempt dealer has no rate to warn about');
});

test('VAT: whole agorot, and the same answer as the register gave before 2.51', () => {
  assert.equal(vatOfGross(11800, 18), 1800);
  assert.equal(netOfGross(10000, 18), 8475);
  assert.equal(vatOfNet(10000, 18), 1800);
  assert.equal(vatOfGross(500, 0), 0);
  // the old formula of docFromSale: round(gross × 100 / (100 + rate)) — identical for every amount up to ₪10,000 at 17% and 18%
  for (const rate of [17, 18]) for (let g = 0; g <= 1_000_000; g += 7) assert.equal(netOfGross(g, rate), Math.round((g * 100) / (100 + rate)), `${g} @ ${rate}`);
  // VAT from a gross price always passes the database's test on the net amount
  for (let g = 1; g < 200_000; g += 13) { const v = vatOfGross(g, 18); assert.ok(vatMatches(g - v, v, 18), `gross ${g}`); }
});

test('business-type rules: who issues what, and the database\'s matrix', () => {
  const all: EntityType[] = ['exempt_dealer', 'licensed_dealer', 'company', 'partnership', 'nonprofit'];
  // the same matrix as entity_doc_types() in the migration
  const sql: Record<EntityType, number[]> = { exempt_dealer: [300, 400], nonprofit: [300, 400], licensed_dealer: [300, 305, 320, 330, 400], company: [300, 305, 320, 330, 400], partnership: [300, 305, 320, 330, 400] };
  for (const e of all) {
    assert.deepEqual([...allowedDocTypes(e)].sort(), sql[e], e);
    for (const t of [300, 305, 320, 330, 400]) assert.equal(canIssue(e, t), sql[e].includes(t), `${e} ${t}`);
  }
  assert.equal(chargesVat('exempt_dealer'), false);
  assert.equal(chargesVat('nonprofit'), false);
  assert.equal(chargesVat('company'), true);
  assert.equal(saleDocType('exempt_dealer'), 400);
  assert.equal(saleDocType('company'), 320);
  assert.equal(invoiceDocType('exempt_dealer'), 300);
  assert.equal(invoiceDocType('licensed_dealer'), 305);
  assert.equal(entityOf(null, 'exempt'), 'exempt_dealer', 'a business from before 2.51: the register switch decides');
  assert.equal(entityOf(undefined, 'licensed'), 'licensed_dealer');
  assert.equal(entityOf('company', 'exempt'), 'company', 'an explicit entity wins');
  assert.equal(entityOf('nonsense', null), 'licensed_dealer');
  assert.equal(businessTypeOf('nonprofit'), 'exempt');
  assert.equal(issuerIdLine({ entityType: 'exempt_dealer', dealerNumber: '123456782' }), 'עוסק פטור 123456782', 'never "עוסק מורשה" for an exempt dealer');
  assert.equal(issuerIdLine({ entityType: 'company', dealerNumber: '514000004' }), 'ח.פ 514000004');
  assert.equal(issuerIdLine({ dealerNumber: '123456782' }, 'exempt'), 'עוסק פטור 123456782');
});

test('documents from the document center pass every database check (2,000 random documents)', () => {
  const r = rng(42);
  const entities: EntityType[] = ['licensed_dealer', 'company', 'exempt_dealer'];
  let issued = 0;
  for (let k = 0; k < 2000; k++) {
    const entity = entities[k % 3];
    const types = allowedDocTypes(entity).filter((t) => t !== 330);
    const docType = types[Math.floor(r() * types.length)];
    const lines: ComposeLine[] = Array.from({ length: 1 + Math.floor(r() * 5) }, (_, i) => ({ name: `שורה ${i}`, qty: r() < 0.2 ? Math.round(r() * 40) / 4 + 0.25 : 1 + Math.floor(r() * 4), unitPrice: Math.round(r() * 200000) / 100 }));
    const discount = r() < 0.5 ? { kind: 'sum' as const, value: Math.round(r() * 3000) / 100 } : { kind: 'percent' as const, value: Math.round(r() * 30) };
    const draft = { docType, entity, vatRate: 18, pricesIncludeVat: r() < 0.5, lines, discount, customer: { name: 'לקוח' }, docDate: TODAY, today: TODAY };
    const pre = composeDocument({ ...draft, payments: [] });
    const total = computeLines(lines, { pricesIncludeVat: draft.pricesIncludeVat, discount, rate: chargesVat(entity) && docType !== 400 ? 18 : 0 }).totals.total;
    if (total <= 0) { assert.equal(pre.ok, false); continue; }
    // split the payment in two when it is a receipt
    const first = Math.round(total * 100 * r()) / 100;
    const payments = docType === 320 || docType === 400
      ? [{ method: 'cash' as const, amount: first, date: TODAY }, { method: 'card' as const, amount: Math.round((total - first) * 100) / 100, date: TODAY }].filter((p) => p.amount > 0) : [];
    const res = composeDocument({ ...draft, payments });
    assert.ok(res.ok, `document ${k}: ${!res.ok && res.errors.join(', ')}`);
    if (!res.ok) continue;
    assert.deepEqual(docInvariants(res.doc, res.totals.vatRate), [], `document ${k} (${docType}, ${entity})`);
    if (!chargesVat(entity) || docType === 400) assert.equal(res.doc.vatAmount, 0, 'no VAT for an exempt dealer or on a receipt');
    issued++;
  }
  assert.ok(issued > 1800);
});

test('the register\'s document passes the database checks for 3,000 random carts (incl. the tiny-discount case fixed in 2.51)', () => {
  const r = rng(7);
  for (let k = 0; k < 3000; k++) {
    const lines = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, i) => ({ name: `פריט ${i}`, price: Math.round(r() * 30000) / 100, qty: 1 + Math.floor(r() * 3) }));
    const discount = r() < 0.4 ? { kind: 'sum' as const, value: r() < 0.3 ? 0.01 : Math.round(r() * 2000) / 100 } : { kind: 'percent' as const, value: Math.floor(r() * 20) };
    const licensed = r() < 0.7;
    const t = computeSale(lines, discount, { type: licensed ? 'licensed' : 'exempt', rate: 18 });
    if (t.total <= 0) continue;
    const d = docFromSale({ items: lines, discount: t.discount, total: t.total, vatAmount: t.vatAmount, vatRate: t.vatRate, method: 'cash', customerName: '', customerPhone: '', payments: [] },
      { licensed, docDate: TODAY });
    assert.deepEqual(docInvariants({ ...d, docType: d.docType }, t.vatRate), [], `cart ${k}: ${JSON.stringify({ lines, discount })}`);
  }
  // the case itself: four lines of ₪0.23 and a discount of one agora — before 2.51 "before discount" (0.76) was below "after" (0.77)
  const lines = Array.from({ length: 4 }, () => ({ name: 'x', price: 0.23, qty: 1 }));
  const t = computeSale(lines, { kind: 'sum', value: 0.01 }, { type: 'licensed', rate: 18 });
  const d = docFromSale({ items: lines, discount: t.discount, total: t.total, vatAmount: t.vatAmount, vatRate: 18, method: 'cash', customerName: '', customerPhone: '', payments: [] }, { licensed: true, docDate: TODAY });
  assert.deepEqual(docInvariants(d, 18), []);
  assert.ok(d.beforeDiscount >= d.afterDiscount);
  assert.equal(d.payments[0].m, 'cash', 'the document keeps the method itself (Bit is "other" in the file)');
});

test('composeDocument refuses what the database would refuse — with a Hebrew reason', () => {
  const base = { entity: 'licensed_dealer' as EntityType, vatRate: 18, pricesIncludeVat: true, customer: { name: 'דנה' }, docDate: TODAY, today: TODAY, lines: [{ name: 'שירות', qty: 1, unitPrice: 118 }] };
  const bad = (x: ReturnType<typeof composeDocument>) => (x.ok ? [] : x.errors).join(' | ');
  assert.match(bad(composeDocument({ ...base, docType: 305, entity: 'exempt_dealer' })), /לא מתאים לסוג העסק/);
  assert.match(bad(composeDocument({ ...base, docType: 330 })), /מתוך החשבונית המקורית/);
  assert.match(bad(composeDocument({ ...base, docType: 305, customer: { name: '' } })), /חסר שם הלקוח/);
  assert.match(bad(composeDocument({ ...base, docType: 305, customer: { name: 'x', dealer: '123456789' } })), /מספר העוסק/);
  assert.match(bad(composeDocument({ ...base, docType: 305, lines: [] })), /לפחות שורה אחת/);
  assert.match(bad(composeDocument({ ...base, docType: 305, lines: [{ name: '', qty: 1, unitPrice: 5 }] })), /בכל שורה/);
  assert.match(bad(composeDocument({ ...base, docType: 320, payments: [{ method: 'cash', amount: 100, date: TODAY }] })), /סכום התשלומים \(₪100\) שונה מסכום המסמך \(₪118\)/);
  assert.match(bad(composeDocument({ ...base, docType: 320, payments: [] })), /איך שולם/);
  assert.match(bad(composeDocument({ ...base, docType: 305, docDate: '2026-10-05' })), /בעתיד/);
  assert.match(bad(composeDocument({ ...base, docType: 305, dueDate: '2026-10-01' })), /מועד התשלום לפני/);
  assert.match(bad(composeDocument({ ...base, docType: 320, payments: [{ method: 'cheque', amount: 118, date: TODAY }] })), /מספר הצ׳ק/);
  const ok = composeDocument({ ...base, docType: 320, payments: [{ method: 'cheque', amount: 118, date: TODAY, cheque: { bank: '12', branch: '345', account: '678', number: '1001', dueDate: '2026-11-01' } }] });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.doc.payments[0], { method: 2, amount: 118, date: TODAY, m: 'cheque', cheque: { bank: '12', branch: '345', account: '678', number: '1001', dueDate: '2026-11-01' } });
    assert.equal(ok.doc.vatAmount, 18);
    assert.equal(ok.doc.afterDiscount, 100);
  }
  // prices before VAT (business to business): ₪1,000 + 18%
  const b2b = composeDocument({ ...base, docType: 305, pricesIncludeVat: false, lines: [{ name: 'ייעוץ', qty: 10, unitPrice: 100 }], dueDate: '2026-11-03' });
  assert.ok(b2b.ok && b2b.doc.total === 1180 && b2b.doc.vatAmount === 180 && b2b.doc.dueDate === '2026-11-03');
});

test('receipts for open invoices: 400 for a 305, 320 for a VAT business\'s 300, never beyond the balance', () => {
  const inv = composeDocument({ docType: 305, entity: 'company', vatRate: 18, pricesIncludeVat: false, lines: [{ name: 'פרויקט', qty: 1, unitPrice: 1000 }], customer: { name: 'לקוח בע"מ' }, docDate: TODAY, today: TODAY });
  assert.ok(inv.ok);
  if (!inv.ok) return;
  const open = { ...inv.doc, docNumber: 12, balance: 1180 };
  const r1 = composeReceipt(open, { entity: 'company', vatRate: 18, payments: [{ method: 'transfer', amount: 500, date: TODAY }], docDate: TODAY, today: TODAY });
  assert.ok(r1.ok && r1.doc.docType === 400 && r1.doc.total === 500 && r1.doc.vatAmount === 0 && r1.doc.lines[0].name === 'תשלום עבור חשבונית מס מס׳ 12');
  if (r1.ok) assert.deepEqual(docInvariants(r1.doc, 0), []);
  const over = composeReceipt({ ...open, balance: 680 }, { entity: 'company', vatRate: 18, payments: [{ method: 'cash', amount: 700, date: TODAY }], docDate: TODAY, today: TODAY });
  assert.ok(!over.ok && /גדול מהיתרה/.test(over.errors.join()));
  // a transaction invoice (300) of a VAT business: paid in full → a 320 with the same lines and amounts
  const t300 = composeDocument({ docType: 300, entity: 'company', vatRate: 18, pricesIncludeVat: true, lines: [{ name: 'חולצה', qty: 2, unitPrice: 59, itemId: 'i1' }], customer: { name: 'x' }, docDate: TODAY, today: TODAY });
  assert.ok(t300.ok);
  if (!t300.ok) return;
  const whole = composeReceipt({ ...t300.doc, docNumber: 3, balance: t300.doc.total }, { entity: 'company', vatRate: 18, payments: [{ method: 'card', amount: 118, date: TODAY }], docDate: TODAY, today: TODAY });
  assert.ok(whole.ok && whole.doc.docType === 320 && whole.doc.total === 118 && whole.doc.lines[0].itemId === 'i1');
  if (whole.ok) assert.deepEqual(docInvariants(whole.doc, 18), []);
  const part = composeReceipt({ ...t300.doc, docNumber: 3, balance: 118 }, { entity: 'company', vatRate: 18, payments: [{ method: 'cash', amount: 50, date: TODAY }], docDate: TODAY, today: TODAY });
  assert.ok(part.ok && part.doc.docType === 320 && part.doc.total === 50 && part.doc.lines[0].name.startsWith('תשלום חלקי'));
  if (part.ok) assert.deepEqual(docInvariants(part.doc, 18), []);
  // an exempt dealer's 300 → a receipt
  const ex = composeReceipt({ ...t300.doc, docNumber: 3, balance: 118, vatAmount: 0 }, { entity: 'exempt_dealer', vatRate: 0, payments: [{ method: 'cash', amount: 118, date: TODAY }], docDate: TODAY, today: TODAY });
  assert.ok(ex.ok && ex.doc.docType === 400);
});

test('credit invoices: full mirror, a sum, chosen lines (their share of the discount) — never beyond what is left', () => {
  const inv = composeDocument({ docType: 320, entity: 'licensed_dealer', vatRate: 18, pricesIncludeVat: true, discount: { kind: 'percent', value: 10 },
    lines: [{ name: 'קרם', qty: 2, unitPrice: 100, itemId: 'cream' }, { name: 'טיפול', qty: 1, unitPrice: 300 }], customer: { name: 'דנה' },
    payments: [{ method: 'cash', amount: 450, date: TODAY }], docDate: TODAY, today: TODAY });
  assert.ok(inv.ok);
  if (!inv.ok) return;
  const base = { ...inv.doc, docNumber: 9, linkNo: 1, issuedAt: `${TODAY}T10:00:00Z` };
  const full = composeCredit(base, { kind: 'full' }, 0, TODAY, { today: TODAY });
  assert.ok(full.ok && full.doc.total === 450 && full.doc.baseDocNumber === 9 && full.doc.payments.length === 0);
  const sum = composeCredit(base, { kind: 'amount', amount: 118 }, 0, TODAY, { today: TODAY });
  assert.ok(sum.ok && sum.doc.total === 118 && sum.doc.vatAmount === 18);
  if (sum.ok) assert.deepEqual(docInvariants(sum.doc, 18), []);
  const lines = composeCredit(base, { kind: 'lines', qty: [1, 0], restock: true }, 0, TODAY, { today: TODAY });
  assert.ok(lines.ok);
  if (lines.ok) {
    assert.deepEqual(docInvariants(lines.doc, 18), []);
    assert.equal(lines.doc.total, 90, 'one cream of ₪100 with the 10% discount = ₪90');
    assert.deepEqual([lines.doc.lines[0].itemId, lines.doc.lines[0].restock], ['cream', true], 'the cream goes back to stock');
  }
  const rest = composeCredit(base, { kind: 'full' }, 400, TODAY, { today: TODAY });
  assert.ok(rest.ok && rest.doc.total === 50, 'after ₪400 credited, "the whole" is the ₪50 left');
  const tooMuch = composeCredit(base, { kind: 'amount', amount: 51 }, 400, TODAY, { today: TODAY });
  assert.ok(!tooMuch.ok && /עד ₪50/.test(tooMuch.errors.join()));
  const done = composeCredit(base, { kind: 'full' }, 450, TODAY, { today: TODAY });
  assert.ok(!done.ok && /זוכתה במלואה/.test(done.errors.join()));
  assert.ok(!composeCredit({ ...base, docType: 400 }, { kind: 'full' }, 0, TODAY, { today: TODAY }).ok, 'a receipt is not credited');
  // random partial credits always pass the database checks
  const r = rng(99);
  for (let k = 0; k < 500; k++) {
    const amount = Math.round(r() * 45000) / 100 + 0.01;
    const c = composeCredit(base, { kind: 'amount', amount }, 0, TODAY, { today: TODAY });
    if (c.ok) assert.deepEqual(docInvariants(c.doc, 18), [], `credit of ${amount}`);
  }
});

test('payments: the unified-file codes, cheque details, the ledger totals', () => {
  assert.deepEqual([payCode('cash'), payCode('cheque'), payCode('card'), payCode('transfer'), payCode('bit'), payCode('other')], [1, 2, 3, 4, 9, 9]);
  assert.equal(chequeError({ bank: '12', branch: '345', account: '678', number: '', dueDate: '' }), 'מספר הצ׳ק — ספרות בלבד');
  assert.equal(chequeError({ bank: '1234', branch: '', account: '', number: '5', dueDate: '' }), 'מספר הבנק — עד 3 ספרות');
  assert.equal(chequeError({ bank: '', branch: '', account: '', number: '5', dueDate: '' }), null);
  assert.deepEqual(toDocPayment({ method: 'bit', amount: 10.005, date: TODAY }), { method: 9, amount: 10.01, date: TODAY, m: 'bit' });
  assert.deepEqual(ledgerTotals([{ direction: 'in', amount: 0.1 }, { direction: 'in', amount: 0.2 }, { direction: 'out', amount: 0.05 }]), { in: 0.3, out: 0.05, net: 0.25 });
});
