'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { useApp } from '@/lib/store';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';
import { AIService } from '@/lib/services';
import { authHeaders } from '@/lib/services/http';
import { cx } from '@/lib/utils';
import { Button, Pill } from '@/components/ui/primitives';
import { ContentEditor } from '@/features/content/ContentEditor';
import { signOutEverywhere } from '@/lib/session';
import { JobRunner } from '@/features/content/JobRunner';
import { VersionTag } from '@/components/system/VersionTag';
import { ThemeToggle } from '@/components/system/ThemeToggle';
import { ModuleShell } from '@/components/shell/ModuleShell';
import { FINANCE_MODULE } from '@/features/finance/module';
import { isFinancePath } from '@/features/finance/routes';
import {
  House, PencilSimpleLine, FilmSlate, SquaresFour, CalendarBlank, Images, Compass, Megaphone,
  UsersThree, ChartLineUp, PlugsConnected, GearSix, Plus, SignOut, ShieldCheck, CalendarCheck, IdentificationBadge, CashRegister, Wallet,
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
  { href: '/leads', label: 'לקוחות', Icon: UsersThree },
  { href: '/appointments', label: 'תורים', Icon: CalendarCheck },
  { href: '/register', label: 'קופה', Icon: CashRegister },
  { href: '/finance', label: 'כספים', Icon: Wallet },
  { href: '/attendance', label: 'נוכחות', Icon: IdentificationBadge },
  { href: '/analytics', label: 'ביצועים', Icon: ChartLineUp },
];
const NAV_BOTTOM_ALL: NavItem[] = [
  { href: '/integrations', label: 'חיבורים', Icon: PlugsConnected },
  { href: '/settings', label: 'הגדרות', Icon: GearSix },
];
/** internal screen, only for ADMIN_EMAILS (the server checks again) */
const NAV_ADMIN: NavItem = { href: '/admin', label: 'ניהול', Icon: ShieldCheck };
// phones: the four screens opened daily sit in the tab bar; "עוד" opens a sheet with every other screen
const MOBILE_LEFT = [NAV[0], NAV[5]];        // בית · מדיה
const MOBILE_RIGHT = [NAV[2]];               // אולפן רילס (+ "עוד")
const MOBILE_TABS = new Set([...MOBILE_LEFT, ...MOBILE_RIGHT].map((n) => n.href));

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
  const businessId = useApp((s) => s.businessId);
  const hydrate = useApp((s) => s.hydrate);
  // a cashier ("קופאי/ת") works in the register only; the database refuses everything else anyway
  const cashier = useApp((s) => s.access === 'register');
  const kiosk = useApp((s) => s.kiosk);
  const [checking, setChecking] = useState(isCloudConfigured);
  // the business this user works in (banner when locked) and the ones they may switch to
  type BizItem = { id: string; name: string; state: 'active' | 'locked' | 'expired' };
  const [biz, setBiz] = useState<{ current: BizItem | null; list: BizItem[]; superAdmin: boolean } | null>(null);
  const [switching, setSwitching] = useState(false);
  // who is signed in (the personal area of a module's menu)
  const [me, setMe] = useState<string | null>(null);
  // the cloud is the source of truth: every app open loads fresh data once (leads imported by the timer,
  // fixes made on the server) — the device cache only bridges the first paint
  const loadedOnce = useRef(false);
  // the first load of the account, while it is on its way (a re-run of the effect waits for it — see below)
  const hydrating = useRef<Promise<void> | null>(null);

  // with accounts configured, nothing renders until we know who this is
  useEffect(() => {
    if (!isCloudConfigured) return;
    let alive = true;
    supabase().auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      const u = data.session?.user;
      if (!u) { router.replace('/auth'); return; }
      const meta = (u.user_metadata ?? {}) as { full_name?: string; name?: string };
      setMe(meta.full_name || meta.name || u.email || null);
      let current: string | null = null;
      try {
        const r = await fetch('/api/business/me', { headers: await authHeaders() });
        const j = await r.json();
        if (r.ok) {
          current = j.business?.id ?? null; setBiz({ current: j.business, list: j.businesses ?? [], superAdmin: Boolean(j.superAdmin) });
          useApp.getState().setAccess(j.access === 'register' ? 'register' : 'full');
        }
      } catch { /* the app still opens; data comes from row-level security anyway */ }
      if (!alive) return;
      // a different user or a different business → load that business's data (never mix two businesses)
      if (!loadedOnce.current || u.id !== userId || (current && current !== businessId)) {
        loadedOnce.current = true;
        hydrating.current = hydrate(u.id, current);
        await hydrating.current;
      } else if (hydrating.current) {
        // hydrate() itself sets userId / businessId, which re-runs this effect while the first load is still on its way:
        // wait for it, or the screens would decide (e.g. "not onboarded" → the wizard) on an account not loaded yet
        await hydrating.current;
      }
      setChecking(false);
    });
    const { data: sub } = supabase().auth.onAuthStateChange((_e, session) => {
      if (!session?.user && location.pathname !== '/') router.replace('/auth');
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [hydrate, router, userId, businessId]);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (!isCloudConfigured) return;
    (async () => {
      try { const r = await fetch('/api/admin/me', { headers: await authHeaders() }); setIsAdmin(Boolean((await r.json()).admin)); }
      catch { /* not an admin */ }
    })();
  }, []);
  /** work in another business: saved on the server, then the whole app reloads with that business's data */
  async function switchBusiness(id: string) {
    if (!id || id === biz?.current?.id) return;
    setSwitching(true);
    try {
      const r = await fetch('/api/business/me', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ id }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || 'switch_failed');
      window.location.reload();
    } catch (e: any) { setSwitching(false); window.alert(`לא הצלחנו לעבור עסק: ${e.message}`); }
  }
  const NAV_BOTTOM = cashier ? [] : isAdmin ? [...NAV_BOTTOM_ALL, NAV_ADMIN] : NAV_BOTTOM_ALL;
  const NAV_MAIN = cashier ? NAV.filter((n) => n.href === '/register') : NAV;
  // a cashier opening any other screen lands in the register
  useEffect(() => { if (cashier && !checking && path !== '/register') router.replace('/register'); }, [cashier, checking, path, router]);
  useEffect(() => { setMoreOpen(false); }, [path]);
  useEffect(() => {
    if (!moreOpen) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [moreOpen]);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => { AIService.available().then(setAiReady); }, []);
  useEffect(() => {
    const h = () => setScrolled(scrollY > 8);
    addEventListener('scroll', h, { passive: true });
    return () => removeEventListener('scroll', h);
  }, []);
  // the saved state (localStorage) is applied only after the first render — deciding "not onboarded"
  // before that sent finished users back to onboarding on every fresh load
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (useApp.persist?.hasHydrated?.() ?? true) setHydrated(true);
    return useApp.persist?.onFinishHydration?.(() => setHydrated(true));
  }, []);
  // signed in, but no business yet (a new account before the system admin opens one, or a member who was removed): nothing
  // can be saved without a business, so the app says so instead of opening screens whose saves would fail
  const noBusiness = Boolean(biz && !biz.current && !biz.superAdmin);
  useEffect(() => { if (hydrated && !checking && !onboarded && !cashier && !noBusiness) router.replace('/onboarding'); }, [hydrated, checking, onboarded, cashier, noBusiness, router]);

  const sideItem = ({ href, label, Icon }: NavItem) => {
    const on = path === href;
    return (
      <Link key={href} href={href} aria-current={on ? 'page' : undefined} title={label}
        className={cx('flex min-h-11 w-full items-center gap-3 rounded-2xl px-3 text-[15px] font-semibold transition-colors max-lg:justify-center',
          on ? 'bg-primary-soft text-ink shadow-[inset_0_0_0_1px_rgba(139,102,255,.35),0_8px_24px_rgba(107,59,245,.25)]' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
        <Icon size={21} weight={on ? 'fill' : 'regular'} aria-hidden className={cx('shrink-0', on && 'text-primary')} />
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

  const signOut = signOutEverywhere;

  const current = [...NAV, ...NAV_BOTTOM].find((n) => n.href === path);
  const register = path === '/register';
  // a module that opens as an app of its own (2.52: finance) — its own menus instead of the app's
  const moduleOn = isFinancePath(path) && !cashier;
  const lockedNotice = biz?.current && biz.current.state !== 'active' ? (
    <p role="alert" className="mb-4 rounded-2xl bg-red-500/10 p-3 text-sm font-semibold text-red-700 dark:text-red-300">
      {biz.superAdmin
        ? `העסק "${biz.current.name}" ${biz.current.state === 'expired' ? 'פג תוקף' : 'נעול'} — מוצג למנהל-על בלבד. ללקוח הוא סגור.`
        : `העסק "${biz.current.name}" נעול כרגע${biz.current.state === 'expired' ? ' (תקופת השימוש הסתיימה)' : ''}. הנתונים שמורים ולא נמחקו — כדי לחדש את השירות פנו למנהל המערכת.`}
    </p>
  ) : null;

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-3 text-muted">
        <span className="spinner" aria-hidden />טוען את החשבון…
      </div>
    );
  }

  if (noBusiness && biz) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div role="alert" className="w-full max-w-md rounded-xl border border-line bg-surface p-6 text-center shadow-sm">
          <h1 className="font-display text-xl font-bold">החשבון עוד לא משויך לעסק</h1>
          <p className="mt-2 text-muted">
            {me ? `נכנסת בהצלחה כ-${me}, ` : 'נכנסת בהצלחה, '}אבל עדיין אין עסק שהחשבון הזה חבר בו — ולכן אי אפשר עדיין לשמור לקוחות, תורים, מכירות או מסמכים.
            {biz.list.length ? ' בחרו את העסק שעובדים בו:' : ' כדי להתחיל, פנו למנהל המערכת: הוא פותח את העסק ומצרף אליו את החשבון.'}
          </p>
          {biz.list.length > 0 && (
            <div className="mt-4 grid gap-2">
              {biz.list.map((b) => <Button key={b.id} variant="primary" disabled={switching} onClick={() => void switchBusiness(b.id)}>{b.name}</Button>)}
            </div>
          )}
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button onClick={() => window.location.reload()}>בדיקה שוב</Button>
            <Button variant="ghost" onClick={() => void signOut()}>יציאה מהחשבון</Button>
          </div>
        </div>
      </div>
    );
  }

  // the register on the whole screen: no menus, no header — the counter's tablet / POS (exit inside the register)
  if (register && kiosk) {
    return (
      <div className="min-h-screen">
        <main className="w-full px-3 pb-6 pt-3 sm:px-4">{children}</main>
        <ContentEditor />
        <JobRunner />
      </div>
    );
  }

  // the finance module as an app of its own: its header, menu, bottom bar and "+" (permissions unchanged — a cashier
  // never gets here, and a locked business shows the same notice)
  if (moduleOn) {
    return (
      <>
        <ModuleShell config={FINANCE_MODULE} path={path} exitHref="/dashboard" notice={lockedNotice}
          businessName={biz?.current?.name ?? undefined} userName={me ?? undefined}
          businesses={biz?.list ?? []} currentBusinessId={biz?.current?.id ?? null}
          canSwitch={Boolean(biz && (biz.superAdmin || biz.list.length > 1))} switching={switching} onSwitchBusiness={(id) => void switchBusiness(id)}>
          {children}
        </ModuleShell>
        <ContentEditor />
        <JobRunner />
      </>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside aria-label="ניווט ראשי"
        className="sticky top-3 m-3 me-0 hidden h-[calc(100vh-24px)] w-[240px] shrink-0 flex-col gap-1 overflow-y-auto rounded-[24px] border border-line bg-[color:var(--glass)] p-4 shadow-[0_20px_60px_rgba(0,0,0,.35)] backdrop-blur-xl md:flex max-lg:w-[76px]">
        <div className="flex items-center gap-2.5 px-2 pb-6 max-lg:justify-center">
          <Logo /><span className="whitespace-nowrap font-display text-[16px] font-bold max-lg:sr-only">Dream Promotion</span>
        </div>
        <nav className="flex flex-col gap-1">{NAV_MAIN.map(sideItem)}</nav>
        <div className="mt-auto flex flex-col gap-1 border-t border-line pt-4">
          {NAV_BOTTOM.map(sideItem)}
          <button type="button" onClick={signOut}
            className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-[15px] font-semibold text-ink-2 transition-colors hover:bg-surface-2 hover:text-[var(--danger)] max-lg:justify-center">
            <SignOut size={22} aria-hidden /><span className="max-lg:sr-only">יציאה</span>
          </button>
          <VersionTag className="px-3 pt-2 text-[11px] text-muted max-lg:hidden" />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className={cx('safe-t sticky top-0 z-30 flex items-center justify-between gap-3 px-4 py-2.5 backdrop-blur-xl transition-colors sm:px-6',
          scrolled ? 'border-b border-line bg-[color:var(--glass-bg)]' : 'border-b border-transparent bg-transparent')}>
          <div className="flex items-center gap-2.5">
            <span className="md:hidden"><Logo small /></span>
            <strong className="font-display text-[17px] font-bold">{current?.label ?? ''}</strong>
          </div>
          <div className="flex items-center gap-2">
            {biz && (biz.superAdmin || biz.list.length > 1) && (
              <select aria-label="העסק שעובדים בו" value={biz.current?.id ?? ''} disabled={switching}
                onChange={(e) => void switchBusiness(e.target.value)}
                className="h-9 max-w-[42vw] rounded-full border border-line bg-surface px-3 text-sm font-semibold">
                {!biz.current && <option value="">בחירת עסק</option>}
                {biz.list.map((b) => <option key={b.id} value={b.id}>{b.name}{b.state !== 'active' ? ` (${b.state === 'locked' ? 'נעול' : 'פג תוקף'})` : ''}</option>)}
              </select>
            )}
            <ThemeToggle />
            {cashier ? (
              <button type="button" onClick={signOut} className="flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm font-semibold text-ink-2 md:hidden">
                <SignOut size={18} aria-hidden />יציאה
              </button>
            ) : <>
              {aiReady !== null && <Pill tone={aiReady ? 'ai' : 'warn'}>{aiReady ? 'AI פעיל' : 'AI לא מוגדר'}</Pill>}
              <Link href="/create" className="max-md:hidden">
                <Button variant="primary" size="sm"><Plus size={16} weight="bold" aria-hidden />יצירה</Button>
              </Link>
            </>}
          </div>
        </header>

        {/* the register uses the whole width of a big screen (1920 and up) — every other screen stays readable at 1240 */}
        <main className={cx('mx-auto w-full px-4 pb-32 pt-6 sm:px-6', register ? 'max-w-none' : 'max-w-[1240px]')}>
          {lockedNotice}
          {children}
        </main>
      </div>

      {!cashier && <nav aria-label="ניווט" className="safe-b fixed inset-x-3 bottom-3 z-40 flex items-center justify-around rounded-[26px] border border-line bg-[color:var(--glass)] px-2 py-1 shadow-[0_20px_50px_rgba(0,0,0,.5)] backdrop-blur-xl md:hidden">
        {MOBILE_LEFT.map(tabItem)}
        <Link href="/create" aria-label="יצירת תוכן חדש"
          className="mx-1 flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] bg-primary text-white shadow-[0_8px_22px_rgba(107,59,245,.42)]">
          <Plus size={26} weight="bold" aria-hidden />
        </Link>
        {MOBILE_RIGHT.map(tabItem)}
        <button type="button" onClick={() => setMoreOpen(true)} aria-haspopup="dialog" aria-expanded={moreOpen}
          className={cx('flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-semibold',
            moreOpen || (current && !MOBILE_TABS.has(current.href)) ? 'text-primary' : 'text-muted')}>
          <SquaresFour size={23} weight={moreOpen ? 'fill' : 'regular'} aria-hidden />
          עוד
        </button>
      </nav>}

      {/* phone: every screen, one tap away */}
      {moreOpen && !cashier && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="כל המסכים">
          <button type="button" aria-label="סגירה" onClick={() => setMoreOpen(false)} className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
          <div className="safe-b absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-[28px] border-t border-line bg-surface px-4 pb-6 pt-3 shadow-[0_-20px_60px_rgba(0,0,0,.5)]">
            <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-line" />
            <div className="grid grid-cols-3 gap-2">
              {[...NAV, ...NAV_BOTTOM].map(({ href, label, Icon }) => {
                const on = path === href;
                return (
                  <Link key={href} href={href} onClick={() => setMoreOpen(false)} aria-current={on ? 'page' : undefined}
                    className={cx('flex min-h-[84px] flex-col items-center justify-center gap-1.5 rounded-2xl border text-[13px] font-semibold',
                      on ? 'border-primary bg-primary-soft text-ink' : 'border-line bg-surface-2 text-ink-2 active:bg-primary-soft')}>
                    <Icon size={26} weight={on ? 'fill' : 'regular'} aria-hidden className={on ? 'text-primary' : undefined} />
                    {label}
                  </Link>
                );
              })}
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
              <button type="button" onClick={signOut}
                className="flex h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold text-ink-2 hover:text-[var(--danger)]">
                <SignOut size={20} aria-hidden />יציאה מהחשבון
              </button>
              <VersionTag className="text-[11px] text-muted" />
            </div>
          </div>
        </div>
      )}
      <ContentEditor />
      <JobRunner />
    </div>
  );
}
