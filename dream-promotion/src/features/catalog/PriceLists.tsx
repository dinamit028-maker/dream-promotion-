'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { Button, Card, Chip, Field, Input, PageHead, Select } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { Note } from '@/features/finance/ui';
import { ils } from '@/features/register/money';
import { useLocations } from '@/features/locations/store';
import { activeLocations, locationName, multiLocation } from '@/features/locations/locations';
import { PRICE_LIST_LIMITS, listPriceInput, posPrice, priceListDraftError, variantLabel, variantsOf, type CatalogItem, type CatalogVariant, type PriceList } from './catalog';
import { loadCatalog } from './data';
import { loadPriceBook, savePriceList, setListPrices, type PriceBook } from './items-data';
import { MIGRATION_4800 } from './serials';

/**
 * "מחירונים" (2.93 — T12ג): the base list is the catalog's own price (what the register shows). A list of a location prices its
 * sales and documents; a list of a customer group — the customers with a tag of the CRM ("סיטונאי", "חברי מועדון") — prices
 * theirs. A list names only the products it changes; the rest stay at the base. THE rule of which price applies is catalog.ts
 * (priceFor): the customer's group, else the location's, else the base. The database writes (price_list_save / price_list_set).
 */
type Draft = { id: string; name: string; kind: 'location' | 'group'; locationId: string | null; tag: string; active: boolean; sort: number; isNew: boolean };
type Row = { key: string; itemId: string; variantId: string | null; name: string; base: number };

export function PriceLists() {
  const leads = useApp((s) => s.leads);
  const { state: loc, loaded, load } = useLocations();
  const [book, setBook] = useState<PriceBook | null | undefined>(undefined);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [variants, setVariants] = useState<CatalogVariant[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);

  const reload = useCallback(async () => {
    const [b, c] = await Promise.all([loadPriceBook(), loadCatalog()]);
    setBook(b);
    if (c.ok) { setItems(c.data.items); setVariants(c.data.variants); } else setError(c.error);
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    // a link that names a product (?q=…) searches it
    const want = new URLSearchParams(window.location.search).get('q');
    if (want) setQ(want);
  }, []);

  const multi = multiLocation(loc);
  const lists = book?.lists ?? [];
  const list = lists.find((l) => l.id === pick) ?? null;
  const tags = useMemo(() => [...new Set(leads.flatMap((l) => l.tags ?? []).map((t) => t.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he')), [leads]);
  const rows: Row[] = useMemo(() => items.filter((i) => i.active && i.kind !== 'package').flatMap((i) => {
    const vs = variantsOf(variants, i.id).filter((v) => v.active);
    const own: Row = { key: `${i.id}|`, itemId: i.id, variantId: null, name: i.name, base: i.price };
    return i.hasVariants && vs.length
      ? [own, ...vs.map((v) => ({ key: `${i.id}|${v.id}`, itemId: i.id, variantId: v.id, name: `${i.name} · ${variantLabel(v)}`, base: posPrice(i, v) }))]
      : [own];
  }), [items, variants]);
  const shown = rows.filter((r) => !q.trim() || r.name.includes(q.trim()) || r.name.toLowerCase().includes(q.trim().toLowerCase()));
  const priceIn = (l: PriceList, r: Row) => book?.prices.find((p) => p.listId === l.id && p.itemId === r.itemId && p.variantId === r.variantId)?.price ?? null;
  const say = (m: string) => { setNote(m); setError(null); setTimeout(() => setNote((x) => (x === m ? null : x)), 4000); };

  async function saveList() {
    if (!draft) return;
    const e = priceListDraftError({ name: draft.name, kind: draft.kind, locationId: draft.locationId, tag: draft.tag });
    if (e) return setError(e);
    setBusy(true);
    const r = await savePriceList(draft);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setPick(draft.id); setDraft(null);
    await reload();
    say(draft.isNew ? 'המחירון נוצר ✓ — עכשיו המחירים שלו' : 'המחירון נשמר ✓');
  }
  async function savePrices() {
    if (!list) return;
    const lines: { itemId: string; variantId: string | null; price: number | null }[] = [];
    for (const r of rows) {
      const raw = edits[r.key];
      if (raw === undefined) continue;
      const p = listPriceInput(raw);
      if (!p.ok) return setError(`${r.name}: ${p.error}`);
      if (p.price !== priceIn(list, r)) lines.push({ itemId: r.itemId, variantId: r.variantId, price: p.price });
    }
    if (!lines.length) return say('אין שינויים לשמור');
    setBusy(true);
    try {
      for (let k = 0; k < lines.length; k += PRICE_LIST_LIMITS.lines) {
        const r = await setListPrices(list.id, lines.slice(k, k + PRICE_LIST_LIMITS.lines));
        if (!r.ok) return setError(r.error);
      }
      setEdits({});
      await reload();
      say(`נשמרו ${lines.length} מחירים ✓`);
    } finally { setBusy(false); }
  }

  if (!loaded || book === undefined) return <div className="py-10 text-center"><Spinner /></div>;
  if (book === null) return <><PageHead title="מחירונים" /><Note tone="warn">{MIGRATION_4800}</Note></>;
  const newDraft = (): Draft => ({ id: crypto.randomUUID(), name: '', kind: multi ? 'location' : 'group', locationId: null, tag: '', active: true, sort: lists.length + 1, isNew: true });
  const kindLine = (l: PriceList) => (l.kind === 'location' ? `סניף: ${locationName(loc, l.locationId) || '—'}` : `לקוחות עם התגית "${l.tag}"`);
  const dirty = Object.keys(edits).length > 0;
  return (
    <>
      <PageHead title="מחירונים" sub="מחירון הבסיס הוא המחיר בקופה. מחירון של סניף או של קבוצת לקוחות משנה רק את המוצרים שנכתבו בו — בקופה ובמסמכים: קודם המחירון של הלקוח, אחר כך של הסניף, ואחרת הבסיס." />
      {error && <div className="mb-3"><Note tone="warn">{error}</Note></div>}
      {note && <p role="status" className="mb-3 rounded-2xl bg-emerald-500/15 p-3 text-sm font-semibold text-emerald-700 dark:text-emerald-300">{note}</p>}
      <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="מחירונים">
        <Chip role="tab" aria-selected={!pick} on={!pick} onClick={() => { setPick(null); setEdits({}); setDraft(null); }}>בסיס</Chip>
        {lists.map((l) => (
          <Chip key={l.id} role="tab" aria-selected={pick === l.id} on={pick === l.id} onClick={() => { if (dirty && !window.confirm('יש מחירים שלא נשמרו. לעבור בלי לשמור?')) return; setPick(l.id); setEdits({}); setDraft(null); }}>
            {l.name}{l.active ? '' : ' (לא פעיל)'}
          </Chip>
        ))}
        <Chip onClick={() => setDraft(newDraft())}>+ מחירון חדש</Chip>
      </div>

      {draft && (
        <Card className="mb-4 p-4">
          <p className="mb-3 font-bold">{draft.isNew ? 'מחירון חדש' : `עריכת ${draft.name}`}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="שם"><Input value={draft.name} maxLength={PRICE_LIST_LIMITS.name} autoFocus onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="למשל: סיטונאי" /></Field>
            <Field label="למי">
              <Select value={draft.kind} disabled={!draft.isNew} onChange={(e) => setDraft({ ...draft, kind: e.target.value === 'location' ? 'location' : 'group' })}>
                <option value="group">קבוצת לקוחות (לפי תגית בכרטיס הלקוח)</option>
                {(multi || draft.kind === 'location') && <option value="location">סניף</option>}
              </Select>
            </Field>
            {draft.kind === 'location' ? (
              <Field label="הסניף">
                <Select value={draft.locationId ?? ''} disabled={!draft.isNew} onChange={(e) => setDraft({ ...draft, locationId: e.target.value || null })}>
                  <option value="">בחירה…</option>
                  {activeLocations(loc).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
              </Field>
            ) : (
              <Field label="התגית של הלקוחות">
                <Input value={draft.tag} maxLength={PRICE_LIST_LIMITS.tag} list="pl-tags" onChange={(e) => setDraft({ ...draft, tag: e.target.value })} placeholder="למשל: סיטונאי" />
              </Field>
            )}
            <label className="mb-4 flex min-h-11 items-center gap-2 self-end text-sm font-semibold">
              <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} className="h-5 w-5" />פעיל
            </label>
          </div>
          <datalist id="pl-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
          {draft.kind === 'group' && <p className="mb-3 text-xs text-muted">תגית מוסיפים בכרטיס הלקוח (לקוחות). לקוח/ה עם התגית — המחירים של המחירון הזה, בקופה ובמסמכים.</p>}
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void saveList()}>{busy ? <Spinner /> : null}שמירה</Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>ביטול</Button>
          </div>
        </Card>
      )}

      {!pick ? (
        <Card className="p-4">
          <p className="mb-2 font-bold">מחירון בסיס — המחיר בקופה</p>
          <p className="mb-3 text-sm text-muted">משנים אותו בעורך המוצר (מחירון ומלאי בקופה). {lists.length ? `${lists.length} מחירונים נוספים: ${lists.map((l) => l.name).join(' · ')}.` : 'עוד אין מחירונים נוספים — "+ מחירון חדש".'}</p>
          <ul className="grid gap-1 text-sm">{rows.slice(0, 50).map((r) => <li key={r.key} className="flex justify-between gap-2"><span className="min-w-0 truncate">{r.name}</span><span className="tabular-nums">{ils(r.base)}</span></li>)}</ul>
          {rows.length > 50 && <p className="mt-2 text-xs text-muted">ועוד {rows.length - 50} — בעורך המוצר.</p>}
        </Card>
      ) : list && (
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span><strong className="block">{list.name}{list.active ? '' : ' (לא פעיל)'}</strong><span className="text-xs text-muted">{kindLine(list)}</span></span>
            <Button size="sm" variant="ghost" onClick={() => setDraft({ id: list.id, name: list.name, kind: list.kind, locationId: list.locationId, tag: list.tag ?? '', active: list.active, sort: list.sort, isNew: false })}>עריכת המחירון</Button>
          </div>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש מוצר" className="mb-3 py-2" aria-label="חיפוש מוצר" />
          <p className="mb-2 text-xs text-muted">ריק = מחיר הבסיס. מחיר למוצר חל גם על הווריאנטים שלו, אלא אם לווריאנט יש מחיר משלו כאן.</p>
          <ul className="grid gap-1.5" aria-label={`המחירים של ${list.name}`}>
            {shown.slice(0, 300).map((r) => {
              const cur = priceIn(list, r);
              const val = edits[r.key] ?? (cur == null ? '' : String(cur));
              return (
                <li key={r.key} className={cx('grid grid-cols-[minmax(0,1fr)_6rem_7rem] items-center gap-2 text-sm', r.variantId && 'ps-4')} data-row={r.name}>
                  <span className="min-w-0 truncate">{r.name}</span>
                  <span className="text-xs tabular-nums text-muted">בסיס {ils(r.base)}</span>
                  <Input inputMode="decimal" value={val} onChange={(e) => setEdits({ ...edits, [r.key]: e.target.value })} placeholder={String(r.base)}
                    className={cx('h-10 px-2 py-0 text-center', edits[r.key] !== undefined && 'border-primary')} aria-label={`מחיר ב${list.name}: ${r.name}`} />
                </li>
              );
            })}
          </ul>
          {shown.length > 300 && <p className="mt-2 text-xs text-muted">מוצגים 300 — מחפשים כדי לצמצם.</p>}
          <div className="sticky bottom-0 mt-3 flex flex-wrap items-center gap-2 border-t border-line bg-surface/95 py-3 backdrop-blur-sm">
            <Button variant="primary" disabled={busy || !dirty} onClick={() => void savePrices()}>{busy ? <><Spinner />שומר…</> : 'שמירת המחירים'}</Button>
            {dirty && <Button variant="ghost" onClick={() => setEdits({})}>ביטול השינויים</Button>}
          </div>
        </Card>
      )}
    </>
  );
}
