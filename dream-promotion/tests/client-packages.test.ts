/**
 * Packages and series of treatments paid in advance (docs/FINANCE ADDITIONS HE.md, T1): the pure rules the finance screen, the
 * client card and the product editor share — validity, what is left and the warnings, which package is offered for a session,
 * the document of a sale (the existing engine, the income once), the cancellation's suggestion (agorot-exact; the owner
 * approves), the report, the catalog's package terms, and the database's refusals in Hebrew. The database side (one deduction
 * per session, never beyond the package, the link of the document, privacy) is tested on a real Postgres:
 * tests/sql/client-packages.check.sql and tests/sql/concurrency.sh §13.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGES_MIGRATION, addMonths, cancelSuggestion, daysUntil, deductibleFor, packageDocLine, packageDocType, packageError, packageKey, packageLine,
  packageState, packageWarnings, packagesCsv, packagesFor, packagesReport, saleProblems, sessionsLabel, termsText, toCatalogPackage, toClientPackage,
  usedValueA, validUntilOf, type ClientPackage,
} from '../src/features/finance/packages';
import { composeDocument, docInvariants } from '../src/features/finance/compose';
import { financeError } from '../src/features/finance/rows';
import {
  MIGRATION_4200, catalogError, changedColumns, draftError, draftOf, emptyDraft, itemColumns, itemColumnsOf, toCatalogItem,
} from '../src/features/catalog/catalog';
import { activeUseOf, givenCount, sessionAt, sessionsOf, toSession } from '../src/features/client-file/sessions';
import { israelParts } from '../src/lib/il-time';
import { saveErrorReason } from '../src/lib/save-status';
import { financeHref, sectionOfPath } from '../src/features/finance/routes';

const TODAY = '2026-10-10';
const pk = (p: Partial<ClientPackage> = {}): ClientPackage => ({
  id: 'p1', leadId: 'l1', customerName: 'נועה', itemId: 'i1', name: '6 טיפולי לייזר', typeId: 'laser', sessionsTotal: 6, price: 1200,
  soldOn: TODAY, validUntil: '2027-04-10', notes: '', status: 'active', documentId: 'd1', cancelledAt: null, cancelReason: '', createdAt: '2026-10-10T08:00:00Z',
  used: 0, returned: 0, remaining: 6, lastUsedAt: null, docType: 305, docNumber: 12, docTotal: 1200, docDate: TODAY, docCancelled: false, paid: 0, credited: 0,
  ...p,
});
const used = (n: number, p: Partial<ClientPackage> = {}) => pk({ used: n, remaining: 6 - n, ...p });

test('validity: the same day n calendar months later; a short month ends on its last day; none = no expiry', () => {
  assert.equal(addMonths('2026-10-10', 6), '2027-04-10');
  assert.equal(addMonths('2026-08-31', 6), '2027-02-28');
  assert.equal(addMonths('2027-08-31', 6), '2028-02-29', 'a leap year');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-12-15', 12), '2027-12-15');
  assert.equal(validUntilOf(TODAY, 6), '2027-04-10');
  assert.equal(validUntilOf(TODAY, null), null);
  assert.equal(daysUntil('2026-10-15', TODAY), 5);
  assert.equal(daysUntil(TODAY, TODAY), 0);
  assert.equal(daysUntil('2026-10-01', TODAY), -9);
  assert.equal(daysUntil('2027-03-28', '2027-03-25'), 3, 'across the change to summer time');
});

test('the card: "נותרו 4 מתוך 6 · בתוקף עד…", and a warning when one is left or the validity is about to end', () => {
  assert.equal(packageLine(used(2), TODAY), 'נותרו 4 מתוך 6 · בתוקף עד 10/04/2027');
  assert.equal(packageLine(used(5), TODAY), 'נותר 1 מתוך 6 · בתוקף עד 10/04/2027');
  assert.equal(packageLine(used(6), TODAY), 'נוצלו כל 6 הטיפולים · בתוקף עד 10/04/2027');
  assert.equal(packageLine(pk({ validUntil: null }), TODAY), 'נותרו 6 מתוך 6 · בלי הגבלת תוקף');
  assert.equal(packageLine(pk({ validUntil: '2026-10-01' }), TODAY), 'נותרו 6 מתוך 6 · פג תוקף ב-01/10/2026');
  assert.equal(packageLine(pk({ status: 'cancelled' }), TODAY), 'בוטלה · נותרו 6 מתוך 6');
  assert.equal(packageLine(pk({ sessionsTotal: 1, used: 1, remaining: 0 }), TODAY), 'הטיפול נוצל · בתוקף עד 10/04/2027');

  assert.deepEqual(packageWarnings(used(2), TODAY), []);
  assert.deepEqual(packageWarnings(used(5), TODAY).map((w) => w.text), ['נותר טיפול אחד']);
  assert.deepEqual(packageWarnings(pk({ validUntil: '2026-10-15' }), TODAY).map((w) => w.text), ['התוקף מסתיים בעוד 5 ימים']);
  assert.deepEqual(packageWarnings(pk({ validUntil: TODAY }), TODAY).map((w) => w.text), ['התוקף מסתיים היום']);
  assert.deepEqual(packageWarnings(pk({ validUntil: '2026-10-11' }), TODAY).map((w) => w.text), ['התוקף מסתיים מחר']);
  assert.equal(packageWarnings(pk({ validUntil: '2026-10-24' }), TODAY).length, 1, '14 days: about to end');
  assert.equal(packageWarnings(pk({ validUntil: '2026-10-25' }), TODAY).length, 0, '15 days: not yet');
  assert.deepEqual(packageWarnings(used(5, { validUntil: '2026-10-12' }), TODAY).map((w) => w.kind), ['last_one', 'expiring'], 'both at once');
  assert.deepEqual(packageWarnings(used(4, { validUntil: '2026-10-01' }), TODAY).map((w) => w.text), ['התוקף פג ב-01/10/2026, ונשארו 2 טיפולים']);
  assert.deepEqual(packageWarnings(used(6), TODAY), [], 'used up: nothing to warn about');
  assert.deepEqual(packageWarnings(pk({ status: 'cancelled', validUntil: '2026-10-11' }), TODAY), [], 'cancelled: nothing to warn about');

  assert.equal(packageState(used(2), TODAY), 'active');
  assert.equal(packageState(used(6, { validUntil: '2026-10-01' }), TODAY), 'used_up', 'used up before it expired');
  assert.equal(packageState(used(2, { validUntil: '2026-10-09' }), TODAY), 'expired');
  assert.equal(packageState(used(2, { validUntil: TODAY }), TODAY), 'active', 'valid through its last day');
  assert.equal(packageState(used(6, { status: 'cancelled' }), TODAY), 'cancelled');
});

test('a session is offered the right package: its type first, then any treatment; valid, active, treatments left', () => {
  const laser = pk({ id: 'laser', typeId: 'laser', validUntil: '2027-04-10', createdAt: '2026-09-01T00:00:00Z' });
  const laserSoon = pk({ id: 'laser-soon', typeId: 'laser', validUntil: '2026-11-01', createdAt: '2026-10-01T00:00:00Z' });
  const any = pk({ id: 'any', typeId: null, validUntil: null });
  const firm = pk({ id: 'firm', typeId: 'firming' });
  const expired = pk({ id: 'expired', typeId: 'laser', validUntil: '2026-10-01' });
  const empty = used(6, { id: 'empty', typeId: 'laser' });
  const cancelled = pk({ id: 'cancelled', typeId: 'laser', status: 'cancelled' });
  const list = [laser, any, firm, expired, empty, cancelled, laserSoon];
  assert.deepEqual(packagesFor(list, 'laser', TODAY).map((p) => p.id), ['laser-soon', 'laser', 'any'], 'the one that ends first is offered first');
  assert.deepEqual(packagesFor(list, 'firming', TODAY).map((p) => p.id), ['firm', 'any']);
  assert.deepEqual(packagesFor(list, null, TODAY).map((p) => p.id), ['laser-soon', 'laser', 'firm', 'any'], 'a treatment without a type: any fitting package');
  assert.deepEqual(packagesFor(list, 'laser', '2026-11-02').map((p) => p.id), ['laser', 'any'], 'valid on the session’s day');
  assert.deepEqual(deductibleFor(list, 'laser').map((p) => p.id).sort(), ['any', 'expired', 'laser', 'laser-soon'],
    'what may be picked on purpose: an expired one too, never one used up, cancelled or of another type');
});

test('a sale’s document: the existing engine, one line at the price — the income once, VAT inside', () => {
  assert.equal(packageDocType(true, true), 320);
  assert.equal(packageDocType(true, false), 305);
  assert.equal(packageDocType(false, true), 400);
  assert.equal(packageDocType(false, false), 300);
  assert.equal(packageKey('abc'), 'package:abc');
  assert.equal(sessionsLabel(6), '6 טיפולים');
  assert.equal(sessionsLabel(1), 'טיפול אחד');
  const line = packageDocLine(' 6 טיפולי לייזר ', 6, 1200, 'item-1');
  assert.deepEqual(line, { name: '6 טיפולי לייזר — 6 טיפולים', qty: 1, unitPrice: 1200, itemId: 'item-1' });
  const base = { entity: 'company' as const, vatRate: 18, pricesIncludeVat: true, lines: [line], customer: { name: 'נועה' }, docDate: TODAY, today: TODAY };
  // later, in two payments: a tax invoice of the whole price — its receipts are money, not income again
  const inv = composeDocument({ ...base, docType: 305, dueDate: '2026-11-09' });
  assert.ok(inv.ok);
  if (inv.ok) {
    assert.deepEqual([inv.doc.total, inv.doc.afterDiscount, inv.doc.vatAmount], [1200, 1016.95, 183.05]);
    assert.deepEqual(docInvariants(inv.doc, 18), [], 'what the database checks on insert');
    assert.equal(inv.doc.lines.length, 1);
    assert.equal(inv.doc.lines[0].itemId, 'item-1', 'the line keeps its catalog item');
  }
  // paid now, in two payments at once
  const now = composeDocument({ ...base, docType: 320, payments: [{ method: 'cash', amount: 600, date: TODAY }, { method: 'card', amount: 600, date: TODAY }] });
  assert.ok(now.ok && docInvariants(now.doc, 18).length === 0 && now.doc.payments.length === 2);
  // an exempt dealer: a receipt, no VAT
  const ex = composeDocument({ ...base, entity: 'exempt_dealer', docType: 400, payments: [{ method: 'bit', amount: 1200, date: TODAY }] });
  assert.ok(ex.ok && ex.doc.vatAmount === 0 && ex.doc.total === 1200);
  // the document's total is the package's price exactly — the database links it only so
  for (const price of [0.1, 99.99, 333.33, 1234.56]) {
    const r = composeDocument({ ...base, docType: 305, lines: [packageDocLine('x', 3, price)] });
    assert.ok(r.ok && r.doc.total === price, `total = price (${price})`);
  }
});

test('before a sale: who, which package, a price, a validity that did not pass', () => {
  const ok = { leadId: 'l1', pkg: { sessions: 6 }, price: '1,200', validUntil: '2027-04-10', today: TODAY };
  assert.deepEqual(saleProblems(ok), []);
  assert.match(saleProblems({ ...ok, leadId: null }).join(), /לקוח/);
  assert.match(saleProblems({ ...ok, pkg: null }).join(), /בחרו חבילה/);
  assert.match(saleProblems({ ...ok, pkg: { sessions: null } }).join(), /מספר טיפולים/);
  assert.match(saleProblems({ ...ok, price: '-5' }).join(), /המחיר/);
  assert.match(saleProblems({ ...ok, price: '12.345' }).join(), /המחיר/);
  assert.deepEqual(saleProblems({ ...ok, price: '0' }), [], 'a package without a price (no document)');
  assert.match(saleProblems({ ...ok, validUntil: '2026-10-09' }).join(), /התוקף/);
  assert.deepEqual(saleProblems({ ...ok, validUntil: '' }), [], 'no expiry');
});

test('cancelling (the Definition of Done’s package: ₪1,200, 6 treatments, 2 used): the system suggests, in agorot', () => {
  assert.equal(usedValueA(used(2)), 40000);
  assert.equal(usedValueA(pk({ price: 1000, sessionsTotal: 3, used: 1, remaining: 2 })), 33333, '₪333.33 — rounded once');
  // a tax invoice paid in two payments: credit what was not used, give back what was paid beyond it
  let c = cancelSuggestion(used(2, { paid: 1200 }));
  assert.deepEqual([c.route, c.usedValue, c.unusedValue, c.credit, c.maxCredit, c.refund, c.owed], ['credit', 400, 800, 800, 1200, 800, 0]);
  c = cancelSuggestion(used(2, { paid: 600 }));
  assert.deepEqual([c.credit, c.refund, c.owed], [800, 200, 0], 'half paid: ₪200 back');
  c = cancelSuggestion(used(2, { paid: 0 }));
  assert.deepEqual([c.credit, c.refund, c.owed], [800, 0, 400], 'nothing paid: the 2 treatments are still owed');
  c = cancelSuggestion(used(2, { docType: 320, paid: 1200 }));
  assert.deepEqual([c.route, c.credit, c.refund], ['credit', 800, 800], 'a tax invoice-receipt the same way');
  // the owner changes the amount: the money back follows
  c = cancelSuggestion(used(2, { paid: 1200 }), 500);
  assert.deepEqual([c.credit, c.refund, c.owed], [500, 500, 0]);
  c = cancelSuggestion(used(2, { paid: 1200 }), 5000);
  assert.equal(c.credit, 1200, 'never beyond what is left to credit');
  c = cancelSuggestion(used(2, { paid: 1000, credited: 200 }));
  assert.deepEqual([c.maxCredit, c.credit, c.refund], [1000, 600, 600], 'credited before: the credit leaves the value used (₪400) charged; ₪1,000 paid − ₪400 = ₪600 back');
  c = cancelSuggestion(used(2, { paid: 300, credited: 900 }));
  assert.deepEqual([c.maxCredit, c.credit, c.refund, c.owed], [300, 0, 0, 0], 'credited beyond the unused part before: nothing more to credit');
  // a receipt / transaction invoice with nothing used: the existing cancellation
  c = cancelSuggestion(pk({ docType: 400, paid: 1200 }));
  assert.deepEqual([c.route, c.refund], ['cancel_document', 1200]);
  c = cancelSuggestion(pk({ docType: 300, paid: 0 }));
  assert.deepEqual([c.route, c.refund, c.owed], ['cancel_document', 0, 0]);
  c = cancelSuggestion(pk({ docType: 300, paid: 200 }));
  assert.equal(c.route, 'none', 'a paid transaction invoice is not cancelled');
  c = cancelSuggestion(used(2, { docType: 400, paid: 1200 }));
  assert.deepEqual([c.route, c.refund], ['none', 800], 'an exempt dealer with treatments used: no credit invoice — the number is information');
  assert.match(c.note, /עוסק פטור/);
  c = cancelSuggestion(pk({ price: 0, documentId: null, docType: null, docTotal: null }));
  assert.equal(c.route, 'no_document');
  c = cancelSuggestion(pk({ documentId: null, docType: null, docTotal: null }));
  assert.deepEqual([c.route, c.refund], ['no_document', 0]);
  assert.match(c.note, /לא הופק מסמך/);
  c = cancelSuggestion(pk({ docType: 400, docCancelled: true, paid: 0 }));
  assert.deepEqual([c.route, c.refund], ['no_document', 0], 'its document was already cancelled');
});

test('the report: open packages, treatments left, paid in advance and not used — information, not accounting', () => {
  const list = [
    used(2, { id: 'a', paid: 1200 }),                                   // 4 left (₪800), paid 1200 − used 400 = 800 in advance
    used(1, { id: 'b', price: 600, docTotal: 600, paid: 0 }),           // 5 left (₪500), nothing paid: 600 to collect
    used(3, { id: 'c', validUntil: '2026-10-01', paid: 1200 }),         // expired with 3 left (₪600)
    used(6, { id: 'd', paid: 1200 }),                                   // used up
    used(1, { id: 'e', status: 'cancelled', paid: 0 }),                 // cancelled
    pk({ id: 'f', price: 0, documentId: null, docType: null, docTotal: null }),   // a gift: 6 left, worth nothing
  ];
  const r = packagesReport(list, TODAY);
  assert.deepEqual(r, { open: 3, remainingSessions: 15, remainingValue: 1300, prepaidUnused: 800, owed: 600, expired: 1, expiredSessions: 3, expiredValue: 600 });
  assert.deepEqual(packagesReport([], TODAY).open, 0);
  const csv = packagesCsv(list.slice(0, 1), TODAY);
  assert.ok(csv.startsWith('﻿'), 'Excel reads Hebrew');
  assert.match(csv, /"נועה","6 טיפולי לייזר","6","2","4","1200.00","1200.00","0.00","חשבונית מס 12","10\/10\/2026","10\/04\/2027","פעילה"/);
});

test('rows of the database → the screens (lenient)', () => {
  const p = toClientPackage({ id: 'p', lead_id: 'l', name: 'x', sessions_total: '6', price: '1200.00', sold_on: TODAY, status: 'active', used: 2, returned: '1',
    paid: '600.00', credited: null, doc_type: 305, doc_number: '12', doc_total: '1200.00', doc_cancelled: false, created_at: 't' });
  assert.deepEqual([p.sessionsTotal, p.price, p.used, p.returned, p.remaining, p.paid, p.credited, p.docNumber], [6, 1200, 2, 1, 4, 600, 0, 12]);
  assert.equal(toClientPackage({ id: 'p', lead_id: 'l', status: 'weird', sessions_total: 3 }).status, 'active');
  const c = toCatalogPackage({ id: 'i', name: 'n', price: '300', package_sessions: '4', package_type_id: null, package_valid_months: null, active: true });
  assert.deepEqual([c.sessions, c.typeId, c.validMonths, c.price], [4, null, null, 300]);
  assert.equal(termsText(c), '4 טיפולים · כל טיפול · בלי הגבלת תוקף');
  assert.equal(termsText({ sessions: 6, typeId: 't', validMonths: 1 }, 'לייזר'), '6 טיפולים · לייזר · חודש');
  assert.equal(termsText({ sessions: null, typeId: null, validMonths: 6 }), 'בלי מספר טיפולים · כל טיפול · 6 חודשים');
});

test('the catalog: a package’s terms on its item — optional, checked when set, written only when the database has them', () => {
  const ok = emptyDraft({ name: '6 טיפולי לייזר', price: '1200', kind: 'package', packageSessions: '6', packageValidMonths: '6' });
  assert.equal(draftError(ok), null);
  assert.equal(draftError({ ...ok, packageSessions: '', packageValidMonths: '' }), null, 'a package of the register without terms still saves');
  assert.match(draftError({ ...ok, packageSessions: '0' })!, /מספר הטיפולים/);
  assert.match(draftError({ ...ok, packageSessions: '501' })!, /מספר הטיפולים/);
  assert.match(draftError({ ...ok, packageValidMonths: '121' })!, /תוקף/);
  assert.match(draftError({ ...ok, packageSessions: '', packageTypeId: 'laser' })!, /כמה טיפולים/);
  assert.equal(draftError({ ...ok, kind: 'service', packageSessions: '0' }), null, 'only a package has terms');
  // written only for a package, only when the database has migration 4200
  assert.deepEqual(Object.keys(itemColumns(ok, [])).filter((k) => k.startsWith('package_')), [], 'without the migration: as before');
  const cols = itemColumns({ ...ok, packageTypeId: 'laser' }, [], { packages: true });
  assert.deepEqual([cols.package_sessions, cols.package_type_id, cols.package_valid_months], [6, 'laser', 6]);
  assert.deepEqual(Object.keys(itemColumns({ ...ok, kind: 'service' }, [], { packages: true })).filter((k) => k.startsWith('package_')), []);
  assert.equal(itemColumns({ ...ok, packageValidMonths: '' }, [], { packages: true }).package_valid_months, null, 'empty = no expiry');
  // an item from the database: the terms back, and only what changed is written
  const item = toCatalogItem({ id: 'i', name: '6 טיפולי לייזר', price: 1200, kind: 'package', active: true, package_sessions: 6, package_type_id: null, package_valid_months: 6 });
  assert.deepEqual([item.packageSessions, item.packageTypeId, item.packageValidMonths], [6, null, 6]);
  assert.deepEqual(changedColumns(itemColumns(draftOf(item), [], { packages: true }), itemColumnsOf(item, { packages: true })), {}, 'nothing changed');
  assert.deepEqual(changedColumns(itemColumns({ ...draftOf(item), packageSessions: '8' }, [], { packages: true }), itemColumnsOf(item, { packages: true })), { package_sessions: 8 });
  const before = toCatalogItem({ id: 'i', name: 'x', price: 1, kind: 'package', active: true });
  assert.deepEqual([before.packageSessions, before.packageTypeId, before.packageValidMonths], [null, null, null], 'a row from before 4200');
  assert.equal(catalogError({ message: 'column catalog_items.package_sessions does not exist', code: '42703' }), MIGRATION_4200);
  assert.match(catalogError({ message: 'new row for relation "catalog_items" violates check constraint "catalog_items_package_check"' })!, /מספר טיפולים/);
});

test('sessions: the day picked → the moment; a deduction that still counts; newest first', () => {
  const now = Date.parse('2026-10-10T09:30:00Z');
  assert.equal(sessionAt(TODAY, now), new Date(now).toISOString(), 'today: now');
  const past = sessionAt('2026-10-03', now);
  assert.deepEqual([israelParts(new Date(past)).date, israelParts(new Date(past)).time], ['2026-10-03', '12:00'], 'an earlier day: noon in Israel');
  assert.equal(sessionAt('2026-10-20', now), new Date(now).toISOString(), 'never in the future');
  assert.equal(sessionAt('nope', now), new Date(now).toISOString());
  const s = [toSession({ id: 's1', treatment_id: 't', lead_id: 'l', at: '2026-10-01T10:00:00Z' }), toSession({ id: 's2', treatment_id: 't', lead_id: 'l', at: '2026-10-05T10:00:00Z', cancelled_at: 'x' }),
    toSession({ id: 's3', treatment_id: 'u', lead_id: 'l', at: '2026-10-07T10:00:00Z' })];
  assert.deepEqual(sessionsOf(s, 't').map((x) => x.id), ['s2', 's1']);
  assert.equal(givenCount(s, 't'), 1, 'a cancelled session is not counted');
  const uses = [{ sessionId: 's1', returnedAt: '2026-10-02', id: 'u1' }, { sessionId: 's1', returnedAt: null, id: 'u2' }];
  assert.equal(activeUseOf('s1', uses)?.id, 'u2', 'the one that was not given back');
  assert.equal(activeUseOf('s3', uses), null);
});

test('the database’s refusals, in Hebrew — a missing migration is named', () => {
  assert.equal(packageError({ message: 'relation "public.client_package_status" does not exist', code: '42P01' }), PACKAGES_MIGRATION);
  assert.equal(packageError({ message: 'Could not find the function public.client_session_add', code: 'PGRST202' }), PACKAGES_MIGRATION);
  assert.equal(packageError({ message: 'column client_sessions.cancelled_at does not exist', code: '42703' }), PACKAGES_MIGRATION);
  const cases: [string, RegExp][] = [
    ['session_deducted: this session was already deducted', /כבר נוכה/],
    ['duplicate key value violates unique constraint "client_package_uses_session_uq"', /כבר נוכה/],
    ['package_used_up: no treatments are left in this package', /לא נשארו טיפולים/],
    ['package_cancelled: a cancelled package is not used', /בוטלה/],
    ['session_cancelled: a cancelled session is not deducted', /הטיפול בוטל/],
    ['package_other_type: the package is for another type of treatment', /סוג טיפול אחר/],
    ['the package was not found for this customer', /לא שייכים/],
    ['session_time: a session that took place (not in the future)', /לא תאריך עתידי/],
    ['package_document: the document is not of this package\'s customer and price', /לא תואם/],
    ['a sold package keeps its terms (cancel it and sell again)', /לא משנה תנאים/],
    ['a reason is required to cancel a package', /סיבה/],
    ['a cancelled package stays cancelled', /לא משתנה/],
    ['update or delete on table "leads" violates foreign key constraint "client_packages_lead_id_business_id_fkey" on table "client_packages"', /חבילה שנמכרה/],
  ];
  for (const [m, re] of cases) assert.match(packageError({ message: m }), re, m);
  assert.match(packageError({ message: 'new row violates row-level security policy', code: '42501' }), /אין הרשאה/, 'the finance module’s own words');
  assert.match(financeError({ message: 'package_document: the document is not of this package\'s customer and price' }), /לא תואם לחבילה/,
    'a refused document of a package, as the document engine reports it');
  assert.match(saveErrorReason({ code: '23503', message: 'update or delete on table "leads" violates foreign key constraint "client_packages_lead_id_business_id_fkey" on table "client_packages"' }),
    /חבילה שנמכרה/, 'deleting a contact with a package says why');
  assert.match(saveErrorReason({ code: '23503', message: 'violates foreign key constraint on table "client_photos"' }), /תיק לקוח/, 'the client file’s message is unchanged');
});

test('the screen’s address: a package opens from the card, a sale from the card', () => {
  assert.equal(financeHref('packages'), '/finance/packages');
  assert.equal(financeHref('packages', { open: 'p1' }), '/finance/packages?open=p1');
  assert.equal(financeHref('packages', { sell: '1', lead: 'l1' }), '/finance/packages?sell=1&lead=l1');
  assert.equal(sectionOfPath('/finance/packages/'), 'packages');
});
