'use client';
import { useMemo, useState } from 'react';
import { money, productMessage, stockLabel, variantLabel, whatsappHref } from '@/lib/format';
import type { Product, Variant } from '@/lib/types';
import { AddToCart } from './AddToCart';

/**
 * Size / colour of a product: a choice per option; the price, the "before discount" price and the availability of THAT
 * variant; a value that has no active variant with the other choices is marked. When the store sells on the site (stage 3)
 * the action is "הוספה לסל" of THAT variant; WhatsApp (when the store has it and the template shows it) stays as a question.
 */
export function VariantPicker({ product, currency, whatsapp, pageUrl, initialVariant }: {
  product: Pick<Product, 'id' | 'name' | 'options' | 'variants' | 'price' | 'price_max' | 'compare_at' | 'in_stock' | 'stock' | 'can_buy'>;
  currency: string; whatsapp: string; pageUrl: string; initialVariant?: string;
}) {
  const { options, variants } = product;
  const start = variants.find((v) => v.id === initialVariant) ?? variants.find((v) => v.in_stock) ?? variants[0] ?? null;
  const [picked, setPicked] = useState<string[]>(() => (start ? start.options.slice() : ['', '', '']));
  const chosen: Variant | null = useMemo(
    () => (options.length ? variants.find((v) => options.every((o) => v.options[o.position - 1] === picked[o.position - 1])) ?? null : null),
    [options, variants, picked]);

  const pick = (pos: number, value: string) => {
    const next = picked.slice(); next[pos - 1] = value;
    // keep a combination that exists: if this value has no variant with the other choices, take the first one that does
    if (!variants.some((v) => options.every((o) => v.options[o.position - 1] === next[o.position - 1]))) {
      const v = variants.find((x) => x.options[pos - 1] === value && x.in_stock) ?? variants.find((x) => x.options[pos - 1] === value);
      if (v) for (const o of options) next[o.position - 1] = v.options[o.position - 1];
    }
    setPicked(next);
    const v = variants.find((x) => options.every((o) => x.options[o.position - 1] === next[o.position - 1]));
    if (v) {
      const u = new URL(window.location.href); u.searchParams.set('variant', v.id); window.history.replaceState(null, '', u);
      if (v.image) document.getElementById(`img-${v.image}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  };
  const exists = (pos: number, value: string) =>
    variants.some((v) => v.options[pos - 1] === value && options.every((o) => o.position === pos || v.options[o.position - 1] === picked[o.position - 1]));

  const price = chosen ? chosen.price : product.price;
  const compare = chosen ? chosen.compare_at : product.compare_at;
  const inStock = chosen ? chosen.in_stock : product.in_stock;
  const stock = chosen ? chosen.stock : product.stock;
  const wa = whatsappHref(whatsapp, productMessage(product, chosen, pageUrl));

  return (
    <div className="buy">
      <p className="buy-price" aria-live="polite">
        {!chosen && product.price_max > product.price && <span className="price-from">החל מ-</span>}
        <bdi className="price-now">{money(price, currency)}</bdi>
        {compare != null && compare > price && <> <span className="sr-only">במקום</span><s className="price-was"><bdi>{money(compare, currency)}</bdi></s></>}
      </p>
      {options.map((o) => (
        <fieldset key={o.position} className="option">
          <legend>{o.name}: <span className="option-value">{picked[o.position - 1] || '—'}</span></legend>
          <div className="chips">
            {o.values.map((val) => {
              const on = picked[o.position - 1] === val;
              const ok = exists(o.position, val);
              return (
                <button key={val} type="button" className={`chip${on ? ' chip-on' : ''}${ok ? '' : ' chip-off'}`} aria-pressed={on}
                  onClick={() => pick(o.position, val)}>
                  {val}{!ok && <span className="sr-only"> (לא בשילוב הזה)</span>}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
      <p className={inStock ? 'stock stock-in' : 'stock stock-out'} aria-live="polite">
        {options.length > 0 && !chosen ? 'השילוב הזה לא קיים' : stockLabel(inStock, stock)}
        {chosen && <span className="sr-only"> — {variantLabel(chosen)}</span>}
      </p>
      {product.can_buy ? (
        <>
          <AddToCart item={product.id} variant={chosen?.id ?? null} disabled={!inStock || (options.length > 0 && !chosen)}
            label={inStock ? undefined : 'אזל המלאי'} />
          {wa && <a className="btn btn-ghost btn-wide" href={wa} target="_blank" rel="noopener noreferrer">שאלה בוואטסאפ</a>}
        </>
      ) : wa
        ? <a className="btn btn-primary btn-wide" href={wa} target="_blank" rel="noopener noreferrer">לפרטים והזמנה בוואטסאפ</a>
        : <a className="btn btn-primary btn-wide" href="#contact-details">ליצירת קשר</a>}
    </div>
  );
}
