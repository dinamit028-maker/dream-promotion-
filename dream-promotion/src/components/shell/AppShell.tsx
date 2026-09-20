'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { cx } from '@/lib/utils';
import { Button, Pill } from '@/components/ui/primitives';

export const NAV = [
  { href: '/dashboard', label: 'בית', ico: '✦' },
  { href: '/create', label: 'יצירה', ico: '✎' },
  { href: '/reels', label: 'אולפן רילס', ico: '▶' },
  { href: '/content', label: 'תוכן', ico: '▦' },
  { href: '/calendar', label: 'יומן', ico: '◫' },
  { href: '/media', label: 'מדיה', ico: '⬚' },
  { href: '/strategy', label: 'אסטרטגיה', ico: '◈' },
  { href: '/ads', label: 'קמפיינים', ico: '◉' },
  { href: '/leads', label: 'לידים', ico: '☺' },
  { href: '/analytics', label: 'ביצועים', ico: '◴' },
];
const NAV_BOTTOM = [
  { href: '/integrations', label: 'חיבורים', ico: '⚯' },
  { href: '/settings', label: 'הגדרות', ico: '⚙' },
];

function Logo({ small }: { small?: boolean }) {
  return (
    <div className={cx('relative shrink-0 rounded-[11px] bg-brand shadow-[0_5px_16px_rgba(107,59,245,.35)]', small ? 'h-7 w-7' : 'h-[34px] w-[34px]')}>
      <span className="absolute inset-[26%] rounded-[5px] bg-white/90" />
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const onboarded = useApp((s) => s.onboarded);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => { AIService.available().then(setAiReady); }, []);
  useEffect(() => {
    const h = () => setScrolled(scrollY > 8);
    addEventListener('scroll', h);
    return () => removeEventListener('scroll', h);
  }, []);
  useEffect(() => { if (!onboarded) router.replace('/onboarding'); }, [onboarded, router]);

  const item = (n: { href: string; label: string; ico: string }) => (
    <Link key={n.href} href={n.href}
      className={cx('flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-[15px] font-semibold transition-colors',
        path === n.href ? 'bg-primary-soft text-primary' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
      <span className="w-[22px] shrink-0 text-center text-lg">{n.ico}</span>
      <span className="max-lg:hidden">{n.label}</span>
    </Link>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col gap-1 overflow-y-auto border-s border-line bg-surface p-4 md:flex lg:w-[248px] max-lg:w-[76px]">
        <div className="flex items-center gap-2.5 px-2 pb-6">
          <Logo /><span className="font-display text-[17px] font-extrabold max-lg:hidden">Dream Promotion</span>
        </div>
        {NAV.map(item)}
        <div className="mt-auto border-t border-line pt-4">{NAV_BOTTOM.map(item)}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className={cx('safe-t sticky top-0 z-30 flex items-center justify-between gap-3 px-4 py-3 backdrop-blur-xl transition-colors sm:px-6',
          scrolled ? 'border-b border-line bg-bg/80' : 'bg-bg/70')}>
          <div className="flex items-center gap-2.5">
            <Logo small /><strong className="font-display">{[...NAV, ...NAV_BOTTOM].find((n) => n.href === path)?.label ?? ''}</strong>
          </div>
          <div className="flex items-center gap-3">
            {aiReady !== null && <Pill tone={aiReady ? 'ai' : 'warn'}>{aiReady ? 'AI פעיל' : 'AI לא מוגדר'}</Pill>}
            <Link href="/create"><Button variant="primary" size="sm">+ יצירה</Button></Link>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1240px] px-4 pb-32 pt-6 sm:px-6">{children}</main>
      </div>

      <nav className="safe-b fixed inset-x-0 bottom-0 z-40 flex items-end justify-around border-t border-line bg-surface/90 px-2 pt-2 backdrop-blur-xl md:hidden">
        {[NAV[0], NAV[4]].map((n) => (
          <Link key={n.href} href={n.href} className={cx('flex flex-1 flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 text-[11px] font-semibold', path === n.href ? 'text-primary' : 'text-muted')}>
            <span className="text-lg">{n.ico}</span>{n.label}
          </Link>
        ))}
        <Link href="/create" className="mb-0.5 flex h-[54px] w-[54px] items-center justify-center rounded-[19px] bg-brand text-2xl text-white shadow-[0_8px_22px_rgba(107,59,245,.42)]">+</Link>
        {[NAV[3], NAV_BOTTOM[1]].map((n) => (
          <Link key={n.href} href={n.href} className={cx('flex flex-1 flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 text-[11px] font-semibold', path === n.href ? 'text-primary' : 'text-muted')}>
            <span className="text-lg">{n.ico}</span>{n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
