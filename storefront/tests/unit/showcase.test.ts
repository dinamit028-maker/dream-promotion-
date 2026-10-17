/**
 * 2.101: the catalog of models ("showcase") and the cards with a picture ("cards") — what a row may hold (lib/theme.ts), how
 * a row becomes a model (lib/showcase-items.ts: the business's picture, else the kit's by its file, else none — the page
 * draws one in the brand's colour), the filters and the quote message (lib/showcase.ts). A model is never a product.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { facetValues, filterItems, minQtyLabel, NO_FILTER, quoteMessage, type ShowcaseItem } from '../../src/lib/showcase';
import { showcaseItems } from '../../src/lib/showcase-items';
import { resolveTheme } from '../../src/lib/theme';

const model = (over: Partial<ShowcaseItem>): ShowcaseItem => ({
  n: 0, name: 'דגם', brand: '', color: '', category: '', material: '', handle: '', finish: '', shape: '', minQty: null, text: '', picture: null, ...over,
});

test('the filters: each one\'s values in the order they first appear, and the models that fit all three', () => {
  const items = [
    model({ n: 0, category: 'נייר', handle: 'חבל', material: 'קרפט' }), model({ n: 1, category: 'קופסאות', handle: 'סרט', material: 'קרטון' }),
    model({ n: 2, category: 'נייר', handle: 'סרט', material: 'קרפט' }), model({ n: 3, category: '', handle: 'חבל', material: '' }),
  ];
  assert.deepEqual(facetValues(items), { category: ['נייר', 'קופסאות'], handle: ['חבל', 'סרט'], material: ['קרפט', 'קרטון'] });
  assert.deepEqual(filterItems(items, NO_FILTER).map((m) => m.n), [0, 1, 2, 3], 'no filter: all');
  assert.deepEqual(filterItems(items, { ...NO_FILTER, category: 'נייר' }).map((m) => m.n), [0, 2]);
  assert.deepEqual(filterItems(items, { category: 'נייר', handle: 'סרט', material: '' }).map((m) => m.n), [2]);
  assert.deepEqual(filterItems(items, { category: 'קופסאות', handle: 'חבל', material: '' }), [], 'a combination with nothing');
});

test('the minimum and the quote: Hebrew numbers, the model\'s name and brand, the store', () => {
  assert.equal(minQtyLabel(1000), 'מינימום 1,000 יח׳');
  assert.equal(minQtyLabel(50), 'מינימום 50 יח׳');
  assert.equal(minQtyLabel(null), '');
  assert.equal(quoteMessage({ name: 'שקית נייר שחורה', brand: 'Aurelle' }, 'FollowMe'), 'היי, אשמח לקבל הצעת מחיר על הדגם "שקית נייר שחורה" (Aurelle) מהקטלוג באתר של FollowMe.');
  assert.equal(quoteMessage({ name: 'קופסה', brand: '' }, 'FollowMe'), 'היי, אשמח לקבל הצעת מחיר על הדגם "קופסה" מהקטלוג באתר של FollowMe.');
});

test('a row → a model: the business\'s picture first, then the kit\'s by its file, else none; a row without a name is left out', () => {
  const rows = [
    { name: 'עם תמונה שלי', brand: 'X', image: 'https://cdn.test/a.webp', pic: 'bag-001.webp', color: '#1f2a40', minQty: 100 },
    { name: 'עם תמונה של הערכה', pic: 'bag-002.webp', color: 'red', minQty: 0 },
    { name: 'עם קובץ שאין', pic: 'bag-999.webp', minQty: 2.5 },
    { name: '', pic: 'bag-003.webp' },
    { name: '  רווחים  ', image: 'http://cdn.test/a.webp', minQty: '7' },
  ];
  const out = showcaseItems(rows, 'bags-3d');
  assert.deepEqual(out.map((m) => [m.n, m.name]), [[0, 'עם תמונה שלי'], [1, 'עם תמונה של הערכה'], [2, 'עם קובץ שאין'], [4, 'רווחים']], 'its place in the list stays its key');
  assert.deepEqual(out[0].picture, { src: 'https://cdn.test/a.webp', alt: 'עם תמונה שלי — X', className: '' });
  assert.deepEqual(out[1].picture, { src: '/kit-images/bags-3d/bag-002.webp', alt: 'שקית ירוקה כהה עם חבל זהב ולוגו מוזהב', className: 'kimg-bag-002' });
  assert.equal(out[2].picture, null, 'a file the kit does not have: the drawing');
  assert.equal(out[3].picture, null, 'not https: not a picture');
  assert.deepEqual(out.map((m) => m.color), ['#1f2a40', '', '', '']);
  assert.deepEqual(out.map((m) => m.minQty), [100, null, null, null], 'a whole number from 1');
  assert.equal(showcaseItems(rows, 'bags')[1].picture, null, 'another kit: none of this kit\'s pictures');
  assert.deepEqual(showcaseItems('x', 'bags-3d'), []);
});

test('what the storefront keeps of a catalog and of cards (resolveTheme): a file name, a colour, a whole number, 60 and 8 rows', () => {
  const row = (i: number) => ({ name: `דגם ${i}`, color: '#ABCDEF', pic: 'bag-001.webp', minQty: 250, category: 'נייר' });
  const t = resolveTheme('kit', { kit: 'bags-3d', sections: [
    { id: 'catalog', type: 'showcase', settings: { title: 'קטלוג', items: [
      ...Array.from({ length: 61 }, (_, i) => row(i)),
    ] } },
    { id: 'odd', type: 'showcase', settings: { items: [
      { name: 'א', pic: '../x.webp', color: 'red', minQty: 0 }, { name: 'ב', pic: 'Bag.webp', color: '#12345', minQty: 1_000_001 },
      { name: 'ג', pic: 'b.webp', minQty: 1 },
    ] } },
    { id: 'cards', type: 'cards', variant: 'tiles', settings: { title: 'קטגוריות', items: [
      ...Array.from({ length: 9 }, (_, i) => ({ title: `כרטיס ${i}`, pic: 'site-03.webp', href: '/#catalog', label: 'לדגמים' })),
    ] } },
    { id: 'bad-link', type: 'cards', variant: 'parallax', settings: { items: [{ title: 'x', href: 'javascript:alert(1)' }] } },
  ] });
  const [catalog, odd, cards, badLink] = t.sections;
  const items = catalog.settings.items as Record<string, unknown>[];
  assert.equal(items.length, 60, 'up to 60 models');
  assert.equal(items[0].color, '#abcdef', 'a colour in lower case');
  assert.deepEqual(Object.keys(items[0]).sort(), ['brand', 'category', 'color', 'finish', 'handle', 'image', 'material', 'minQty', 'name', 'pic', 'shape', 'text'].sort(), 'every field of a row, no other');
  assert.deepEqual((odd.settings.items as Record<string, unknown>[]).map((r) => [r.pic, r.color, r.minQty]), [['', '', ''], ['', '', ''], ['b.webp', '', 1]]);
  assert.equal((cards.settings.items as unknown[]).length, 8, 'up to 8 cards');
  assert.equal(cards.variant, 'tiles');
  assert.deepEqual((cards.settings.items as Record<string, unknown>[])[0], { title: 'כרטיס 0', text: '', image: '', pic: 'site-03.webp', href: '/#catalog', label: 'לדגמים' });
  assert.equal((badLink.settings.items as Record<string, unknown>[])[0].href, '', 'a link the storefront does not render: dropped');
  assert.equal(badLink.variant, 'tiles', 'a layout that is not one of the list: the first');
});
