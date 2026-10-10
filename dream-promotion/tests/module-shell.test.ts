/**
 * "כספים" as an app of its own (2.52): every screen has its own address, old links (/finance?tab=…) move to it,
 * the module's menu holds every screen exactly once, and "+" offers only the documents the business may issue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { FINANCE_SECTIONS, financeHref, isFinancePath, legacyFinanceRedirect, sectionOfPath } from '../src/features/finance/routes';
import { FINANCE_MODULE, financeActions } from '../src/features/finance/module';
import { groupOfPath, isActiveLink, toggleGroup } from '../src/components/shell/module-nav';
import { proxy, config as proxyConfig } from '../src/proxy';

test('every finance screen has its own address, and back', () => {
  assert.deepEqual(FINANCE_SECTIONS.map((s) => s.path), [
    '/finance', '/finance/documents', '/finance/income', '/finance/receivables', '/finance/quotes', '/finance/packages',
    '/finance/expenses', '/finance/reports', '/finance/accountant', '/finance/settings',
  ]);
  for (const s of FINANCE_SECTIONS) {
    assert.equal(financeHref(s.id), s.path);
    assert.equal(sectionOfPath(s.path), s.id, s.path);
    assert.equal(sectionOfPath(`${s.path}/`), s.id, 'a trailing slash is the same screen');
  }
  assert.equal(financeHref('documents', { new: '305', lead: 'abc' }), '/finance/documents?new=305&lead=abc');
  assert.equal(sectionOfPath('/finance/nope'), null);
  assert.equal(sectionOfPath('/register'), null);
  assert.ok(isFinancePath('/finance') && isFinancePath('/finance/') && isFinancePath('/finance/quotes'));
  assert.ok(!isFinancePath('/financestuff') && !isFinancePath('/register') && !isFinancePath('/'), 'only the module itself');
});

test('old links (/finance?tab=…) move to the new address, keeping the rest of the query', () => {
  const cases: [string, string | null][] = [
    ['?tab=documents&new=1&lead=L1', '/finance/documents?new=1&lead=L1'],   // the CRM card before 2.52
    ['?tab=quotes&new=1&lead=L1', '/finance/quotes?new=1&lead=L1'],
    ['?tab=documents', '/finance/documents'],
    ['?tab=income', '/finance/income'],
    ['?tab=receivables', '/finance/receivables'],
    ['?tab=quotes', '/finance/quotes'],                                     // the quote push before 2.52
    ['?tab=expenses', '/finance/expenses'],
    ['?tab=reports', '/finance/reports'],
    ['?tab=accountant', '/finance/accountant'],
    ['?tab=settings&tax=connected', '/finance/settings?tax=connected'],    // the Tax Authority's return before 2.52
    ['?tab=settings', '/finance/settings'],
    ['?tab=overview', '/finance'],
    ['?tab=whatever', '/finance'],                                         // unknown → the lobby
    ['', null],                                                             // nothing to move
    ['?new=1', null],
  ];
  for (const [search, to] of cases) assert.equal(legacyFinanceRedirect('/finance', search), to, search);
  assert.equal(legacyFinanceRedirect('/finance/', 'tab=quotes'), '/finance/quotes', 'with or without "?"');
  assert.equal(legacyFinanceRedirect('/finance/documents', '?tab=quotes'), null, 'only /finance itself');
  assert.equal(legacyFinanceRedirect('/register', '?tab=quotes'), null);
  // never a loop: the new address has nothing more to move
  for (const [search] of cases) {
    const to = legacyFinanceRedirect('/finance', search);
    if (to) { const u = new URL(to, 'http://x'); assert.equal(legacyFinanceRedirect(u.pathname, u.search), null, to); }
  }
});

test('the proxy sends an old link on (307) and lets everything else through', () => {
  assert.deepEqual(proxyConfig.matcher, ['/finance']);
  const moved = proxy(new NextRequest('https://app.example/finance?tab=documents&new=305&lead=L9'));
  assert.equal(moved.status, 307);
  assert.equal(moved.headers.get('location'), 'https://app.example/finance/documents?new=305&lead=L9');
  const pass = proxy(new NextRequest('https://app.example/finance'));
  assert.equal(pass.headers.get('location'), null);
  assert.equal(pass.headers.get('x-middleware-next'), '1');
});

test('the module menu: every screen exactly once, in the agreed groups; the bottom bar and the "+"', () => {
  const links = FINANCE_MODULE.groups.flatMap((g) => g.links.map((l) => l.href));
  assert.deepEqual([...links].sort(), FINANCE_SECTIONS.map((s) => s.path).sort(), 'all 10 screens');
  assert.equal(new Set(links).size, links.length, 'none twice');
  assert.deepEqual(FINANCE_MODULE.groups.map((g) => [g.label, g.links.map((l) => l.label)]), [
    ['לובי כספים', ['לובי כספים']],
    ['הכנסות', ['מסמכים', 'הכנסות', 'חייבים', 'הצעות מחיר', 'חבילות']],
    ['הוצאות', ['הוצאות']],
    ['דוחות ורואה חשבון', ['דוחות', 'רואה חשבון']],
    ['הגדרות כספים', ['הגדרות כספים']],
  ]);
  assert.deepEqual(FINANCE_MODULE.tabs.map((t) => [t.label, t.href]), [
    ['לובי', '/finance'], ['הכנסות', '/finance/income'], ['הוצאות', '/finance/expenses'], ['חייבים', '/finance/receivables'],
  ]);
  assert.equal(FINANCE_MODULE.theme, 'module-finance');
  assert.equal(FINANCE_MODULE.home, '/finance');
});

test('"+" offers what the business may issue — a VAT business and an exempt dealer', () => {
  assert.deepEqual(financeActions('company').map((a) => [a.label, a.href]), [
    ['חשבונית מס', '/finance/documents?new=305'],
    ['חשבונית מס / קבלה', '/finance/documents?new=320'],
    ['קבלה', '/finance/receivables?receipt=1'],   // a VAT business: on the invoice that was paid (no stand-alone 400 in the composer)
    ['הצעת מחיר', '/finance/quotes?new=1'],
    ['הוצאה', '/finance/expenses?new=1'],
  ]);
  assert.match(financeActions('company').find((a) => a.id === 'doc-400')!.hint ?? '', /חייבים/, 'and it says where it goes');
  assert.deepEqual(financeActions('exempt_dealer').map((a) => [a.label, a.href]), [
    ['חשבונית עסקה', '/finance/documents?new=300'],
    ['קבלה', '/finance/documents?new=400'],          // an exempt dealer: the receipt form itself
    ['הצעת מחיר', '/finance/quotes?new=1'],
    ['הוצאה', '/finance/expenses?new=1'],
  ]);
  assert.ok(!financeActions('nonprofit').some((a) => /new=(305|320)/.test(a.href)), 'no tax invoice from a non-profit');
  assert.deepEqual(FINANCE_MODULE.actions.map((a) => a.id), financeActions('licensed_dealer').map((a) => a.id), 'before the settings load: the usual list');
});

test('the menu marks the screen on screen and opens one group at a time', () => {
  assert.ok(isActiveLink('/finance/quotes', '/finance/quotes?new=1'), 'the query of a link does not matter');
  assert.ok(isActiveLink('/finance/quotes/', '/finance/quotes'));
  assert.ok(!isActiveLink('/finance/quotes', '/finance'), 'the lobby is not every page');
  assert.equal(groupOfPath(FINANCE_MODULE.groups, '/finance/receivables'), 'income');
  assert.equal(groupOfPath(FINANCE_MODULE.groups, '/finance/packages'), 'income', 'packages are income (2.87)');
  assert.equal(groupOfPath(FINANCE_MODULE.groups, '/finance/accountant'), 'reports');
  assert.equal(groupOfPath(FINANCE_MODULE.groups, '/finance'), 'lobby');
  assert.equal(groupOfPath(FINANCE_MODULE.groups, '/dashboard'), null);
  assert.equal(toggleGroup(null, 'income'), 'income');
  assert.equal(toggleGroup('income', 'reports'), 'reports', 'opening one closes the other');
  assert.equal(toggleGroup('reports', 'reports'), null, 'tapping the open one closes it');
});
