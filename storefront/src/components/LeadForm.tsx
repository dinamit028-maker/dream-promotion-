'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { FIELD_ERRORS, LEAD_ERRORS, LEAD_SENT, MODEL, topicsOf, type LeadField, type LeadKind } from '@/lib/leads';
import { postJson } from './cart-client';

/** one id per filled form (a retry is the same request); crypto.randomUUID needs https, getRandomValues does not */
function requestId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * A request from the site (2.102): "בקשת הצעת מחיר" of a product sold by a quote (kind quote — the model's code is filled in by
 * itself), or the contact form (kind contact — a model from the address, ?model=bag-032 or ?design=bag-032, is filled in too).
 * It goes to the store's own server (/api/lead), which records it in the business's leads; "נשלח" only after it was recorded.
 */
export function LeadForm({ kind, item = null, model = '', min = null, topics = '', submitLabel, autoFocus = false, tone = 'light' }: {
  kind: LeadKind; item?: string | null; model?: string; min?: number | null; topics?: string; submitLabel?: string;
  autoFocus?: boolean; tone?: 'light' | 'dark';
}) {
  const uid = useId();
  const request = useRef('');
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const [bad, setBad] = useState<LeadField[]>([]);
  const [asked, setAsked] = useState(model);
  const choices = topicsOf(topics);

  // the contact form: a model from the address it was opened with
  useEffect(() => {
    if (kind !== 'contact') return;
    const sp = new URLSearchParams(window.location.search);
    const m = (sp.get('model') || sp.get('design') || '').trim();
    if (m && MODEL.test(m)) setAsked(m);
  }, [kind]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? '');
    if (!request.current) request.current = requestId();
    setBusy(true); setError(''); setBad([]);
    const r = await postJson('/api/lead', {
      kind, request: request.current, item, model: kind === 'contact' ? asked : '', page: window.location.pathname,
      name: v('name'), phone: v('phone'), email: v('email'), qty: v('qty'), topic: v('topic'), notes: v('notes'), website: v('website'),
    });
    setBusy(false);
    if (r.ok) { setDone(r.message || LEAD_SENT[kind]); return; }
    if (r.error === 'details' && Array.isArray(r.fields) && r.fields.length) {
      const fields = r.fields.filter((x): x is LeadField => x in FIELD_ERRORS);
      setBad(fields); setError(LEAD_ERRORS.details);
      form.current?.querySelector<HTMLElement>(`[name="${fields[0] === 'model' ? 'notes' : fields[0]}"]`)?.focus();
      return;
    }
    setError(r.message || LEAD_ERRORS.error);
  }
  // a field being fixed loses its message (the others keep theirs until the next "שליחה")
  function fixing(e: React.FormEvent<HTMLFormElement>) {
    const name = (e.target as HTMLInputElement).name as LeadField;
    if (!bad.includes(name)) return;
    const left = bad.filter((x) => x !== name);
    setBad(left);
    if (!left.length) setError('');
  }

  if (done) return <p className={`note note-ok lead-done lead-${tone}`} role="status">{done}</p>;
  const id = (k: string) => `${uid}-${k}`;
  const err = (k: LeadField) => (bad.includes(k) ? { 'aria-invalid': true as const, 'aria-describedby': id(`${k}-e`) } : {});
  const msg = (k: LeadField) => (bad.includes(k) ? <p id={id(`${k}-e`)} className="field-error">{FIELD_ERRORS[k]}</p> : null);
  return (
    <form ref={form} onSubmit={submit} onChange={fixing} className={`lead-form lead-${tone}`} noValidate>
      {asked && <p className="lead-model">קוד דגם: <bdi dir="ltr">{asked}</bdi>{kind === 'contact' && <button type="button" className="lead-model-x" onClick={() => setAsked('')} aria-label="הסרת קוד הדגם">×</button>}</p>}
      {bad.includes('model') && <p className="field-error">{FIELD_ERRORS.model}</p>}
      <div className="field"><label htmlFor={id('name')}>שם</label>
        <input id={id('name')} name="name" required maxLength={80} autoComplete="name" autoFocus={autoFocus} {...err('name')} />{msg('name')}</div>
      <div className="field"><label htmlFor={id('phone')}>טלפון</label>
        <input id={id('phone')} name="phone" type="tel" required maxLength={20} autoComplete="tel" inputMode="tel" dir="ltr" {...err('phone')} />{msg('phone')}</div>
      {kind === 'contact' && (
        <div className="field"><label htmlFor={id('email')}>אימייל (לא חובה)</label>
          <input id={id('email')} name="email" type="email" maxLength={120} autoComplete="email" dir="ltr" {...err('email')} />{msg('email')}</div>
      )}
      {kind === 'quote' && (
        <div className="field"><label htmlFor={id('qty')}>כמות משוערת{min ? ` (מינימום ${min.toLocaleString('he-IL')})` : ''}</label>
          <input id={id('qty')} name="qty" inputMode="numeric" maxLength={10} autoComplete="off" dir="ltr" {...err('qty')} />{msg('qty')}</div>
      )}
      {kind === 'contact' && choices.length > 0 && (
        <div className="field"><label htmlFor={id('topic')}>נושא</label>
          <select id={id('topic')} name="topic" defaultValue="">
            <option value="">בחירה (לא חובה)</option>
            {choices.map((t) => <option key={t} value={t}>{t}</option>)}
          </select></div>
      )}
      <div className="field"><label htmlFor={id('notes')}>{kind === 'quote' ? 'מה חשוב לדעת (צבעים, מידה, לוגו) — לא חובה' : 'במה נוכל לעזור?'}</label>
        <textarea id={id('notes')} name="notes" rows={3} maxLength={1000} {...err('notes')} />{msg('notes')}</div>
      <div className="trap" aria-hidden="true"><label htmlFor={id('website')}>אתר</label><input id={id('website')} name="website" tabIndex={-1} autoComplete="off" /></div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary btn-wide" disabled={busy}>{busy ? 'שולחים…' : submitLabel || (kind === 'quote' ? 'שליחת הבקשה' : 'שליחה')}</button>
    </form>
  );
}
