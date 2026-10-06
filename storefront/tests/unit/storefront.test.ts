/**
 * The storefront's pure rules (no server, no database): which host is a store's, the preview token, the template's
 * settings (nothing from a draft can break the page or inject anything), the shopper's filters, prices, the CSP and the
 * structured data. Run: npm test (node:test via tsx).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPlatformHost, normalizeHost } from '../../src/lib/host';
import { makePreviewToken, verifyPreviewToken, PREVIEW_MAX_SECONDS } from '../../src/lib/preview';
import { contrast, onColor, resolveTheme, safeHref, safeImage, themeCss } from '../../src/lib/theme';
import { BAGS } from '../../src/templates/bags';
import { pageHref, parseQuery, PAGE_SIZE } from '../../src/lib/query';
import { excerpt, money, priceLabel, productMessage, stockLabel, whatsappHref } from '../../src/lib/format';
import { buildCsp, jsonForScript } from '../../src/lib/csp';
import { toOpts } from '../../src/lib/data';

test('a host: lower case, no port, an IDN in punycode — anything else is no store', () => {
  assert.equal(normalizeHost('FollowMeCollection.com:443'), 'followmecollection.com');
  assert.equal(normalizeHost(' www.followmecollection.com. '), 'www.followmecollection.com');
  assert.match(normalizeHost('שקיות.co.il'), /^xn--[a-z0-9]+\.co\.il$/);
  for (const bad of ['', 'evil.com/path', 'a b.com', '[::1]:3000', 'evil.com\r\nx', '-bad-.com', 'x'.repeat(300)]) {
    assert.equal(normalizeHost(bad), '', `rejects ${JSON.stringify(bad).slice(0, 30)}`);
  }
  assert.equal(normalizeHost(null), '');
});

test('the storefront\'s own addresses: only a preview lives there', () => {
  assert.ok(isPlatformHost('dream-storefront-git-x.vercel.app'));
  assert.ok(isPlatformHost('localhost'));
  assert.ok(isPlatformHost('platform.test', 'platform.test, other.test'));
  assert.ok(!isPlatformHost('followmecollection.com', ''));
  assert.ok(!isPlatformHost('vercel.app.evil.com', ''));
  assert.ok(!isPlatformHost('', 'x'));
});

test('a preview token: one store, at most two hours, signed — a changed byte is nothing', () => {
  const secret = 's'.repeat(32), store = '00000000-0000-4000-8000-000000000001', now = 1_800_000_000;
  const t = makePreviewToken(store, secret, now + 3600);
  assert.deepEqual(verifyPreviewToken(t, secret, now), { store, expires: now + 3600 });
  assert.equal(verifyPreviewToken(t, secret, now + 3601), null, 'expired');
  assert.equal(verifyPreviewToken(t, 'x'.repeat(32), now), null, 'another secret');
  assert.equal(verifyPreviewToken(t, 'short', now), null, 'a short secret is no secret');
  assert.equal(verifyPreviewToken(t, undefined, now), null, 'no secret: no preview');
  assert.equal(verifyPreviewToken(makePreviewToken(store, secret, now + PREVIEW_MAX_SECONDS + 60), secret, now), null, 'too long');
  const other = '00000000-0000-4000-8000-000000000002';
  assert.equal(verifyPreviewToken(t.replace(store, other), secret, now), null, 'another store');
  assert.equal(verifyPreviewToken(`${t}x`, secret, now), null);
  assert.equal(verifyPreviewToken('nope', secret, now), null);
  // the dashboard signs the same format (dream-promotion/src/features/store/preview-token.ts): one known vector
  assert.equal(makePreviewToken(store, 'k'.repeat(32), 2_000_000_000), '00000000-0000-4000-8000-000000000001.2000000000.etcj1FtX2uQt0wWYJMeWvRvUyrqRpC_n-dlyxhzqymo');
});

test('the template: the bags defaults when nothing was saved', () => {
  const t = resolveTheme('bags', {});
  assert.equal(t.template, 'bags');
  assert.deepEqual(t.sections.map((s) => s.id), ['hero', 'collections', 'featured', 'about', 'steps', 'faq', 'contact']);
  assert.equal(t.sections.find((s) => s.id === 'faq')?.hidden, true, 'no questions yet: hidden');
  assert.equal(resolveTheme('nope', null).template, 'bags', 'an unknown template → the first one');
  assert.ok(contrast(BAGS.colors.text, BAGS.colors.background) >= 4.5 && contrast(BAGS.colors.muted, BAGS.colors.background) >= 4.5, 'the template reads well');
});

test('the template: the business\'s changes, checked — order, hiding, texts, links, pictures', () => {
  const t = resolveTheme('bags', {
    colors: { primary: '#0A3D62', accent: 'red', nope: '#000000' },
    radius: 'large',
    announcement: { text: '  משלוח   חינם  ', href: 'javascript:alert(1)' },
    sections: [
      { id: 'contact', hidden: false },
      { id: 'hero', settings: { title: 'שקיות FollowMe', primaryHref: '//evil.test', secondaryHref: 'https://wa.me/972500000000', image: 'http://plain.test/a.jpg', bogus: 1 } },
      { id: 'faq', hidden: false, settings: { items: [{ q: 'כמה?', a: 'הרבה' }, { q: '', a: '' }, 'junk'] } },
      { id: 'hero', hidden: true },
      { id: 'unknown' },
    ],
  });
  assert.equal(t.colors.primary, '#0a3d62');
  assert.equal(t.colors.accent, BAGS.colors.accent, 'not a colour → the template\'s');
  assert.equal(t.radius, 'large');
  assert.equal(t.announcement.text, 'משלוח חינם');
  assert.equal(t.announcement.href, BAGS.announcement.href, 'javascript: is never a link');
  assert.deepEqual(t.sections.map((s) => s.id).slice(0, 3), ['contact', 'hero', 'faq'], 'the business\'s order; a duplicate and an unknown id are ignored');
  assert.equal(t.sections.length, BAGS.sections.length, 'the rest of the template follows');
  const hero = t.sections.find((s) => s.id === 'hero')!;
  assert.equal(hero.hidden, false, 'the first mention wins');
  assert.equal(hero.settings.title, 'שקיות FollowMe');
  assert.equal(hero.settings.primaryHref, BAGS.sections[0].settings.primaryHref, '"//" leaves the site: refused');
  assert.equal(hero.settings.secondaryHref, 'https://wa.me/972500000000');
  assert.equal(hero.settings.image, '', 'a picture over http: refused (the template\'s empty picture stays)');
  assert.equal('bogus' in hero.settings, false);
  assert.deepEqual(t.sections.find((s) => s.id === 'faq')!.settings.items, [{ q: 'כמה?', a: 'הרבה' }], 'an empty row and junk are dropped');
});

test('never unreadable: text on a background below 4.5:1 → the template\'s pair; a button\'s text picks its contrast', () => {
  const t = resolveTheme('bags', { colors: { text: '#eeeeee', background: '#ffffff' } });
  assert.equal(t.colors.text, BAGS.colors.text);
  assert.equal(t.colors.background, BAGS.colors.background);
  assert.equal(onColor('#1f1b16'), '#ffffff');
  assert.equal(onColor('#f5d76e'), '#14110e');
  assert.match(themeCss(t), /^:root\{--c-bg:#[0-9a-f]{6};.*--radius-btn:999px\}$/);
});

test('links and pictures a template may hold', () => {
  for (const ok of ['/', '/collections/all', '/products/שקית-בד', 'https://instagram.com/x', 'whatsapp', '#contact']) assert.equal(safeHref(ok), ok, ok);
  for (const bad of ['javascript:alert(1)', '//evil.test', 'http://plain.test', '/a b', '/"x', 'data:text/html,x', 'mailto:x@y.z', '']) assert.equal(safeHref(bad), null, bad);
  assert.equal(safeImage('https://cdn.test/a.webp'), 'https://cdn.test/a.webp');
  for (const bad of ['http://cdn.test/a.webp', 'https://cdn.test/a b.webp', 'javascript:x', 42]) assert.equal(safeImage(bad), null);
});

test('the shopper\'s filters, from the address', () => {
  const q = parseQuery({ q: '  שקית ', sort: 'price_asc', stock: '1', min: '10', max: 'abc', 'o.מידה': ['S', 'M', 'S'], 'o.צבע': 'שחור', page: '3', junk: 'x' });
  assert.equal(q.q, 'שקית');
  assert.equal(q.sort, 'price_asc');
  assert.equal(q.in_stock, true);
  assert.equal(q.min_price, 10);
  assert.equal(q.max_price, undefined, 'not a number: ignored');
  assert.deepEqual(q.options, { מידה: ['S', 'M'], צבע: ['שחור'] });
  assert.equal(q.offset, 2 * PAGE_SIZE);
  assert.equal(parseQuery({ sort: 'drop table' }).sort, undefined);
  assert.equal(parseQuery({ page: '-4' }).page, 1);
  assert.equal(parseQuery({ page: '99999' }).page, 200);
  assert.deepEqual(toOpts({ collection: 'eco', in_stock: true, min_price: 5, options: { מידה: ['S'] }, limit: 24, offset: 0 }),
    { collection: 'eco', in_stock: '1', min_price: '5', options: { מידה: ['S'] }, limit: '24', offset: '0' });
  assert.equal(pageHref('/collections/eco', { 'o.מידה': ['S', 'M'], page: '2' }, 3), '/collections/eco?o.%D7%9E%D7%99%D7%93%D7%94=S&o.%D7%9E%D7%99%D7%93%D7%94=M&page=3');
  assert.equal(pageHref('/search', { q: 'x', page: '2' }, 1), '/search?q=x');
});

test('prices, stock, WhatsApp and descriptions', () => {
  assert.match(money(12), /12/);
  assert.doesNotMatch(money(12), /12[.,]00/, 'whole shekels without agorot');
  assert.match(money(12.5), /12[.,]50/);
  assert.equal(money(null), '');
  assert.deepEqual(priceLabel({ price: 20, price_max: 24 }).from, true);
  assert.deepEqual(priceLabel({ price: 20, price_max: 20 }).from, false);
  assert.equal(stockLabel(false, 3), 'אזל המלאי');
  assert.equal(stockLabel(true, null), 'במלאי');
  assert.equal(stockLabel(true, 4), 'נשארו 4 במלאי');
  assert.equal(stockLabel(true, 40), 'במלאי');
  assert.equal(whatsappHref('+972-50-123-4567', 'היי'), 'https://wa.me/972501234567?text=%D7%94%D7%99%D7%99');
  assert.equal(whatsappHref('12', 'x'), null);
  assert.equal(productMessage({ name: 'שקית בד' }, { options: ['M', 'שחור', ''] }), 'היי, אשמח לפרטים על שקית בד (M / שחור)');
  assert.equal(excerpt('## כותרת\n\nטקסט קצר'), 'כותרת טקסט קצר');
  assert.ok(excerpt('מילה '.repeat(100)).length <= 160);
});

test('the CSP: scripts only with the nonce, no inline styles, nothing framed; JSON-LD cannot close its tag', () => {
  const csp = buildCsp('abc123');
  assert.match(csp, /script-src 'self' 'nonce-abc123' 'strict-dynamic'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(csp, /unsafe-eval/, 'production: no eval');
  assert.match(buildCsp('n', { dev: true }), /'unsafe-eval'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /upgrade-insecure-requests/);
  assert.doesNotMatch(buildCsp('n', { https: false }), /upgrade-insecure-requests/);
  const s = jsonForScript({ name: '</script><script>alert(1)</script>', x: '&' });
  assert.doesNotMatch(s, /<\/script>/i);
  assert.deepEqual(JSON.parse(s), { name: '</script><script>alert(1)</script>', x: '&' });
});
