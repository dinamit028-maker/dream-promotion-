/**
 * 2.122 — stage 4ג (migration 20261129007200; the owner's answers 15, 17 of 27.11.2026): what the existing screens change from the
 * books' start — the bank's line of the books' time goes to an account (bank_line_classify), the one-sided journal closes — and
 * the Hebrew of 7200's refusals. Pure functions; the screens are clicked through in tests/e2e/cash-bank.e2e.ts and journal.e2e.ts.
 * Demo data only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { israelParts } from '../src/lib/il-time';
import { accountLabel, bankLineNeedsAccount, classifyChoices, classifyProblem, journalClosed, startMoveExplain, toGlAccounts } from '../src/features/finance/books';
import { JOURNAL_BOOKS_CLOSED, financeError } from '../src/features/finance/rows';

const START = '2026-12-01';

test('a bank line needs an account from the books\' start (gl_books_active: line_date >= start) — never before 7200', () => {
  assert.equal(bankLineNeedsAccount('2026-12-01', START), true, 'the start day itself');
  assert.equal(bankLineNeedsAccount('2026-12-31', START), true);
  assert.equal(bankLineNeedsAccount('2026-11-30', START), false, 'the day before — "טופל בלי התאמה" as before');
  assert.equal(bankLineNeedsAccount('2026-12-01', null), false, 'before 7200 (no books state) — as before');
  assert.equal(bankLineNeedsAccount('', START), false);
});

test('the journal closes from the start — Israel time: 00:00–03:00 of the 1st (UTC still the 30th), and the change of month', () => {
  const at = (iso: string) => israelParts(new Date(iso)).date;
  assert.equal(at('2026-11-30T22:30:00Z'), '2026-12-01', '00:30 in Israel on the 1st (winter, +2)');
  assert.equal(journalClosed(at('2026-11-30T22:30:00Z'), START), true, '00:30 on the 1st — closed, though UTC says the 30th');
  assert.equal(journalClosed(at('2026-12-01T00:59:00Z'), START), true, '02:59 on the 1st');
  assert.equal(journalClosed(at('2026-11-30T21:59:00Z'), START), false, '23:59 on the 30th — still open');
  assert.equal(journalClosed('2027-01-01', START), true, 'later months — closed');
  assert.equal(journalClosed('2026-11-27', START), false, 'before the start — as today');
  assert.equal(journalClosed('2026-12-05', null), false, 'before 7200 — as today');
  // a bank line of the 1st that the bank's file dates in Israel time: the 1st is the books'
  assert.equal(bankLineNeedsAccount(at('2026-11-30T22:30:00Z'), START), true);
});

test('the picker: active accounts by key, never the bank; customers / suppliers only by a search', () => {
  const rows = [
    { key: '6112', name: 'עמלות בנק וסליקה', kind: 'expense', role: 'expense:fees', active: true },
    { key: 'BANK', name: 'בנק', kind: 'asset', role: 'bank', active: true },
    { key: '1100', name: 'קופת מזומן — ראשי', kind: 'asset', role: 'cash:x', active: true },
    { key: '050-0000072', name: 'לקוחה דמו', kind: 'asset', role: 'customer:050-0000072', active: true },
    { key: 'S-000000067', name: 'ספק דמו', kind: 'liability', role: 'supplier:000000067', active: true },
    { key: '7000', name: 'חשבון שהבעלים הוסיפו', kind: 'income', role: null, active: true },
    { key: '7001', name: 'לא פעיל', kind: 'income', role: null, active: false },
    { key: '', name: 'בלי מפתח', kind: 'asset', role: null },
    { key: '7002', name: 'סוג לא ידוע', kind: 'other', role: null },
  ];
  const acc = toGlAccounts(rows);
  assert.deepEqual(acc.map((a) => a.key), ['050-0000072', '1100', '6112', '7000', 'BANK', 'S-000000067'], 'active and well-formed, by key');
  assert.deepEqual(classifyChoices(acc).map((a) => a.key), ['1100', '6112', '7000'], 'no bank, no customer / supplier without a search');
  assert.deepEqual(classifyChoices(acc, 'ספק').map((a) => a.key), ['S-000000067'], 'a supplier by name');
  assert.deepEqual(classifyChoices(acc, '050').map((a) => a.key), ['050-0000072'], 'a customer by key');
  assert.deepEqual(classifyChoices(acc, '6').map((a) => a.key), ['6112'], 'one character — the key\'s start, no party accounts');
  assert.deepEqual(classifyChoices(acc, 'בנק').map((a) => a.key), ['6112'], 'the bank itself is never offered');
  assert.equal(classifyChoices(acc, '', 1).length, 1, 'a limit');
  assert.deepEqual(toGlAccounts(null), []);
  assert.equal(accountLabel(acc[2]), '6112 · עמלות בנק וסליקה');
  assert.equal(classifyProblem({ account: '', note: 'עמלה' }), 'בוחרים חשבון');
  assert.match(classifyProblem({ account: 'bank', note: 'עמלה' })!, /הבנק עצמו/);
  assert.match(classifyProblem({ account: '6112', note: 'x' })!, /שתי אותיות/);
  assert.equal(classifyProblem({ account: '6112', note: 'עמלת בנק' }), null);
});

test('7200\'s refusals in Hebrew — before "books_started" and "not allowed"; no key, number or amount in them', () => {
  const he = (message: string, code = '23514') => financeError({ message, code });
  const j = he('journal_books_started: מתאריך תחילת הספרים (2026-12-01) פקודה ידנית נרשמת רק כפקודה כפולה (חובה וזכות)');
  assert.ok(j.startsWith(JOURNAL_BOOKS_CLOSED) && j.includes('01/12/2026'), j);
  assert.match(JOURNAL_BOOKS_CLOSED, /חובה וזכות/);
  assert.notEqual(he('books_started: x'), j, 'the move of the start keeps its own message');
  assert.match(he('bank_line_account_required: שורת בנק מתאריך תחילת הספרים נרשמת לחשבון (bank_line_classify) — לא רק בהערה'), /נרשמת לחשבון בספרים/);
  assert.match(he('bank_class_account: החשבון 6999 לא נמצא בלוח החשבונות (או שאינו פעיל)', '22023'), /לא נמצא בלוח החשבונות/);
  assert.ok(!he('bank_class_account: החשבון 6999 לא נמצא בלוח החשבונות (או שאינו פעיל)', '22023').includes('6999'), 'the key is not repeated');
  assert.match(he('bank_class_account: שורת בנק לא נרשמת לחשבון הבנק עצמו', '22023'), /הבנק עצמו — בוחרים חשבון אחר/);
  assert.match(he('books_not_allowed: רק הבעלים רושמים שורת בנק לחשבון', '42501'), /רק הבעלים של העסק רושמים בספרים/);
  assert.match(he('not allowed: שורה שנרשמה לחשבון נפתחת מחדש רק על ידי הבעלים', '42501'), /רק הבעלים מחזירים אותה לטיפול/);
  assert.equal(he('not allowed', '42501'), 'אין הרשאה לפעולה הזו.', 'a plain refusal — as before');
  for (const m of ['bank_line_account_required: x', 'bank_class_account: x', 'books_not_allowed: x']) assert.ok(!/[0-9]{4}|₪/.test(he(m)), m);
});

test('moving the start: the 1225 warning names the supplier-looking keys too ("S-")', () => {
  const warn = startMoveExplain('2026-06-01', '2026-11-27', '2026-12-01');
  assert.ok(warn.some((x) => /שדה 1225/.test(x) && x.includes('"S-"') && /BANK/.test(x)));
});

test('review 2.122: a customer\'s / a supplier\'s account picked for a bank line warns — a payment is matched instead', async () => {
  const { isPartyAccount, PARTY_ACCOUNT_WARNING } = await import('../src/features/finance/books');
  const acc = toGlAccounts([
    { key: '6112', name: 'עמלות', kind: 'expense', role: 'expense:fees' },
    { key: '050-0000072', name: 'לקוחה דמו', kind: 'asset', role: 'customer:050-0000072' },
    { key: 'S-000000067', name: 'ספק דמו', kind: 'liability', role: 'supplier:000000067' },
  ]);
  assert.equal(PARTY_ACCOUNT_WARNING, 'אם יש תשלום — מתאימים אותו במקום');
  assert.equal(isPartyAccount('6112', acc), false);
  assert.equal(isPartyAccount('050-0000072', acc), true, 'a customer');
  assert.equal(isPartyAccount('S-000000067', acc), true, 'a supplier');
  assert.equal(isPartyAccount('S-999', []), true, 'a typed supplier key (no chart readable)');
  assert.equal(isPartyAccount('', acc), false);
});
