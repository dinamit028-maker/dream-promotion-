'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Button, Input, PageHead, Select } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { saveMenu, savePage } from './data';
import { hiddenLinks, type HiddenLink } from './kits';
import { hasPlaceholders, linkTargets, menuProblem, STORE_LIMITS, type MenuLink, type PageRow } from './store';
import { storeHref } from './routes';
import { Block, NeedsStore, Notice } from './ui';
import { useStoreData } from './useStoreData';

/**
 * "תפריטים" (2.55): the main menu (at the top of every page) and the footer menu. A link leads to an address of the store
 * (a collection, a page, a policy…) or to an https:// address — the database keeps the same rule (store_links_ok). An empty
 * menu shows the storefront's own: every product and the collections.
 */
export function StoreNavigation() {
  const { data, error, loading, setData, reload } = useStoreData();
  if (loading) return <><PageHead title="תפריטים" /><p className="flex items-center gap-2 text-muted"><Spinner /> טוען…</p></>;
  if (error && !data) return <><PageHead title="תפריטים" /><Notice tone="error">{error}</Notice></>;
  if (!data?.store) return <><PageHead title="תפריטים" /><NeedsStore /></>;
  const targets = linkTargets(data.collections, data.pages);
  const saved = (kind: 'main' | 'footer', items: MenuLink[]) => setData((d) => (d ? { ...d, menus: { ...d.menus, [kind]: items } } : d));
  return (
    <>
      <PageHead title="תפריטים" sub="הקישורים בראש האתר ובתחתית שלו." />
      <HiddenLinks storeId={data.store.id} links={hiddenLinks(data.menus, data.pages, data.collections)} pages={data.pages} reload={reload} />
      <Menu key={`main-${data.store.id}`} storeId={data.store.id} kind="main" title="תפריט ראשי" empty='ריק — האתר מציג: "כל המוצרים", עד 4 קולקציות ו"צרו קשר".'
        initial={data.menus.main} targets={targets} onSaved={(items) => saved('main', items)} />
      <Menu key={`footer-${data.store.id}`} storeId={data.store.id} kind="footer" title="תפריט בתחתית" empty="ריק — האתר מציג עד 6 קולקציות. המדיניות ופרטי הקשר מוצגים בתחתית תמיד."
        initial={data.menus.footer} targets={targets} onSaved={(items) => saved('footer', items)} />
    </>
  );
}

/**
 * 2.58: a link to a page, a policy or a collection that is not on the site is left out of the menu the shoppers see
 * (migration 3800) — said here plainly, with a way to put it on the site.
 */
function HiddenLinks({ storeId, links, pages, reload }: { storeId: string; links: HiddenLink[]; pages: PageRow[]; reload: () => Promise<unknown> }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  if (!links.length && !msg) return null;
  const publish = async (l: HiddenLink) => {
    const g = pages.find((p) => p.id === l.target?.id);
    if (!g) return;
    setBusy(g.id); setMsg(null);
    const r = await savePage(storeId, g.id, { kind: g.kind, policy: g.policy, slug: g.slug, title: g.title, body: g.body, seo_title: g.seoTitle, seo_description: g.seoDescription, published: true });
    setBusy('');
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); return; }
    setMsg({ tone: 'ok', text: `"${g.title}" פורסם, והקישור אליו מופיע עכשיו בתפריט.` });
    await reload();
  };
  return (
    <Block title="קישורים שלא מופיעים באתר" sub="הם מובילים לעמוד, למדיניות או לקולקציה שעוד לא באתר — ולכן הלקוחות לא רואים אותם בתפריט. בתצוגה המקדימה הם מופיעים.">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <ul className="stack-y-2">
        {links.map((l, i) => {
          const g = l.target?.kind === 'page' ? pages.find((p) => p.id === l.target!.id) : undefined;
          const direct = g && g.body.trim() && !hasPlaceholders(g.body);
          return (
            <li key={`${l.menu}-${i}`} className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{l.label} <span className="text-xs font-normal text-muted">({l.menu === 'main' ? 'תפריט ראשי' : 'תפריט בתחתית'})</span></span>
                <span className="block text-xs text-muted">
                  {!l.target ? 'העמוד הזה לא קיים בכלל — כדאי להסיר את הקישור או ליצור את העמוד.'
                    : l.target.kind === 'collection' ? `הקולקציה "${l.target.title}" לא מוצגת באתר.`
                    : l.target.kind === 'policy' ? `"${l.target.title}" עוד לא פורסם (מדיניות מתפרסמת אחרי השלמה ואישור).`
                    : direct ? `העמוד "${l.target.title}" עוד לא פורסם.` : `העמוד "${l.target.title}" עוד לא פורסם, ויש בו מקומות להשלים [ … ].`}
                </span>
              </span>
              {l.target?.kind === 'page' && direct && <Button variant="primary" size="sm" disabled={busy === l.target.id} onClick={() => void publish(l)}>{busy === l.target.id ? <Spinner /> : 'פרסם את העמוד'}</Button>}
              {l.target?.kind === 'page' && !direct && <Link className="text-sm font-semibold text-primary underline underline-offset-2" href={storeHref('pages', { page: l.target.id })}>להשלמה ופרסום</Link>}
              {l.target?.kind === 'policy' && <Link className="text-sm font-semibold text-primary underline underline-offset-2" href={storeHref('pages', { policy: l.href.split('/').pop()! })}>להשלמה ופרסום</Link>}
              {l.target?.kind === 'collection' && <Link className="text-sm font-semibold text-primary underline underline-offset-2" href={storeHref('collections')}>לקולקציות</Link>}
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

const OTHER = '__other__';

function Menu({ storeId, kind, title, empty, initial, targets, onSaved }: {
  storeId: string; kind: 'main' | 'footer'; title: string; empty: string; initial: MenuLink[];
  targets: { href: string; label: string; note?: string }[]; onSaved: (items: MenuLink[]) => void;
}) {
  const [rows, setRows] = useState<MenuLink[]>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const change = (next: MenuLink[]) => { setRows(next); setDirty(true); setMsg(null); };
  const known = new Set(targets.map((t) => t.href));
  const move = (i: number, by: number) => {
    const j = i + by; if (j < 0 || j >= rows.length) return;
    const next = rows.slice(); [next[i], next[j]] = [next[j], next[i]]; change(next);
  };
  const save = async () => {
    const items = rows.map((r) => ({ label: r.label.trim(), href: r.href.trim() }));
    const problem = menuProblem(items);
    if (problem) { setMsg({ tone: 'error', text: problem }); return; }
    setBusy(true);
    const r = await saveMenu(storeId, kind, items);
    setBusy(false);
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); return; }
    setRows(items); setDirty(false); onSaved(items);
    setMsg({ tone: 'ok', text: 'התפריט נשמר. הוא מופיע באתר מיד.' });
  };

  return (
    <Block title={title} id={kind}>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {!rows.length && <p className="mb-3 text-sm text-muted">{empty}</p>}
      <ol className="mb-3 stack-y-3">
        {rows.map((r, i) => {
          const other = !known.has(r.href);
          return (
            <li key={i} className="rounded-md border border-line p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-2">שם הקישור</span>
                  <Input value={r.label} maxLength={STORE_LIMITS.menuLabel} onChange={(e) => change(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-2">לאן</span>
                  <Select value={other ? OTHER : r.href} onChange={(e) => {
                    const v = e.target.value;
                    const t = targets.find((x) => x.href === v);
                    // a new destination brings its name — unless the owner wrote a name of their own
                    const own = r.label.trim() !== '' && r.label !== targets.find((x) => x.href === r.href)?.label;
                    change(rows.map((x, j) => (j === i ? { label: own ? x.label : t?.label ?? '', href: v === OTHER ? 'https://' : v } : x)));
                  }}>
                    {targets.map((t) => <option key={t.href} value={t.href}>{t.label}{t.note ? ` (${t.note})` : ''}</option>)}
                    <option value={OTHER}>כתובת אחרת…</option>
                  </Select>
                </label>
              </div>
              {other && (
                <label className="mt-2 block">
                  <span className="mb-1 block text-xs font-semibold text-ink-2">כתובת</span>
                  <Input dir="ltr" value={r.href} maxLength={STORE_LIMITS.href} placeholder="https://… או /pages/…"
                    onChange={(e) => change(rows.map((x, j) => (j === i ? { ...x, href: e.target.value } : x)))} />
                </label>
              )}
              <div className="mt-2 flex gap-1">
                <Button variant="soft" size="sm" aria-label={`להזיז למעלה: ${r.label}`} disabled={i === 0} onClick={() => move(i, -1)}>▲</Button>
                <Button variant="soft" size="sm" aria-label={`להזיז למטה: ${r.label}`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>▼</Button>
                <Button variant="soft" size="sm" className="ms-auto" onClick={() => change(rows.filter((_, j) => j !== i))}>הסרה</Button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-2">
        {rows.length < STORE_LIMITS.menuItems && (
          <Button variant="soft" onClick={() => change([...rows, { label: targets[1]?.label ?? '', href: targets[1]?.href ?? '/' }])}>+ קישור</Button>
        )}
        <Button variant="primary" className="ms-auto" disabled={busy || !dirty} onClick={() => void save()}>{busy ? <><Spinner /> שומר…</> : 'שמירת התפריט'}</Button>
      </div>
    </Block>
  );
}
