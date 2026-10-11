'use client';
import { useEffect, useState } from 'react';
import { Button, Card, Input } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { Note } from '@/features/finance/ui';
import { cx } from '@/lib/utils';
import { formatIL } from '@/lib/il-time';
import { locationName, multiLocation, type LocationState } from '@/features/locations/locations';
import { SERIAL_STATUS_HE, historyLine, type Serial, type SerialEvent } from '@/features/catalog/serials';
import { findSerials, loadSerialHistory, loadSerialSummary } from '@/features/catalog/items-data';
import type { StockCatalog } from './stock-data';
import { CameraScan } from './CameraScan';

/**
 * "מספרים סידוריים" (2.93 — T12ג): a unit found by its number (typed, scanned by a reader or the camera) — its product, where it
 * is, and its history (received, sold, returned, moved, written off); and how many units with numbers each location holds.
 * Reading only: units come in, are sold and move through the product editor, the register and the transfers.
 */
export function Serials({ catalog, loc }: { catalog: StockCatalog; loc: LocationState }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Serial[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ id: string; events: SerialEvent[] | null } | null>(null);
  const [summary, setSummary] = useState<{ itemId: string; variantId: string | null; locationId: string; count: number }[] | null>(null);
  useEffect(() => { void loadSerialSummary().then(setSummary); }, []);
  const multi = multiLocation(loc);
  const nameOf = (s: Pick<Serial, 'itemId' | 'variantId'>) => {
    const it = catalog.items.find((i) => i.id === s.itemId);
    const v = s.variantId ? catalog.variants.find((x) => x.id === s.variantId) : null;
    return it ? (v ? `${it.name} · ${v.label}` : it.name) : '';
  };

  async function search(text = q) {
    if (!text.trim()) return;
    setBusy(true); setOpen(null);
    const r = await findSerials(text);
    setBusy(false);
    if (r === null) return setError('מספרים סידוריים עוד לא הופעלו במסד הנתונים (מיגרציה 20261011004800).');
    if (!r.ok) return setError(r.error);
    setError(null); setHits(r.data);
    if (r.data.length === 1) void history(r.data[0]);
  }
  async function history(s: Serial) {
    if (open?.id === s.id) return setOpen(null);
    setOpen({ id: s.id, events: null });
    const r = await loadSerialHistory(s.id);
    if (!r.ok) { setOpen(null); return setError(r.error); }
    setOpen({ id: s.id, events: r.data });
  }

  const byItem = new Map<string, { name: string; total: number; at: Map<string, number> }>();
  for (const row of summary ?? []) {
    const name = nameOf({ itemId: row.itemId, variantId: null });
    const cur = byItem.get(row.itemId) ?? { name, total: 0, at: new Map<string, number>() };
    cur.total += row.count; cur.at.set(row.locationId, (cur.at.get(row.locationId) ?? 0) + row.count);
    byItem.set(row.itemId, cur);
  }
  return (
    <div className="grid gap-4">
      <Card className="p-4">
        <p className="mb-2 font-bold">חיפוש לפי מספר סידורי</p>
        <div className="flex flex-wrap gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} dir="ltr" placeholder="מקלידים או סורקים מספר" aria-label="מספר סידורי לחיפוש" className="min-w-0 flex-1 py-2"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} />
          <Button variant="primary" disabled={busy || !q.trim()} onClick={() => void search()}>{busy ? <Spinner /> : 'חיפוש'}</Button>
          <CameraScan onCode={(c) => { setQ(c); void search(c); }} />
        </div>
        {error && <div className="mt-3"><Note tone="warn">{error}</Note></div>}
        {hits && !hits.length && <p className="mt-3 text-sm text-muted">לא נמצא מספר כזה בעסק.</p>}
        {hits && hits.length > 0 && (
          <ul className="mt-3 grid gap-2" aria-label="תוצאות החיפוש">
            {hits.map((s) => (
              <li key={s.id} className="rounded-xl bg-surface-2 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <strong dir="ltr" className="font-mono">{s.serial}</strong>
                  <span>{nameOf(s)}</span>
                  <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-bold', s.status === 'in_stock' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-line text-ink-2')}>
                    {SERIAL_STATUS_HE[s.status]}</span>
                  {multi && <span className="text-xs text-muted">{locationName(loc, s.locationId)}</span>}
                  <span className="flex-1" />
                  <button type="button" className="text-xs font-semibold text-primary" aria-expanded={open?.id === s.id} onClick={() => void history(s)}>היסטוריה</button>
                </div>
                {open?.id === s.id && (open.events === null ? <div className="py-2"><Spinner /></div> : (
                  <ol className="mt-2 grid gap-1 border-s-2 border-line ps-3 text-xs" aria-label={`ההיסטוריה של ${s.serial}`}>
                    {[...open.events].reverse().map((e) => <li key={e.id}><span className="text-muted">{formatIL(e.at)}</span> · {historyLine(e, multi ? locationName(loc, e.locationId) : '')}</li>)}
                  </ol>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="p-4">
        <p className="mb-2 font-bold">יחידות עם מספר במלאי</p>
        {summary === null ? <div className="py-4 text-center"><Spinner /></div> : !byItem.size ? <p className="text-sm text-muted">אין עדיין יחידות עם מספר במלאי.</p> : (
          <ul className="grid gap-1 text-sm">
            {[...byItem.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, 'he')).map(([id, x]) => (
              <li key={id} className="flex flex-wrap justify-between gap-2">
                <span>{x.name || 'מוצר'}</span>
                <span className="tabular-nums text-ink-2">{x.total}{multi ? ` · ${[...x.at.entries()].map(([l, n]) => `${locationName(loc, l)} ${n}`).join(' · ')}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted">קליטה עם מספרים — בעורך המוצר. מכירה — בקופה, לפי המספר. העברה בין סניפים — לפי המספרים.</p>
      </Card>
    </div>
  );
}
