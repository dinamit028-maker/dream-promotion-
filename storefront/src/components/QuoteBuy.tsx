'use client';
import { useId, useState } from 'react';
import { quotePrice, whatsappHref } from '@/lib/format';
import { minQtyLabel } from '@/lib/showcase';
import type { Product, Quote } from '@/lib/types';
import { LeadForm } from './LeadForm';

/**
 * The buy box of a product sold by a quote (2.102): "החל מ-$3.50 ליחידה" (the business's own currency, shown only), the minimum,
 * and "בקשת הצעת מחיר" — a short form under it (the model's code filled in), never a cart or a payment. WhatsApp, when the
 * store has it and the template shows it, stays a question beside it.
 */
export function QuoteBuy({ product, quote, currency, whatsapp, pageUrl }: {
  product: Pick<Product, 'id' | 'name' | 'sku' | 'slug'>; quote: Quote; currency: string; whatsapp: string; pageUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const from = quotePrice(quote, currency);
  const code = product.sku || product.slug;
  const wa = whatsappHref(whatsapp, `היי, אשמח לקבל הצעת מחיר על ${product.name} (${code})\n${pageUrl}`);
  return (
    <div className="buy buy-quote">
      <p className="buy-price">
        {from
          ? <><span className="price-from">החל מ-</span><bdi className="price-now">{from}</bdi> <span className="price-unit">ליחידה</span></>
          : <span className="price-now">בהצעת מחיר</span>}
      </p>
      {quote.min ? <p className="quote-min">{minQtyLabel(quote.min)}</p> : null}
      <button type="button" className="btn btn-primary btn-wide" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>
        בקשת הצעת מחיר
      </button>
      <div id={panel} className="quote-panel" hidden={!open}>
        {open && <LeadForm kind="quote" item={product.id} model={code} min={quote.min} autoFocus />}
      </div>
      {wa && <a className="btn btn-ghost btn-wide" href={wa} target="_blank" rel="noopener noreferrer">שאלה בוואטסאפ</a>}
    </div>
  );
}
