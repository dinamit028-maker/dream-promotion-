'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ComponentType } from 'react';
import { useApp } from '@/lib/store';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';
import { AIService } from '@/lib/services';
import { cx } from '@/lib/utils';
import { Button, Pill } from '@/components/ui/primitives';
import { ContentEditor } from '@/features/content/ContentEditor';
import {
  House, PencilSimpleLine, FilmSlate, SquaresFour, CalendarBlank, Images, Compass, Megaphone,
  UsersThree, ChartLineUp, PlugsConnected, GearSix, Plus,
} from '@/components/ui/Icon';

type NavItem = { href: string; label: string; Icon: ComponentType<any> };

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'בית', Icon: House },
  { href: '/create', label: 'יצירה', Icon: PencilSimpleLine },
  { href: '/reels', label: 'אולפן רילס', Icon: FilmSlate },
  { href: '/content', label: 'תוכן', Icon: SquaresFour },
  { href: '/calendar', label: 'יומן', Icon: CalendarBlank },
  { href: '/media', label: 'מדיה', Icon: Images },
  { href: '/strategy', label: 'אסטרטגיה', Icon: Compass },
  { href: '/ads', label: 'קמפיינים', Icon: Megaphone },
  { href: '/leads', label: 'לידים', Icon: UsersThree },
  { href: '/analytics', label: 'ביצועים', Icon: ChartLineUp },
];
const NAV_BOTTOM: NavItem[] = [
  { href: '/integrations', label: 'חיבורים', Icon: PlugsConnected },
  { href: '/settings', label: 'הגדרות', Icon: GearSix },
];
// phones get the four destinations people open daily; everything else lives under "עוד"
const MOBILE_LEFT = [NAV[0], NAV[4]];
const MOBILE_RIGHT = [NAV[3], { ...NAV_BOTTOM[1], label: 'עוד' }];

function Logo({ small }: { small?: boolean }) {
  return (
    <span aria-hidden className={cx('relative shrink-0 rounded-[11px] bg-primary shadow-[0_5px_16px_rgba(107,59,245,.35)]', small ? 'h-7 w-7' : 'h-[34px] w-[34px]')}>
      <span className="absolute inset-[26%] rounded-[5px] bg-white/90" />
    </span>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const onboarded = useApp((s) => s.onboarded);
  const userId = useApp((s) => s.userId);
  const hydrate = useApp((s) => s.hydrate);
  const [checking, setChecking] = useState(isCloudConfigured);

  // with accounts configured, nothing renders until we know who this is
  useEffect(() => {
    if (!isCloudConfigured) return;
    let alive = true;
    supabase().auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      const u = data.session?.user;
      if (!u) { router.replace('/auth'); return; }
      if (u.id !== userId) await hydrate(u.id);
      setChecking(false);
    });
    const { data: sub } = supabase().auth.onAuthStateChange((_e, session) => {
      if (!session?.user) router.replace('/auth');
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [hydrate, router, userId]);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => { AIService.available().then(setAiReady); }, []);
  useEffect(() => {
    const h = () => setScrolled(scrollY > 8);
    addEventListener('scroll', h, { passive: true });
    return () => removeEventListener('scroll', h);
  }, []);
  useEffect(() => { if (!checking && !onboarded) router.replace('/onboarding'); }, [checking, onboarded, router]);

  const sideItem = ({ href, label, Icon }: NavItem) => {
    const on = path === href;
    return (
      <Link key={href} href={href} aria-current={on ? 'page' : undefined} title={label}
        className={cx('flex min-h-11 w-full items-center gap-3 rounded-2xl px-3 text-[15px] font-semibold transition-colors max-lg:justify-center',
          on ? 'bg-primary-soft text-primary' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
        <Icon size={21} weight={on ? 'fill' : 'regular'} aria-hidden className="shrink-0" />
        <span className="max-lg:sr-only">{label}</span>
      </Link>
    );
  };

  const tabItem = ({ href, label, Icon }: NavItem) => {
    const on = path === href;
    return (
      <Link key={href} href={href} aria-current={on ? 'page' : undefined}
        className={cx('flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-semibold',
          on ? 'text-primary' : 'text-muted')}>
        <Icon size={23} weight={on ? 'fill' : 'regular'} aria-hidden />
        {label}
      </Link>
    );
  };

  const current = [...NAV, ...NAV_BOTTOM].find((n) => n.href === path);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-3 text-muted">
        <span className="spinner" aria-hidden />טוען את החשבון…
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside aria-label="ניווט ראשי"
        className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col gap-1 overflow-y-auto border-s border-line bg-surface p-4 md:flex max-lg:w-[76px]">
        <div className="flex items-center gap-2.5 px-2 pb-6 max-lg:justify-center">
          <Logo /><span className="font-display text-[17px] font-bold max-lg:sr-only">Dream Promotion</span>
        </div>
        <nav className="flex flex-col gap-1">{NAV.map(sideItem)}</nav>
        <div className="mt-auto flex flex-col gap-1 border-t border-line pt-4">{NAV_BOTTOM.map(sideItem)}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className={cx('safe-t sticky top-0 z-30 flex items-center justify-between gap-3 px-4 py-2.5 backdrop-blur-xl transition-colors sm:px-6',
          scrolled ? 'border-b border-line bg-bg/85' : 'border-b border-transparent bg-bg/70')}>
          <div className="flex items-center gap-2.5">
            <span className="md:hidden"><Logo small /></span>
            <strong className="font-display text-[17px] font-bold">{current?.label ?? ''}</strong>
          </div>
          <div className="flex items-center gap-2">
            {aiReady !== null && <Pill tone={aiReady ? 'ai' : 'warn'}>{aiReady ? 'AI פעיל' : 'AI לא מוגדר'}</Pill>}
            <Link href="/create" className="max-md:hidden">
              <Button variant="primary" size="sm"><Plus size={16} weight="bold" aria-hidden />יצירה</Button>
            </Link>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1240px] px-4 pb-32 pt-6 sm:px-6">{children}</main>
      </div>

      <nav aria-label="ניווט" className="safe-b fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t border-line bg-surface/92 px-2 pt-1 backdrop-blur-xl md:hidden">
        {MOBILE_LEFT.map(tabItem)}
        <Link href="/create" aria-label="יצירת תוכן חדש"
          className="mx-1 flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] bg-primary text-white shadow-[0_8px_22px_rgba(107,59,245,.42)]">
          <Plus size={26} weight="bold" aria-hidden />
        </Link>
        {MOBILE_RIGHT.map(tabItem)}
      </nav>
      <ContentEditor />
    </div>
  );
}
