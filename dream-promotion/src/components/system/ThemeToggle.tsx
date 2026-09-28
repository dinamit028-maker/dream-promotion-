'use client';
import { useEffect, useState } from 'react';
import { Sun, Moon } from '@/components/ui/Icon';
import { cx } from '@/lib/utils';

import { THEME_KEY } from '@/lib/theme';
type Theme = 'dark' | 'light';

/** Switches the whole site (landing and app) between dark and light, and remembers the choice. */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  }, []);

  const flip = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode: still switches for this visit */ }
    setTheme(next);
  };

  const label = theme === 'dark' ? 'מעבר למצב בהיר' : 'מעבר למצב כהה';
  return (
    <button type="button" onClick={flip} aria-label={label} title={label}
      className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink', className)}>
      {theme === 'dark' ? <Sun size={19} aria-hidden /> : <Moon size={19} aria-hidden />}
    </button>
  );
}

