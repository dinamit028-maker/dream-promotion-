'use client';
import { cx } from '@/lib/utils';
import type { StepN } from './logic';

/** The wizard bar: where you are, what is done, what comes next (moved verbatim from the page). */
export function ReelStepper({ steps, step, done, canOpen, onSelect }: {
  steps: { n: StepN; label: string; hint: string }[]; step: StepN;
  done: Record<StepN, boolean>; canOpen: (n: number) => boolean; onSelect: (n: StepN) => void;
}) {
  return (
    <nav aria-label="שלבי יצירת הריל" className="sticky top-0 z-20 -mx-1 mb-5 rounded-2xl bg-[var(--bg)]/90 px-1 py-2 backdrop-blur">
      <ol className="flex gap-1.5 overflow-x-auto">
        {steps.map((st) => {
          const on = step === st.n, isDone = done[st.n], open = canOpen(st.n);
          return (
            <li key={st.n} className="min-w-[60px] flex-1">
              <button type="button" disabled={!open} onClick={() => onSelect(st.n)} aria-current={on ? 'step' : undefined}
                className={cx('flex w-full flex-col items-center gap-1 rounded-2xl border px-2 py-2 text-xs font-semibold transition-colors',
                  on ? 'border-primary bg-primary text-white' : isDone ? 'border-primary/40 bg-primary-soft text-ink' : open ? 'border-line bg-surface text-ink-2' : 'border-line bg-surface text-muted opacity-50')}>
                <span className={cx('flex h-6 w-6 items-center justify-center rounded-full text-[12px]', on ? 'bg-white/25' : isDone ? 'bg-primary text-white' : 'bg-surface-2')}>
                  {isDone && !on ? '✓' : st.n}
                </span>
                {st.label}
              </button>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 px-1 text-sm text-ink-2">
        <strong>שלב {step}:</strong> {steps[step - 1].hint}
      </p>
    </nav>
  );
}
