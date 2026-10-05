'use client';
import { useEffect, useState } from 'react';
import { SAVE_ERROR_EVENT, type SaveError } from '@/lib/save-status';

/** a save that failed in the background, said in Hebrew at the bottom of the screen until closed */
export function SaveErrorBanner() {
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<SaveError>).detail;
      if (d?.message) setErrors((all) => (all.includes(d.message) ? all : [...all, d.message].slice(-3)));
    };
    window.addEventListener(SAVE_ERROR_EVENT, on);
    return () => window.removeEventListener(SAVE_ERROR_EVENT, on);
  }, []);
  if (!errors.length) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-[210] flex justify-center px-3 pb-[max(env(safe-area-inset-bottom),12px)] print:hidden">
      <div role="alert" className="flex w-full max-w-xl items-start gap-3 rounded-2xl border border-red-500/40 bg-surface p-3 text-sm shadow-lg">
        <div className="min-w-0 flex-1 space-y-1 font-semibold text-red-700 dark:text-red-300">{errors.map((m) => <p key={m}>{m}</p>)}</div>
        <button type="button" onClick={() => setErrors([])} className="min-h-11 shrink-0 rounded-full px-3 font-semibold text-muted" aria-label="סגירת ההודעה">סגירה</button>
      </div>
    </div>
  );
}
