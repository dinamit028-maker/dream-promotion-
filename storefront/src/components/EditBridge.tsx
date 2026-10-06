'use client';
import { useEffect } from 'react';
import type { EditMessage } from '@/lib/edit';

/**
 * "לחץ לעריכה" (2.61): inside the dashboard's visual editor only (site.edit). Every click is the owner choosing what to
 * edit, never a shopper's action: a text marked inline is edited in place, anything else is named to the dashboard, a link
 * to another page of the store asks the dashboard to go there, and nothing is submitted. Messages go only to the dashboard's
 * origin, and only its messages are read.
 */
export function EditBridge({ dashboard }: { dashboard: string }) {
  useEffect(() => {
    if (window.parent === window) return;   // opened on its own, not framed: no editing
    const send = (m: EditMessage) => window.parent.postMessage(m, dashboard);
    document.documentElement.classList.add('edit-mode');
    let selected: HTMLElement | null = null;
    const select = (el: HTMLElement | null) => { selected?.classList.remove('edit-selected'); selected = el; el?.classList.add('edit-selected'); };

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
      const sectionEl = t.closest<HTMLElement>('[data-edit-section]');
      const section = sectionEl?.dataset.editSection;
      const field = t.closest<HTMLElement>('[data-edit-field]');
      const image = t.closest<HTMLElement>('[data-edit-image]');
      const link = t.closest<HTMLElement>('[data-edit-link]');
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
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.isContentEditable && (e.key === 'Enter' || e.key === 'Escape')) { e.preventDefault(); el.blur(); }
    };
    const stop = (e: Event) => e.preventDefault();
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== dashboard || !e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'select' && typeof e.data.id === 'string') {
        const el = document.querySelector<HTMLElement>(`[data-edit-section="${CSS.escape(e.data.id)}"]`);
        select(el); el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('submit', stop, true);
    window.addEventListener('message', onMessage);
    send({ type: 'ready', path: location.pathname });
    return () => {
      document.removeEventListener('click', onClick, true); document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('submit', stop, true); window.removeEventListener('message', onMessage);
    };
  }, [dashboard]);
  return null;
}
