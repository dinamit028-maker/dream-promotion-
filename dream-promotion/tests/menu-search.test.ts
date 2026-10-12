/**
 * The search in the menu and the favorites (2.96, docs/FINANCE_ADDITIONS_HE.md T11): Hebrew read loosely, what is found for what
 * people type ("גבייה" → חייבים), which screens are there for whom, and the favorites kept with the person — only addresses of the
 * app, at most 12, and only those the person sees now.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEEP_LINKS, KEYWORDS, appEntries, dedupe, moduleEntries, normalizeHe, searchMenu, type MenuEntry } from '../src/components/shell/menu-search';
import { MAX_FAVORITES, favoriteEntries, parseFavorites, toggleFavorite } from '../src/components/shell/favorites';
import { NAV, NAV_BOTTOM_ALL } from '../src/components/shell/app-nav';
import { FINANCE_MODULE } from '../src/features/finance/module';
import { STORE_MODULE } from '../src/features/store/module';

const hrefs = (l: MenuEntry[]) => l.map((e) => e.href);

test('Hebrew read loosely: no points, no geresh or gershayim, final letters as any letter', () => {
  assert.equal(normalizeHe('מע״מ'), 'מעמ');
  assert.equal(normalizeHe('מע"מ'), 'מעמ');
  assert.equal(normalizeHe('רו״ח'), 'רוח');
  assert.equal(normalizeHe('צ׳קים'), 'צקימ');
  assert.equal(normalizeHe('חשבון'), 'חשבונ', 'a final letter is the letter');
  assert.equal(normalizeHe('שָׁלוֹם'), 'שלומ', 'no points');
  assert.equal(normalizeHe('  דוחות — רווח/הפסד  '), 'דוחות רווח הפסד');
  assert.equal(normalizeHe('CRM'), 'crm');
});

test('what people type finds the screen — "גבייה" goes straight to the receivables', () => {
  const all = appEntries({ journal: true, cash: true });
  const first = (q: string) => searchMenu(all, q)[0]?.href;
  assert.equal(first('גבייה'), '/finance/receivables', 'the document\'s own example');
  assert.equal(first('חייבים'), '/finance/receivables');
  assert.equal(first('מעמ'), '/finance/reports');
  assert.equal(first('רוח'), '/finance/accountant');
  assert.equal(first('חשבון'), '/finance/accountant', '"רואה חשבון" by a word of its name');
  assert.equal(first('חשבונית מס'), '/finance/documents');
  assert.equal(first('כרטסת ספק'), '/finance/reports?view=sledger', 'two words, a report inside');
  assert.equal(first('יומן'), '/calendar', 'its own name first');
  assert.ok(hrefs(searchMenu(all, 'יומן')).includes('/finance/journal'));
  assert.equal(first('פקודה ידנית'), '/finance/journal');
  assert.equal(first('הפקדה'), '/finance/cash');
  assert.equal(first('תור'), '/appointments');
  assert.equal(first('קוד הנחה'), '/store/coupons');
  assert.equal(first('crm'), '/leads');
  assert.deepEqual(searchMenu(all, 'שוקולד'), [], 'nothing like it');
  assert.deepEqual(searchMenu(all, '  '), []);
  assert.ok(searchMenu(all, 'ח').length <= 8, 'a few at a time');
  assert.equal(new Set(hrefs(searchMenu(all, 'כרטסת'))).size, searchMenu(all, 'כרטסת').length, 'each screen once');
});

test('the screens there are: the app\'s, כספים\'s and חנות\'s — each once, and only what the person may open', () => {
  const base = appEntries();
  const h = new Set(hrefs(base));
  for (const n of [...NAV, ...NAV_BOTTOM_ALL]) assert.ok(h.has(n.href), n.href);
  for (const g of [...FINANCE_MODULE.groups, ...STORE_MODULE.groups]) for (const l of g.links) assert.ok(h.has(l.href), l.href);
  for (const d of DEEP_LINKS) assert.ok(h.has(d.href), d.href);
  assert.equal(h.size, base.length, 'none twice');
  assert.ok(!h.has('/stock') && !h.has('/admin') && !h.has('/finance/journal') && !h.has('/finance/cash'), 'by default: none of the conditional screens');
  const more = new Set(hrefs(appEntries({ multi: true, admin: true, journal: true, cash: true })));
  for (const x of ['/stock', '/admin', '/finance/journal', '/finance/cash', '/finance/bank']) assert.ok(more.has(x), x);
  assert.equal(base.find((e) => e.href === '/finance/receivables')?.where, 'כספים');
  assert.equal(base.find((e) => e.href === '/leads')?.where, '');
  assert.deepEqual(base.find((e) => e.href === '/finance/receivables')?.keywords, KEYWORDS['/finance/receivables']);
  // a module's own menu: a group of one link is that link under the group's name
  const fin = moduleEntries('כספים', FINANCE_MODULE.groups);
  assert.equal(fin.find((e) => e.href === '/finance/expenses')?.label, 'הוצאות');
  assert.equal(fin.find((e) => e.href === '/finance')?.label, 'לובי כספים');
  assert.equal(dedupe([...fin, ...base]).find((e) => e.href === '/finance')?.label, 'לובי כספים', 'inside the module, its own name wins');
  for (const k of Object.keys(KEYWORDS)) assert.ok(k.startsWith('/') && !k.includes('?'), k);
});

test('favorites: addresses of the app only, once each, at most 12, in the order starred — and only screens shown now', () => {
  assert.deepEqual(parseFavorites(['/finance/receivables', '/leads', '/finance/receivables', 'https://evil.test', '//evil.test', 'javascript:alert(1)', 7, '/Finance', '/a b']),
    ['/finance/receivables', '/leads']);
  assert.deepEqual(parseFavorites('/leads'), []);
  assert.deepEqual(parseFavorites(null), []);
  assert.equal(parseFavorites(Array.from({ length: 20 }, (_, i) => `/x${i}`)).length, MAX_FAVORITES);
  assert.deepEqual(parseFavorites(['/finance/reports?view=customers']), ['/finance/reports?view=customers']);
  let r = toggleFavorite([], '/leads');
  assert.deepEqual(r, { list: ['/leads'], full: false });
  r = toggleFavorite(r.list, '/finance/receivables');
  assert.deepEqual(r.list, ['/leads', '/finance/receivables']);
  assert.deepEqual(toggleFavorite(r.list, '/leads').list, ['/finance/receivables'], 'off');
  const full = Array.from({ length: MAX_FAVORITES }, (_, i) => `/x${i}`);
  assert.deepEqual(toggleFavorite(full, '/leads'), { list: full, full: true }, 'a full list stays');
  assert.deepEqual(toggleFavorite(full, '/x3').list.length, MAX_FAVORITES - 1, 'a full list still lets one go');
  assert.deepEqual(toggleFavorite([], 'https://evil.test'), { list: [], full: false });
  const shown = favoriteEntries(['/finance/journal', '/leads', '/stock', '/finance/receivables'], appEntries());
  assert.deepEqual(hrefs(shown), ['/leads', '/finance/receivables'], 'a screen this business does not have (yet) stays hidden');
});
