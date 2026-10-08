/**
 * A section's own design (2.68): resolveTheme keeps only steps of the scales; every class styleClasses can make has its
 * rule in the CSS, for the phone, a tablet and a computer (a class without a rule would be a choice that does nothing).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTheme } from '../../src/lib/theme';
import { STYLE_KEYS, STYLE_SCALES, styleClasses } from '../../src/lib/builder-registry';

test('a theme: the section\'s style and its screens, checked', () => {
  const t = resolveTheme('kit', { sections: [{ id: 'a', type: 'text', settings: {}, style: { padY: 'xl', surface: 'url(x)' }, responsive: { md: { align: 'center' }, lg: {} } }] });
  const a = t.sections.find((s) => s.id === 'a')!;
  assert.deepEqual([a.style, a.responsive], [{ padY: 'xl' }, { md: { align: 'center' } }]);
  assert.equal(resolveTheme('kit', { sections: [{ id: 'b', type: 'text', settings: {} }] }).sections[0].style, undefined, 'none chosen: none');
});

test('every class has its rule in the CSS, on every screen', () => {
  const css = readFileSync(join(__dirname, '../../src/app/globals.css'), 'utf8');
  for (const k of STYLE_KEYS) for (const o of STYLE_SCALES[k]) {
    const s = { [k]: o.value };
    for (const c of styleClasses(s, { md: s, lg: s })) assert.ok(css.includes(`.${c} `), c);
  }
});
