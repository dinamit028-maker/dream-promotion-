'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { A11Y_CLASSES, A11Y_KEY, A11Y_TOGGLES, NO_PREFS, isDefault, prefClasses, readPrefs, writePrefs, type A11yPrefs, type A11yToggle, type TextLevel } from '@/lib/a11y';

/**
 * The accessibility menu (2.104): a button at the bottom left of every page, and a panel of choices — the text's size, high
 * contrast, links marked, a readable font, no motion, more space between lines, all back to normal, and the statement. Built
 * here (no plugin), nothing sent anywhere: the choices stay in this browser (lib/a11y.ts) and hold from page to page.
 * The panel: native radios and checkboxes (a screen reader says each state), focus inside on opening, Esc closes and gives the
 * focus back to the button, a click outside or the focus leaving closes it. While the cookie banner is open, the button sits
 * above it (its height, by CSSOM — the CSP allows it, not a style attribute).
 */
const SIZES: [TextLevel, string][] = [[0, 'רגיל'], [1, 'גדול'], [2, 'גדול יותר'], [3, 'גדול מאוד']];
const TOGGLES: Record<A11yToggle, string> = {
  contrast: 'ניגודיות גבוהה', links: 'הדגשת קישורים', font: 'פונט קריא', still: 'עצירת אנימציות', spacing: 'ריווח שורות מוגדל',
};

function load(): A11yPrefs {
  try { return readPrefs(localStorage.getItem(A11Y_KEY)); } catch { return { ...NO_PREFS }; }
}
function keep(p: A11yPrefs) {
  try {
    const v = writePrefs(p);
    if (v) localStorage.setItem(A11Y_KEY, v); else localStorage.removeItem(A11Y_KEY);
  } catch { /* no storage (a private window): the choice holds on this page only */ }
}
function apply(p: A11yPrefs) {
  const c = document.documentElement.classList;
  c.remove(...A11Y_CLASSES);
  c.add(...prefClasses(p));
}

export function A11yMenu({ statement }: { statement: string }) {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<A11yPrefs>(NO_PREFS);
  const [said, setSaid] = useState('');
  const fab = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  // the boot script (<head>) already put the kept choices on the page: the menu only shows them
  useEffect(() => { const p = load(); setPrefs(p); apply(p); }, []);

  const change = (next: A11yPrefs, say = '') => { setPrefs(next); apply(next); keep(next); setSaid(say); };

  const close = useCallback((focusBack: boolean) => {
    setOpen(false);
    if (focusBack) fab.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    // the focus on the first choice — the text size chosen now (a selector list would find the close button first)
    (panel.current?.querySelector<HTMLElement>('input:checked') ?? panel.current?.querySelector<HTMLElement>('input, button'))?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(true); } };
    const outside = (t: EventTarget | null) => !(t instanceof Node) || !(panel.current?.contains(t) || fab.current?.contains(t));
    const onDown = (e: PointerEvent) => { if (outside(e.target)) close(false); };
    const onFocus = (e: FocusEvent) => { if (outside(e.target)) close(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('focusin', onFocus);
    };
  }, [open, close]);

  // the cookie banner sits at the bottom too: while it is open, the button goes above it
  useEffect(() => {
    const root = document.documentElement;
    let seen: ResizeObserver | null = null;
    const watch = () => {
      const banner = document.querySelector<HTMLElement>('.consent');
      seen?.disconnect();
      seen = null;
      root.classList.toggle('a11y-lift', Boolean(banner));
      if (!banner) { root.style.removeProperty('--a11y-lift'); return; }
      const set = () => root.style.setProperty('--a11y-lift', `${Math.ceil(banner.getBoundingClientRect().height)}px`);
      set();
      seen = new ResizeObserver(set);
      seen.observe(banner);
    };
    watch();
    const added = new MutationObserver(watch);
    added.observe(document.body, { childList: true });
    return () => { added.disconnect(); seen?.disconnect(); root.classList.remove('a11y-lift'); };
  }, []);

  return (
    <div className="a11y">
      <button ref={fab} type="button" className="a11y-fab" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => (open ? close(false) : setOpen(true))}>
        <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="10.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="12" cy="6.7" r="1.7" fill="currentColor" />
          <path d="M6.6 9.5c1.8.5 3.6.8 5.4.8s3.6-.3 5.4-.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M12 10.3v3.5m0 0-2.5 4.4m2.5-4.4 2.5 4.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="sr-only">תפריט נגישות</span>
      </button>
      <div ref={panel} id={`${id}-panel`} className="a11y-panel" role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} hidden={!open}>
        <div className="a11y-head">
          <h2 id={`${id}-title`} className="a11y-title">נגישות</h2>
          <button type="button" className="a11y-close" onClick={() => close(true)}>
            <span aria-hidden="true">×</span><span className="sr-only">סגירת תפריט הנגישות</span>
          </button>
        </div>
        <fieldset className="a11y-sizes">
          <legend className="a11y-legend">גודל טקסט</legend>
          <div className="a11y-size-row">
            {SIZES.map(([v, label]) => (
              <label key={v} className="a11y-size">
                <input type="radio" name={`${id}-text`} value={v} checked={prefs.text === v} onChange={() => change({ ...prefs, text: v })} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <ul className="a11y-toggles" role="list">
          {A11Y_TOGGLES.map((k) => (
            <li key={k}>
              <label className="a11y-toggle">
                <input type="checkbox" checked={prefs[k]} onChange={(e) => change({ ...prefs, [k]: e.target.checked })} />
                <span>{TOGGLES[k]}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="a11y-foot">
          <button type="button" className="btn btn-ghost a11y-reset" disabled={isDefault(prefs)} onClick={() => change({ ...NO_PREFS }, 'כל הבחירות בוטלו — האתר חזר לרגיל.')}>
            איפוס הכול
          </button>
          <a href={statement} className="a11y-statement">הצהרת נגישות</a>
        </div>
        <p className="sr-only" role="status">{said}</p>
      </div>
    </div>
  );
}
