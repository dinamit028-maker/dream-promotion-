import type { Card, Product, Variant } from './types';

/** ₪ — whole shekels without ".00", agorot when there are any */
export function money(n: number | null | undefined, currency = 'ILS', lang = 'he'): string {
  if (n == null || !Number.isFinite(n)) return '';
  const whole = Math.round(n * 100) % 100 === 0;
  return new Intl.NumberFormat(lang === 'he' ? 'he-IL' : 'en-US', {
    style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2,
  }).format(n);
}

/** "₪12" or "החל מ-₪12" (variants at different prices) */
export function priceLabel(p: Pick<Card, 'price' | 'price_max'>, currency = 'ILS'): { from: boolean; text: string } {
  return { from: p.price_max != null && p.price_max > p.price, text: money(p.price, currency) };
}

/** what the shopper reads about availability; a count only when the store chose to show it */
export function stockLabel(inStock: boolean, stock: number | null): string {
  if (!inStock) return 'אזל המלאי';
  if (stock != null && stock > 0 && stock <= 10) return `נשארו ${stock} במלאי`;
  return 'במלאי';
}

/** the variant's options as a label: "M / שחור" */
export const variantLabel = (v: Pick<Variant, 'options'>) => v.options.filter(Boolean).join(' / ');

/** a WhatsApp link with a first message (digits only: 9725…) */
export function whatsappHref(number: string, text: string): string | null {
  const digits = number.replace(/\D/g, '');
  if (!/^\d{9,15}$/.test(digits)) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** the message a product's "ask on WhatsApp" opens with */
export const productMessage = (p: Pick<Product, 'name'>, v?: Pick<Variant, 'options'> | null, url?: string) =>
  [`היי, אשמח לפרטים על ${p.name}${v && variantLabel(v) ? ` (${variantLabel(v)})` : ''}`, url].filter(Boolean).join('\n');

/** a description for search engines: the first sentence-ish 160 characters of a text */
export function excerpt(text: string, max = 160): string {
  const flat = text.replace(/^#+\s*/gm, '').replace(/^[-*]\s+/gm, '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30))}…`;
}
