'use client';
import { useEffect } from 'react';
import { announceCount } from './cart-client';

/** a page that knows the cart's count (an order was paid: the cart is empty) tells the header */
export function CartCount({ n }: { n: number }) {
  useEffect(() => { announceCount(n); }, [n]);
  return null;
}
