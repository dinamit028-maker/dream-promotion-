'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { whatsappHref } from '@/lib/format';
import { facetValues, filterItems, minQtyLabel, NO_FILTER, quoteMessage, type FacetKey, type Filter, type ShowcaseItem } from '@/lib/showcase';
import { onColor } from '@/lib/theme-tokens';

const PAGE = 12;

/**
 * The catalog of models (2.101, the section "showcase"): filters by category (chips) and by handle and material (lists),
 * 12 at a time, and on every model a button that asks for a quote on WhatsApp — the model's name and brand in the message
 * (the contact section when the store has no WhatsApp). A link on the page to "#<this section>" with data-cat (a category
 * card) opens the catalog on that category. No cart, no price: a model is not a product.
 */
export function Showcase({ id, items, store, whatsapp, contact, buttonLabel }: {
  id: string; items: ShowcaseItem[]; store: string; whatsapp: string; contact: boolean; buttonLabel: string;
}) {
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [shown, setShown] = useState(PAGE);
  const values = useMemo(() => facetValues(items), [items]);
  const list = useMemo(() => filterItems(items, filter), [items, filter]);
  const grid = useRef<HTMLUListElement>(null);
  const cats = useRef<HTMLDivElement>(null);
  const focusFrom = useRef<number | null>(null);
  const active = filter.category || filter.handle || filter.material;

  const choose = (key: FacetKey, value: string) => { setFilter((f) => ({ ...f, [key]: value })); setShown(PAGE); };
  const clear = () => { setFilter(NO_FILTER); setShown(PAGE); };
  // how many models a choice would leave, with the other two filters as they are
  const count = (key: FacetKey, value: string) => filterItems(items, { ...filter, [key]: value }).length;

  // a category card of the page ("/#catalog", data-cat): the catalog opens on that category (the link scrolls here itself)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[data-cat]');
      if (!(a instanceof HTMLAnchorElement) || e.defaultPrevented) return;
      const url = new URL(a.href, window.location.href);
      if (url.pathname !== window.location.pathname || url.hash !== `#${id}`) return;
      const cat = a.dataset.cat ?? '';
      setFilter({ ...NO_FILTER, category: values.category.includes(cat) ? cat : '' });
      setShown(PAGE);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [id, values]);

  // the chosen category in sight, in its row that scrolls on a phone (a category card chooses it from afar)
  useEffect(() => {
    const row = cats.current, chip = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!row || !chip) return;
    const r = row.getBoundingClientRect(), c = chip.getBoundingClientRect();
    if (c.left < r.left) row.scrollBy({ left: c.left - r.left - 16 });
    else if (c.right > r.right) row.scrollBy({ left: c.right - r.right + 16 });
  }, [filter.category]);

  // "עוד דגמים": the first new model takes the focus, so a keyboard or a screen reader goes on from there
  useEffect(() => {
    if (focusFrom.current === null) return;
    const el = grid.current?.children[focusFrom.current];
    focusFrom.current = null;
    if (el instanceof HTMLElement) el.focus();
  }, [shown]);

  const visible = list.slice(0, shown);
  const rest = list.length - visible.length;
  const label = buttonLabel || 'בקשת הצעת מחיר';

  return (
    <div className="sc">
      <svg className="sc-defs" aria-hidden="true" focusable="false" width="0" height="0">
        <defs>
          <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#ffffff" stopOpacity=".2" /><stop offset=".55" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="1" stopColor="#000000" stopOpacity=".12" />
          </linearGradient>
        </defs>
      </svg>
      <div className="sc-filters">
        {values.category.length > 1 && (
          <div ref={cats} className="sc-cats" role="group" aria-label="קטגוריה">
            {['', ...values.category].map((v) => {
              const on = filter.category === v;
              const n = v ? count('category', v) : 0;
              return (
                <button key={v || '*'} type="button" className={`chip${on ? ' chip-on' : ''}${v && !n ? ' chip-off' : ''}`} aria-pressed={on} onClick={() => choose('category', v)}>
                  {v || 'הכול'}{v && !n && <span className="sr-only"> (אין דגמים בשילוב הזה)</span>}
                </button>
              );
            })}
          </div>
        )}
        <div className="sc-selects">
          {(['handle', 'material'] as const).filter((k) => values[k].length > 1).map((k) => (
            <label key={k} className="sc-select">
              <span>{k === 'handle' ? 'ידית' : 'חומר'}</span>
              <select value={filter[k]} onChange={(e) => choose(k, e.target.value)}>
                <option value="">הכול</option>
                {values[k].map((v) => {
                  const n = count(k, v);
                  return <option key={v} value={v} disabled={!n && filter[k] !== v}>{`${v} (${n})`}</option>;
                })}
              </select>
            </label>
          ))}
        </div>
        <div className="sc-status">
          <p role="status" className="sc-count">
            {!list.length ? 'אין דגמים בשילוב הזה' : list.length === 1 ? 'דגם אחד'
              : rest > 0 ? `מוצגים ${visible.length} מתוך ${list.length} דגמים` : `${list.length} דגמים`}
          </p>
          {active && <button type="button" className="link-button" onClick={clear}>ניקוי הסינון</button>}
        </div>
      </div>
      <ul ref={grid} className="sc-grid" role="list">
        {visible.map((it) => {
          const wa = whatsappHref(whatsapp, quoteMessage(it, store));
          const href = wa ?? (contact ? '#contact' : null);
          return (
            <li key={it.n} className="sc-item" tabIndex={-1} aria-labelledby={`${id}-m${it.n}`}>
              <article className="sc-card fcard">
                <div className="sc-media">
                  {it.picture
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={it.picture.src} alt={it.picture.alt} className={it.picture.className || undefined} loading="lazy" decoding="async" />
                    : <BrandBag color={it.color} brand={it.brand} shine={`${id}-shine`} />}
                </div>
                <div className="sc-body">
                  {it.brand && <p className="sc-brand"><bdi>{it.brand}</bdi></p>}
                  <h3 id={`${id}-m${it.n}`} className="sc-name">{it.name}</h3>
                  {it.text && <p className="sc-text">{it.text}</p>}
                  <dl className="sc-facts">
                    {([['חומר', it.material], ['ידית', it.handle], ['גימור', it.finish], ['צורה', it.shape]] as const).filter(([, v]) => v).map(([k, v]) => (
                      <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
                    ))}
                  </dl>
                  {it.minQty ? <p className="sc-min">{minQtyLabel(it.minQty)}</p> : null}
                  {href && (
                    <a className="btn btn-primary sc-quote" href={href} {...(wa ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                      {label}<span className="sr-only"> — {it.name}{wa ? ' (וואטסאפ, בחלון חדש)' : ''}</span>
                    </a>
                  )}
                </div>
              </article>
            </li>
          );
        })}
      </ul>
      {!list.length && <div className="actions center"><button type="button" className="btn btn-ghost" onClick={clear}>ניקוי הסינון</button></div>}
      {rest > 0 && (
        <div className="actions center">
          <button type="button" className="btn btn-ghost" onClick={() => { focusFrom.current = visible.length; setShown((s) => s + PAGE); }}>
            עוד דגמים ({rest})
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A model with no picture yet: a bag drawn in its brand's colour, the brand's name on it in gold (a dark bag) or in ink (a
 * light one). Decorative — the card has the words. Colours as SVG attributes (the CSP blocks style attributes).
 */
function BrandBag({ color, brand, shine }: { color: string; brand: string; shine: string }) {
  const fill = color || '#2a2622';
  const ink = onColor(fill) === '#ffffff' ? '#d8b66e' : '#2b2118';
  const word = brand.toUpperCase();
  const spacing = word.length > 8 ? 1 : 2.5;
  const size = Math.max(6, Math.min(12, (92 / Math.max(word.length, 1) - spacing) / 0.72));
  return (
    <svg className="sc-bag" viewBox="0 0 200 220" aria-hidden="true" focusable="false">
      <ellipse cx="102" cy="204" rx="74" ry="9" fill="#000000" fillOpacity=".16" />
      <path d="M78 74C78 30 128 30 128 74" fill="none" stroke={ink} strokeOpacity=".55" strokeWidth="4" strokeLinecap="round" />
      <path d="M38 80L62 70H166L142 80Z" fill={fill} /><path d="M38 80L62 70H166L142 80Z" fill="#000000" fillOpacity=".38" />
      <path d="M142 80L166 70L170 186L144 198Z" fill={fill} /><path d="M142 80L166 70L170 186L144 198Z" fill="#000000" fillOpacity=".24" />
      <path d="M38 80H142L144 198H36Z" fill={fill} stroke="#000000" strokeOpacity=".1" />
      <path d="M38 80H142L144 198H36Z" fill={`url(#${shine})`} />
      <path d="M64 88C64 40 116 40 116 88" fill="none" stroke={ink} strokeWidth="4.5" strokeLinecap="round" />
      <circle cx="64" cy="92" r="3" fill={ink} /><circle cx="116" cy="92" r="3" fill={ink} />
      {word && (
        <>
          <text x="90" y="146" textAnchor="middle" fill={ink} fontSize={size.toFixed(1)} letterSpacing={spacing} fontWeight="600">{word}</text>
          <path d="M74 156H106" stroke={ink} strokeOpacity=".5" strokeWidth="1" />
        </>
      )}
    </svg>
  );
}
