'use client';
import { useState } from 'react';
import { postJson } from './cart-client';

/**
 * "ביטול / החזרה" — from the order's page (ref) or from /cancel (the order's number + email). The answer says what was
 * recorded; nothing is charged or refunded here (the business answers and refunds).
 */
export function OrderRequest({ orderRef }: { orderRef?: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v)]));
    if (orderRef) body.ref = orderRef;
    setBusy(true); setError('');
    const r = await postJson('/api/order-request', body);
    setBusy(false);
    if (r.ok) setDone(String(r.message ?? 'הבקשה התקבלה.')); else setError(String(r.message ?? 'משהו השתבש. נסו שוב.'));
  }
  if (done) return <p className="note" role="status">{done}</p>;
  return (
    <form onSubmit={submit} className="checkout" noValidate>
      {!orderRef && <>
        <div className="field"><label htmlFor="r-number">מספר הזמנה</label><input id="r-number" name="number" inputMode="numeric" required autoComplete="off" /></div>
        <div className="field"><label htmlFor="r-email">האימייל שאיתו הזמנתם</label><input id="r-email" name="email" type="email" required autoComplete="email" dir="ltr" /></div>
      </>}
      <fieldset className="field">
        <legend>מה מבקשים</legend>
        <label className="choice"><input type="radio" name="kind" value="cancel" defaultChecked /> <span>ביטול ההזמנה</span></label>
        <label className="choice"><input type="radio" name="kind" value="return" /> <span>החזרת מוצר</span></label>
      </fieldset>
      <div className="field"><label htmlFor="r-note">פרטים (לא חובה)</label><textarea id="r-note" name="note" rows={3} maxLength={500} /></div>
      <div className="trap" aria-hidden="true"><label htmlFor="r-website">אתר</label><input id="r-website" name="website" tabIndex={-1} autoComplete="off" /></div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'שולח…' : 'שליחת הבקשה'}</button>
    </form>
  );
}
