'use client';
import { cx } from '@/lib/utils';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

type Variant = 'primary' | 'ghost' | 'soft';
type Size = 'sm' | 'md' | 'lg';

// every size clears the 44px touch minimum on phones
const sizes: Record<Size, string> = {
  sm: 'min-h-11 px-4 text-sm sm:min-h-10',
  md: 'min-h-11 px-5 text-[15px]',
  lg: 'min-h-14 px-8 text-[17px]',
};

export function Button({
  variant = 'soft', size = 'md', className, ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  // press feedback uses opacity + shadow, never a transform that nudges neighbours
  const base = 'inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-[background-color,box-shadow,opacity,color] duration-200 active:opacity-80 disabled:opacity-50 disabled:pointer-events-none';
  const variants: Record<Variant, string> = {
    primary: 'bg-primary text-white shadow-[0_6px_18px_rgba(107,59,245,.28)] hover:shadow-[0_10px_26px_rgba(107,59,245,.38)]',
    ghost: 'border border-line bg-surface hover:bg-surface-2',
    soft: 'bg-surface-2 hover:bg-primary-soft hover:text-primary',
  };
  return <button className={cx(base, sizes[size], variants[variant], className)} {...p} />;
}

export function Card({ children, className, hover }: { children: ReactNode; className?: string; hover?: boolean }) {
  return (
    <div className={cx(
      'rounded-lg border border-line bg-surface p-6 shadow-sm transition-all duration-300',
      hover && 'hover:-translate-y-0.5 hover:shadow-md',
      className,
    )}>{children}</div>
  );
}

export function Chip({ on, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean }) {
  return (
    <button className={cx(
      'inline-flex min-h-11 items-center gap-1.5 rounded-full border-[1.5px] px-4 text-sm font-semibold transition-colors',
      on ? 'border-primary bg-primary-soft text-primary' : 'border-transparent bg-surface-2 hover:border-line',
      className,
    )} {...p} />
  );
}

export function Pill({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'ai' | 'ok' | 'warn' }) {
  const tones = {
    default: 'bg-surface-2 text-muted',
    ai: 'bg-primary-soft text-primary',
    ok: 'bg-[var(--ok-soft)] text-ok',
    warn: 'bg-[var(--warn-soft)] text-warn',
  };
  return <span className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold', tones[tone])}>{children}</span>;
}

const fieldBase = 'w-full rounded-md border-[1.5px] border-line bg-surface px-4 py-3 text-[15px] outline-none transition-all focus:border-primary focus:shadow-[0_0_0_4px_var(--primary-soft)]';

export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(fieldBase, p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(fieldBase, 'min-h-28 resize-y leading-relaxed', p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(fieldBase, p.className)} />;

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <label className="mb-2 block text-sm font-semibold text-ink-2">{label}</label>
      {children}
    </div>
  );
}

export function PageHead({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="font-display text-2xl font-extrabold tracking-tight sm:text-3xl">{title}</h2>
        {sub && <p className="mt-1 text-muted">{sub}</p>}
      </div>
      {action}
    </div>
  );
}
