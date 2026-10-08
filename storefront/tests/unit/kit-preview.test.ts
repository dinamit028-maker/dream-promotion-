/**
 * A kit's preview (2.64): the proxy keeps the choice in a cookie and strips it from the address; only a kit that exists and
 * the two modes are read; "design" keeps the store's own home page in the kit's look, "full" shows the kit's own — with the
 * store's name, a booking link as WhatsApp — and neither is saved anywhere (there is no write here to make).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { proxy } from '../../src/proxy';
import { previewTheme, readKitChoice, KIT_IDS } from '../../src/lib/kit-preview';
import { kitCookieValue } from '../../src/lib/kit-choice';

const run = (path: string) => proxy(new NextRequest(`https://shop.example.com${path}`, { headers: { host: 'shop.example.com', 'x-forwarded-proto': 'https' } }));

test('the proxy: ?kit= becomes a cookie of this address (an hour), the address loses it; ?kit=off and ?preview=off remove it', () => {
  const r = run('/collections/all?kit=fashion&kitmode=full&sort=new');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://shop.example.com/collections/all?sort=new');
  assert.match(r.headers.get('set-cookie') ?? '', /sf_kit=fashion%3Afull|sf_kit=fashion:full/);
  assert.match(r.headers.get('set-cookie') ?? '', /HttpOnly/i);
  assert.match(r.headers.get('set-cookie') ?? '', /Max-Age=3600/);
  assert.match(run('/?kit=beauty').headers.get('set-cookie') ?? '', /sf_kit=beauty(%3A|:)design/, 'the mode defaults to design');
  for (const p of ['/?kit=off', '/?kit=../../x', '/?kit=fashion&kitmode=evil', '/?preview=off']) assert.match(run(p).headers.get('set-cookie') ?? '', /sf_kit=;/, p);
  assert.equal(kitCookieValue('Fashion', 'full'), null);
});

test('the cookie is read only for a kit that exists and one of the two modes', () => {
  assert.deepEqual(readKitChoice('fashion:full'), { kit: 'fashion', mode: 'full', name: 'אופנה' });
  for (const v of ['', 'fashion', 'fashion:edit', 'nope:design', '__proto__:design', 'constructor:full', undefined, null]) assert.equal(readKitChoice(v as string), null, String(v));
  assert.deepEqual([...KIT_IDS].sort(), ['bags', 'beauty', 'fashion', 'furniture', 'general', 'retail', 'services']);
});

test('"full": the kit\'s own home page and look, the store\'s name in it, a booking link → WhatsApp', () => {
  const t = previewTheme('bags', { sections: [{ id: 'hero', settings: { title: 'שקיות FollowMe' } }] }, { kit: 'beauty', mode: 'full', name: 'ביוטי' }, 'FollowMe "Q"');
  assert.equal(t.kit, 'beauty');
  assert.deepEqual(t.sections.map((s) => s.id), ['hero', 'treatments', 'before-after', 'care', 'steps', 'faq', 'contact']);
  assert.equal(t.sections[0].variant, 'editorial');
  assert.ok(!JSON.stringify(t).includes('{{name}}'), 'the name filled in');
  assert.ok(!JSON.stringify(t.sections).includes('"booking"'));
  assert.equal(t.font, 'frank');
});

test('"design": the store\'s own home page — every section of its template, its texts — in the kit\'s look', () => {
  const saved = { colors: { primary: '#0a3d62' }, sections: [{ id: 'hero', settings: { title: 'שקיות FollowMe' } }, { id: 'faq', hidden: false, settings: { items: [{ q: 'יש מינימום?', a: 'כן.' }] } }] };
  const own = previewTheme('bags', saved, { kit: 'fashion', mode: 'design', name: 'אופנה' }, 'FollowMe');
  assert.equal(own.kit, 'fashion');
  assert.equal(own.sections.find((s) => s.id === 'hero')!.settings.title, 'שקיות FollowMe', 'the store\'s text');
  assert.deepEqual(own.sections.map((s) => s.id), ['hero', 'faq', 'collections', 'featured', 'about', 'steps', 'contact'], 'the store\'s sections, its order');
  assert.equal(own.colors.primary, '#111111', 'the kit\'s colours');
  assert.equal(own.font, 'assistant');
  assert.equal(own.chrome.header, 'transparent-overlay', 'the kit\'s header');
  assert.equal(own.sections.find((s) => s.id === 'hero')!.variant, 'full-image', 'a section the kit has by id: its layout');
  assert.equal(own.sections.find((s) => s.id === 'about')!.variant, 'split', 'a section the kit does not have: its type\'s first');
});
