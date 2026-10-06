'use client';
import { useEffect, useState } from 'react';
import { CART_EVENT, countFromCookie } from './cart-client';

/** the cart in the header: how many items (from a small cookie the cart's answers keep), updated when something is added */
export function CartBadge() {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(countFromCookie());
    const on = (e: Event) => setN(Number((e as CustomEvent).detail) || 0);
    window.addEventListener(CART_EVENT, on);
    return () => window.removeEventListener(CART_EVENT, on);
  }, []);
  return (
    <a href="/cart" className="icon-link cart-link" aria-label={n ? `סל הקניות, ${n} פריטים` : 'סל הקניות'}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
        <path d="M6 8h12l-1 12H7L6 8Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M9 8V6a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {n > 0 && <span className="cart-count" aria-hidden="true">{n > 99 ? '99+' : n}</span>}
    </a>
  );
}
