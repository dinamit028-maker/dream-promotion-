'use client';
import { useState } from 'react';
import { money } from '@/lib/format';
import type { Cart } from '@/lib/types';
import { postJson } from './cart-client';

const LABEL: Record<string, string> = {
  name: 'שם מלא', phone: 'טלפון', email: 'אימייל', method: 'איך מקבלים את ההזמנה', city: 'עיר', street: 'רחוב', house: 'מספר בית',
  apartment: 'דירה', notes: 'הערות', terms: 'אישור התקנון ומדיניות הביטולים',
};
const FIX: Record<string, string> = {
  name: 'שם מלא, בין 2 ל-80 תווים.', phone: 'מספר טלפון ישראלי (למשל 050-1234567) או בינלאומי עם +.', email: 'כתובת אימייל, לשם נשלח האישור.',
  method: 'בחרו איסוף או משלוח.', city: 'עיר.', street: 'רחוב.', house: 'מספר בית.', apartment: 'עד 10 תווים.', notes: 'עד 500 תווים.',
  terms: 'צריך לאשר את התקנון ואת מדיניות הביטולים.',
};

/**
 * The customer's details and "לתשלום". The total shown here is a preview of the server's: the order's amount is computed by
 * the database, and the card is typed only on the payment provider's page (the browser is sent there).
 */
export function CheckoutForm({ cart, hasTerms }: { cart: Cart; hasTerms: boolean }) {
  const pickup = cart.shipping.pickup, delivery = cart.shipping.delivery;
  const [method, setMethod] = useState<'pickup' | 'delivery'>(pickup ? 'pickup' : 'delivery');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [bad, setBad] = useState<string[]>([]);
  const [stock, setStock] = useState<{ name: string; available: number }[]>([]);
  const cur = cart.currency;
  const ship = method === 'delivery' && delivery ? delivery.price : 0;
  const total = Math.round((cart.subtotal - cart.discount + ship) * 100) / 100;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v)]));
    body.terms = f.get('terms') === 'on';
    setBusy(true); setError(''); setBad([]); setStock([]);
    const r = await postJson('/api/checkout', body);
    if (r.ok && r.url) { window.location.assign(r.url); return; }
    setBusy(false);
    setError(r.message || 'משהו השתבש. נסו שוב.');
    setBad(r.fields ?? []);
    setStock(r.lines ?? []);
    if (r.fields?.length) document.getElementById(`f-${r.fields[0]}`)?.focus();
  }
  const invalid = (k: string) => bad.includes(k);
  const field = (k: string, props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <div className="field">
      <label htmlFor={`f-${k}`}>{LABEL[k]}{props.required ? '' : ' (לא חובה)'}</label>
      <input id={`f-${k}`} name={k} aria-invalid={invalid(k) || undefined} aria-describedby={invalid(k) ? `e-${k}` : undefined} {...props} />
      {invalid(k) && <span id={`e-${k}`} className="field-error">{FIX[k]}</span>}
    </div>
  );

  return (
    <form className="checkout" onSubmit={submit} noValidate>
      <fieldset>
        <legend>פרטים</legend>
        {field('name', { required: true, autoComplete: 'name', maxLength: 80 })}
        {field('phone', { required: true, type: 'tel', inputMode: 'tel', autoComplete: 'tel', dir: 'ltr', maxLength: 20 })}
        {field('email', { required: true, type: 'email', inputMode: 'email', autoComplete: 'email', dir: 'ltr', maxLength: 120 })}
      </fieldset>
      <fieldset aria-describedby={invalid('method') ? 'e-method' : undefined}>
        <legend>{LABEL.method}</legend>
        {pickup && (
          <label className="choice">
            <input type="radio" name="method" value="pickup" checked={method === 'pickup'} onChange={() => setMethod('pickup')} />
            <span><strong>איסוף עצמי</strong> · חינם{pickup.note && <span className="muted"> — {pickup.note}</span>}</span>
          </label>
        )}
        {delivery && (
          <label className="choice">
            <input type="radio" name="method" value="delivery" checked={method === 'delivery'} onChange={() => setMethod('delivery')} />
            <span><strong>משלוח</strong> · {delivery.price > 0 ? <bdi>{money(delivery.price, cur)}</bdi> : 'חינם'}{delivery.note && <span className="muted"> — {delivery.note}</span>}</span>
          </label>
        )}
        {invalid('method') && <span id="e-method" className="field-error">{FIX.method}</span>}
      </fieldset>
      {method === 'delivery' && (
        <fieldset>
          <legend>כתובת למשלוח</legend>
          {field('city', { required: true, autoComplete: 'address-level2', maxLength: 60 })}
          {field('street', { required: true, autoComplete: 'address-line1', maxLength: 80 })}
          <div className="field-row">
            {field('house', { required: true, inputMode: 'numeric', maxLength: 10 })}
            {field('apartment', { maxLength: 10 })}
          </div>
        </fieldset>
      )}
      <div className="field">
        <label htmlFor="f-notes">{LABEL.notes} (לא חובה)</label>
        <textarea id="f-notes" name="notes" rows={3} maxLength={500} />
      </div>
      {/* a field people never see: a form that fills it is not a person */}
      <div className="trap" aria-hidden="true"><label htmlFor="f-website">אתר</label><input id="f-website" name="website" tabIndex={-1} autoComplete="off" /></div>
      <label className="choice terms">
        <input id="f-terms" type="checkbox" name="terms" aria-invalid={invalid('terms') || undefined} aria-describedby={invalid('terms') ? 'e-terms' : undefined} />
        <span>קראתי ואני מאשר/ת את {hasTerms ? <a href="/policies/terms" target="_blank">התקנון</a> : 'התקנון'} ואת <a href="/policies/returns" target="_blank">מדיניות הביטולים וההחזרות</a></span>
      </label>
      {invalid('terms') && <span id="e-terms" className="field-error">{FIX.terms}</span>}

      <dl className="sums">
        <div><dt>סכום המוצרים</dt><dd><bdi>{money(cart.subtotal, cur)}</bdi></dd></div>
        {cart.discount > 0 && <div><dt>הנחה{cart.coupon?.code ? ` (${cart.coupon.code})` : ''}</dt><dd><bdi>−{money(cart.discount, cur)}</bdi></dd></div>}
        <div><dt>{method === 'delivery' ? 'משלוח' : 'איסוף עצמי'}</dt><dd>{ship > 0 ? <bdi>{money(ship, cur)}</bdi> : 'חינם'}</dd></div>
        <div className="sum-total"><dt>לתשלום</dt><dd><bdi>{money(total, cur)}</bdi></dd></div>
      </dl>
      <div role="alert" className={error ? 'note note-bad' : 'sr-only'}>
        {error}
        {stock.length > 0 && <ul>{stock.map((s, i) => <li key={i}>{s.name}: {s.available > 0 ? `נשארו ${s.available}` : 'אזל'}</li>)}</ul>}
        {stock.length > 0 && <a href="/cart">לעדכון הסל</a>}
      </div>
      {cart.test && <p className="note note-test">חנות בבדיקה: זה תשלום ניסיון בסביבת הבדיקה של ספק הסליקה. לא יחויב כסף, ולא תיווצר מכירה.</p>}
      <button type="submit" className="btn btn-primary btn-wide" disabled={busy} aria-disabled={busy}>
        {busy ? 'פותחים את עמוד התשלום…' : `לתשלום מאובטח · ${money(total, cur)}`}
      </button>
      <p className="muted small center">פרטי הכרטיס מוזנים בעמוד של חברת הסליקה, ולא נשמרים אצלנו.</p>
    </form>
  );
}
