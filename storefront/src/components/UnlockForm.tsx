'use client';
import { useState } from 'react';
import { postJson } from './cart-client';

/** "בקרוב" with the password the owner shared: right → the store opens (a cookie of this address), wrong → says so */
export function UnlockForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError('');
    const r = await postJson('/api/unlock', { password: String(f.get('password') ?? ''), website: String(f.get('website') ?? '') });
    if (r.ok) { window.location.reload(); return; }
    setBusy(false);
    setError(String(r.message ?? 'משהו השתבש. נסו שוב.'));
  }
  return (
    <form onSubmit={submit} className="unlock" noValidate>
      <div className="field">
        <label htmlFor="u-password">יש לכם סיסמה? כניסה לאתר</label>
        <input id="u-password" name="password" type="password" autoComplete="current-password" required
          aria-invalid={error ? true : undefined} aria-describedby={error ? 'u-error' : undefined} />
      </div>
      <div className="trap" aria-hidden="true"><label htmlFor="u-website">אתר</label><input id="u-website" name="website" tabIndex={-1} autoComplete="off" /></div>
      {error && <p id="u-error" className="field-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'בודק…' : 'כניסה'}</button>
    </form>
  );
}
