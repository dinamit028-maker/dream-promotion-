/**
 * Manual journal entries, one-sided (2.96, docs/FINANCE_ADDITIONS_HE.md T13א): reading the table, what an entry does to the money
 * summary, the form's checks (the database's own, in Hebrew), the call's arguments, undoing, the table for CSV / PDF and the
 * accountant, the summary's manual share, the reports' "פקודה ידנית" lines, the menu item and every refusal's Hebrew. The database
 * keeps the same rules (tests/sql/journal.check.sql).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canReverse, draftAsEntry, effectText, emptyDraft, entriesTotals, entryArgs, entryEffect, journalErrors, journalTable, kindsFor, manualPnlRows, manualVatRows,
  partyKeyOf, partyKinds, reverseErrors, toEntries, toManual, vatAt, NO_MANUAL, type JournalDraft,
} from '../src/features/finance/journal';
import {
  MANUAL_ENTRIES, MANUAL_NO_CUSTOMER, MANUAL_NO_SUPPLIER, categoriesTable, customerLedgerTable, incomeTable, itemsTable, supplierLedgerTable, suppliersTable,
  toCustomerLedger, toIncomeByCustomer, toSalesByItem, toSupplierLedger, toSupplierReport, typesTable,
} from '../src/features/finance/statements';
import { FINANCE_MODULE, JOURNAL_LINK, financeGroups } from '../src/features/finance/module';
import { FINANCE_SECTIONS } from '../src/features/finance/routes';
import { financeError } from '../src/features/finance/rows';
import { auditLine, toAuditRow } from '../src/features/finance/audit';
import { toSummary } from '../src/features/finance/Overview';

const row = (n: number, o: Record<string, unknown> = {}) => ({
  id: `e${n}`, number: n, entry_date: '2026-10-11', kind: 'income', amount: '200.00', vat: '36.00', vat_side: 'output', category: null, explanation: `פקודה ${n}`,
  location_id: 'L1', party_kind: null, lead_id: null, party_name: '', party_dealer: '', reverses: null, created_at: '2026-10-11T10:00:00Z', ...o,
});
const today = '2026-10-11';
const draft = (o: Partial<JournalDraft> = {}): JournalDraft => ({ ...emptyDraft(today), amount: '200', vat: '36', explanation: 'הכנסה שלא הופקה עליה חשבונית', ...o });

test('the table\'s rows: newest first, each with the entry it undoes and the one that undid it (from the list or around it)', () => {
  const list = toEntries([
    row(1, { party_kind: 'customer', lead_id: 'L-dana', party_name: 'דנה' }),
    row(2, { kind: 'expense', vat_side: 'input', category: 'rent', amount: -50, vat: 0 }),
    row(3, { kind: 'income', amount: -200, vat: -36, reverses: 'e1' }),
    row(4, { kind: 'vat', amount: 0, vat: 50, vat_side: 'output' }),
    row(5, { kind: 'loan' }),                                     // not a kind of entry: left out
  ], [{ id: 'e9', number: 9, reverses: 'e2' }]);
  assert.deepEqual(list.map((e) => e.number), [4, 3, 2, 1]);
  const [e4, e3, e2, e1] = list;
  assert.deepEqual(e1.party, { kind: 'customer', leadId: 'L-dana', name: 'דנה', dealer: '' });
  assert.equal(e1.reversedBy, 3, 'undone by entry 3 (in the list)');
  assert.equal(e3.reversesNumber, 1);
  assert.equal(e2.reversedBy, 9, 'undone by entry 9 — of a later period, told by the context only');
  assert.equal(e2.amount, -50); assert.equal(e2.category, 'rent');
  assert.equal(e4.vatSide, 'output'); assert.equal(e4.amount, 0);
  assert.ok(canReverse(e4) && !canReverse(e3) && !canReverse(e1), 'a reversal and an undone entry are not undone again');
  assert.deepEqual(toEntries(null), []);
});

test('what an entry does to the money summary — and says it in Hebrew', () => {
  assert.deepEqual(entryEffect({ kind: 'income', amount: 200, vat: 36, vatSide: 'output' }), { income: 200, expense: 0, vatOut: 36, vatIn: 0 });
  assert.deepEqual(entryEffect({ kind: 'expense', amount: 100, vat: 18, vatSide: 'input' }), { income: 0, expense: 100, vatOut: 0, vatIn: 18 });
  assert.deepEqual(entryEffect({ kind: 'vat', amount: 0, vat: 20, vatSide: 'input' }), { income: 0, expense: 0, vatOut: 0, vatIn: 20 });
  assert.deepEqual(entryEffect({ kind: 'vat', amount: 0, vat: 50, vatSide: 'output' }), { income: 0, expense: 0, vatOut: 50, vatIn: 0 });
  assert.deepEqual(entryEffect({ kind: 'other', amount: 300, vat: 0, vatSide: null }), { income: 0, expense: 0, vatOut: 0, vatIn: 0 });
  assert.equal(effectText({ kind: 'income', amount: 200, vat: 36, vatSide: 'output' }), 'הכנסות +₪200 · מע״מ עסקאות +₪36');
  assert.equal(effectText({ kind: 'income', amount: -200.5, vat: -36.09, vatSide: 'output' }), 'הכנסות −₪200.50 · מע״מ עסקאות −₪36.09');
  assert.match(effectText({ kind: 'other', amount: 300, vat: 0, vatSide: null }), /רק ברשימה ובכרטסת/);
  const t = entriesTotals([{ kind: 'income', amount: 0.1, vat: 0.02, vatSide: 'output' }, { kind: 'income', amount: 0.2, vat: 0.01, vatSide: 'output' },
    { kind: 'expense', amount: 250, vat: 0, vatSide: 'input' }, { kind: 'vat', amount: 0, vat: 20, vatSide: 'input' }]);
  assert.deepEqual(t, { income: 0.3, expense: 250, vatOut: 0.03, vatIn: 20, count: 4 }, 'to the agora');
});

test('the form: what the database would refuse, in Hebrew', () => {
  const ctx = { today, lockedUntil: null, vatOn: true };
  assert.deepEqual(journalErrors(draft(), ctx), []);
  assert.match(journalErrors(draft({ date: '2026-10-12' }), ctx).join(), /היום או לפני/);
  assert.match(journalErrors(draft({ date: '2026-09-30' }), { ...ctx, lockedUntil: '2026-09-30' }).join(), /סגורים עד 30\/09\/2026/);
  assert.match(journalErrors(draft({ amount: '10.555' }), ctx).join(), /שתי ספרות/);
  assert.match(journalErrors(draft({ amount: 'abc' }), ctx).join(), /שתי ספרות/);
  assert.match(journalErrors(draft({ amount: '0', vat: '' }), ctx).join(), /סכום/);
  assert.deepEqual(journalErrors(draft({ amount: '-200', vat: '-36' }), ctx), [], 'a correction that reduces is a negative amount');
  assert.match(journalErrors(draft({ kind: 'vat', vat: '50', vatSide: null }), ctx).join(), /עסקאות או מע״מ תשומות/);
  assert.match(journalErrors(draft({ kind: 'vat', vat: '', vatSide: 'output' }), ctx).join(), /סכום המע״מ/);
  assert.deepEqual(journalErrors(draft({ kind: 'vat', amount: '999', vat: '50', vatSide: 'output' }), ctx), [], 'a VAT entry\'s amount is not read');
  assert.match(journalErrors(draft({ kind: 'vat', vat: '50', vatSide: 'output' }), { ...ctx, vatOn: false }).join(), /עוסק פטור לא רושם מע״מ/);
  assert.match(journalErrors(draft({ explanation: ' x ' }), ctx).join(), /הסבר — חובה/);
  assert.match(journalErrors(draft({ explanation: 'א'.repeat(501) }), ctx).join(), /ארוך מדי/);
  assert.match(journalErrors(draft({ party: { kind: 'supplier', leadId: null, name: 'ספק', dealer: '' } }), ctx).join(), /הכנסה שייכת ללקוח/);
  assert.match(journalErrors(draft({ kind: 'expense', party: { kind: 'customer', leadId: null, name: 'דנה', dealer: '' } }), ctx).join(), /הוצאה שייכת לספק/);
  assert.match(journalErrors(draft({ party: { kind: 'customer', leadId: null, name: 'דנה', dealer: '12345678' } }), ctx).join(), /9 ספרות/);
  assert.match(journalErrors(draft({ party: { kind: 'customer', leadId: null, name: ' ', dealer: '' } }), ctx).join(), /שם הלקוח או מספר העוסק/);
  assert.deepEqual(journalErrors(draft({ party: { kind: 'customer', leadId: 'L1', name: '', dealer: '' } }), ctx), [], 'a card is enough');
  assert.deepEqual(journalErrors(draft({ kind: 'other', vat: '', party: { kind: 'supplier', leadId: null, name: '', dealer: '512345678' } }), ctx), []);
  assert.deepEqual(kindsFor(true), ['income', 'expense', 'vat', 'other']);
  assert.deepEqual(kindsFor(false), ['income', 'expense', 'other'], 'an exempt dealer has no VAT entry');
  assert.deepEqual(partyKinds('vat'), []); assert.deepEqual(partyKinds('other'), ['customer', 'supplier']);
  assert.equal(vatAt(200, 18), 36); assert.equal(vatAt(0.5, 18), 0.09); assert.equal(vatAt(-100, 17), -17);
});

test('the call\'s arguments: as the database reads them', () => {
  assert.deepEqual(entryArgs('id1', draft({ party: { kind: 'customer', leadId: 'L1', name: 'דנה', dealer: '' }, locationId: 'L2' }), true), {
    p_id: 'id1', p_date: today, p_kind: 'income', p_amount: 200, p_vat: 36, p_vat_side: null, p_category: null, p_explanation: 'הכנסה שלא הופקה עליה חשבונית',
    p_location: 'L2', p_party: { kind: 'customer', leadId: 'L1', dealer: '' },
  });
  const v = entryArgs('id2', draft({ kind: 'vat', amount: '999', vat: '50', vatSide: 'input' }), true);
  assert.equal(v.p_amount, 0); assert.equal(v.p_vat, 50); assert.equal(v.p_vat_side, 'input'); assert.equal(v.p_party, null);
  const x = entryArgs('id3', draft({ kind: 'expense', category: '', vat: '1,234.50', amount: '6,858.33', party: { kind: 'supplier', leadId: null, name: ' ספק ', dealer: '512345678' } }), true);
  assert.equal(x.p_category, 'other'); assert.equal(x.p_vat, 1234.5); assert.equal(x.p_amount, 6858.33);
  assert.deepEqual(x.p_party, { kind: 'supplier', name: 'ספק', dealer: '512345678' });
  assert.equal(entryArgs('id4', draft({ kind: 'other', vat: '18' }), true).p_vat, 0, '"other" carries no VAT');
  assert.equal(entryArgs('id5', draft(), false).p_vat, 0, 'an exempt dealer records none');
  assert.equal(entryArgs('id6', draft({ kind: 'expense', party: { kind: 'customer', leadId: null, name: 'דנה', dealer: '' } }), true).p_party, null, 'a party of the wrong kind is not sent');
  assert.deepEqual(draftAsEntry(draft({ kind: 'expense' }), true), { kind: 'expense', amount: 200, vat: 36, vatSide: 'input' });
  assert.equal(partyKeyOf({ kind: 'customer', leadId: 'L1', name: 'דנה', dealer: '' }), 'l:L1');
  assert.equal(partyKeyOf({ kind: 'supplier', leadId: 'L1', name: 'ספק', dealer: '512345678' }), 'd:512345678', 'a supplier is never a card');
  assert.equal(partyKeyOf(null), null);
});

test('undoing: on or after the entry, today or before, not in closed books, with a reason', () => {
  const ctx = { today, lockedUntil: null };
  assert.deepEqual(reverseErrors({ date: '2026-10-01' }, { date: today, reason: 'נרשם פעמיים' }, ctx), []);
  assert.match(reverseErrors({ date: '2026-10-05' }, { date: '2026-10-04', reason: 'נרשם פעמיים' }, ctx).join(), /מתאריך הפקודה/);
  assert.match(reverseErrors({ date: '2026-10-05' }, { date: '2026-10-12', reason: 'נרשם פעמיים' }, ctx).join(), /מתאריך הפקודה/);
  assert.match(reverseErrors({ date: '2026-09-01' }, { date: '2026-09-15', reason: 'נרשם פעמיים' }, { ...ctx, lockedUntil: '2026-09-30' }).join(), /סגורים/);
  assert.match(reverseErrors({ date: '2026-10-01' }, { date: today, reason: ' ' }, ctx).join(), /סיבה — חובה/);
});

test('the table of a period (CSV, PDF, the accountant): every entry, the kind, the party and the undoing', () => {
  const list = toEntries([
    row(1, { party_kind: 'customer', lead_id: 'L', party_name: 'דנה' }), row(2, { kind: 'expense', vat_side: 'input', category: 'rent', amount: 100, vat: 18, location_id: 'L2' }),
    row(3, { amount: -200, vat: -36, reverses: 'e1' }), row(4, { kind: 'vat', amount: 0, vat: 50, vat_side: 'output' }),
  ]);
  const t = journalTable(list, { vatOn: true });
  assert.equal(t.title, 'פקודות יומן ידניות');
  assert.deepEqual(t.columns.map((c) => c.label), ['מס׳', 'תאריך', 'סוג', 'לפני מע״מ', 'מע״מ', 'הסבר', 'לקוח / ספק', 'ביטול']);
  assert.deepEqual(t.rows.map((r) => r[0]), [1, 2, 3, 4], 'by number');
  assert.deepEqual(t.rows[0].slice(2), ['הכנסה', 200, 36, 'פקודה 1', 'לקוח: דנה', 'בוטלה ב-3']);
  assert.equal(t.rows[1][2], 'הוצאה · שכירות');
  assert.equal(t.rows[2][7], 'הופכת את 1');
  assert.equal(t.rows[3][2], 'מע״מ עסקאות', 'a VAT entry by its side (not "מע״מ" twice)');
  assert.match(t.note ?? '', /הכנסות \+₪0, הוצאות \+₪100, מע״מ עסקאות \+₪50, מע״מ תשומות \+₪18/);
  const ex = journalTable(list, { vatOn: false, locationName: (id) => (id === 'L2' ? 'צפון' : 'ראשי') });
  assert.deepEqual(ex.columns.map((c) => c.label), ['מס׳', 'תאריך', 'סוג', 'סכום', 'הסבר', 'לקוח / ספק', 'ביטול', 'סניף']);
  assert.equal(ex.rows[1][7], 'צפון');
});

test('the money summary\'s manual share: in the numbers already, said apart — nothing when there is none', () => {
  assert.deepEqual(toManual(undefined), NO_MANUAL, 'before migration 5100');
  const m = toManual({ count: 9, income: { net: 350, vat: 63 }, expense: { net: 350, vat: 18 }, vat: { output: 50, input: 20 } });
  assert.deepEqual(manualPnlRows(m), [['מתוכן פקודות יומן ידניות — הכנסות', 350], ['מתוכן פקודות יומן ידניות — הוצאות', 350]]);
  assert.deepEqual(manualVatRows(m), [['מתוכן פקודות יומן ידניות — מע״מ עסקאות', 113], ['מתוכן פקודות יומן ידניות — מע״מ תשומות', 38]]);
  assert.deepEqual(manualPnlRows(NO_MANUAL), []); assert.deepEqual(manualVatRows(NO_MANUAL), []);
  assert.deepEqual(toSummary({ revenue: {}, expenses: {}, cash: {}, receivables: {}, pending: {}, posWithoutDocument: {} }).manual, NO_MANUAL);
});

test('the reports: the manual entries on lines of their own — "פקודה ידנית" on the cards, apart in the totals', () => {
  const inc = toIncomeByCustomer({ vat: true, total: { net: 1350, vat: 293, count: 6, manual: 350 }, customers: [
    { key: 'l:L', name: 'דנה', net: 1200, vat: 216, gross: 1416, count: 2, manual: 200 }, { key: 'm:', name: '', net: 0, vat: 50, gross: 50, count: 3, manual: 0 }] });
  const it = incomeTable(inc);
  assert.deepEqual(it.rows.map((r) => r[0]), ['דנה', MANUAL_NO_CUSTOMER]);
  assert.match(it.note ?? '', /כולל פקודות יומן ידניות: ₪350/);
  assert.doesNotMatch(incomeTable(toIncomeByCustomer({ vat: true, total: {}, customers: [] })).note ?? '', /פקודות/, 'none — the note as it was');
  const items = toSalesByItem({ total: 1350, items: [], types: [], unattributed: { net: 0, count: 0 }, manual: { net: 350, count: 4 } });
  assert.deepEqual(itemsTable(items).rows.at(-1), [MANUAL_ENTRIES, '', '', null, 350]);
  assert.deepEqual(typesTable(items).rows.at(-1), [MANUAL_ENTRIES, null, 350]);
  assert.equal(itemsTable(toSalesByItem({ total: 0, items: [], types: [] })).rows.length, 0, 'none — no line');
  const sup = toSupplierReport({ total: { net: 850, vat: 108, total: 958, paid: 590, open: 0, count: 3, manual: 368 },
    suppliers: [{ key: 'd:512345678', name: 'ספק ציוד', dealer: '512345678', count: 2, net: 600, vat: 108, total: 708, paid: 590, open: 0, manual: 118 },
      { key: 'm:', name: '', dealer: '', count: 1, net: 250, vat: 0, total: 250, paid: 0, open: 0, manual: 250 }],
    categories: [{ category: 'other', count: 1, net: 250, total: 250, paid: 0, open: 0, manual: 250 }] });
  const st = suppliersTable(sup);
  assert.equal(st.columns.at(-1)?.label, 'פקודות ידניות');
  assert.deepEqual(st.rows[1].slice(0, 1).concat(st.rows[1].slice(-1)), [MANUAL_NO_SUPPLIER, 250]);
  assert.equal(st.total?.at(-1), 368);
  assert.equal(categoriesTable(sup).columns.at(-1)?.label, 'פקודות ידניות');
  const none = toSupplierReport({ total: { total: 590, paid: 590 }, suppliers: [], categories: [] });
  assert.equal(suppliersTable(none).columns.length, 8, 'no entries — the table as it was');
  assert.equal(categoriesTable(none).columns.length, 6);
  const cl = customerLedgerTable(toCustomerLedger({ name: 'דנה', from: '2026-10-01', to: '2026-10-31', opening: 0, debit: 1416, credit: 0, closing: 1416, rows: [
    { date: '2026-10-11', kind: 'charge', docType: 305, docNumber: 7, debit: 1180, credit: 0, balance: 1180, note: '' },
    { date: '2026-10-11', kind: 'manual', docType: null, docNumber: 1, debit: 236, credit: 0, balance: 1416, note: 'הכנסה מטיפול' }] }));
  assert.deepEqual(cl.rows[2].slice(1, 4), ['פקודה ידנית — הכנסה מטיפול', 'פקודה 1', 236]);
  assert.match(cl.note ?? '', /לא ב"חייבים"/);
  const sl = supplierLedgerTable(toSupplierLedger({ name: 'ספק ציוד', from: '2026-10-01', to: '2026-10-31', opening: 0, debit: 590, credit: 708, closing: 118, rows: [
    { date: '2026-10-11', kind: 'manual', number: 2, ref: '', debit: 0, credit: 118, balance: 118, note: 'חשבונית שלא נרשמה' }] }));
  assert.deepEqual(sl.rows[1].slice(1, 6), ['פקודה ידנית — חשבונית שלא נרשמה', 'פקודה 2', '', null, 118]);
});

test('the menu: "פקודות יומן" under the reports once the migration is in the database; every screen exactly once', () => {
  assert.equal(JOURNAL_LINK.href, '/finance/journal');
  assert.deepEqual(financeGroups({ cash: false }), FINANCE_MODULE.groups, 'neither: the menu as it was');
  assert.deepEqual(financeGroups({ cash: false, journal: true }).find((g) => g.id === 'reports')?.links.map((l) => l.label), ['דוחות', 'רואה חשבון', 'פקודות יומן']);
  const links = financeGroups({ cash: true, journal: true }).flatMap((g) => g.links.map((l) => l.href));
  assert.deepEqual([...links].sort(), FINANCE_SECTIONS.map((s) => s.path).sort(), 'all 14 screens');
  assert.equal(new Set(links).size, links.length, 'none twice');
  assert.equal(FINANCE_MODULE.groups.find((g) => g.id === 'reports')?.links.length, 2, 'the module\'s own groups are not changed');
});

test('every refusal of the journal says its own thing in Hebrew; the audit log names the entries', () => {
  const said: [string, RegExp][] = [
    ["journal_not_allowed: only the business's owners record a manual entry", /רק הבעלים של העסק/],
    ['journal_date: an entry is dated today or before', /תאריך הפקודה/],
    ['journal_kind: income, expense, VAT or other', /סוג הפקודה/],
    ['journal_amount: an amount of money (agorot)', /עד אגורות/],
    ['journal_vat_side: VAT on sales or on inputs', /מע״מ עסקאות או מע״מ תשומות/],
    ['journal_vat: an exempt dealer records no VAT', /עוסק פטור/],
    ['journal_vat: a VAT entry is VAT only', /רק סכום מע״מ/],
    ['journal_vat: an "other" entry carries no VAT', /"אחר" — בלי מע״מ/],
    ['journal_category: a kind of expense', /סוג ההוצאה/],
    ['journal_explanation: an explanation, 2 to 500 letters', /הסבר — חובה/],
    ['journal_party: a dealer number is 9 digits', /9 ספרות/],
    ['journal_party: a customer card of the business', /לא נמצא ברשימת הלקוחות/],
    ['journal_party: a name or a dealer number', /שם או מספר עוסק/],
    ['journal_party: a customer on income, a supplier on an expense, either on "other" — none on VAT', /הכנסה שייכת ללקוח/],
    ['journal_location: an active location of the business', /סניף פעיל/],
    ['journal_entry: the entry was not found in this business', /לא נמצאה בעסק/],
    ['journal_reversed: the entry was already reversed', /כבר בוטלה/],
    ['journal_reverse: a reversing entry is not reversed — record a new entry instead', /רושמים פקודה חדשה/],
    ['period_locked: the books are closed until 2026-09-30', /הספרים סגורים/],
  ];
  for (const [message, hebrew] of said) assert.match(financeError({ message }), hebrew, message);
  const line = auditLine(toAuditRow({ id: 1, action: 'journal.created', entity: 'journal_entries', entity_id: 'x', actor_kind: 'member',
    details: { number: 3, amount: 250, explanation: 'הפרשה לחופשה' }, at: '2026-10-11T10:00:00Z' }));
  assert.match(line, /נרשמה פקודה ידנית/); assert.match(line, /מס׳ 3/); assert.match(line, /₪250/); assert.match(line, /הפרשה לחופשה/);
  assert.match(auditLine(toAuditRow({ id: 2, action: 'journal.reversed', entity: '', entity_id: '', actor_kind: 'member', details: { number: 4 }, at: '2026-10-11T10:00:00Z' })), /נרשמה פקודה הפוכה/);
});
