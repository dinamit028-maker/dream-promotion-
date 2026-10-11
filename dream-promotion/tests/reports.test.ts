/**
 * The reports of 2.94 (docs/FINANCE_ADDITIONS_HE.md T8) and tax withheld at source: the tables the screen, the CSV and the PDF share
 * (their totals are the database's — tests/sql/reports.check.sql proves those against finance_summary), the customer / supplier
 * key, the same period a year before, the advances' estimate, a withholding line of a receipt from the form to the document and the
 * ledger, the printed label, the PDF route (its gates and limits) and the treatment type of a service in the catalog.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { fakeDb } from './fakedb';
import {
  advanceEstimate, advancePctError, advanceTable, cellText, change, customerLedgerTable, incomeTable, itemsTable, monthsTable, partyKey, pdfBody, pnlTable,
  reportFileName, supplierLedgerTable, suppliersTable, tableCsv, toCustomerLedger, toIncomeByCustomer, toSalesByItem, toSupplierLedger, toSupplierReport,
  toWithholding, typesTable, withholdingRowsTable, withholdingTable, yearBefore, NOT_BY_ITEM, NO_TYPE,
} from '../src/features/finance/statements';
import { ledgerTotals, payLabel, toDocPayment, toLedgerRow, withholdingErrors, withholdingPctError } from '../src/features/finance/payments';
import { composeDocument, composeReceipt, docInvariants } from '../src/features/finance/compose';
import { docPayLabel } from '../src/features/documents/documents';
import { financeError } from '../src/features/finance/rows';
import { emptyDraft, itemColumns, itemColumnsOf, toCatalogItem } from '../src/features/catalog/catalog';
import { buildReportPdf, reportPdfInput, REPORT_PDF_LIMITS } from '../src/lib/server/report-pdf';

const LEAD = '00000000-0000-0000-0000-000000e4ad01';

test('who a customer or a supplier is: the CRM card, else the dealer number, else the name as the database reads it', () => {
  assert.equal(partyKey({ leadId: LEAD, dealer: '514000012', name: 'דנה' }), `l:${LEAD}`);
  assert.equal(partyKey({ dealer: '514000012', name: 'חברה בע"מ' }), 'd:514000012');
  assert.equal(partyKey({ dealer: '5140', name: 'יוסי כהן' }), 'n:יוסיכהן', 'not 9 digits: by the name');
  assert.equal(partyKey({ name: 'חברת  החשמל' }), partyKey({ name: 'חברת-החשמל' }), 'spaces and signs do not make another supplier');
  assert.equal(partyKey({ name: 'ABC Ltd.' }), 'n:abcltd');
});

test('income by customer: rows as the database gives them, the total as finance_summary\'s; an exempt dealer has no VAT columns', () => {
  const r = toIncomeByCustomer({ from: '2026-01-01', to: '2026-10-11', vat: true, total: { net: '4770.00', vat: '858.60', count: 7 },
    customers: [{ key: 'd:514000012', leadId: null, name: 'חברה בע"מ', dealer: '514000012', net: 2000, vat: 360, gross: 2360, count: 1 },
      { key: `l:${LEAD}`, leadId: LEAD, name: 'דנה', dealer: '', net: '1870.00', vat: '336.60', gross: '2206.60', count: 5 }] });
  assert.equal(r.total.net, 4770);
  assert.equal(r.customers[1].gross, 2206.6);
  const t = incomeTable(r);
  assert.deepEqual(t.columns.map((c) => c.label), ['לקוח', 'ע.מ / ח.פ', 'מסמכים', 'לפני מע״מ', 'מע״מ', 'כולל מע״מ']);
  assert.deepEqual(t.total, ['סה״כ', '', 7, 4770, 858.6, 5628.6]);
  const ex = incomeTable({ ...r, vat: false });
  assert.deepEqual(ex.columns.map((c) => c.label), ['לקוח', 'ע.מ / ח.פ', 'קבלות', 'הכנסות']);
  assert.equal(incomeTable({ ...r, customers: [{ ...r.customers[0], name: '' }] }).rows[0][0], 'לקוח מזדמן');
  // the CSV: Excel's Hebrew (BOM), plain numbers, the total last
  const csv = tableCsv(t);
  assert.ok(csv.startsWith('﻿"לקוח"'));
  assert.ok(csv.includes('"חברה בע""מ","514000012","1","2000.00","360.00","2360.00"'), csv);
  assert.ok(csv.trimEnd().endsWith('"סה״כ","","7","4770.00","858.60","5628.60"'));
});

test('sales by item and treatment type: what has no type, what is not by item, quantities of a share', () => {
  const r = toSalesByItem({ from: '2026-01-01', to: '2026-12-31', vat: true, total: 4810,
    items: [{ key: 'a|', itemId: 'a', variantId: null, name: 'ייעוץ', kind: 'service', typeId: null, qty: '2.00', net: '2066.66' },
      { key: 'b|', itemId: 'b', variantId: null, name: 'טיפול לייזר', kind: 'service', typeId: 'T1', qty: 4, net: 1366.67 },
      { key: 'c|', itemId: 'c', variantId: null, name: 'חבילה', kind: 'package', typeId: 'T2', qty: 1, net: 900 },
      { key: 'd|', itemId: 'd', variantId: null, name: 'קרם', kind: 'product', typeId: null, qty: 4.5, net: 436.67 }],
    types: [{ typeId: null, name: '', qty: 6.5, net: 2503.33 }, { typeId: 'T1', name: 'לייזר', qty: 4, net: 1366.67 }, { typeId: 'T2', name: 'פנים', qty: 1, net: 900 }],
    unattributed: { net: 40, count: 1 } });
  const items = itemsTable(r);
  assert.deepEqual(items.rows[1], ['טיפול לייזר', 'שירות', 'לייזר', 4, 1366.67]);
  assert.deepEqual(items.rows[3].slice(0, 3), ['קרם', 'מוצר', '']);
  assert.deepEqual(items.rows.at(-1), [NOT_BY_ITEM, '', '', null, 40], 'a document with no lines');
  assert.deepEqual(items.total, ['סה״כ', '', '', null, 4810]);
  assert.equal(cellText(4.5, 'qty', 'show'), '4.50');
  assert.equal(cellText(4.5, 'qty', 'csv'), '4.5');
  assert.equal(cellText(2, 'qty', 'show'), '2');
  const types = typesTable(r);
  assert.deepEqual(types.rows.map((x) => x[0]), [NO_TYPE, 'לייזר', 'פנים', NOT_BY_ITEM]);
  // every agora: the rows add up to the total
  const sum = (t: ReturnType<typeof typesTable>) => Math.round(t.rows.reduce((a, x) => a + Number(x[x.length - 1] ?? 0) * 100, 0)) / 100;
  assert.equal(sum(types), 4810);
  assert.equal(sum(items), 4810);
});

test('a customer\'s card: the opening balance first, every move with its document and method, the closing balance last', () => {
  const r = toCustomerLedger({ key: `l:${LEAD}`, from: '2026-01-01', to: '2026-10-11', name: 'דנה', opening: 590, debit: 2383.6, credit: 2769.5, closing: 204.1,
    rows: [{ date: '2026-02-01', kind: 'payment_document', docType: 400, docNumber: 1, debit: 0, credit: 25, method: 'withholding', balance: 565 },
      { date: '2026-02-10', kind: 'charge', docType: 305, docNumber: 2, debit: 1380.6, credit: 0, method: '', balance: 1380.6 },
      { date: '2026-10-11', kind: 'cancelled', docType: 300, docNumber: 2, debit: 0, credit: 59, method: '', balance: 204.1 }] });
  const t = customerLedgerTable(r);
  assert.equal(t.title, 'כרטסת לקוח — דנה');
  assert.deepEqual(t.rows[0], ['2026-01-01', 'יתרת פתיחה', '', null, null, 590]);
  assert.deepEqual(t.rows[1], ['2026-02-01', 'תשלום · ניכוי במקור', 'קבלה 1', null, 25, 565]);
  assert.deepEqual(t.rows[2], ['2026-02-10', 'חיוב', 'חשבונית מס 2', 1380.6, null, 1380.6]);
  assert.equal(t.rows[3][1], 'ביטול מסמך');
  assert.deepEqual(t.total, ['2026-10-11', 'יתרת סגירה', '', 2383.6, 2769.5, 204.1]);
  assert.equal(cellText('2026-02-01', 'date', 'show'), '01/02/2026');
  assert.equal(cellText(-1234.5, 'money', 'show'), '-1,234.50');
  assert.equal(cellText(-1234.5, 'money', 'csv'), '-1234.50');
});

test('suppliers and their card: paid and not yet; money back from a supplier is said so', () => {
  const s = toSupplierReport({ from: '2026-01-01', to: '2026-10-11', total: { net: 1900, vat: 342, total: 2242, paid: 826, open: 1416, count: 5 },
    suppliers: [{ key: 'd:516000017', name: 'ספק ציוד בע"מ', dealer: '516000017', count: 3, net: 1400, vat: 252, total: 1652, paid: 472, open: 1180 }],
    categories: [{ category: 'utilities', count: 2, net: 500, total: 590, paid: 354, open: 236 }] });
  assert.deepEqual(suppliersTable(s).total, ['סה״כ', '', 5, 1900, 342, 2242, 826, 1416]);
  const l = toSupplierLedger({ key: 'd:516000017', from: '2026-01-01', to: '2026-10-11', name: 'ספק ציוד', opening: 236, debit: 767, credit: 1947, closing: 1416,
    rows: [{ date: '2026-04-10', kind: 'payment_expense', number: 5, ref: 'Z-9', debit: 0, credit: 118, method: 'transfer', balance: 1357 },
      { date: '2026-03-20', kind: 'payment_expense', number: 4, ref: '7103', debit: 590, credit: 0, method: 'transfer', balance: 1357 }] });
  const t = supplierLedgerTable(l);
  assert.equal(t.rows[1][1], 'החזר מהספק · העברה בנקאית');
  assert.equal(t.rows[2][1], 'תשלום לספק · העברה בנקאית');
  assert.deepEqual(t.total, ['2026-10-11', 'יתרת סגירה', '', '', 767, 1947, 1416]);
});

test('tax withheld at source: by customer for the year, and the receipts — a cancelled one says so', () => {
  const w = toWithholding({ from: '2026-01-01', to: '2026-12-31', total: 183.5,
    customers: [{ key: 'd:514000012', leadId: null, name: 'חברה בע"מ', dealer: '514000012', amount: 100, count: 1 }, { key: `l:${LEAD}`, leadId: LEAD, name: 'דנה', dealer: '', amount: 83.5, count: 2 }],
    rows: [{ date: '2026-02-01', key: `l:${LEAD}`, name: 'דנה', dealer: '', docType: 400, docNumber: 1, invoice: '305-1', amount: 25, pct: 5 },
      { date: '2026-10-11', key: 'd:514000012', name: 'חברה בע"מ', dealer: '514000012', docType: 400, docNumber: 4, invoice: '305-3', amount: -100, pct: null }] });
  assert.deepEqual(withholdingTable(w).total, ['סה״כ', '', 3, 183.5]);
  const rows = withholdingRowsTable(w).rows;
  assert.deepEqual(rows[0], ['2026-02-01', 'דנה', '', 'קבלה 1', 'חשבונית מס 1', 5, 25]);
  assert.equal(rows[1][3], 'קבלה 4 (בוטלה)');
  assert.equal(cellText(5, 'pct', 'show'), '5%');
  assert.equal(cellText(null, 'pct', 'show'), '');
});

test('profit and loss against the same period a year before; month by month', () => {
  assert.deepEqual(yearBefore({ from: '2026-01-01', to: '2026-12-31' }), { from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(yearBefore({ from: '2024-02-01', to: '2024-02-29' }), { from: '2023-02-01', to: '2023-02-28' }, 'no 29 February the year before');
  assert.deepEqual(yearBefore({ from: '2029-02-01', to: '2029-02-28' }), { from: '2028-02-01', to: '2028-02-28' });
  assert.deepEqual(change(150, 100), { diff: 50, pct: 50 });
  assert.deepEqual(change(-50, 100), { diff: -150, pct: -150 });
  assert.deepEqual(change(10, 0), { diff: 10, pct: null }, 'no percent from zero');
  const now = { revenue: { net: 4770 }, expenses: { net: 1900, vat: 342, vatDeductible: 300 }, profit: 2828 };
  const before = { revenue: { net: 500 }, expenses: { net: 0, vat: 0, vatDeductible: 0 }, profit: 500 };
  const t = pnlTable(now, before, { now: '2026', before: '2025' });
  assert.deepEqual(t.columns.map((c) => c.label), ['', '2026', '2025', 'שינוי', 'שינוי %']);
  assert.deepEqual(t.rows[2], ['מע״מ על הוצאות שלא מקוזז', 42, 0, 42, null]);
  assert.deepEqual(t.total, ['רווח משוער', 2828, 500, 2328, 465.6]);
  const m = monthsTable([{ month: '2026-01', revenue: 100, expenses: 30 }, { month: '2026-02', revenue: 200, expenses: 250 }],
    [{ month: '2025-02', revenue: 50, expenses: 10 }]);
  assert.deepEqual(m.rows[0], ['ינואר 2026', 100, 30, 70, null, null]);
  assert.deepEqual(m.rows[1], ['פברואר 2026', 200, 250, -50, 50, 40]);
  assert.deepEqual(m.total, ['סה״כ', 300, 280, 20, 50, 40]);
});

test('income tax advances: a percent the business sets, an estimate only', () => {
  assert.equal(advancePctError(''), null);
  assert.equal(advancePctError('7.5'), null);
  assert.equal(advancePctError('100'), null);
  assert.ok(advancePctError('101'));
  assert.ok(advancePctError('5.555'));
  assert.ok(advancePctError('-1'));
  assert.ok(advancePctError('חמש'));
  assert.equal(advanceEstimate(4770, null), null, 'no percent: no estimate');
  assert.deepEqual(advanceEstimate(4770, 7.5), { base: 4770, pct: 7.5, amount: 357.75 });
  assert.deepEqual(advanceEstimate(333.33, 3), { base: 333.33, pct: 3, amount: 10 });
  const t = advanceTable({ base: 4770, pct: 7.5, amount: 357.75 }, 183.5, true);
  assert.deepEqual(t.rows.map((r) => r[1]), [4770, '7.5%', 357.75, 183.5]);
  assert.ok(t.note?.includes('הערכה בלבד'));
});

test('a withholding line of a receipt: its percent, its customer, never all of it; the document, the ledger and the label', () => {
  assert.equal(withholdingPctError(null), null);
  assert.equal(withholdingPctError(5), null);
  assert.equal(withholdingPctError(2.55), null, 'two decimals (no floating point trap)');
  assert.ok(withholdingPctError(120));
  assert.ok(withholdingPctError(1.234));
  assert.deepEqual(withholdingErrors([{ method: 'cash', amount: 100 }], { total: 100, customerName: '' }), [], 'none: nothing to check');
  assert.deepEqual(withholdingErrors([{ method: 'transfer', amount: 565 }, { method: 'withholding', amount: 25, pct: 5 }], { total: 590, customerName: 'דנה' }), []);
  assert.equal(withholdingErrors([{ method: 'withholding', amount: 590 }], { total: 590, customerName: 'דנה' }).length, 1, 'all of it');
  assert.equal(withholdingErrors([{ method: 'cash', amount: 50 }, { method: 'withholding', amount: 10 }], { total: 60, customerName: ' ' }).length, 1, 'no customer');
  assert.deepEqual(toDocPayment({ method: 'withholding', amount: 25, date: '2026-02-01', pct: 5 }), { method: 9, amount: 25, date: '2026-02-01', m: 'withholding', pct: 5 });
  assert.deepEqual(toDocPayment({ method: 'withholding', amount: 25, date: '2026-02-01', pct: null }), { method: 9, amount: 25, date: '2026-02-01', m: 'withholding' });
  assert.equal('pct' in toDocPayment({ method: 'cash', amount: 25, date: '2026-02-01', pct: 5 }), false, 'a percent only on a withholding');
  assert.equal(payLabel('withholding'), 'ניכוי במקור');
  assert.equal(docPayLabel({ method: 9, m: 'withholding', pct: 5 }), 'ניכוי במקור (5%)');
  assert.equal(docPayLabel({ method: 9, m: 'withholding' }), 'ניכוי במקור');
  assert.equal(docPayLabel({ method: 9, m: 'bit' }), 'אחר', 'every other line as before');
  assert.equal(docPayLabel({ method: 4 }), 'העברה בנקאית');
  // the ledger: tax withheld is not money — out of in / out, counted on its own (a cancelled receipt gives it back)
  const rows = [
    toLedgerRow({ id: '1', direction: 'in', amount: '565.00', method: 'transfer', paid_on: '2026-02-01', source: 'document', reference: {} }),
    toLedgerRow({ id: '2', direction: 'in', amount: '25.00', method: 'withholding', paid_on: '2026-02-01', source: 'document', reference: { pct: 5 } }),
    toLedgerRow({ id: '3', direction: 'in', amount: '100.00', method: 'withholding', paid_on: '2026-05-01', source: 'document', reference: {} }),
    toLedgerRow({ id: '4', direction: 'out', amount: '100.00', method: 'withholding', paid_on: '2026-10-11', source: 'cancel', reference: {} }),
    toLedgerRow({ id: '5', direction: 'out', amount: '118.00', method: 'cash', paid_on: '2026-03-01', source: 'credit' }),
  ];
  assert.equal(rows[1].pct, 5);
  assert.equal(rows[2].pct, null);
  assert.deepEqual(ledgerTotals(rows), { in: 565, out: 118, net: 447, withheld: 25 });
});

test('a receipt with tax withheld: the form → a document the database accepts; the same refusals in Hebrew first', () => {
  const inv = { docType: 305, docNumber: 1, customerName: 'חברה בע"מ', customerPhone: '', customerDealer: '514000012', customerStreet: '', customerCity: '',
    lines: [{ name: 'ייעוץ', qty: 1, unitPriceExVat: 2000, discountExVat: 0, totalExVat: 2000, vatRate: 18, kind: 1 as const }],
    beforeDiscount: 2000, discount: 0, afterDiscount: 2000, vatAmount: 360, total: 2360, balance: 2360 };
  const r = composeReceipt(inv, { entity: 'company', vatRate: 18, docDate: '2026-04-15', today: '2026-10-11',
    payments: [{ method: 'transfer', amount: 2260, date: '2026-04-15' }, { method: 'withholding', amount: 100, date: '2026-04-15', pct: 5 }] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.doc.docType, 400);
  assert.equal(r.doc.total, 2360);
  assert.deepEqual(r.doc.payments.map((p) => [p.method, p.m, p.amount, (p as any).pct]), [[4, 'transfer', 2260, undefined], [9, 'withholding', 100, 5]]);
  assert.deepEqual(docInvariants(r.doc, 0), []);
  const all = composeReceipt(inv, { entity: 'company', vatRate: 18, docDate: '2026-04-15', today: '2026-10-11', payments: [{ method: 'withholding', amount: 100, date: '2026-04-15' }] });
  assert.ok(!all.ok && all.errors.some((e) => e.includes('לא כולו')));
  const pct = composeReceipt(inv, { entity: 'company', vatRate: 18, docDate: '2026-04-15', today: '2026-10-11',
    payments: [{ method: 'cash', amount: 50, date: '2026-04-15' }, { method: 'withholding', amount: 10, date: '2026-04-15', pct: 120 }] });
  assert.ok(!pct.ok && pct.errors.some((e) => e.includes('אחוז')));
  // a tax invoice-receipt of the document center: tax withheld needs the customer's name
  const doc = (name: string) => composeDocument({ docType: 320, entity: 'company', vatRate: 18, pricesIncludeVat: true, lines: [{ name: 'טיפול', qty: 1, unitPrice: 590 }],
    customer: { name }, docDate: '2026-02-01', today: '2026-10-11',
    payments: [{ method: 'cash', amount: 565, date: '2026-02-01' }, { method: 'withholding', amount: 25, date: '2026-02-01', pct: 5 }] });
  const anon = doc('');
  assert.ok(!anon.ok && anon.errors.some((e) => e.includes('שם הלקוח')));
  const named = doc('דנה');
  assert.ok(named.ok, JSON.stringify(named));
  assert.deepEqual(docInvariants(named.doc, 18), []);
});

test('the database\'s refusals of 2.94 in Hebrew', () => {
  assert.match(financeError({ message: 'withholding_pct: the percent is a number from 0 to 100' }), /אחוז הניכוי/);
  assert.match(financeError({ message: 'withholding_customer: tax withheld at source needs the customer who withheld it' }), /שם הלקוח/);
  assert.match(financeError({ message: 'withholding_all: tax withheld at source is part of a payment, not all of it' }), /לא כולו/);
  assert.match(financeError({ message: 'new row for relation "payments" violates check constraint "payments_withholding_source"' }), /רק בקבלה/);
  assert.match(financeError({ message: 'bad range', code: '22023' }), /טווח התאריכים/);
  assert.match(financeError({ message: 'customer: a key', code: '22023' }), /לקוח או ספק/);
  assert.match(financeError({ message: 'not allowed', code: '42501' }), /אין הרשאה/);
});

test('a service\'s treatment type in the catalog: written only for a service, only with migration 4900, and only when changed', () => {
  const svc = emptyDraft({ name: 'טיפול לייזר', kind: 'service', price: '500', treatmentTypeId: 'T1' });
  assert.equal((itemColumns(svc, [], { types: true }) as any).treatment_type_id, 'T1');
  assert.equal('treatment_type_id' in itemColumns(svc, []), false, 'before 4900: no such column');
  assert.equal((itemColumns({ ...svc, kind: 'product' }, [], { types: true }) as any).treatment_type_id, null, 'a product has none');
  assert.equal((itemColumns({ ...svc, treatmentTypeId: '' }, [], { types: true }) as any).treatment_type_id, null);
  const item = toCatalogItem({ id: 'i1', name: 'טיפול לייזר', kind: 'service', price: 500, treatment_type_id: 'T1' });
  assert.equal(item.treatmentTypeId, 'T1');
  assert.equal(toCatalogItem({ id: 'i2', name: 'x', kind: 'service', price: 1 }).treatmentTypeId, null, 'a row from before 4900');
  assert.equal((itemColumnsOf(item, { types: true }) as any).treatment_type_id, 'T1');
});

test('a report\'s PDF: only text in the limits; the table drawn, the header again on every page, a wide one on its side', async () => {
  assert.equal(reportPdfInput(null).ok, false);
  assert.equal(reportPdfInput({ title: '', columns: [{ label: 'a', numeric: false }], rows: [] }).ok, false, 'no title');
  assert.equal(reportPdfInput({ title: 't', columns: [], rows: [] }).ok, false, 'no columns');
  assert.equal(reportPdfInput({ title: 't', columns: [{ label: 'a', numeric: false }], rows: [['x', 'y']] }).ok, false, 'a row of another width');
  assert.equal(reportPdfInput({ title: 't', columns: [{ label: 'a', numeric: false }], rows: [[{ evil: 1 }]] }).ok, false, 'a cell that is not text');
  assert.equal(reportPdfInput({ title: 't', columns: [{ label: 'a', numeric: false }], rows: Array.from({ length: REPORT_PDF_LIMITS.rows + 1 }, () => ['x']) }).ok, false, 'too many rows');
  const ok = reportPdfInput({ title: 'הכנסות לפי לקוח', subtitle: 'השנה', columns: [{ label: 'לקוח', numeric: false }, { label: 'סכום', numeric: true }],
    rows: [['דנה', '1,870.00']], total: ['סה״כ', '1,870.00'], note: '' });
  assert.ok(ok.ok);
  const long = 'א'.repeat(500);
  const cut = reportPdfInput({ title: long, columns: [{ label: 'a', numeric: false }], rows: [[long]] });
  assert.ok(cut.ok && cut.input.title.length === REPORT_PDF_LIMITS.title && cut.input.rows[0][0].length === REPORT_PDF_LIMITS.cell, 'long text is cut, not refused');

  const ledger = customerLedgerTable(toCustomerLedger({ key: `l:${LEAD}`, from: '2026-01-01', to: '2026-12-31', name: 'דנה (בדיקה) — 5%', opening: 0, debit: 0, credit: 0, closing: 0,
    rows: Array.from({ length: 120 }, (_, i) => ({ date: '2026-02-01', kind: 'charge', docType: 305, docNumber: i + 1, debit: 100, credit: 0, method: '', balance: (i + 1) * 100 })) }));
  const body = pdfBody(ledger, 'ינואר–דצמבר 2026 · כל הסניפים');
  assert.equal(body.columns.length, 6);
  assert.equal(body.rows[1][5], '100.00');
  const v = reportPdfInput(JSON.parse(JSON.stringify(body)));
  assert.ok(v.ok);
  const pdf = await buildReportPdf(v.input, { name: 'קליניקה בע"מ', dealerNumber: '514000046' }, { software: 'Dream Promotion test', at: '2026-10-11T08:00:00Z' });
  const bytes = await pdf.save();
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  const back = await PDFDocument.load(bytes);
  assert.ok(back.getPageCount() >= 3, `120 rows on more than one page (got ${back.getPageCount()})`);
  assert.ok(back.getPage(0).getHeight() > back.getPage(0).getWidth(), 'six columns: standing');
  const wide = suppliersTable(toSupplierReport({ from: '2026-01-01', to: '2026-12-31', total: {}, suppliers: [{ key: 'n:x', name: 'ספק', dealer: '', count: 1, net: 1, vat: 0, total: 1, paid: 0, open: 1 }], categories: [] }));
  const w = reportPdfInput(pdfBody(wide, ''));
  assert.ok(w.ok);
  const wp = await PDFDocument.load(await (await buildReportPdf(w.input, { name: 'x', dealerNumber: '' }, { software: 't', at: '2026-10-11T08:00:00Z' })).save());
  assert.ok(wp.getPage(0).getWidth() > wp.getPage(0).getHeight(), 'eight columns: on its side');
  assert.equal(reportFileName('כרטסת לקוח — דנה/בדיקה', { from: '2026-01-01', to: '2026-12-31' }, 'pdf'), 'כרטסת-לקוח-—-דנה-בדיקה-2026-01-01-2026-12-31.pdf');
});

test('the PDF route: a member of the business (a viewer too), never a cashier or someone signed out; the business from the database', async () => {
  const OWN = 'u-own', VIEW = 'u-view', CASH = 'u-cash';
  const tables: Record<string, any[]> = {
    profiles: [{ id: OWN, is_super_admin: false }, { id: VIEW, is_super_admin: false }, { id: CASH, is_super_admin: false }],
    businesses: [{ id: 'b1', name: 'Clinic', status: 'active', paid_until: null, grace_days: 0 }],
    business_members: [{ business_id: 'b1', user_id: OWN, role: 'owner', access: 'full' }, { business_id: 'b1', user_id: VIEW, role: 'viewer', access: 'full' },
      { business_id: 'b1', user_id: CASH, role: 'editor', access: 'register' }],
    register_settings: [{ business_id: 'b1', legal_name: 'קליניקה בע"מ', dealer_number: '514000046' }],
    finance_access_grants: [],
  };
  (globalThis as any).__DP_TEST_ADMIN_DB__ = {
    from: (t: string) => fakeDb(tables).from(t),
    auth: { getUser: async (t: string) => ({ data: { user: [OWN, VIEW, CASH].includes(t) ? { id: t } : null } }) },
    rpc: async (fn: string) => ({ data: fn === 'business_for_user' ? 'b1' : null, error: null }),
  };
  const { POST } = await import('../src/app/api/finance/report-pdf/route');
  const body = JSON.stringify(pdfBody(incomeTable(toIncomeByCustomer({ vat: true, total: { net: 100, vat: 18, count: 1 },
    customers: [{ key: 'n:x', name: 'לקוח', dealer: '', net: 100, vat: 18, gross: 118, count: 1 }] })), 'השנה'));
  const post = (u: string | null, b: string = body) => POST(new Request('http://x/api/finance/report-pdf', { method: 'POST', body: b,
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.0.${u?.length ?? 0}`, ...(u ? { authorization: `Bearer ${u}` } : {}) } }));
  assert.equal((await post(null)).status, 401);
  assert.equal((await post(CASH)).status, 403, 'a cashier');
  const own = await post(OWN);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'application/pdf');
  assert.equal(own.headers.get('cache-control'), 'no-store');
  assert.equal(Buffer.from(await own.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await post(VIEW)).status, 200, 'a viewer reads reports');
  assert.equal((await post(OWN, '{"title":')).status, 400, 'not JSON');
  assert.equal((await post(OWN, JSON.stringify({ title: 'x', columns: 'a', rows: [] }))).status, 400);
});
