'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { cx } from '@/lib/utils';
import { Button, Chip, Input, PageHead, Pill, Select } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { Switch } from '@/features/catalog/PublishSwitch';
import { LIMITS, SEO_SHOWN, type CatalogItem } from '@/features/catalog/catalog';
import { loadCatalog } from '@/features/catalog/data';
import { deleteCollection, orderCollections, saveCollection, type CollectionInput } from './data';
import { allTags, COLLECTION_SORT, collectionProblem, matchesTags, STORE_LIMITS, suggestSlug, type CollectionRow } from './store';
import { AiShort } from './AiShort';
import { AreaRow, Block, NeedsStore, Notice, PicturePicker, TextRow } from './ui';
import { useStoreData } from './useStoreData';

/**
 * "קולקציות" (2.55): groups of products on the site — hand-picked in an order of their own, or automatic by tag — each
 * with its page (/collections/<address>), a picture, a text and a title for Google. Not on the site until "באתר" is on.
 * Changing the address of a collection that was on the site leaves a 301 from the old one (the database does it).
 */
export function StoreCollections() {
  return <Suspense fallback={<div className="py-10 text-center"><Spinner /></div>}><Collections /></Suspense>;
}

type Draft = { id: string | null; title: string; slug: string; slugTouched: boolean; description: string; imageUrl: string; kind: 'manual' | 'auto';
  tags: string[]; sort: CollectionRow['sort']; publishOnline: boolean; seoTitle: string; seoDescription: string; position: number; items: string[] };
const draftOf = (c: CollectionRow | null, position: number): Draft => c
  ? { id: c.id, title: c.title, slug: c.slug, slugTouched: true, description: c.description, imageUrl: c.imageUrl, kind: c.kind, tags: c.tags, sort: c.sort,
      publishOnline: c.publishOnline, seoTitle: c.seoTitle, seoDescription: c.seoDescription, position: c.position, items: c.items.map((x) => x.itemId) }
  : { id: null, title: '', slug: '', slugTouched: false, description: '', imageUrl: '', kind: 'manual', tags: [], sort: 'manual', publishOnline: false,
      seoTitle: '', seoDescription: '', position, items: [] };

function Collections() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { data, error, loading, reload, setData } = useStoreData();
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void loadCatalog().then((r) => setItems(r.ok ? r.data.items : [])); }, []);
  const list = data?.collections ?? [];
  // "+ קולקציה חדשה" of the module
  // and a collection clicked on the site, in the visual editor (?edit=<id>, 2.61)
  useEffect(() => {
    if (!data?.store) return;
    const one = params?.get('edit') ? list.find((c) => c.id === params.get('edit')) : undefined;
    if (one) setEdit(draftOf(one, one.position));
    else if (params?.get('new') === '1') setEdit(draftOf(null, list.length));
    else return;
    router.replace(pathname, { scroll: false });
  }, [params, data?.store]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <><PageHead title="קולקציות" /><p className="flex items-center gap-2 text-muted"><Spinner /> טוען…</p></>;
  if (error && !data) return <><PageHead title="קולקציות" /><Notice tone="error">{error}</Notice></>;
  if (!data?.store) return <><PageHead title="קולקציות" /><NeedsStore /></>;

  if (edit) {
    return <Editor draft={edit} items={items} taken={list.filter((c) => c.id !== edit.id).map((c) => c.slug)} onClose={() => setEdit(null)}
      onSaved={async (text) => { await reload(); setEdit(null); setMsg({ tone: 'ok', text }); }} />;
  }

  // the order of the collections on the site: positions 0…n-1 by the order on the screen
  const move = async (i: number, by: number) => {
    const j = i + by; if (j < 0 || j >= list.length) return;
    const next = list.slice(); [next[i], next[j]] = [next[j], next[i]];
    setBusy(true); setMsg(null);
    const r = await orderCollections(next);
    setBusy(false);
    if (!r.ok) { setMsg({ tone: 'error', text: r.error }); await reload(); return; }
    setData((d) => (d ? { ...d, collections: next.map((c, k) => ({ ...c, position: k })) } : d));
  };

  return (
    <>
      <PageHead title="קולקציות" sub="קבוצות של מוצרים באתר — למשל שקיות נייר, שקיות בד. לכל קולקציה עמוד משלה."
        action={<Button variant="primary" onClick={() => { setMsg(null); setEdit(draftOf(null, list.length)); }}>+ קולקציה חדשה</Button>} />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {!list.length ? (
        <div className="rounded-lg border border-dashed border-line p-6 text-center">
          <p className="mb-1 font-semibold">עוד אין קולקציות.</p>
          <p className="text-sm text-muted">בלי קולקציות האתר מציג את כל המוצרים יחד, בעמוד "כל המוצרים".</p>
        </div>
      ) : (
        <ol className="stack-y-2">
          {list.map((c, i) => {
            const count = c.kind === 'manual' ? c.items.length : (items ?? []).filter((it) => matchesTags(it.tags, c.tags)).length;
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface p-3">
                {c.imageUrl
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={c.imageUrl} alt="" className="h-12 w-12 rounded-md border border-line object-cover" />
                  : <span aria-hidden className="grid h-12 w-12 place-items-center rounded-md bg-surface-2 text-lg">🛍</span>}
                <button type="button" className="min-w-0 flex-1 text-start" onClick={() => { setMsg(null); setEdit(draftOf(c, c.position)); }}>
                  <span className="block font-semibold">{c.title}</span>
                  <span className="block text-sm text-muted"><bdi dir="ltr">/collections/{c.slug}</bdi> · {c.kind === 'auto' ? `אוטומטית לפי תגיות (${count})` : `${count} מוצרים`}</span>
                </button>
                <Pill tone={c.publishOnline ? 'ok' : 'default'}>{c.publishOnline ? 'באתר' : 'לא באתר'}</Pill>
                <span className="flex gap-1">
                  <Button variant="soft" size="sm" aria-label={`להזיז למעלה: ${c.title}`} disabled={busy || i === 0} onClick={() => void move(i, -1)}>▲</Button>
                  <Button variant="soft" size="sm" aria-label={`להזיז למטה: ${c.title}`} disabled={busy || i === list.length - 1} onClick={() => void move(i, 1)}>▼</Button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

function Editor({ draft, items, taken, onClose, onSaved }: {
  draft: Draft; items: CatalogItem[] | null; taken: string[]; onClose: () => void; onSaved: (text: string) => Promise<void>;
}) {
  const [d, setD] = useState<Draft>(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [tagInput, setTagInput] = useState('');
  const set = (patch: Partial<Draft>) => { setD((x) => ({ ...x, ...patch })); setError(''); };
  const byId = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);
  const tags = useMemo(() => allTags(items ?? []), [items]);
  const autoCount = (items ?? []).filter((i) => matchesTags(i.tags, d.tags)).length;
  const found = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (items ?? []).filter((i) => !d.items.includes(i.id) && (!t || i.name.toLowerCase().includes(t) || i.sku.toLowerCase() === t)).slice(0, 30);
  }, [items, q, d.items]);
  const moveItem = (i: number, by: number) => {
    const j = i + by; if (j < 0 || j >= d.items.length) return;
    const next = d.items.slice(); [next[i], next[j]] = [next[j], next[i]]; set({ items: next });
  };

  const save = async () => {
    const slug = d.slugTouched ? d.slug.trim() : suggestSlug(d.title, taken, 'קולקציה');
    const problem = collectionProblem({ ...d, slug }, taken);
    if (problem) { setError(problem); return; }
    const row: CollectionInput = {
      title: d.title.trim(), slug, description: d.description.trim(), image_url: d.imageUrl, kind: d.kind, rules: d.kind === 'auto' ? { tags: d.tags } : {},
      sort: d.sort, publish_online: d.publishOnline, seo_title: d.seoTitle.trim(), seo_description: d.seoDescription.trim(), position: d.position,
    };
    setBusy(true);
    const r = await saveCollection(d.id, row, d.kind === 'manual' ? d.items : []);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    await onSaved(d.id && draft.slug !== slug && draft.publishOnline ? `נשמר. הכתובת הישנה מפנה לחדשה.` : 'הקולקציה נשמרה.');
  };

  return (
    <>
      <PageHead title={d.id ? d.title || 'קולקציה' : 'קולקציה חדשה'} action={<Button variant="ghost" onClick={onClose}>חזרה לרשימה</Button>} />
      {error && <Notice tone="error">{error}</Notice>}

      <Block title="פרטים">
        <TextRow label="שם" value={d.title} max={STORE_LIMITS.collectionTitle} placeholder="למשל שקיות נייר"
          onChange={(v) => set({ title: v, ...(d.slugTouched ? {} : { slug: suggestSlug(v, taken, 'קולקציה') }) })} />
        <TextRow label="כתובת באתר" value={d.slug} max={LIMITS.slug} dir="ltr" onChange={(v) => set({ slug: v.toLowerCase().replace(/\s+/g, '-'), slugTouched: true })}
          hint={`/collections/${d.slug || '…'}${d.id && draft.publishOnline ? ' · שינוי הכתובת משאיר הפניה מהכתובת הישנה' : ''}`} />
        <AreaRow label="תיאור (מוצג בראש העמוד)" value={d.description} onChange={(v) => set({ description: v })} max={STORE_LIMITS.collectionDescription} />
        <AiShort ask={{ field: 'collection', title: d.title, tags: d.tags, current: d.description }} autoKey={`collection:${d.id ?? 'new'}`}
          onUse={(c) => set({ description: c.text, seoTitle: d.seoTitle.trim() || c.seoTitle, seoDescription: d.seoDescription.trim() || c.seoDescription })} />
        <PicturePicker label="תמונה" value={d.imageUrl} onChange={(u) => set({ imageUrl: u })} />
        <label className="flex min-h-11 items-center justify-between gap-3">
          <span className="text-sm font-semibold">באתר</span>
          <Switch on={d.publishOnline} onClick={() => set({ publishOnline: !d.publishOnline })} label="הקולקציה באתר" />
        </label>
      </Block>

      <Block title="אילו מוצרים">
        <div className="mb-4 flex flex-wrap gap-2" role="radiogroup" aria-label="סוג הקולקציה">
          <Chip role="radio" aria-checked={d.kind === 'manual'} on={d.kind === 'manual'} onClick={() => set({ kind: 'manual' })}>בחירה ידנית</Chip>
          <Chip role="radio" aria-checked={d.kind === 'auto'} on={d.kind === 'auto'} onClick={() => set({ kind: 'auto', sort: d.sort === 'manual' ? 'newest' : d.sort })}>אוטומטית לפי תגית</Chip>
        </div>
        {items === null ? <p className="flex items-center gap-2 text-muted"><Spinner /> טוען מוצרים…</p> : d.kind === 'manual' ? (
          <>
            {d.items.length > 0 ? (
              <ol className="mb-4 stack-y-2">
                {d.items.map((id, i) => {
                  const it = byId.get(id);
                  return (
                    <li key={id} className="flex items-center gap-2 rounded-md border border-line px-3 py-2">
                      <span className="min-w-0 flex-1 truncate">{it?.name ?? 'מוצר שנמחק'}{it && !it.publishOnline && <span className="ms-2 text-xs text-muted">(לא באתר — לא יוצג)</span>}</span>
                      <Button variant="soft" size="sm" aria-label={`להזיז למעלה: ${it?.name ?? ''}`} disabled={i === 0} onClick={() => moveItem(i, -1)}>▲</Button>
                      <Button variant="soft" size="sm" aria-label={`להזיז למטה: ${it?.name ?? ''}`} disabled={i === d.items.length - 1} onClick={() => moveItem(i, 1)}>▼</Button>
                      <Button variant="soft" size="sm" aria-label={`להסיר: ${it?.name ?? ''}`} onClick={() => set({ items: d.items.filter((x) => x !== id) })}>✕</Button>
                    </li>
                  );
                })}
              </ol>
            ) : <p className="mb-3 text-sm text-muted">עוד לא נבחרו מוצרים.</p>}
            <label className="mb-2 block">
              <span className="mb-2 block text-sm font-semibold text-ink-2">הוספת מוצרים</span>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי שם או מק״ט" />
            </label>
            <ul className="max-h-72 stack-y-1 overflow-y-auto">
              {found.map((i) => (
                <li key={i.id}>
                  <button type="button" className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-3 text-start hover:bg-surface-2"
                    onClick={() => set({ items: [...d.items, i.id] })}>
                    <span className="min-w-0 truncate">{i.name}{!i.publishOnline && <span className="ms-2 text-xs text-muted">(לא באתר)</span>}</span>
                    <span aria-hidden className="text-primary">+</span><span className="sr-only">להוסיף</span>
                  </button>
                </li>
              ))}
              {!found.length && <li className="px-3 text-sm text-muted">{items.length ? 'אין עוד מוצרים מתאימים.' : 'עוד אין מוצרים.'}</li>}
            </ul>
          </>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted">כל מוצר באתר שיש לו אחת מהתגיות נכנס לקולקציה לבד. תגיות מוסיפים בעריכת המוצר.</p>
            {tags.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {tags.map((t) => <Chip key={t} aria-pressed={d.tags.includes(t)} on={d.tags.includes(t)} onClick={() => set({ tags: d.tags.includes(t) ? d.tags.filter((x) => x !== t) : [...d.tags, t] })}>{t}</Chip>)}
              </div>
            )}
            <form className="mb-3 flex items-end gap-2" onSubmit={(e) => {
              e.preventDefault();
              const t = tagInput.trim().slice(0, LIMITS.tag);
              if (t && !d.tags.includes(t)) set({ tags: [...d.tags, t] });
              setTagInput('');
            }}>
              <label className="min-w-0 flex-1">
                <span className="mb-2 block text-sm font-semibold text-ink-2">תגית אחרת</span>
                <Input value={tagInput} onChange={(e) => setTagInput(e.target.value)} maxLength={LIMITS.tag} />
              </label>
              <Button type="submit" variant="soft" disabled={!tagInput.trim()}>הוספה</Button>
            </form>
            {d.tags.length > 0 && <p className="text-sm">נבחרו: {d.tags.map((t) => <span key={t} className="me-2 inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5">{t}
              <button type="button" aria-label={`להסיר את התגית ${t}`} className="text-muted" onClick={() => set({ tags: d.tags.filter((x) => x !== t) })}>✕</button></span>)}
              <span className="text-muted"> · {autoCount} מוצרים מתאימים</span></p>}
          </>
        )}
        <label className="mt-4 block max-w-xs">
          <span className="mb-2 block text-sm font-semibold text-ink-2">סדר המוצרים בעמוד</span>
          <Select value={d.sort} onChange={(e) => set({ sort: e.target.value as Draft['sort'] })}>
            {(Object.keys(COLLECTION_SORT) as Draft['sort'][]).filter((k) => k !== 'manual' || d.kind === 'manual').map((k) => <option key={k} value={k}>{COLLECTION_SORT[k]}</option>)}
          </Select>
        </label>
      </Block>

      <Block title="בגוגל" sub="ריק = השם והתיאור של הקולקציה.">
        <TextRow label="כותרת" value={d.seoTitle} onChange={(v) => set({ seoTitle: v })} max={STORE_LIMITS.seoTitle}
          hint={`${d.seoTitle.length} תווים · גוגל מציג בערך ${SEO_SHOWN.title}`} />
        <AreaRow label="תיאור" value={d.seoDescription} onChange={(v) => set({ seoDescription: v })} rows={2} max={STORE_LIMITS.seoDescription}
          hint={`${d.seoDescription.length} תווים · גוגל מציג בערך ${SEO_SHOWN.description}`} />
      </Block>

      <div className={cx('sticky bottom-20 z-10 flex flex-wrap justify-end gap-2 rounded-lg bg-(--glass) py-2 backdrop-blur-sm sm:bottom-4')}>
        {d.id && (
          <Button variant="ghost" className="me-auto text-red-700" disabled={busy} onClick={async () => {
            if (!window.confirm(`למחוק את הקולקציה "${d.title}"? המוצרים עצמם לא נמחקים.${draft.publishOnline ? ' העמוד שלה באתר יפסיק לעבוד.' : ''}`)) return;
            setBusy(true); const r = await deleteCollection(d.id!); setBusy(false);
            if (!r.ok) setError(r.error); else await onSaved('הקולקציה נמחקה.');
          }}>מחיקה</Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={onClose}>ביטול</Button>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? <><Spinner /> שומר…</> : 'שמירה'}</Button>
      </div>
    </>
  );
}
