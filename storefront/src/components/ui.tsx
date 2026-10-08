import type { ReactNode } from 'react';
import { jsonForScript } from '@/lib/csp';
import { money, priceLabel, stockLabel } from '@/lib/format';
import type { Card, Picture as Pic } from '@/lib/types';

/** a picture in its sizes (400 / 800 / 1600, made in the dashboard's browser): the browser picks the right one */
export function Picture({ pic, alt, sizes, eager = false, className }: { pic: Pic; alt: string; sizes: string; eager?: boolean; className?: string }) {
  const set = Object.entries(pic.sizes ?? {}).filter(([w, u]) => /^\d+$/.test(w) && /^https:\/\//.test(u)).sort((a, b) => Number(a[0]) - Number(b[0]));
  const src = pic.sizes?.['800'] || pic.url;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src} alt={alt} className={className}
      srcSet={set.length ? set.map(([w, u]) => `${u} ${w}w`).join(', ') : undefined}
      sizes={set.length ? sizes : undefined}
      width={pic.width ?? undefined} height={pic.height ?? undefined}
      loading={eager ? 'eager' : 'lazy'} decoding="async" fetchPriority={eager ? 'high' : undefined}
    />
  );
}

/** the price (a number inside <bdi>, so RTL never flips it), the price before the discount, "החל מ-" */
export function Price({ price, priceMax, compareAt, currency = 'ILS', className = '' }: { price: number; priceMax?: number; compareAt?: number | null; currency?: string; className?: string }) {
  const { from, text } = priceLabel({ price, price_max: priceMax ?? price }, currency);
  return (
    <span className={`price ${className}`}>
      {from && <span className="price-from">החל מ-</span>}
      <bdi className="price-now">{text}</bdi>
      {compareAt != null && compareAt > price && (
        <>
          <span className="sr-only">במקום</span>
          <s className="price-was"><bdi>{money(compareAt, currency)}</bdi></s>
        </>
      )}
    </span>
  );
}

export function Stock({ inStock, stock }: { inStock: boolean; stock: number | null }) {
  return <span className={inStock ? 'stock stock-in' : 'stock stock-out'}>{stockLabel(inStock, stock)}</span>;
}

export function ProductCard({ p, currency, eager = false }: { p: Card; currency: string; eager?: boolean }) {
  return (
    <li className="card">
      <a href={`/products/${encodeURIComponent(p.slug)}`} className="card-link">
        <span className="card-media">
          {p.image ? <Picture pic={p.image} alt={p.image.alt || p.name} sizes="(min-width: 960px) 25vw, 50vw" eager={eager} /> : <span className="card-noimage" aria-hidden="true"><Art /></span>}
          {!p.in_stock && <span className="badge">אזל</span>}
          {p.in_stock && p.compare_at != null && p.compare_at > p.price && <span className="badge badge-sale">מבצע</span>}
        </span>
        <span className="card-name">{p.name}</span>
        <Price price={p.price} priceMax={p.price_max} compareAt={p.compare_at} currency={currency} />
      </a>
    </li>
  );
}

/** layout (2.63): '' = the grid; 'carousel' = one row that scrolls sideways */
export function ProductGrid({ items, currency, eagerFirst = 0, layout = '' }: { items: Card[]; currency: string; eagerFirst?: number; layout?: string }) {
  return <ul className={layout === 'carousel' ? 'grid grid--carousel' : 'grid'} role="list">{items.map((p, i) => <ProductCard key={p.slug} p={p} currency={currency} eager={i < eagerFirst} />)}</ul>;
}

/** 2.58: before there are products, the owner's preview shows where they will be — shapes only, never a made-up product */
export function PlaceholderGrid({ count = 4, label = 'כאן יופיע מוצר', layout = '' }: { count?: number; label?: string; layout?: string }) {
  return (
    <ul className={layout === 'carousel' ? 'grid grid--carousel' : 'grid'} role="list" aria-label="מקום למוצרים">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="card card-placeholder">
          <span className="card-link">
            <span className="card-media"><span className="card-noimage" aria-hidden="true"><Art /></span></span>
            <span className="card-name muted">{label}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** structured data for search engines; nothing inside can close the tag */
export function JsonLd({ data, nonce }: { data: unknown; nonce?: string }) {
  return <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonForScript(data) }} />;
}

/** the text of a page: "## " / "### " titles, "- " lists, paragraphs (a blank line between them) — plain text only (React
 *  escapes it), no HTML */
export function RichText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) { const lines = para; out.push(<p key={out.length}>{lines.map((l, j) => <span key={j}>{j > 0 && <br />}{l}</span>)}</p>); para = []; }
    if (list.length) { const items = list; out.push(<ul key={out.length}>{items.map((l, j) => <li key={j}>{l}</li>)}</ul>); list = []; }
  };
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = line.match(/^(#{2,3})\s+(.+)$/);
    if (h) { flush(); out.push(h[1].length === 2 ? <h2 key={out.length}>{h[2]}</h2> : <h3 key={out.length}>{h[2]}</h3>); continue; }
    const li = line.match(/^[-*•]\s+(.+)$/);
    if (li) { if (para.length) flush(); list.push(li[1]); continue; }
    if (list.length) flush();
    para.push(line);
  }
  flush();
  return <div className="prose">{out}</div>;
}

/**
 * Where the business has no picture yet (decorative): the drawn bag, or a plain shape (2.58). Both are in the page; the
 * theme's CSS (themeCss) hides the one its template does not use — so a product card needs no theme to draw it.
 */
export function Art({ className = '' }: { className?: string }) {
  return <><BagArt className={className} /><PlainArt className={className} /></>;
}

/** a plain shape in the theme's colours: a frame, a sun and two hills — no subject, so it fits any business */
export function PlainArt({ className = '' }: { className?: string }) {
  return (
    <svg className={`plain-art ${className}`} viewBox="0 0 320 360" role="presentation" aria-hidden="true" focusable="false">
      <rect x="40" y="60" width="240" height="240" rx="24" className="plain-frame" />
      <circle cx="200" cy="130" r="26" className="plain-sun" />
      <path d="M40 260l70-74 56 58 34-34 80 80v-6a24 24 0 0 1-24 24H64a24 24 0 0 1-24-24z" className="plain-hills" />
    </svg>
  );
}

/** the drawn bag of the template, when the business has no picture yet (decorative) */
export function BagArt({ className = '' }: { className?: string }) {
  return (
    <svg className={`bag-art ${className}`} viewBox="0 0 320 360" role="presentation" aria-hidden="true" focusable="false">
      <path d="M110 92c0-36 22-62 50-62s50 26 50 62" fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round" className="bag-handle" />
      <path d="M58 96h204l22 236a12 12 0 0 1-12 13H48a12 12 0 0 1-12-13z" className="bag-body" />
      <path d="M58 96h204l6 64H52z" className="bag-fold" />
      <circle cx="122" cy="118" r="7" className="bag-hole" /><circle cx="198" cy="118" r="7" className="bag-hole" />
      <rect x="110" y="200" width="100" height="70" rx="14" className="bag-logo" />
      <path d="M134 236h52M148 252h24" stroke="currentColor" strokeWidth="8" strokeLinecap="round" className="bag-logo-lines" />
    </svg>
  );
}
