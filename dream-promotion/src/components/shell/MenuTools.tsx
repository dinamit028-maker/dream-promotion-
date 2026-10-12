'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from '@/lib/utils';
import { MagnifyingGlass, Star, X } from '@/components/ui/Icon';
import { useLocations } from '@/features/locations/store';
import { multiLocation } from '@/features/locations/locations';
import { journalReady } from '@/features/finance/journal-data';
import { appEntries, dedupe, moduleEntries, searchMenu, type MenuEntry } from './menu-search';
import { favoriteEntries } from './favorites';
import { useFavorites } from './favorites-store';
import type { ModuleGroup } from './module-nav';

/**
 * The search in the menu and the favorites (2.96, T11) — one set of parts for the app's menu (AppShell), a module's menu
 * (ModuleShell) and the home screen: a star next to a screen, "מועדפים" at the top of the menu, a search box ("גבייה" → חייבים)
 * and the search window of a computer (Ctrl+K, or the search field at the top of the menu).
 */

/** every screen the person may open now: a module's own menu first (when inside one), then the app's */
export function useMenuEntries(o: { admin?: boolean; moduleName?: string; moduleGroups?: ModuleGroup[] } = {}): MenuEntry[] {
  const multi = useLocations((x) => multiLocation(x.state));
  const [journal, setJournal] = useState(false);
  // the journal's screen exists once its migration is in the database (asked once an app open)
  useEffect(() => { let alive = true; void journalReady().then((v) => { if (alive) setJournal(v); }); return () => { alive = false; }; }, []);
  const { admin, moduleName, moduleGroups } = o;
  return useMemo(() => dedupe([...(moduleName && moduleGroups ? moduleEntries(moduleName, moduleGroups) : []), ...appEntries({ multi, admin, journal })]),
    [multi, admin, journal, moduleName, moduleGroups]);
}

/** ☆ next to a screen: on — in the favorites (a filled star, always shown); off — shown on hover / focus, or always (`always`) */
export function StarButton({ href, label, always, className }: { href: string; label: string; always?: boolean; className?: string }) {
  const on = useFavorites((s) => s.list.includes(href));
  const toggle = useFavorites((s) => s.toggle);
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" aria-pressed={on} aria-label={`${on ? 'הסרה מהמועדפים' : 'הוספה למועדפים'}: ${label}`} title={on ? 'הסרה מהמועדפים' : 'הוספה למועדפים'}
      disabled={busy}
      onClick={async (e) => {
        e.preventDefault(); e.stopPropagation();
        setBusy(true);
        const m = await toggle(href);
        setBusy(false);
        if (m) useFavorites.setState({ message: m });
      }}
      className={cx('grid h-11 w-11 shrink-0 place-items-center rounded-full transition-opacity hover:bg-surface-2 focus-visible:opacity-100',
        on ? 'text-amber-500' : cx('text-muted hover:text-amber-500', !always && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'), className)}>
      <Star size={18} weight={on ? 'fill' : 'regular'} aria-hidden />
    </button>
  );
}

/** "מועדפים": the starred screens the person sees now — nothing at all when there are none (and no message) */
export function FavoritesList({ entries, path, variant, onNavigate }: {
  entries: MenuEntry[]; path?: string; variant: 'side' | 'sheet' | 'home'; onNavigate?: () => void;
}) {
  const list = useFavorites((s) => s.list);
  const message = useFavorites((s) => s.message);
  const favs = favoriteEntries(list, entries);
  useEffect(() => { if (!message) return; const t = setTimeout(() => useFavorites.setState({ message: null }), 5000); return () => clearTimeout(t); }, [message]);
  if (!favs.length && !message) return null;
  const note = message ? <p role="status" className="px-3 pb-1 text-xs font-semibold text-warn">{message}</p> : null;
  if (variant === 'home') {
    return (
      <section aria-label="מועדפים" className="mb-6">
        <h3 className="mb-2 font-display text-xl font-black">מועדפים</h3>
        {note}
        <div className="flex flex-wrap gap-2">
          {favs.map((e) => (
            <Link key={e.href} href={e.href} className="flex min-h-11 items-center gap-2 rounded-2xl border border-line bg-surface px-4 text-sm font-semibold hover:bg-surface-2">
              {e.Icon && <e.Icon size={18} aria-hidden className="text-primary" />}{e.label}{e.where && <span className="text-xs font-normal text-muted">· {e.where}</span>}
            </Link>
          ))}
        </div>
      </section>
    );
  }
  return (
    <div aria-label="מועדפים" role="group" className={cx(variant === 'side' ? 'mb-3 border-b border-line pb-3' : 'mb-3')}>
      <p className="px-3 pb-1 text-xs font-bold text-muted">מועדפים</p>
      {note}
      <ul className={cx(variant === 'sheet' ? 'flex flex-wrap gap-1.5 px-1' : 'flex flex-col gap-0.5')}>
        {favs.map((e) => {
          const on = path != null && path === e.href.split('?')[0];
          return (
            <li key={e.href} className={cx('group relative', variant === 'sheet' && 'flex')}>
              <Link href={e.href} onClick={onNavigate} aria-current={on ? 'page' : undefined}
                className={cx(variant === 'sheet'
                  ? 'flex min-h-11 items-center gap-2 rounded-2xl border border-line bg-surface-2 ps-3 pe-11 text-sm font-semibold'
                  : 'flex min-h-11 items-center gap-3 rounded-2xl px-3 pe-11 text-[15px] font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink',
                on && 'bg-primary-soft text-ink')}>
                {e.Icon && <e.Icon size={variant === 'sheet' ? 18 : 20} aria-hidden className="shrink-0" />}
                <span className="truncate">{e.label}</span>
              </Link>
              <StarButton href={e.href} label={e.label} className="absolute inset-y-0 end-0 my-auto" />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** the search box: as one types, the screens (best first); arrows choose, Enter opens, Escape clears */
export function MenuSearch({ entries, onNavigate, autoFocus, className }: { entries: MenuEntry[]; onNavigate?: () => void; autoFocus?: boolean; className?: string }) {
  const router = useRouter();
  const id = useId();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchMenu(entries, q), [entries, q]);
  useEffect(() => { setActive(0); }, [q]);
  const go = (e: MenuEntry | undefined) => { if (!e) return; setQ(''); onNavigate?.(); router.push(e.href); };
  function keys(ev: KeyboardEvent<HTMLInputElement>) {
    if (ev.key === 'ArrowDown' && results.length) { ev.preventDefault(); setActive((a) => (a + 1) % results.length); }
    else if (ev.key === 'ArrowUp' && results.length) { ev.preventDefault(); setActive((a) => (a - 1 + results.length) % results.length); }
    else if (ev.key === 'Enter') { ev.preventDefault(); go(results[active] ?? results[0]); }
    else if (ev.key === 'Escape' && q) { ev.preventDefault(); ev.stopPropagation(); ev.nativeEvent.stopPropagation(); setQ(''); }
  }
  return (
    <div className={className}>
      {/* the magnifier sits on the box itself (not on the box and the results under it) */}
      <div className="relative">
        <MagnifyingGlass size={18} aria-hidden className="pointer-events-none absolute inset-y-0 start-3 my-auto text-muted" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={keys} autoFocus={autoFocus}
          role="combobox" aria-expanded={results.length > 0} aria-controls={`${id}-list`} aria-autocomplete="list"
          aria-activedescendant={results.length ? `${id}-${active}` : undefined} aria-label="חיפוש בתפריט" placeholder="חיפוש מסך — למשל: גבייה"
          className="h-11 w-full rounded-2xl border border-line bg-surface ps-10 pe-3 text-[15px] outline-none focus:border-primary" />
      </div>
      {q.trim() !== '' && (
        <ul id={`${id}-list`} role="listbox" aria-label="תוצאות החיפוש" className="mt-1 grid gap-0.5 rounded-2xl border border-line bg-surface p-1 shadow-lg">
          {!results.length && <li className="px-3 py-2 text-sm text-muted">אין מסך כזה בתפריט.</li>}
          {results.map((e, i) => (
            <li key={e.href} id={`${id}-${i}`} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => go(e)}
              className={cx('flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 text-[15px]', i === active ? 'bg-primary-soft text-ink' : 'text-ink-2')}>
              {e.Icon && <e.Icon size={18} aria-hidden className="shrink-0" />}
              <span className="min-w-0 flex-1 truncate font-semibold">{e.label}</span>
              {e.where && <span className="shrink-0 text-xs text-muted">{e.where}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** a computer's search: a window at the top of the screen (the search field of the menu, or Ctrl+K) */
export function SearchDialog({ entries, onClose }: { entries: MenuEntry[]; onClose: () => void }) {
  const back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    back.current = document.activeElement as HTMLElement | null;
    const k = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', k);
    return () => { removeEventListener('keydown', k); back.current?.focus?.(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="חיפוש בתפריט">
      <button type="button" tabIndex={-1} aria-label="סגירת החיפוש" onClick={onClose} className="absolute inset-0 animate-fade bg-black/50 backdrop-blur-[2px]" />
      <div className="absolute inset-x-3 top-16 mx-auto max-w-lg animate-pop rounded-3xl border border-line bg-surface p-3 shadow-[0_24px_70px_rgba(0,0,0,.45)]">
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <p className="font-display text-lg font-bold">חיפוש בתפריט</p>
          <button type="button" onClick={onClose} aria-label="סגירה" className="grid h-11 w-11 place-items-center rounded-full text-ink-2 hover:bg-surface-2"><X size={20} aria-hidden /></button>
        </div>
        <MenuSearch entries={entries} onNavigate={onClose} autoFocus />
        <p className="mt-2 px-1 text-xs text-muted">Enter — למסך הראשון · חיצים — לבחירה · Esc — סגירה. ☆ ליד מסך בתפריט — למועדפים.</p>
      </div>
    </div>
  );
}

/**
 * the search at the top of a computer's menu: a field to click — the search window opens ready to type ("גבייה" → Enter) — with
 * its keys (Ctrl K; ⌘K on a Mac); in a narrow menu (a tablet) a magnifier
 */
export function SearchButton({ onClick, variant = 'field', className }: { onClick: () => void; variant?: 'field' | 'icon'; className?: string }) {
  const [mac, setMac] = useState(false);
  useEffect(() => { setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)); }, []);
  if (variant === 'icon') {
    return (
      <button type="button" data-menu-search onClick={onClick} aria-label="חיפוש בתפריט" title={`חיפוש בתפריט (${mac ? '⌘K' : 'Ctrl+K'})`}
        className={cx('grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink', className)}>
        <MagnifyingGlass size={20} aria-hidden />
      </button>
    );
  }
  return (
    <button type="button" data-menu-search onClick={onClick} aria-label="חיפוש בתפריט" aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
      className={cx('flex h-11 w-full shrink-0 items-center gap-2 rounded-2xl border border-line bg-surface px-3 text-start text-sm text-muted transition-colors hover:border-primary hover:text-ink', className)}>
      <MagnifyingGlass size={18} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">חיפוש מסך…</span>
      <kbd dir="ltr" className="shrink-0 rounded-md border border-line px-1.5 py-0.5 font-sans text-[11px] font-semibold">{mac ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
  );
}

/** Ctrl+K (⌘K on a Mac) opens the search — while `on` */
export function useSearchShortcut(on: boolean, open: () => void) {
  useEffect(() => {
    if (!on) return;
    const k = (e: globalThis.KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); } };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [on, open]);
}
