/**
 * The accessibility menu (2.104): the shopper's choices — read back safely from this browser, written only when something was
 * chosen, the classes on <html> — and the boot script that applies them before the first paint by the same rules; every class
 * has its rule in globals.css. And the automatic statement: the business's name and contact, the menu only when it is on,
 * nothing that was not checked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { A11Y_BOOT, A11Y_CLASSES, A11Y_KEY, NO_PREFS, isDefault, prefClasses, readPrefs, writePrefs } from '../../src/lib/a11y';
import { A11Y_MENU_OPTIONS, A11Y_STATEMENT_DATE, a11yStatement } from '../../src/lib/a11y-statement';

const CSS = readFileSync(path.join(__dirname, '../../src/app/globals.css'), 'utf8');

test('the kept choices: read back exactly, anything broken or foreign → nothing chosen', () => {
  assert.deepEqual(readPrefs(null), NO_PREFS);
  assert.deepEqual(readPrefs(''), NO_PREFS);
  assert.deepEqual(readPrefs('not json'), NO_PREFS);
  assert.deepEqual(readPrefs('[1,2]'), NO_PREFS);
  assert.deepEqual(readPrefs('"contrast"'), NO_PREFS);
  assert.deepEqual(readPrefs('{"text":2,"contrast":true,"links":false,"font":true,"still":true,"spacing":true}'),
    { text: 2, contrast: true, links: false, font: true, still: true, spacing: true });
  // only true is on, only 1 / 2 / 3 is a size; an unknown key is ignored
  assert.deepEqual(readPrefs('{"text":4,"contrast":"yes","links":1,"font":null,"still":true,"evil":"<script>"}'), { ...NO_PREFS, still: true });
  assert.deepEqual(readPrefs('{"text":"3"}'), NO_PREFS);
});

test('what is kept: nothing when nothing is chosen; otherwise exactly the choices', () => {
  assert.equal(writePrefs(NO_PREFS), null);
  assert.ok(isDefault(NO_PREFS));
  const p = { ...NO_PREFS, text: 1 as const, links: true };
  assert.ok(!isDefault(p));
  assert.deepEqual(readPrefs(writePrefs(p)), p);
});

test('the classes on <html>: one per choice, the size by its level', () => {
  assert.deepEqual(prefClasses(NO_PREFS), []);
  assert.deepEqual(prefClasses({ text: 3, contrast: true, links: true, font: true, still: true, spacing: true }),
    ['a11y-text-3', 'a11y-contrast', 'a11y-links', 'a11y-font', 'a11y-still', 'a11y-spacing']);
  for (const c of prefClasses({ text: 2, contrast: true, links: true, font: true, still: true, spacing: true })) assert.ok(A11Y_CLASSES.includes(c), c);
});

test('every class of the menu has its rule in globals.css', () => {
  for (const c of A11Y_CLASSES) assert.ok(new RegExp(`html\\.${c}[\\s,:{.)]`).test(CSS), `no rule for ${c}`);
  assert.match(CSS, /\.a11y-fab\s*\{/);
  assert.match(CSS, /\.a11y-panel\[hidden\]\s*\{\s*display:\s*none/);
  // the text follows the root's size: the body's own size is in rem (16px by default — the same as before)
  assert.match(CSS, /body \{[^}]*font-size: 1rem;/);
});

/** the boot script in a sandbox: a <html> with a class list, and what this browser kept */
function boot(kept: string | null, storage = true): string[] {
  const classes = new Set<string>();
  const sandbox = {
    document: { documentElement: { classList: { add: (...c: string[]) => c.forEach((x) => classes.add(x)) } } },
    localStorage: storage
      ? { getItem: (k: string) => (k === A11Y_KEY ? kept : null) }
      : { getItem: () => { throw new Error('SecurityError'); } },
  };
  vm.runInNewContext(A11Y_BOOT, sandbox);
  return [...classes];
}

test('the boot script applies what readPrefs reads — the same rules, never an error', () => {
  const samples = [null, '', 'garbage', '[]', '"x"', '42', 'null',
    '{"text":1}', '{"text":2,"contrast":true}', '{"text":3,"links":true,"font":true,"still":true,"spacing":true}',
    '{"text":4,"contrast":"true","links":1}', '{"contrast":true,"spacing":false}', '{"__proto__":{"contrast":true}}'];
  for (const raw of samples) assert.deepEqual(boot(raw).sort(), prefClasses(readPrefs(raw)).sort(), String(raw));
  assert.deepEqual(boot('{"text":2}', false), [], 'no storage (a private window): nothing, and no error');
});

test('the automatic statement: the name, the menu as it is, the contact — and no claim', () => {
  const on = a11yStatement({ name: 'Follow Me', phone: '050-3566969', whatsapp: '972503566969', email: 'shop@example.com', widget: true });
  assert.match(on, /^## נגישות באתר/);
  assert.match(on, /ב-Follow Me אנחנו רוצים שכל אחד ואחת יוכלו להשתמש באתר/);
  for (const o of A11Y_MENU_OPTIONS) assert.ok(on.includes(`- ${o}`), o);
  assert.match(on, /טלפון \/ וואטסאפ: \u2066050-3566969\u2069/, 'the same number once — a left-to-right run');
  assert.match(on, /מייל: \u2066shop@example\.com\u2069/);
  assert.doesNotMatch(on, /\[|\]/, 'no [brackets]: it is shown as it is');
  for (const claim of ['האתר נגיש', 'נגיש במלואו', 'מונגש', 'עומד בתקן', 'עומד בדרישות', '5568', 'WCAG', 'מאושר']) assert.ok(!on.includes(claim), claim);

  const off = a11yStatement({ name: 'חנות', phone: '', whatsapp: '972501112222', email: '', widget: false });
  assert.doesNotMatch(off, /תפריט הנגישות|כפתור נגישות/, 'the menu is off: not a word of it');
  assert.match(off, /וואטסאפ: \u2066\+972501112222\u2069/, 'the "+" first, whatever the line\'s direction');
  assert.doesNotMatch(off, /טלפון:/);

  const two = a11yStatement({ name: 'חנות', phone: '03-5551234', whatsapp: '972501112222', email: '', widget: true });
  assert.match(two, /טלפון: \u206603-5551234\u2069\nוואטסאפ: \u2066\+972501112222\u2069/, 'two numbers: both');

  const none = a11yStatement({ name: 'חנות', phone: '', whatsapp: '', email: '', widget: true });
  assert.match(none, /ונשמח לעזור\.$/, 'no contact at all: no empty list');
  assert.match(A11Y_STATEMENT_DATE, /^\d{4}-\d{2}-\d{2}$/);
});
