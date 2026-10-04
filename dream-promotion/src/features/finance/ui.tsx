'use client';
import { useMemo, useState, type ReactNode } from 'react';
import { Chip, Input, SmallSelect } from '@/components/ui/primitives';
import { cx } from '@/lib/utils';
import { israelParts } from '@/lib/il-time';
import { ils } from '@/features/register/money';
import type { Lead } from '@/types';
import { EMPTY_CHEQUE, PAY_METHODS, type PaymentEntry, type PayMethod } from './payments';
import type { ComposeCustomer, ComposeLine } from './compose';
import { periodOf, previousPeriod, type PeriodKind } from './reports';

/** small shared pieces of the money screens (mobile first: one column on a phone, more on a wide screen) */
export { ils };
export const todayIL = () => israelParts(Date.now()).date;
export const ddmmyyyy = (d: string | null | undefined) => (d ? d.split('-').reverse().join('/') : '');

export function Stat({ label, value, hint, tone, onClick }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'bad'; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick}
      className={cx('min-w-0 rounded-2xl border border-line bg-surface p-3 text-start', onClick && 'hover:border-primary')}>
      <span className="block truncate text-xs font-semibold text-muted">{label}</span>
      <strong className={cx('mt-0.5 block truncate text-xl font-black tabular-nums', tone === 'ok' && 'text-emerald-600 dark:text-emerald-400', tone === 'warn' && 'text-amber-600 dark:text-amber-400', tone === 'bad' && 'text-red-600 dark:text-red-400')}>{value}</strong>
      {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
    </Tag>
  );
}

export function Pill({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'ok' | 'warn' | 'bad' | 'info' }) {
  const tones = { default: 'bg-surface-2 text-muted', ok: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', warn: 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
    bad: 'bg-red-500/15 text-red-700 dark:text-red-300', info: 'bg-primary-soft text-primary' };
  return <span className={cx('inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-bold', tones[tone])}>{children}</span>;
}

export function Note({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'ok' }) {
  return <p className={cx('rounded-2xl p-3 text-sm', tone === 'warn' ? 'bg-warn/10 text-warn' : tone === 'ok' ? 'bg-emerald-500/15 font-semibold' : 'bg-surface-2 text-ink-2')}>{children}</p>;
}

export interface Period { from: string; to: string; label: string; kind: PeriodKind | 'custom' }
export function periodNow(kind: PeriodKind): Period { return { ...periodOf(kind, todayIL()), kind }; }
/** this month / last month / the VAT period / this year / a range */
export function PeriodPicker({ value, onChange, vatKind = 'bimonth' }: { value: Period; onChange: (p: Period) => void; vatKind?: 'month' | 'bimonth' }) {
  const t = todayIL();
  const opts: [string, Period][] = [
    ['החודש', periodNow('month')], ['חודש קודם', { ...previousPeriod('month', t), kind: 'month' }],
    [vatKind === 'bimonth' ? 'תקופת מע״מ' : 'חודש מע״מ', periodNow(vatKind)], ['השנה', periodNow('year')],
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {opts.map(([label, p]) => <Chip key={label} on={value.from === p.from && value.to === p.to} onClick={() => onChange(p)}>{label}</Chip>)}
      <label className="flex items-center gap-1 text-xs text-muted">מ־
        <input type="date" value={value.from} max={value.to} onChange={(e) => e.target.value && onChange({ from: e.target.value, to: value.to, label: 'טווח', kind: 'custom' })}
          className="h-9 rounded-full border border-line bg-surface px-2 text-sm" aria-label="מתאריך" /></label>
      <label className="flex items-center gap-1 text-xs text-muted">עד
        <input type="date" value={value.to} min={value.from} onChange={(e) => e.target.value && onChange({ from: value.from, to: e.target.value, label: 'טווח', kind: 'custom' })}
          className="h-9 rounded-full border border-line bg-surface px-2 text-sm" aria-label="עד תאריך" /></label>
    </div>
  );
}

/** a customer from the contacts (name, phone, email and the invoice details saved on the card) or typed in */
export function CustomerFields({ value, onChange, leads, leadId, onLead, needName }: {
  value: ComposeCustomer; onChange: (c: ComposeCustomer) => void; leads: Lead[]; leadId: string | null; onLead: (id: string | null) => void; needName?: boolean;
}) {
  const [q, setQ] = useState('');
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    return leads.filter((l) => l.name.toLowerCase().includes(s) || (l.phone ?? '').replace(/\D/g, '').includes(s.replace(/\D/g, '') || '§')).slice(0, 6);
  }, [q, leads]);
  const pick = (l: Lead) => {
    onLead(l.id);
    onChange({ name: l.billingName || l.name, phone: l.phone ?? '', email: l.email ?? '', dealer: l.billingDealer ?? '', street: l.billingStreet ?? '', city: l.billingCity ?? '' });
    setQ('');
  };
  const set = (k: keyof ComposeCustomer) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid gap-2">
      <div className="relative">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לקוח ברשימת הלקוחות (שם או טלפון)" aria-label="חיפוש לקוח" />
        {hits.length > 0 && (
          <div className="absolute inset-x-0 top-full z-10 mt-1 grid rounded-2xl border border-line bg-surface p-1 shadow-lg">
            {hits.map((l) => <button key={l.id} type="button" onClick={() => pick(l)} className="rounded-xl px-3 py-2 text-start text-sm hover:bg-surface-2">{l.name}{l.phone ? ` · ${l.phone}` : ''}</button>)}
          </div>
        )}
      </div>
      {leadId && <p className="text-xs text-muted">מקושר לכרטיס הלקוח · <button type="button" className="text-primary" onClick={() => onLead(null)}>ניתוק</button></p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <Input value={value.name} onChange={set('name')} placeholder={needName ? 'שם הלקוח (חובה)' : 'שם הלקוח (לא חובה)'} aria-label="שם הלקוח" />
        <Input value={value.phone ?? ''} onChange={set('phone')} placeholder="טלפון" inputMode="tel" dir="ltr" aria-label="טלפון" />
        <Input value={value.dealer ?? ''} onChange={(e) => onChange({ ...value, dealer: e.target.value.replace(/\D/g, '').slice(0, 9) })} placeholder="ע.מ / ח.פ (לעסק)" inputMode="numeric" dir="ltr" aria-label="מספר עוסק של הלקוח" />
        <Input value={value.email ?? ''} onChange={set('email')} placeholder="מייל" inputMode="email" dir="ltr" aria-label="מייל" />
        <Input value={value.street ?? ''} onChange={set('street')} placeholder="כתובת" aria-label="כתובת" />
        <Input value={value.city ?? ''} onChange={set('city')} placeholder="עיר" aria-label="עיר" />
      </div>
    </div>
  );
}

export interface CatalogPick { id: string; name: string; price: number; kind: string }
/** lines: description, quantity, price — or a product / service from the price list (products then move in stock) */
export function LinesEditor({ lines, onChange, catalog }: { lines: ComposeLine[]; onChange: (l: ComposeLine[]) => void; catalog: CatalogPick[] }) {
  const set = (i: number, patch: Partial<ComposeLine>) => onChange(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  return (
    <div className="grid gap-2">
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_4.5rem_6.5rem_2rem] items-center gap-1.5">
          <Input value={l.name} onChange={(e) => set(i, { name: e.target.value, itemId: undefined })} placeholder="תיאור" aria-label={`תיאור שורה ${i + 1}`} list="dp-catalog" className="py-2"
            onBlur={(e) => { const c = catalog.find((x) => x.name === e.target.value.trim()); if (c && !l.itemId) set(i, { name: c.name, itemId: c.id, unitPrice: l.unitPrice || c.price }); }} />
          <Input type="number" inputMode="decimal" min={0} step="any" value={l.qty || ''} onChange={(e) => set(i, { qty: Number(e.target.value) })} aria-label={`כמות שורה ${i + 1}`} className="px-2 py-2 text-center" />
          <Input type="number" inputMode="decimal" min={0} step="0.01" value={l.unitPrice || ''} onChange={(e) => set(i, { unitPrice: Number(e.target.value) })} placeholder="מחיר" aria-label={`מחיר שורה ${i + 1}`} className="px-2 py-2 text-center" />
          <button type="button" aria-label={`הסרת שורה ${i + 1}`} onClick={() => onChange(lines.length > 1 ? lines.filter((_, k) => k !== i) : [{ name: '', qty: 1, unitPrice: 0 }])} className="h-10 rounded-full text-muted hover:text-[var(--danger)]">✕</button>
        </div>
      ))}
      <datalist id="dp-catalog">{catalog.map((c) => <option key={c.id} value={c.name} />)}</datalist>
      <button type="button" className="justify-self-start text-sm font-semibold text-primary" onClick={() => onChange([...lines, { name: '', qty: 1, unitPrice: 0 }])}>+ שורה</button>
    </div>
  );
}

/** how it was paid: one or more payments (a cheque with its details) */
export function PaymentsEditor({ payments, onChange, total, today }: { payments: PaymentEntry[]; onChange: (p: PaymentEntry[]) => void; total: number; today: string }) {
  const set = (i: number, patch: Partial<PaymentEntry>) => onChange(payments.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const paidA = payments.reduce((a, p) => a + Math.round((p.amount || 0) * 100), 0);
  const left = (Math.round(total * 100) - paidA) / 100;
  return (
    <div className="grid gap-2">
      {payments.map((p, i) => (
        <div key={i} className="grid gap-1.5 rounded-2xl border border-line p-2">
          <div className="grid grid-cols-[minmax(0,1fr)_6.5rem_8.5rem] gap-1.5">
            <SmallSelect value={p.method} onChange={(e) => set(i, { method: e.target.value as PayMethod, ...(e.target.value === 'cheque' && !p.cheque ? { cheque: { ...EMPTY_CHEQUE } } : {}) })} aria-label={`אמצעי תשלום ${i + 1}`}>
              {PAY_METHODS.map((m) => <option key={m.id} value={m.id}>{m.icon} {m.label}</option>)}
            </SmallSelect>
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={p.amount || ''} onChange={(e) => set(i, { amount: Number(e.target.value) })} aria-label={`סכום תשלום ${i + 1}`} className="px-2 py-2 text-center" />
            <Input type="date" value={p.date} max={today} onChange={(e) => set(i, { date: e.target.value })} aria-label={`תאריך תשלום ${i + 1}`} className="px-2 py-2" />
          </div>
          {p.method === 'cheque' && (
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
              {(['number', 'bank', 'branch', 'account'] as const).map((k) => (
                <Input key={k} value={p.cheque?.[k] ?? ''} inputMode="numeric" dir="ltr" placeholder={{ number: 'מס׳ צ׳ק', bank: 'בנק', branch: 'סניף', account: 'חשבון' }[k]}
                  onChange={(e) => set(i, { cheque: { ...(p.cheque ?? EMPTY_CHEQUE), [k]: e.target.value.replace(/\D/g, '') } })} aria-label={{ number: 'מספר צ׳ק', bank: 'מספר בנק', branch: 'מספר סניף', account: 'מספר חשבון' }[k]} className="px-2 py-2" />
              ))}
              <Input type="date" value={p.cheque?.dueDate ?? ''} onChange={(e) => set(i, { cheque: { ...(p.cheque ?? EMPTY_CHEQUE), dueDate: e.target.value } })} aria-label="תאריך פירעון" className="px-2 py-2" />
            </div>
          )}
          {payments.length > 1 && <button type="button" className="justify-self-start text-xs text-muted" onClick={() => onChange(payments.filter((_, k) => k !== i))}>הסרה</button>}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button type="button" className="font-semibold text-primary" onClick={() => onChange([...payments, { method: 'cash', amount: Math.max(0, left), date: today }])}>+ אמצעי נוסף</button>
        {left !== 0 && <span className={left > 0 ? 'text-amber-600' : 'text-red-600'}>{left > 0 ? `חסר ${ils(left)}` : `עודף ${ils(-left)}`}</span>}
        {left > 0 && payments.length > 0 && <button type="button" className="text-xs text-primary" onClick={() => set(payments.length - 1, { amount: Math.round((payments[payments.length - 1].amount + left) * 100) / 100 })}>להשלים את היתרה</button>}
      </div>
    </div>
  );
}

/** a CSV / text file downloaded by the browser */
export function download(name: string, text: string, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
