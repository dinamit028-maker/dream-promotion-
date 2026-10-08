/**
 * 2.66: the theme's variables come from one rule (themeCss and the visual editor's live change); every value is checked; a
 * section hidden on some screens keeps only known screens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenVars } from '../../src/lib/theme-tokens';
import { hiddenOnOf, resolveTheme, themeCss } from '../../src/lib/theme';

const colors = { background: '#FFFFFF', surface: '#ffffff', text: '#111111', muted: '#5c5c5c', primary: '#111111', accent: '#b0413e', accentSoft: '#f6eeee', border: '#e6e6e6' };

test('the variables: colours (lower case), the colour on a button, corners and the font — or nothing at all', () => {
  const v = Object.fromEntries(tokenVars(colors, 'frank', 'large')!);
  assert.equal(v['--c-bg'], '#ffffff');
  assert.equal(v['--c-on-primary'], '#ffffff');
  assert.equal(v['--radius'], '20px');
  assert.match(v['--font'], /^'Frank Ruhl Libre Variable'/);
  assert.equal(tokenVars({ ...colors, text: 'red' }, 'frank', 'large'), null, 'a colour that is not hex');
  assert.equal(tokenVars(colors, "x'}body{", 'large'), null, 'a font off the list');
  assert.equal(tokenVars(colors, 'heebo', '9px'), null, 'a corner off the list');
  assert.equal(tokenVars({ ...colors, accent: '#b0413e;}' }, 'heebo', 'small'), null);
});

test('themeCss: the same variables, in the same order as before', () => {
  const css = themeCss(resolveTheme('bags', {}));
  assert.match(css, /^:root\{--c-bg:#fbf8f3;--c-surface:#ffffff;--c-text:#1f1b16;--c-muted:#5f574e;--c-primary:#1f1b16;--c-on-primary:#ffffff;--c-accent:#8a5a2b;--c-accent-soft:#f1e6d6;--c-border:#e7ddcf;--radius:12px;--radius-btn:999px;--font:'Heebo Variable','Heebo',system-ui/);
});

test('hidden on some screens: known ones, in order, once; all three is not this', () => {
  assert.deepEqual(hiddenOnOf(['lg', 'base', 'base', 'tv']), ['base', 'lg']);
  assert.deepEqual(hiddenOnOf(['base', 'md', 'lg']), []);
  assert.deepEqual(hiddenOnOf(null), []);
});
