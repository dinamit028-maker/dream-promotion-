/**
 * The product feed for Google Merchant Center (2.60, stage 5): /feeds/google.xml of a store on the air — RSS 2.0 with the
 * g: namespace (https://support.google.com/merchants/answer/7052112). Built from the same sf_product the product page shows,
 * so the feed never says anything the page does not: the price a shopper pays, the stock, the pictures.
 *   - a product with variants: one item per variant, grouped by item_group_id, linked to ?variant=<id>
 *   - a sale (compare-at above the price): price = the compare-at, sale_price = the price
 *   - a barcode that is a GTIN (8/12/13/14 digits, valid check digit) goes as gtin; none → identifier_exists=no
 *   - left out: services (Merchant takes products only), and anything without a picture (Merchant requires one)
 */
import type { Product, Variant } from './types';

export interface FeedItem {
  id: string; groupId: string | null; title: string; description: string; link: string; image: string; images: string[];
  availability: 'in_stock' | 'out_of_stock'; price: string; salePrice: string | null; brand: string; gtin: string | null; mpn: string;
  color: string; size: string;
}

const COLOR = /^(צבע|color|colour)$/i, SIZE = /^(מידה|גודל|size)$/i;
const money = (n: number, currency: string) => `${(Math.round(n * 100) / 100).toFixed(2)} ${currency}`;
const https = (u: string | null | undefined) => (u && /^https:\/\//.test(u) ? u : '');

/** a GTIN: 8, 12, 13 or 14 digits with a valid check digit (GS1) */
export function isGtin(code: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  const d = code.split('').map(Number), check = d.pop()!;
  const sum = d.reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** the text Merchant takes: no markup, one space between words, within its limit */
const plain = (s: string, max: number) => s.replace(/<[^>]*>/g, ' ').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, max);

export function feedItems(p: Product, o: { origin: string; currency: string; storeName: string }): FeedItem[] {
  if (p.kind === 'service') return [];
  const link = `${o.origin}/products/${encodeURIComponent(p.slug)}`;
  const pictures = p.images.map((i) => https(i.url)).filter(Boolean);
  const description = plain(p.description || p.seo_description || p.name, 5000);
  const brand = plain(p.manufacturer || o.storeName, 70);
  const optionAt = (name: RegExp) => p.options.findIndex((x) => name.test(x.name.trim()));
  const colorAt = optionAt(COLOR), sizeAt = optionAt(SIZE);
  const item = (v: Variant | null): FeedItem | null => {
    const own = v?.image ? https(p.images.find((i) => i.id === v.image)?.url ?? v.image) : '';
    const image = own || pictures[0] || '';
    if (!image) return null;
    const price = v ? v.price : p.price, compare = v ? v.compare_at : p.compare_at;
    const sale = compare != null && compare > price;
    const barcode = (v ? v.barcode : p.barcode).trim();
    const chosen = v ? v.options.filter(Boolean).join(' / ') : '';
    return {
      id: v ? v.id : p.id, groupId: v ? p.id : null, title: plain(chosen ? `${p.name} — ${chosen}` : p.name, 150), description,
      link: v ? `${link}?variant=${encodeURIComponent(v.id)}` : link, image, images: pictures.filter((u) => u !== image).slice(0, 10),
      availability: (v ? v.in_stock : p.in_stock) ? 'in_stock' : 'out_of_stock',
      price: money(sale ? compare! : price, o.currency), salePrice: sale ? money(price, o.currency) : null,
      brand, gtin: isGtin(barcode) ? barcode : null, mpn: plain(v ? v.sku : p.sku, 70),
      color: v && colorAt >= 0 ? v.options[colorAt] ?? '' : '', size: v && sizeAt >= 0 ? v.options[sizeAt] ?? '' : '',
    };
  };
  const rows = p.variants.length ? p.variants.map(item) : [item(null)];
  return rows.filter((x): x is FeedItem => x !== null);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function feedXml(items: FeedItem[], o: { origin: string; storeName: string; description: string }): string {
  const tag = (name: string, v: string | null | undefined) => (v ? `<${name}>${esc(v)}</${name}>` : '');
  const rows = items.map((i) => `    <item>${[
    tag('g:id', i.id), tag('g:item_group_id', i.groupId), tag('g:title', i.title), tag('g:description', i.description), tag('g:link', i.link),
    tag('g:image_link', i.image), ...i.images.map((u) => tag('g:additional_image_link', u)), tag('g:availability', i.availability),
    tag('g:price', i.price), tag('g:sale_price', i.salePrice), tag('g:brand', i.brand), tag('g:condition', 'new'),
    i.gtin ? tag('g:gtin', i.gtin) : tag('g:identifier_exists', 'no'), tag('g:mpn', i.mpn), tag('g:color', i.color), tag('g:size', i.size),
  ].filter(Boolean).join('')}</item>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n  <channel>\n    ${
    tag('title', o.storeName)}\n    ${tag('link', `${o.origin}/`)}\n    ${tag('description', o.description || o.storeName)}\n${rows.join('\n')}\n  </channel>\n</rss>\n`;
}
