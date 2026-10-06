'use client';
import { useEffect, useState } from 'react';
import { money } from '@/lib/format';
import type { Cart, CartLine } from '@/lib/types';
import { announceCount, postJson } from './cart-client';

const PROBLEM: Record<string, string> = { gone: 'המוצר כבר לא זמין — הסירו אותו מהסל.', out: 'אזל מהמלאי — הסירו אותו מהסל.', short: 'אין מספיק במלאי — הקטינו את הכמות.' };
const COUPON: Record<string, string> = { not_found: 'הקופון הזה לא קיים.', not_started: 'הקופון עוד לא בתוקף.', ended: 'הקופון כבר לא בתוקף.', used_up: 'הקופון כבר נוצל.' };

/** the cart: change a quantity, remove a line, a coupon; the sums are always the ones the store's server returned */
export function CartView({ initial }: { initial: Cart }) {
  const [cart, setCart] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [code, setCode] = useState(initial.coupon?.code ?? '');
  const cur = cart.currency;
  useEffect(() => { announceCount(initial.count); }, [initial.count]);

  async function send(body: Record<string, unknown>) {
    setBusy(true); setMsg('');
    const r = await postJson('/api/cart', body);
    setBusy(false);
    if (r.cart) { setCart(r.cart); announceCount(r.cart.count); }
    if (!r.ok) setMsg(r.message || 'משהו השתבש. נסו שוב.');
    return r;
  }
  const setQty = (l: CartLine, qty: number) => send({ action: 'set', item: l.item, variant: l.variant, qty });

  const lines = cart.lines;
  if (!lines.length) {
    return (
      <div className="empty-cart">
        <p>הסל ריק.</p>
        <a href="/collections/all" className="btn btn-primary">לכל המוצרים</a>
      </div>
    );
  }
  const couponErr = cart.coupon?.error === 'min_subtotal' ? `הקופון תקף מסכום של ${money(cart.coupon.min ?? 0, cur)}.` : cart.coupon?.error ? COUPON[cart.coupon.error] : '';
  const delivery = cart.shipping.delivery;
  return (
    <div className="cart-grid">
      <ul className="cart-lines" role="list" aria-busy={busy}>
        {lines.map((l) => (
          <li key={`${l.item}:${l.variant ?? ''}`} className={`cart-line${l.problem ? ' cart-line-bad' : ''}`}>
            <a href={`/products/${encodeURIComponent(l.slug)}`} className="cart-thumb" tabIndex={-1} aria-hidden="true">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {l.image?.url ? <img src={l.image.sizes?.['400'] || l.image.url} alt="" width={72} height={90} loading="lazy" /> : <span className="cart-noimg" />}
            </a>
            <div className="cart-info">
              <a href={`/products/${encodeURIComponent(l.slug)}`} className="cart-name">{l.name}</a>
              {l.variant_label && <span className="muted">{l.variant_label}</span>}
              <span><bdi>{money(l.price, cur)}</bdi></span>
              {l.problem && <span className="note note-bad">{PROBLEM[l.problem]}{l.problem === 'short' && l.available != null ? ` (נשארו ${l.available})` : ''}</span>}
            </div>
            <div className="cart-qty">
              <div className="stepper" role="group" aria-label={`כמות: ${l.name}`}>
                <button type="button" onClick={() => setQty(l, l.qty - 1)} disabled={busy} aria-label="פחות אחד">−</button>
                <output aria-live="polite">{l.qty}</output>
                <button type="button" onClick={() => setQty(l, l.qty + 1)} disabled={busy || l.qty >= l.max || Boolean(l.problem)} aria-label="עוד אחד">+</button>
              </div>
              <button type="button" className="link-button" onClick={() => setQty(l, 0)} disabled={busy}>הסרה</button>
              {l.line_total != null && <bdi className="cart-line-total">{money(l.line_total, cur)}</bdi>}
            </div>
          </li>
        ))}
      </ul>
      <aside className="cart-summary" aria-labelledby="sum-t">
        <h2 id="sum-t" className="summary-title">סיכום</h2>
        <form className="coupon" onSubmit={(e) => { e.preventDefault(); void send({ action: 'coupon', code }); }}>
          <label htmlFor="coupon">קוד קופון</label>
          <div className="coupon-row">
            <input id="coupon" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoComplete="off" maxLength={30} dir="ltr" />
            <button type="submit" className="btn btn-ghost" disabled={busy}>החלה</button>
          </div>
          {cart.coupon?.code && !cart.coupon.error && (
            <p className="note note-ok">הקופון {cart.coupon.code} הוחל · <button type="button" className="link-button" onClick={() => { setCode(''); void send({ action: 'coupon', code: '' }); }}>הסרה</button></p>
          )}
          {couponErr && <p className="note note-bad">{couponErr}</p>}
        </form>
        <dl className="sums">
          <div><dt>סכום המוצרים</dt><dd><bdi>{money(cart.subtotal, cur)}</bdi></dd></div>
          {cart.discount > 0 && <div><dt>הנחה</dt><dd><bdi>−{money(cart.discount, cur)}</bdi></dd></div>}
          {delivery && <div><dt>משלוח</dt><dd>{delivery.price > 0 ? <bdi>{money(delivery.price, cur)}</bdi> : 'חינם'}</dd></div>}
          {cart.shipping.pickup && <div><dt>איסוף עצמי</dt><dd>חינם</dd></div>}
        </dl>
        {delivery?.free_over != null && delivery.price > 0 && (
          <p className="muted small">משלוח חינם מעל <bdi>{money(delivery.free_over, cur)}</bdi></p>
        )}
        <p role="status" aria-live="polite" className={msg ? 'note note-bad' : 'sr-only'}>{msg}</p>
        {cart.test && <p className="note note-test">חנות בבדיקה: התשלום הוא תשלום ניסיון, ולא יחויב כסף.</p>}
        {cart.can_checkout
          ? <a href="/checkout" className="btn btn-primary btn-wide">להמשך לתשלום</a>
          : <button type="button" className="btn btn-primary btn-wide" disabled aria-disabled="true">{cart.problems ? 'יש בסל מוצרים שצריך לעדכן' : 'אי אפשר לשלם באתר כרגע'}</button>}
      </aside>
    </div>
  );
}
