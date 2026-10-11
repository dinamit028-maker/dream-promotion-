'use client';
import { useMemo, useState } from 'react';
import { Button, Card, Input } from '@/components/ui/primitives';
import { cx } from '@/lib/utils';
import { activeLocations, locationName, type LocationState } from '@/features/locations/locations';
import { levelOf, lowStock, qtyAt, type StockRow } from './stock-locations';
import type { StockCatalog } from './stock-data';
import type { TransferDraft } from './StockScreen';

const tone = (lvl: 'ok' | 'low' | 'out') => (lvl === 'out' ? 'text-red-600 dark:text-red-300' : lvl === 'low' ? 'text-amber-700 dark:text-amber-300' : '');

/** "לפי סניף": every product's count at every location, what is running low where — and where to bring it from */
export function ByLocation({ rows, catalog, loc, onTransfer }: { rows: StockRow[]; catalog: StockCatalog; loc: LocationState; onTransfer: (d: TransferDraft) => void }) {
  const [q, setQ] = useState('');
  const places = activeLocations(loc);
  const low = useMemo(() => lowStock(rows, catalog.items, catalog.variants, places), [rows, catalog, places]);
  const tracked = catalog.items.filter((i) => i.trackStock && i.active);
  const shown = tracked.filter((i) => !q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase()));
  const lowOf = (itemId: string, variantId: string | null) => {
    const it = catalog.items.find((i) => i.id === itemId)!;
    return variantId ? catalog.variants.find((v) => v.id === variantId)?.lowStock ?? it.lowStock : it.lowStock;
  };
  const cells = (itemId: string, variantId: string | null) => {
    const lvl = lowOf(itemId, variantId);
    return places.map((p) => {
      const n = qtyAt(rows, p.id, itemId, variantId);
      return <td key={p.id} className={cx('px-2 py-1.5 text-center tabular-nums', tone(levelOf(n, lvl)))}>{n}</td>;
    });
  };
  const total = (itemId: string, variantId: string | null) => places.reduce((a, p) => a + qtyAt(rows, p.id, itemId, variantId), 0);

  return (
    <div className="grid gap-4">
      {low.length > 0 && (
        <Card className="p-4">
          <p className="mb-2 font-bold">⚠️ מלאי נמוך</p>
          <ul className="grid gap-1.5 text-sm">
            {low.slice(0, 40).map((l) => (
              <li key={`${l.locationId}|${l.itemId}|${l.variantId ?? ''}`} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-surface-2 px-3 py-2">
                <span className="min-w-0"><strong>{l.name}</strong> · {locationName(loc, l.locationId)}:{' '}
                  <span className={tone(l.level)}>{l.qty <= 0 ? 'אזל' : `נשארו ${l.qty}`}</span>
                  <span className="text-xs text-muted"> (רמת התראה: {l.low})</span></span>
                {l.suggest && (
                  <Button size="sm" variant="ghost" onClick={() => onTransfer({ from: l.suggest!.from, to: l.locationId, lines: [{ itemId: l.itemId, variantId: l.variantId, qty: l.suggest!.qty }] })}>
                    להעביר {l.suggest.qty} מ{locationName(loc, l.suggest.from)}</Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש מוצר" aria-label="חיפוש מוצר" />
      {!tracked.length ? <p className="py-6 text-center text-sm text-muted">עוד אין מוצרים שהמלאי שלהם נספר. סופרים מוצר בקופה (מחירון) או בספירה.</p> : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th className="px-3 py-2 text-start font-semibold">מוצר</th>
                {places.map((p) => <th key={p.id} className="px-2 py-2 text-center font-semibold">{p.name}</th>)}
                <th className="px-2 py-2 text-center font-semibold">סה״כ</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((it) => {
                const vs = it.hasVariants ? catalog.variants.filter((v) => v.itemId === it.id && v.active) : [];
                return [
                  <tr key={it.id} className="border-b border-line/60">
                    <td className="px-3 py-1.5 font-semibold">{it.name}</td>{cells(it.id, null)}
                    <td className="px-2 py-1.5 text-center font-bold tabular-nums">{total(it.id, null)}</td>
                  </tr>,
                  ...vs.map((v) => (
                    <tr key={v.id} className="border-b border-line/40 text-ink-2">
                      <td className="px-3 py-1 ps-6 text-xs">{v.label}</td>{cells(it.id, v.id)}
                      <td className="px-2 py-1 text-center tabular-nums">{total(it.id, v.id)}</td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
