'use client';
import { useEffect } from 'react';
import { STYLE_CLASS } from '@/lib/builder-registry';
import type { EditMessage } from '@/lib/edit';
import { tokenVars } from '@/lib/theme-tokens';

/**
 * "לחץ לעריכה" (2.61): inside the dashboard's visual editor only (site.edit). Every click is the owner choosing what to
 * edit, never a shopper's action: a text marked inline is edited in place, anything else is named to the dashboard, a link
 * to another page of the store asks the dashboard to go there, and nothing is submitted. Messages go only to the dashboard's
 * origin, and only its messages are read.
 *
 * 2.65 (Dream Builder PR-3a) — no reload for every change:
 *   - the dashboard says "move" / "remove": the section's element moves or goes at once (the draft is saved behind it);
 *   - "rerender": after a save, this page fetches itself again (the same address, the same edit token) and swaps the
 *     content — the header, the main part, the footer — keeping the scroll; a failure or no answer in 4 seconds reloads;
 *   - dragging: a handle on the chosen section (a long press on a phone, the arrows and space on a keyboard). The page only
 *     says where it was dropped; the dashboard decides, and answers with "move". The page never changes the draft itself.
 */
const MOVE_HOLD_MS = 400;
const REFETCH_MS = 4000;

export function EditBridge({ dashboard }: { dashboard: string }) {
  useEffect(() => {
    if (window.parent === window) return;   // opened on its own, not framed: no editing
    const send = (m: EditMessage) => window.parent.postMessage(m, dashboard);
    document.documentElement.classList.add('edit-mode');
    const live = document.createElement('div');
    live.className = 'sr-only'; live.setAttribute('aria-live', 'assertive');
    document.body.appendChild(live);
    const say = (text: string) => { live.textContent = ''; window.setTimeout(() => { live.textContent = text; }, 30); };

    const sections = () => Array.from(document.querySelectorAll<HTMLElement>('main > [data-edit-section]'));
    const byId = (id: string) => document.querySelector<HTMLElement>(`[data-edit-section="${CSS.escape(id)}"]`);
    let selected: HTMLElement | null = null;
    const handle = document.createElement('button');
    handle.type = 'button'; handle.className = 'edit-drag'; handle.textContent = '⠿';
    handle.setAttribute('aria-label', 'גרירת החלק. במקלדת: רווח כדי להרים, חיצים כדי להזיז, רווח כדי להניח');
    const select = (el: HTMLElement | null) => {
      selected?.classList.remove('edit-selected'); selected = el; el?.classList.add('edit-selected');
      if (el) el.appendChild(handle); else handle.remove();
    };
    // 2.67: the block of a free section open in the panel (its id survives a rerender)
    let block: string | null = null;
    const markBlock = (id: string | null) => {
      block = id;
      document.querySelectorAll('.edit-block-selected').forEach((x) => x.classList.remove('edit-block-selected'));
      if (id) selected?.querySelector(`[data-edit-block="${CSS.escape(id)}"]`)?.classList.add('edit-block-selected');
    };

    // ---- the dashboard's commands ---------------------------------------------------------------------------------------
    const moveTo = (id: string, to: number) => {
      const list = sections(), el = byId(id);
      if (!el) return;
      const others = list.filter((x) => x !== el);
      const ref = others[to];
      if (ref) ref.before(el); else others[others.length - 1]?.after(el);
      say(`החלק הוזז למקום ${sections().indexOf(el) + 1} מתוך ${sections().length}`);
    };
    let rev = 0;
    const rerender = async (r: number) => {
      rev = r;
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), REFETCH_MS);
      try {
        const res = await fetch(location.href, { credentials: 'same-origin', signal: ctrl.signal, cache: 'no-store' });
        const html = res.ok ? await res.text() : '';
        window.clearTimeout(timer);
        if (r !== rev) return;                          // a newer one is on its way
        // without its <head>: a parsed document takes this page's CSP, and the fetched <style> carries the other request's nonce
        const doc = new DOMParser().parseFromString(html.replace(/<head[\s\S]*?<\/head>/i, '<head></head>'), 'text/html');
        const swap = (sel: string) => {
          const fresh = doc.querySelector(sel), cur = document.querySelector(sel);
          if (!fresh || !cur) return false;
          cur.replaceChildren(...Array.from(fresh.childNodes).map((n) => document.importNode(n, true)));
          return true;
        };
        if (!swap('main')) { location.reload(); return; }
        swap('header.site-header'); swap('footer.site-footer');
        document.body.className = doc.body.className;
        const id = selected?.dataset.editSection;
        select(id ? byId(id) : null);
        markBlock(block);
      } catch {
        if (r === rev) location.reload();
      }
    };

    // 2.66: "עיצוב כללי" at once — the theme's variables (checked here: hex colours, a corner and a font from the lists) set
    // through CSSOM, and the body's design classes (only names of the lists' shape); the saved draft follows
    const CLASS = /^v-(sp|hs|btn|ct|card|h|f|pc|cc|pp)-[a-z][a-z-]{1,30}$/;
    const applyStyle = (m: Record<string, unknown>) => {
      const vars = m.colors && typeof m.colors === 'object' ? tokenVars(m.colors, m.font, m.radius) : null;
      if (vars) for (const [k, v] of vars) document.documentElement.style.setProperty(k, v);
      const classes = typeof m.classes === 'string' ? m.classes.split(' ') : [];
      if (classes.length === 10 && classes.every((c) => CLASS.test(c))) {
        const keep = Array.from(document.body.classList).filter((c) => !CLASS.test(c));
        document.body.className = [...keep, ...classes].join(' ');
      }
    };

    // ---- clicks and typing -------------------------------------------------------------------------------------------------
    const finish = (el: HTMLElement) => {
      el.removeAttribute('contenteditable');
      const section = el.closest<HTMLElement>('[data-edit-section]')?.dataset.editSection;
      const field = el.dataset.editField;
      if (section && field) send({ type: 'text', section, field, value: (el.textContent ?? '').replace(/\s+/g, ' ').trim() });
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('[contenteditable]')) return;          // typing in a text being edited
      e.preventDefault(); e.stopPropagation();
      if (t.closest('.edit-drag')) return;                  // the handle drags, it does not choose
      const sectionEl = t.closest<HTMLElement>('[data-edit-section]');
      const section = sectionEl?.dataset.editSection;
      const field = t.closest<HTMLElement>('[data-edit-field]');
      const image = t.closest<HTMLElement>('[data-edit-image]');
      const link = t.closest<HTMLElement>('[data-edit-link]');
      const blockEl = t.closest<HTMLElement>('[data-edit-block]');
      if (blockEl && section) { select(sectionEl!); markBlock(blockEl.dataset.editBlock!); send({ type: 'block', section, id: blockEl.dataset.editBlock! }); return; }
      markBlock(null);
      if (field && section) {
        select(sectionEl!);
        if (field.hasAttribute('data-edit-inline')) {
          field.setAttribute('contenteditable', 'plaintext-only');
          field.focus();
          field.addEventListener('blur', () => finish(field), { once: true });
        } else send({ type: 'field', section, field: field.dataset.editField! });
        return;
      }
      if (image && section) { select(sectionEl!); send({ type: 'image', section, field: image.dataset.editImage! }); return; }
      if (sectionEl && section) { select(sectionEl); send({ type: 'section', id: section }); return; }
      // the nearer of the two wins: a product card inside a collection's page goes to the product, the page's own text opens
      // the collection; a menu link goes to its page, the header around it opens the menus
      const a = t.closest<HTMLAnchorElement>('a[href]');
      const inside = a && (!link || link.contains(a));
      if (a && inside) {
        const u = new URL(a.href, location.href);
        if (u.origin === location.origin) send({ type: 'navigate', path: u.pathname });
        else if (link) send({ type: 'open', target: link.dataset.editLink! });
        return;
      }
      if (link) send({ type: 'open', target: link.dataset.editLink! });
    };

    // ---- dragging a section ---------------------------------------------------------------------------------------------
    let drag: { el: HTMLElement; line: HTMLElement; to: number; y: number; raf: number } | null = null;
    let hold = 0;
    const targetAt = (el: HTMLElement, y: number) => sections().filter((x) => x !== el).filter((x) => { const r = x.getBoundingClientRect(); return r.top + r.height / 2 < y; }).length;
    const placeLine = () => {
      if (!drag) return;
      const others = sections().filter((x) => x !== drag!.el);
      const ref = others[drag.to];
      const top = ref ? ref.getBoundingClientRect().top : (others[others.length - 1]?.getBoundingClientRect().bottom ?? 0);
      drag.line.style.setProperty('--edit-line-y', `${Math.round(top)}px`);   // CSSOM, not an attribute: the CSP allows it
    };
    const tick = () => {
      if (!drag) return;
      const edge = 70, h = window.innerHeight;
      if (drag.y < edge) window.scrollBy(0, -12); else if (drag.y > h - edge) window.scrollBy(0, 12);
      drag.to = targetAt(drag.el, drag.y); placeLine();
      drag.raf = window.requestAnimationFrame(tick);
    };
    const start = (y: number) => {
      if (!selected) return;
      const line = document.createElement('div');
      line.className = 'edit-drop-line'; line.setAttribute('aria-hidden', 'true');
      document.body.appendChild(line);
      selected.classList.add('edit-dragging');
      drag = { el: selected, line, to: targetAt(selected, y), y, raf: 0 };
      drag.raf = window.requestAnimationFrame(tick);
      navigator.vibrate?.(15);
    };
    const end = (drop: boolean) => {
      window.clearTimeout(hold); hold = 0;
      if (!drag) return;
      window.cancelAnimationFrame(drag.raf);
      drag.line.remove(); drag.el.classList.remove('edit-dragging');
      const { el, to } = drag; drag = null;
      const id = el.dataset.editSection;
      if (drop && id && to !== sections().indexOf(el)) send({ type: 'drop', id, to });
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.edit-drag')) return;
      e.preventDefault();
      const y = e.clientY;
      // a finger holds the handle for a moment (so a scroll is not a drag); a mouse drags at once
      if (e.pointerType === 'touch') hold = window.setTimeout(() => start(y), MOVE_HOLD_MS); else start(y);
    };
    const onPointerMove = (e: PointerEvent) => { if (drag) { drag.y = e.clientY; e.preventDefault(); } };
    const onPointerUp = () => end(true);
    const onPointerCancel = () => end(false);
    let lifted: { id: string; from: number } | null = null;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.isContentEditable && (e.key === 'Enter' || e.key === 'Escape')) { e.preventDefault(); el.blur(); return; }
      if (drag && e.key === 'Escape') { e.preventDefault(); end(false); return; }
      if (el !== handle || !selected) return;
      const id = selected.dataset.editSection!, at = sections().indexOf(selected);
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (lifted) { lifted = null; say('החלק הונח'); } else { lifted = { id, from: at }; say(`החלק הורם, מקום ${at + 1} מתוך ${sections().length}. חיצים כדי להזיז, רווח כדי להניח, Escape כדי לבטל`); }
      } else if (lifted && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const to = at + (e.key === 'ArrowUp' ? -1 : 1);
        if (to >= 0 && to < sections().length) send({ type: 'drop', id, to });
      } else if (lifted && e.key === 'Escape') {
        e.preventDefault();
        if (at !== lifted.from) send({ type: 'drop', id, to: lifted.from });
        lifted = null; say('ההזזה בוטלה');
      }
    };
    const stop = (e: Event) => e.preventDefault();
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== dashboard || !e.data || typeof e.data !== 'object') return;
      const m = e.data as Record<string, unknown>;
      const id = typeof m.id === 'string' && m.id.length <= 40 ? m.id : null;
      if (m.type === 'select' && id) {
        const el = byId(id); select(el);
        markBlock(typeof m.block === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(m.block) ? m.block : null);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      else if (m.type === 'move' && id && Number.isInteger(m.to) && (m.to as number) >= 0) { moveTo(id, m.to as number); if (lifted || selected?.dataset.editSection === id) handle.focus(); }
      else if (m.type === 'remove' && id) { const el = byId(id); if (el === selected) select(null); el?.remove(); }
      else if (m.type === 'rerender' && Number.isInteger(m.rev)) void rerender(m.rev as number);
      else if (m.type === 'style') applyStyle(m);
      // 2.68: a section's own design at once — only classes of the scales' shape (STYLE_CLASS), the saved draft follows
      else if (m.type === 'sectionStyle' && id && Array.isArray(m.classes) && m.classes.length <= 12 && m.classes.every((c) => typeof c === 'string' && STYLE_CLASS.test(c))) {
        const el = byId(id);
        if (el) { el.classList.remove(...Array.from(el.classList).filter((c) => STYLE_CLASS.test(c))); el.classList.add(...(m.classes as string[])); }
      }
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('submit', stop, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('message', onMessage);
    send({ type: 'ready', path: location.pathname });
    return () => {
      end(false);
      document.removeEventListener('click', onClick, true); document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('submit', stop, true); document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove); window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel); window.removeEventListener('message', onMessage);
      live.remove(); handle.remove();
    };
  }, [dashboard]);
  return null;
}
