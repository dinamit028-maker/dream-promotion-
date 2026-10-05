'use client';
import Link from 'next/link';
import { useId, useRef, useState, type ReactNode } from 'react';
import { cx } from '@/lib/utils';
import { Button, Input } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { uploadStorePicture } from '@/features/catalog/upload';
import { storeHref } from './routes';

/** a block of a store screen: a title, an optional line under it, the content */
export function Block({ title, sub, id, children, action }: { title: string; sub?: string; id?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section id={id} className="mb-5 scroll-mt-24 rounded-lg border border-line bg-surface p-4 sm:p-6" aria-labelledby={id ? `${id}-t` : undefined}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id={id ? `${id}-t` : undefined} className="text-lg font-extrabold">{title}</h3>
          {sub && <p className="mt-0.5 text-sm text-muted">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'ok' | 'warn' | 'error'; children: ReactNode }) {
  const tones = {
    info: 'border-line bg-surface-2 text-ink-2',
    ok: 'border-line bg-[var(--ok-soft)] text-ok',
    warn: 'border-line bg-[var(--warn-soft)] text-warn',
    error: 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200',
  };
  return <div role={tone === 'error' ? 'alert' : 'status'} className={cx('mb-4 rounded-md border px-4 py-3 text-sm leading-relaxed', tones[tone])}>{children}</div>;
}

/** a screen that needs the store: "open it first" (in Settings) */
export function NeedsStore() {
  return (
    <div className="rounded-lg border border-dashed border-line p-6 text-center">
      <p className="mb-3 font-semibold">עוד אין חנות לעסק הזה.</p>
      <Link href={storeHref('settings')} className="inline-flex min-h-11 items-center rounded-full bg-primary px-5 font-semibold text-white">לפתיחת החנות</Link>
    </div>
  );
}

/** a picture of the store (logo, home page): upload from the device (sizes made in the browser) or remove */
export function PicturePicker({ label, value, onChange, square }: { label: string; value: string; onChange: (url: string) => void; square?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pick = async (files: FileList | null) => {
    const file = files?.[0];   // read before anything awaits: the input is cleared right after
    if (input.current) input.current.value = '';
    if (!file) return;
    setBusy(true); setError('');
    const r = await uploadStorePicture(file);
    setBusy(false);
    if (r.ok) onChange(r.data.url); else setError(r.error);
  };
  return (
    <div className="mb-4">
      <p className="mb-2 text-sm font-semibold text-ink-2">{label}</p>
      <div className="flex flex-wrap items-center gap-3">
        {value
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={value} alt="" className={cx('rounded-md border border-line object-cover', square ? 'h-16 w-16' : 'h-16 w-28')} />
          : <span className={cx('grid place-items-center rounded-md border border-dashed border-line text-xs text-muted', square ? 'h-16 w-16' : 'h-16 w-28')}>אין</span>}
        <input ref={input} type="file" accept="image/*" className="sr-only" aria-label={label} onChange={(e) => void pick(e.target.files)} />
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? <><Spinner /> מעלה…</> : value ? 'החלפה' : 'העלאה'}</Button>
        {value && <Button type="button" variant="soft" size="sm" onClick={() => onChange('')}>הסרה</Button>}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}

/** a small text field with its label above (for dense forms); the hint is read after the field, not as its name */
export function TextRow({ label, value, onChange, placeholder, hint, max, type = 'text', dir, id }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string; max?: number; type?: string; dir?: 'ltr' | 'rtl'; id?: string;
}) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <div className="mb-4">
      <label htmlFor={fieldId} className="mb-2 block text-sm font-semibold text-ink-2">{label}</label>
      <Input id={fieldId} type={type} value={value} maxLength={max} placeholder={placeholder} dir={dir} aria-describedby={hint ? `${fieldId}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)} />
      {hint && <span id={`${fieldId}-hint`} className="mt-1 block text-xs text-muted">{hint}</span>}
    </div>
  );
}

/** a text area with its label above and a line under it (a count, a hint) that is read after it — the label is not
 *  wrapped around the field: a text area's text would become part of the label's text */
export function AreaRow({ label, value, onChange, rows = 3, max, hint, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; rows?: number; max?: number; hint?: string; placeholder?: string;
}) {
  const fieldId = useId();
  return (
    <div className="mb-4">
      <label htmlFor={fieldId} className="mb-2 block text-sm font-semibold text-ink-2">{label}</label>
      <textarea id={fieldId} className="w-full rounded-md border-[1.5px] border-line bg-surface px-4 py-3 text-[15px] leading-relaxed" rows={rows} maxLength={max}
        placeholder={placeholder} value={value} aria-describedby={hint ? `${fieldId}-hint` : undefined} onChange={(e) => onChange(e.target.value)} />
      {hint && <span id={`${fieldId}-hint`} className="mt-1 block text-xs text-muted">{hint}</span>}
    </div>
  );
}
