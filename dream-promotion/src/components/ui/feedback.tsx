'use client';
import { useEffect, type ReactNode } from 'react';
import { Button } from './primitives';
import { cx } from '@/lib/utils';

export function Spinner() { return <span className="spinner" aria-hidden />; }

export function Modal({ open, onClose, children, wide }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  }, [onClose]);
  if (!open) return null;
  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(18,14,28,.46)] p-4 backdrop-blur-sm">
      <div className={cx('max-h-[88vh] w-full overflow-y-auto rounded-xl bg-surface p-8 shadow-lg animate-pop', wide ? 'max-w-4xl' : 'max-w-2xl')}>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ emoji, title, body, action }: { emoji: string; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border-[1.5px] border-dashed border-line bg-brand-soft px-6 py-16 text-center">
      <div className="mb-3 text-5xl">{emoji}</div>
      <h3 className="font-display text-xl font-extrabold">{title}</h3>
      <p className="mx-auto mt-2 max-w-sm text-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Shown wherever a real integration is missing. Never a fake success. */
export function AdapterNote({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border-[1.5px] border-dashed border-line bg-surface-2 p-4 text-[14.5px] text-ink-2">
      {title && <strong className="block">{title}</strong>}
      {children}
    </div>
  );
}

export function AiUnavailable() {
  return (
    <AdapterNote title="מנוע ה-AI לא מוגדר.">
      הגדירו <code>ANTHROPIC_API_KEY</code> בקובץ <code>.env.local</code>. עד אז לא נוצר טקסט מקומי שמתחזה ליצירה של מודל.
    </AdapterNote>
  );
}

/** Branded generation state — AI work never looks frozen. */
export function GenerationState({ lines, step }: { lines: string[]; step: number }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-6 shadow-sm">
      {lines.map((l, i) => (
        <div key={l} className={cx('flex items-center gap-3 py-2 text-[15px] transition-all',
          i < step ? 'text-ok opacity-80' : i === step ? 'text-ink opacity-100' : 'text-muted opacity-30')}>
          {i < step ? <span className="w-[17px] shrink-0">✓</span> : i === step ? <Spinner /> : <span className="w-[17px] shrink-0" />}
          <span>{l}</span>
        </div>
      ))}
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full bg-brand transition-all duration-500" style={{ width: `${Math.min(95, (step + 1) * (100 / lines.length))}%` }} />
      </div>
    </div>
  );
}

export function IntegrationDialog({ open, onClose, provider, what }: { open: boolean; onClose: () => void; provider: string; what: string }) {
  return (
    <Modal open={open} onClose={onClose}>
      <h3 className="font-display text-xl font-extrabold">{what} דורש חיבור {provider}</h3>
      <p className="mt-3 text-muted">
        אין כאן פעולה מדומה. כדי להמשיך צריך לחבר את החשבון דרך OAuth ולהגדיר את המפתחות בסביבת השרת.
      </p>
      <div className="mt-5 flex gap-3">
        <a href="/integrations"><Button variant="primary">למסך החיבורים</Button></a>
        <Button variant="ghost" onClick={onClose}>סגירה</Button>
      </div>
    </Modal>
  );
}
