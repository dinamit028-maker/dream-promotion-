'use client';
import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button, Chip, Input, PageHead } from '@/components/ui/primitives';
import { EmptyState, Spinner } from '@/components/ui/feedback';
import { ImageGlyph, ShoppingBag } from '@/components/ui/Icon';
import { cx } from '@/lib/utils';
import { ils } from '@/features/register/money';
import { KIND_HE, MIGRATION_3300, findByCode, level, variantsOf, type CatalogItem } from './catalog';
import { loadCatalog, type CatalogData } from './data';
import { PublishSwitch, SITE_NOT_LIVE, type EditorFocus } from './PublishSwitch';
import { ProductEditorDialog } from './ProductEditor';

/**
 * The products — one list for the store (/store/products) and finance (/finance/products), the same rows as the
 * register's price list (2.54). Search by name, SKU or barcode; "באתר" next to every product; the one editor opens from
 * here (a page in the store, a window in finance).
 */
type Filter = 'all' | 'online' | 'offline' | 'noimage';
const FILTERS: { id: Filter; label: string }[] = [{ id: 'all', label: 'הכול' }, { id: 'online', label: 'באתר' }, { id: 'offline', label: 'לא באתר' }, { id: 'noimage', label: 'בלי תמונה' }];

export function ProductsScreen(p: { title?: string; sub?: string; editHref?: (id: string) => string }) {
  // the address's query (?new=1, ?edit=<id>) is read inside a suspense boundary
  return <Suspense fallback={<div className="py-10 text-center"><Spinner /></div>}><Products {...p} /></Suspense>;
}

function Products({ title = 'מוצרים', sub, editHref }: { title?: string; sub?: string; editHref?: (id: string) => string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [data, setData] = useState<CatalogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [edit, setEdit] = useState<{ id: string | null; focus?: EditorFocus } | null>(null);

  const load = useCallback(async () => {
    const r = await loadCatalog();
    if (r.ok) { setData(r.data); setError(null); } else setError(r.error);
  }, []);
  useEffect(() => { void load(); }, [load]);
  // "+ מוצר חדש" of the module, or a link to one product
  useEffect(() => {
    const n = params?.get('new'), e = params?.get('edit');
    if (!n && !e) return;
    if (editHref) router.replace(editHref(e ?? 'new'));
    else { setEdit({ id: e ?? null }); router.replace(pathname, { scroll: false }); }
  }, [params, editHref, router, pathname]);

  const put = (it: CatalogItem) => setData((d) => (d ? { ...d, items: d.items.some((x) => x.id === it.id) ? d.items.map((x) => (x.id === it.id ? it : x)) : [...d.items, it] } : d));
  // the store: a product's own page (a new one: /store/products/new); finance: a window over the screen
  const open = (id: string | null, focus?: EditorFocus) => (editHref ? router.push(`${editHref(id ?? 'new')}${focus ? `?focus=${focus}` : ''}`) : setEdit({ id, focus }));

  const rows = useMemo(() => {
    if (!data) return [];
    const t = q.trim().toLowerCase();
    const code = t ? findByCode(q, data.items.map((i) => ({ ...i, active: true })), data.variants.map((v) => ({ ...v, active: true }))) : null;
    return data.items
      .filter((i) => filter === 'all' || (filter === 'online' ? i.publishOnline : filter === 'offline' ? !i.publishOnline : !i.imageUrl))
      .filter((i) => !t || i.name.toLowerCase().includes(t) || code?.item.id === i.id || i.tags.some((g) => g.toLowerCase().includes(t)));
  }, [data, q, filter]);

  return (
    <div>
      <PageHead title={title} sub={sub ?? 'מוצרים ושירותים — אותה רשימה של הקופה והכספים.'}
        action={<Button variant="primary" onClick={() => open(null)}>+ מוצר חדש</Button>} />
      {data && !data.ready && <p role="status" className="mb-4 rounded-2xl bg-amber-500/15 p-3 text-sm font-semibold text-amber-800 dark:text-amber-200">{MIGRATION_3300}</p>}
      {data?.ready && <p className="mb-4 rounded-2xl bg-surface-2 p-3 text-xs text-ink-2">{SITE_NOT_LIVE}</p>}
      {error && <p role="alert" className="mb-4 rounded-2xl bg-red-500/10 p-3 text-sm font-semibold text-red-700 dark:text-red-300">{error}</p>}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי שם, מק״ט או ברקוד" aria-label="חיפוש מוצר" className="max-w-sm" />
        <div className="flex flex-wrap gap-1.5">{FILTERS.map((f) => <Chip key={f.id} on={filter === f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</Chip>)}</div>
      </div>

      {!data ? (error ? <Button onClick={() => void load()}>ניסיון נוסף</Button> : <div className="py-10 text-center"><Spinner /></div>)
        : !data.items.length ? <EmptyState icon={<ShoppingBag />} title="עוד אין מוצרים" body="מוצר שנוצר כאן מופיע מיד גם בקופה ובכספים." action={<Button variant="primary" onClick={() => open(null)}>+ מוצר חדש</Button>} />
        : !rows.length ? <p className="py-6 text-center text-muted">אין מוצרים שמתאימים לחיפוש.</p>
        : (
          <ul className="grid gap-2">
            {rows.map((i) => {
              const vs = variantsOf(data.variants, i.id);
              const stock = !i.trackStock ? '' : i.stockQty <= 0 ? 'אזל מהמלאי' : `במלאי ${i.stockQty}`;
              const lvl = i.trackStock ? level(i.stockQty, i.lowStock) : null;
              const editLabel = `עריכה: ${i.name}`;
              return (
                <li key={i.id} className="flex min-w-0 flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-3">
                  {i.imageUrl
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={i.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-xl bg-surface-2 object-cover" loading="lazy" />
                    : <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted"><ImageGlyph size={22} aria-hidden /></span>}
                  <span className="min-w-0 flex-1">
                    {editHref
                      ? <Link href={editHref(i.id)} className={cx('block truncate font-bold hover:text-primary', !i.active && 'text-muted line-through')}>{i.name}</Link>
                      : <button type="button" onClick={() => open(i.id)} className={cx('block max-w-full truncate text-start font-bold hover:text-primary', !i.active && 'text-muted line-through')}>{i.name}</button>}
                    <span className="block text-xs text-muted">
                      {KIND_HE[i.kind]} · {ils(i.price)}{i.onlinePrice != null && i.onlinePrice !== i.price ? ` · באתר ${ils(i.onlinePrice)}` : ''}
                      {vs.length ? ` · ${vs.length} וריאנטים` : ''}{stock ? ' · ' : ''}
                      {stock && <span className={cx(lvl === 'out' ? 'text-red-600 dark:text-red-300' : lvl === 'low' ? 'text-amber-700 dark:text-amber-300' : '')}>{stock}</span>}
                      {!i.active ? ' · מוסתר בקופה' : ''}
                    </span>
                  </span>
                  <PublishSwitch item={i} ready={data.ready} onChanged={put} onComplete={(focus) => open(i.id, focus)} onError={setError} />
                  {editHref
                    ? <Link href={editHref(i.id)} aria-label={editLabel} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2">עריכה</Link>
                    : <Button size="sm" variant="ghost" aria-label={editLabel} onClick={() => open(i.id)}>עריכה</Button>}
                </li>
              );
            })}
          </ul>
        )}

      <ProductEditorDialog open={Boolean(edit)} itemId={edit?.id ?? null} focus={edit?.focus} nextSort={data?.items.length ?? 9999}
        onClose={() => setEdit(null)} onSaved={put} onDeleted={() => { setEdit(null); void load(); }} />
    </div>
  );
}
