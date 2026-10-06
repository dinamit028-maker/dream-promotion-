'use client';
import type { Cart } from '@/lib/types';

/** the browser's side of the cart: one JSON request to this store's own server, and a signal for the header's badge */
export interface CartAnswer { ok: boolean; error?: string; message?: string; available?: number; cart?: Cart; url?: string;
  fields?: string[]; lines?: { name: string; available: number }[] }

export async function postJson(path: string, body: unknown): Promise<CartAnswer> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    const j = await res.json().catch(() => null);
    return j && typeof j === 'object' ? j : { ok: false, message: 'משהו השתבש. נסו שוב.' };
  } catch {
    return { ok: false, message: 'אין חיבור לאינטרנט. נסו שוב.' };
  }
}

export const CART_EVENT = 'sf-cart';
/** the header's count changes now, and stays right on the next page (the same small cookie the cart's answers write) */
export function announceCount(count: number) {
  const n = Math.max(0, Math.floor(count) || 0);
  document.cookie = `sf_cart_n=${n}; path=/; max-age=${30 * 86400}; samesite=lax${location.protocol === 'https:' ? '; secure' : ''}`;
  window.dispatchEvent(new CustomEvent(CART_EVENT, { detail: n }));
}
export function countFromCookie(): number {
  const m = /(?:^|;\s*)sf_cart_n=(\d{1,3})/.exec(document.cookie);
  return m ? Number(m[1]) : 0;
}
