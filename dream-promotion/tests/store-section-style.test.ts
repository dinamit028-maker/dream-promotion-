/**
 * A section's own design (Dream Builder PR-3d, 2.68): steps of the scales only; the phone is the base, a tablet and a
 * computer take what is below them unless they have their own; back to the smaller screen; through the draft and back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanResponsive, cleanStyle, STYLE_CLASS, styleClasses } from '../src/features/store/builder-registry';
import { resetDevice, sectionStyleClasses, setSectionStyle, styleShown } from '../src/features/store/section-style';
import { draftOf, settingsOf } from '../src/features/store/theme-fields';

test('cleanStyle: only known keys, only steps of their scale; the classes have one shape', () => {
  assert.deepEqual(cleanStyle({ padY: 'l', surface: 'accentSoft', align: 'center', width: '1200px', color: '#f00', extra: 1 }), { padY: 'l', surface: 'accentSoft', align: 'center' });
  assert.deepEqual(cleanStyle('x'), {});
  assert.deepEqual(cleanResponsive({ md: { padY: 'xl' }, lg: { padY: '9px' }, xl: { padY: 's' } }), { md: { padY: 'xl' } });
  const cls = styleClasses({ padY: 'l', surface: 'accentSoft' }, { md: { width: 'wide' }, lg: { align: 'center' } });
  assert.deepEqual(cls, ['sx-py-l', 'sx-sf-accent-soft', 'sx-md-w-wide', 'sx-lg-al-center']);
  assert.ok(cls.every((c) => STYLE_CLASS.test(c)));
  assert.deepEqual(styleClasses(undefined, undefined), [], 'nothing chosen: no class, the kit\'s look');
});

const draft = () => draftOf('kit', { sections: [{ id: 'hero', type: 'hero', settings: {} }, { id: 'a', type: 'text', settings: {} }] });
const sec = (d: ReturnType<typeof draft>) => d.sections.find((s) => s.id === 'a')!;

test('a value per screen: the phone is the base, a tablet takes it, a computer takes the tablet\'s; back to below', () => {
  let d = setSectionStyle(draft(), 'a', 'base', 'padY', 'l');
  assert.deepEqual(sec(d).style, { padY: 'l' });
  assert.deepEqual(styleShown(sec(d), 'md', 'padY'), { value: 'l', own: false }, 'a tablet takes the phone\'s');
  d = setSectionStyle(d, 'a', 'md', 'padY', 'xl');
  assert.deepEqual([styleShown(sec(d), 'md', 'padY'), styleShown(sec(d), 'lg', 'padY')], [{ value: 'xl', own: true }, { value: 'xl', own: false }]);
  d = setSectionStyle(d, 'a', 'lg', 'surface', 'dark');
  assert.deepEqual(sectionStyleClasses(sec(d)), ['sx-py-l', 'sx-md-py-xl', 'sx-lg-sf-dark']);
  const back = draftOf('kit', settingsOf(d));
  assert.deepEqual([sec(back).style, sec(back).responsive], [{ padY: 'l' }, { md: { padY: 'xl' }, lg: { surface: 'dark' } }], 'saved and read back');
  d = resetDevice(d, 'a', 'md');
  assert.deepEqual(sec(d).responsive, { lg: { surface: 'dark' } });
  d = setSectionStyle(setSectionStyle(d, 'a', 'lg', 'surface', ''), 'a', 'base', 'padY', '');
  assert.equal(sec(d).style, undefined, 'empty: no style at all');
  assert.equal(sec(d).responsive, undefined);
  assert.equal(settingsOf(d).sections.find((s) => s.id === 'a')!.style, undefined, 'nothing saved');
});

test('a value off the scale, an unknown section, the same value: the same draft', () => {
  const d = setSectionStyle(draft(), 'a', 'base', 'padY', 'm');
  assert.equal(setSectionStyle(d, 'a', 'base', 'padY', '30px'), d);
  assert.equal(setSectionStyle(d, 'nope', 'base', 'padY', 'l'), d);
  assert.equal(setSectionStyle(d, 'a', 'base', 'padY', 'm'), d);
  assert.equal(resetDevice(d, 'a', 'lg'), d);
  assert.deepEqual(sec(draftOf('kit', { sections: [{ id: 'a', type: 'text', settings: {}, style: { padY: '"><script>' }, responsive: { md: 'x' } }] })).style, undefined);
});
