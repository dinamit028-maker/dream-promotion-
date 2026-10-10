'use client';
import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '@/lib/utils';
import { ThemeToggle } from '@/components/system/ThemeToggle';
import { VersionTag } from '@/components/system/VersionTag';
import { ArrowRight, ArrowsLeftRight, CaretDown, Check, List, Plus, UserCircle, X } from '@/components/ui/Icon';
import { groupOfPath, isActiveLink, toggleGroup, type ModuleAction, type ModuleConfig, type ModuleGroup, type ModuleLink } from './module-nav';

export type { ModuleAction, ModuleConfig, ModuleGroup, ModuleLink } from './module-nav';

/**
 * A module of Dream as an app of its own (2.52 — finance first; customers and marketing can use the same shell).
 * Phone: a header (back to Dream · the module and the business · the business switch), a menu that opens from the
 * right with groups (one open at a time, the page on screen marked), the module's bottom bar, and a floating "+" for
 * its "new …" actions. Computer: the module's sidebar (back to Dream at the top) and a "חדש" menu in the header.
 * The shell only navigates — the screens, the data and the permissions stay where they were.
 */
export interface ModuleBusiness { id: string; name: string; state: 'active' | 'locked' | 'expired' }

const ActionsCtx = createContext<((a: ModuleAction[] | null) => void) | null>(null);
/** a screen inside the module replaces the "+" actions (finance: only the documents this business may issue) */
export function useModuleActions(actions: ModuleAction[] | null) {
  const set = useContext(ActionsCtx);
  const key = actions ? actions.map((a) => `${a.id}=${a.href}`).join('|') : '';
  useEffect(() => {
    if (!set) return;
    set(actions);
    return () => set(null);
  }, [set, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

interface Props {
  config: ModuleConfig;
  path: string;
  children: ReactNode;
  /** where "חזרה ל-Dream" goes (the app's home) */
  exitHref: string;
  businessName?: string;
  userName?: string;
  businesses?: ModuleBusiness[];
  currentBusinessId?: string | null;
  canSwitch?: boolean;
  switching?: boolean;
  onSwitchBusiness?: (id: string) => void;
  /** above the page (for example: the business is locked) */
  notice?: ReactNode;
  /** the location switch (T12א) — renders nothing for a business with one location */
  locationSwitch?: ReactNode;
}

const stateLabel = (b: ModuleBusiness) => (b.state === 'active' ? '' : b.state === 'locked' ? ' (נעול)' : ' (פג תוקף)');

export function ModuleShell({ config, path, children, exitHref, businessName, userName, businesses = [], currentBusinessId, canSwitch, switching, onSwitchBusiness, notice, locationSwitch }: Props) {
  const [override, setOverride] = useState<ModuleAction[] | null>(null);
  const actions = override ?? config.actions;
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState<'new' | 'business' | null>(null);
  const [newMenu, setNewMenu] = useState(false);
  const [open, setOpen] = useState<string | null>(() => groupOfPath(config.groups, path));
  const menuButton = useRef<HTMLButtonElement>(null);
  const plusButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const newBox = useRef<HTMLDivElement>(null);

  // a new page: every panel closes, and the menu will open on the page's group
  useEffect(() => { setMenu(false); setSheet(null); setNewMenu(false); setOpen(groupOfPath(config.groups, path)); }, [path, config.groups]);

  // closing by hand returns the focus to the button that opened the panel
  const closeMenu = useCallback(() => { setMenu(false); menuButton.current?.focus(); }, []);
  const closeSheet = useCallback(() => { if (sheet === 'new') plusButton.current?.focus(); setSheet(null); }, [sheet]);
  // Escape closes; the page behind does not scroll while a panel is open
  const layer = menu || sheet !== null;
  useEffect(() => {
    if (!layer) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (menu) closeMenu(); else closeSheet(); } };
    addEventListener('keydown', k);
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { removeEventListener('keydown', k); html.style.overflow = before; };
  }, [layer, menu, closeMenu, closeSheet]);
  useEffect(() => { if (menu) closeButton.current?.focus(); }, [menu]);
  // the computer's "חדש" menu closes on a click outside it or on Escape
  useEffect(() => {
    if (!newMenu) return;
    const out = (e: MouseEvent) => { if (!newBox.current?.contains(e.target as Node)) setNewMenu(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setNewMenu(false); };
    addEventListener('mousedown', out); addEventListener('keydown', k);
    return () => { removeEventListener('mousedown', out); removeEventListener('keydown', k); };
  }, [newMenu]);

  const title = (
    <>
      <span className="text-module">{config.name}</span>
      {businessName ? <span className="text-ink"> · {businessName}</span> : null}
    </>
  );

  return (
    <ActionsCtx.Provider value={setOverride}>
      <div className={cx(config.theme, 'flex min-h-screen')} data-module={config.id}>
        {/* ---- computer: the module's sidebar ---------------------------------------------------------------- */}
        <aside aria-label={`ניווט ${config.name}`}
          className="sticky top-3 m-3 me-0 hidden h-[calc(100vh-24px)] w-[248px] shrink-0 flex-col overflow-y-auto rounded-lg border border-line bg-(--glass) p-3 shadow-[0_20px_60px_rgba(0,0,0,.35)] backdrop-blur-xl md:flex">
          <Link href={exitHref} className="mb-2 flex min-h-11 items-center gap-2 rounded-2xl px-3 text-sm font-semibold text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink">
            <ArrowRight size={18} aria-hidden />חזרה ל-Dream
          </Link>
          <div className="mb-3 flex items-center gap-2.5 px-3 py-1">
            <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-module text-module-ink"><config.Icon size={20} weight="fill" /></span>
            <strong className="font-display text-[17px] font-bold">{config.name}</strong>
          </div>
          <ModuleNav groups={config.groups} path={path} />
          <div className="mt-auto border-t border-line pt-3">
            <Person userName={userName} businessName={businessName} />
            <VersionTag className="px-3 pt-1 text-[11px] text-muted" />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* ---- phone: header ------------------------------------------------------------------------------- */}
          <header className="safe-t sticky top-0 z-30 border-b border-line bg-(--glass-bg) backdrop-blur-xl md:hidden">
            <div className="flex h-14 items-center gap-1 px-1.5">
              <Link href={exitHref} aria-label="חזרה ל-Dream"
                className="flex h-11 shrink-0 items-center gap-1 rounded-full px-2.5 text-sm font-semibold text-ink-2 hover:text-ink">
                <ArrowRight size={20} aria-hidden /><span aria-hidden>Dream</span>
              </Link>
              <div className="flex min-w-0 flex-1 justify-center">
                {canSwitch ? (
                  <button type="button" onClick={() => setSheet('business')} aria-haspopup="dialog" aria-expanded={sheet === 'business'}
                    aria-label={`${config.name} · ${businessName ?? ''} — החלפת עסק`}
                    className="flex h-11 min-w-0 max-w-full items-center gap-1 rounded-full px-3 font-display text-[16px] font-bold hover:bg-surface-2">
                    <span className="truncate">{title}</span><CaretDown size={14} aria-hidden className="shrink-0 text-muted" />
                  </button>
                ) : <h1 className="truncate px-2 font-display text-[16px] font-bold">{title}</h1>}
              </div>
              <ThemeToggle className="h-11! w-11!" />
            </div>
            {/* the location switch, under the title (nothing at all for a business with one location) */}
            <div className="flex justify-center px-2 pb-2 empty:hidden">{locationSwitch}</div>
          </header>

          {/* ---- computer: header ---------------------------------------------------------------------------- */}
          <header className="sticky top-0 z-30 hidden items-center justify-between gap-3 border-b border-line bg-(--glass-bg) px-6 py-2.5 backdrop-blur-xl md:flex">
            <h1 className="truncate font-display text-[17px] font-bold">{title}</h1>
            <div className="flex items-center gap-2">
              {locationSwitch}
              {canSwitch && (
                <select aria-label="העסק שעובדים בו" value={currentBusinessId ?? ''} disabled={switching}
                  onChange={(e) => onSwitchBusiness?.(e.target.value)}
                  className="h-10 max-w-[260px] rounded-full border border-line bg-surface px-3 text-sm font-semibold">
                  {!currentBusinessId && <option value="">בחירת עסק</option>}
                  {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}{stateLabel(b)}</option>)}
                </select>
              )}
              <ThemeToggle />
              <div ref={newBox} className="relative">
                <button type="button" onClick={() => setNewMenu((v) => !v)} aria-expanded={newMenu} aria-controls="module-new"
                  className="flex h-10 items-center gap-1.5 rounded-full bg-module px-4 text-sm font-bold text-module-ink shadow-[0_6px_18px_rgba(0,0,0,.25)]">
                  <Plus size={16} weight="bold" aria-hidden />חדש
                </button>
                {newMenu && (
                  <div id="module-new" role="group" aria-label="יצירה חדשה" className="absolute inset-e-0 top-full z-40 mt-2 w-64 rounded-2xl border border-line bg-surface p-1.5 shadow-[0_20px_50px_rgba(0,0,0,.35)] animate-fade">
                    {actions.map((a) => (
                      <Link key={a.id} href={a.href} onClick={() => setNewMenu(false)} aria-label={a.label} aria-describedby={a.hint ? `new-menu-${a.id}` : undefined}
                        className="flex min-h-11 items-center gap-3 rounded-xl px-3 py-1.5 text-sm font-semibold hover:bg-module-soft">
                        <a.Icon size={20} aria-hidden className="shrink-0 text-module" />
                        <span className="min-w-0 flex-1">{a.label}{a.hint && <span id={`new-menu-${a.id}`} className="block text-xs font-normal text-muted">{a.hint}</span>}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </header>

          <main className="mx-auto w-full max-w-[1240px] px-4 pb-40 pt-4 sm:px-6 md:pb-12 md:pt-6">
            {notice}
            {children}
          </main>
        </div>

        {/* ---- phone: the module's bottom bar and its "+" ---------------------------------------------------- */}
        <nav aria-label={`ניווט ${config.name}`}
          className="safe-b fixed inset-x-0 bottom-0 z-40 border-t border-line bg-(--glass) backdrop-blur-xl md:hidden">
          <div className="mx-auto flex max-w-lg items-stretch px-1">
            {config.tabs.map((t) => <Tab key={t.href} link={t} on={isActiveLink(path, t.href)} />)}
            <button ref={menuButton} type="button" onClick={() => setMenu(true)} aria-haspopup="dialog" aria-expanded={menu}
              className={cx('flex min-h-[58px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold', menu ? 'text-module' : 'text-muted')}>
              <List size={23} weight={menu ? 'bold' : 'regular'} aria-hidden />תפריט
            </button>
          </div>
        </nav>
        <button ref={plusButton} type="button" onClick={() => setSheet('new')} aria-label="יצירה חדשה" aria-haspopup="dialog" aria-expanded={sheet === 'new'}
          className="fixed inset-e-4 z-40 grid h-14 w-14 place-items-center rounded-full bg-module text-module-ink shadow-[0_12px_30px_rgba(0,0,0,.4)] md:hidden"
          style={{ bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))' }}>
          <Plus size={26} weight="bold" aria-hidden />
        </button>

        {/* ---- phone: the menu, from the right ------------------------------------------------------------------ */}
        {menu && (
          <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label={`תפריט ${config.name}`}>
            <button type="button" tabIndex={-1} aria-label="סגירת התפריט" onClick={closeMenu} className="absolute inset-0 animate-fade bg-black/55 backdrop-blur-[2px]" />
            <div className="safe-t safe-b absolute inset-y-0 right-0 flex w-[86%] max-w-[340px] animate-drawer flex-col border-e border-line bg-surface shadow-[-20px_0_60px_rgba(0,0,0,.45)]">
              <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line ps-4 pe-1.5">
                <strong className="flex items-center gap-2.5 font-display text-lg font-bold">
                  <span aria-hidden className="grid h-8 w-8 place-items-center rounded-xl bg-module text-module-ink"><config.Icon size={18} weight="fill" /></span>
                  {config.name}
                </strong>
                <button ref={closeButton} type="button" onClick={closeMenu} aria-label="סגירת התפריט"
                  className="grid h-11 w-11 place-items-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink">
                  <X size={22} aria-hidden />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <ModuleNav groups={config.groups} path={path} accordion open={open} onToggle={(id) => setOpen((o) => toggleGroup(o, id))} onNavigate={() => setMenu(false)} />
              </div>
              <div className="shrink-0 border-t border-line p-3">
                <Person userName={userName} businessName={businessName} />
                {canSwitch && (
                  <button type="button" onClick={() => { setMenu(false); setSheet('business'); }}
                    className="flex min-h-11 w-full items-center gap-3 rounded-2xl px-3 text-start font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink">
                    <ArrowsLeftRight size={20} aria-hidden />החלפת עסק
                  </button>
                )}
                <Link href={exitHref} className="flex min-h-11 items-center gap-3 rounded-2xl px-3 font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink">
                  <ArrowRight size={20} aria-hidden />חזרה ל-Dream
                </Link>
              </div>
            </div>
          </div>
        )}

        {/* ---- phone: "+" — the module's new … actions ------------------------------------------------------- */}
        {sheet === 'new' && (
          <Sheet label="יצירה חדשה" onClose={closeSheet}>
            <p className="mb-2 px-1 font-display text-lg font-bold">חדש</p>
            <div className="grid gap-1.5">
              {actions.map((a) => (
                <Link key={a.id} href={a.href} onClick={() => setSheet(null)} aria-label={a.label} aria-describedby={a.hint ? `new-sheet-${a.id}` : undefined}
                  className="flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-surface-2 px-3 py-1.5 font-semibold active:bg-module-soft">
                  <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-module-soft text-module"><a.Icon size={22} /></span>
                  <span className="min-w-0 flex-1">{a.label}{a.hint && <span id={`new-sheet-${a.id}`} className="block text-xs font-normal text-muted">{a.hint}</span>}</span>
                </Link>
              ))}
            </div>
          </Sheet>
        )}

        {/* ---- phone: the business switch ----------------------------------------------------------------- */}
        {sheet === 'business' && (
          <Sheet label="החלפת עסק" onClose={closeSheet}>
            <p className="mb-2 px-1 font-display text-lg font-bold">העסק שעובדים בו</p>
            <div className="grid gap-1.5">
              {businesses.map((b) => {
                const on = b.id === currentBusinessId;
                return (
                  <button key={b.id} type="button" disabled={switching} aria-current={on ? 'true' : undefined}
                    onClick={() => { if (on) setSheet(null); else onSwitchBusiness?.(b.id); }}
                    className={cx('flex min-h-14 items-center gap-3 rounded-2xl border px-4 text-start font-semibold',
                      on ? 'border-(--module-line) bg-module-soft' : 'border-line bg-surface-2')}>
                    <span className="min-w-0 flex-1 truncate">{b.name}{stateLabel(b)}</span>
                    {on && <Check size={20} weight="bold" aria-hidden className="text-module" />}
                  </button>
                );
              })}
            </div>
            {switching && <p className="mt-2 text-sm text-muted">עוברים עסק…</p>}
          </Sheet>
        )}
      </div>
    </ActionsCtx.Provider>
  );
}

function ModuleNav({ groups, path, accordion, open, onToggle, onNavigate }: {
  groups: ModuleGroup[]; path: string; accordion?: boolean; open?: string | null; onToggle?: (id: string) => void; onNavigate?: () => void;
}) {
  return (
    <nav className="flex flex-col gap-1">
      {groups.map((g) => {
        if (g.links.length === 1) return <Item key={g.id} link={{ ...g.links[0], label: g.label, Icon: g.Icon }} on={isActiveLink(path, g.links[0].href)} onClick={onNavigate} />;
        const here = g.links.some((l) => isActiveLink(path, l.href));
        const expanded = accordion ? open === g.id : true;
        return (
          <div key={g.id}>
            {accordion ? (
              <button type="button" onClick={() => onToggle?.(g.id)} aria-expanded={expanded} aria-controls={`module-group-${g.id}`}
                className={cx('flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 text-start text-[15px] font-semibold transition-colors hover:bg-surface-2',
                  here ? 'text-ink' : 'text-ink-2')}>
                <g.Icon size={21} weight={here ? 'fill' : 'regular'} aria-hidden className={cx('shrink-0', here && 'text-module')} />
                <span className="flex-1">{g.label}</span>
                <CaretDown size={16} aria-hidden className={cx('shrink-0 text-muted transition-transform', expanded && 'rotate-180')} />
              </button>
            ) : <p className="px-3 pb-1 pt-3 text-xs font-bold text-muted">{g.label}</p>}
            {expanded && (
              <div id={`module-group-${g.id}`} className={cx('flex flex-col gap-0.5', accordion && 'ps-4')}>
                {g.links.map((l) => <Item key={l.href} link={l} on={isActiveLink(path, l.href)} onClick={onNavigate} />)}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function Item({ link: { href, label, Icon }, on, onClick }: { link: ModuleLink; on: boolean; onClick?: () => void }) {
  return (
    <Link href={href} aria-current={on ? 'page' : undefined} onClick={onClick}
      className={cx('flex min-h-11 items-center gap-3 rounded-2xl px-3 text-[15px] font-semibold transition-colors',
        on ? 'bg-module-soft text-ink shadow-[inset_0_0_0_1px_var(--module-line)]' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
      <Icon size={20} weight={on ? 'fill' : 'regular'} aria-hidden className={cx('shrink-0', on && 'text-module')} />
      <span className="truncate">{label}</span>
    </Link>
  );
}

function Tab({ link: { href, label, Icon }, on }: { link: ModuleLink; on: boolean }) {
  return (
    <Link href={href} aria-current={on ? 'page' : undefined}
      className={cx('flex min-h-[58px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold', on ? 'text-module' : 'text-muted')}>
      <Icon size={23} weight={on ? 'fill' : 'regular'} aria-hidden />{label}
    </Link>
  );
}

function Person({ userName, businessName }: { userName?: string; businessName?: string }) {
  if (!userName && !businessName) return null;
  return (
    <div className="flex items-center gap-3 px-2 pb-2">
      <UserCircle size={34} aria-hidden className="shrink-0 text-muted" />
      <div className="min-w-0">
        {userName && <p className="truncate text-sm font-semibold">{userName}</p>}
        {businessName && <p className="truncate text-xs text-muted">{businessName}</p>}
      </div>
    </div>
  );
}

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label={label}>
      <button type="button" tabIndex={-1} aria-label="סגירה" onClick={onClose} className="absolute inset-0 animate-fade bg-black/55 backdrop-blur-[2px]" />
      <div className="safe-b absolute inset-x-0 bottom-0 max-h-[85vh] animate-pop overflow-y-auto rounded-t-[28px] border-t border-line bg-surface px-4 pb-6 pt-3 shadow-[0_-20px_60px_rgba(0,0,0,.5)]">
        <div className="mb-1 flex items-center justify-between">
          <span aria-hidden className="mx-auto h-1.5 w-12 rounded-full bg-line" />
        </div>
        <button type="button" onClick={onClose} aria-label="סגירה"
          className="absolute inset-e-2 top-2 grid h-11 w-11 place-items-center rounded-full text-ink-2 hover:bg-surface-2"><X size={20} aria-hidden /></button>
        {children}
      </div>
    </div>
  );
}
