'use client';
import { useState } from 'react';
import { announceCount, postJson } from './cart-client';

/** "הוספה לסל": one unit of the chosen variant; the answer (and how many are left) comes from the store's server */
export function AddToCart({ item, variant, disabled, label }: { item: string; variant: string | null; disabled: boolean; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function add() {
    setBusy(true); setMsg(null);
    const r = await postJson('/api/cart', { action: 'add', item, variant, qty: 1 });
    setBusy(false);
    if (r.ok && r.cart) { announceCount(r.cart.count); setMsg({ ok: true, text: 'נוסף לסל' }); }
    else setMsg({ ok: false, text: r.message || 'לא הצלחנו להוסיף לסל. נסו שוב.' });
  }
  return (
    <div className="add-to-cart">
      <button type="button" className="btn btn-primary btn-wide" disabled={disabled || busy} aria-disabled={disabled || busy} onClick={add}>
        {busy ? 'מוסיפים…' : label ?? 'הוספה לסל'}
      </button>
      <p className={msg ? (msg.ok ? 'note note-ok' : 'note note-bad') : 'sr-only'} role="status" aria-live="polite">
        {msg?.text}{msg?.ok && <> · <a href="/cart">מעבר לסל</a></>}
      </p>
    </div>
  );
}
