'use client';
import { useEffect, useState } from 'react';
import { Button, Input, SmallSelect } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { SKU_LIMITS, nextSkuPreview, skuPrefix, skuSeriesError, type SkuSeries } from './catalog';
import { loadSkuSeries, nextSku, saveSkuSeries } from './items-data';

let ready: Promise<boolean> | null = null;
/** migration 4800 is in the database (asked once a page: the SKU series' table answers) */
export function itemsReady(): Promise<boolean> {
  ready ??= loadSkuSeries().then((s) => s !== null, () => false);
  return ready;
}
export function useItemsReady(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => { let alive = true; void itemsReady().then((v) => { if (alive) setOk(v); }); return () => { alive = false; }; }, []);
  return ok;
}

/**
 * "מק״ט אוטומטי" (2.93 — T12ג "מקט מונה"): the next free code of a series ("תכשיטים" → JW-0001…), from the database (sku_next —
 * never a code a product or a variant has). It fills the SKU field; "שמירה" saves the product as always. A series is a category
 * with its own prefix — made here too.
 */
export function SkuAuto({ onCode, emptyVariants = 0, onVariantCodes, fail }: {
  onCode: (code: string) => void;
  /** variants of the product with no SKU yet — "גם לווריאנטים" fills them */
  emptyVariants?: number;
  onVariantCodes?: (codes: string[]) => void;
  fail: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [series, setSeries] = useState<SkuSeries[] | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ name: string; prefix: string; digits: number } | null>(null);
  async function load(select?: string) {
    const s = await loadSkuSeries();
    const list = (s ?? []).filter((x) => x.active);
    setSeries(list);
    setPick(select ?? (list.some((x) => x.id === pick) ? pick : list[0]?.id ?? ''));
    if (!list.length) setFresh({ name: '', prefix: '', digits: 4 });
  }
  useEffect(() => { if (open && series === null) void load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  async function take(withVariants: boolean) {
    if (!pick) return;
    setBusy(true);
    try {
      const r = await nextSku(pick);
      if (!r.ok) return fail(r.error);
      onCode(r.data);
      if (withVariants && onVariantCodes && emptyVariants > 0) {
        const codes: string[] = [];
        for (let k = 0; k < emptyVariants; k++) {
          const v = await nextSku(pick);
          if (!v.ok) { fail(v.error); break; }
          codes.push(v.data);
        }
        onVariantCodes(codes);
      }
      await load(pick);
      setOpen(false);
    } finally { setBusy(false); }
  }
  async function create() {
    if (!fresh) return;
    const e = skuSeriesError({ name: fresh.name, prefix: fresh.prefix, digits: fresh.digits, next: 1 });
    if (e) return fail(e);
    setBusy(true);
    const id = crypto.randomUUID();
    const r = await saveSkuSeries({ id, name: fresh.name, prefix: skuPrefix(fresh.prefix), digits: fresh.digits, next: 1, active: true });
    setBusy(false);
    if (!r.ok) return fail(r.error);
    setFresh(null);
    await load(id);
  }

  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>מק״ט אוטומטי</Button>;
  const chosen = series?.find((x) => x.id === pick);
  return (
    <div className="grid gap-2 rounded-xl bg-surface-2 p-3 text-sm" role="group" aria-label="מק״ט אוטומטי">
      {series === null ? <Spinner /> : <>
        {series.length > 0 && !fresh && (
          <div className="flex flex-wrap items-center gap-2">
            <SmallSelect value={pick} onChange={(e) => (e.target.value === '+' ? setFresh({ name: '', prefix: '', digits: 4 }) : setPick(e.target.value))} className="w-auto" aria-label="סדרת מק״ט">
              {series.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.prefix})</option>)}
              <option value="+">+ סדרה חדשה…</option>
            </SmallSelect>
            <Button size="sm" variant="primary" disabled={busy || !pick} onClick={() => void take(false)}>{busy ? <Spinner /> : null}קבלת מק״ט</Button>
            {emptyVariants > 0 && onVariantCodes && <Button size="sm" variant="ghost" disabled={busy || !pick} onClick={() => void take(true)}>גם ל-{emptyVariants} וריאנטים בלי מק״ט</Button>}
            {chosen && <span className="text-xs text-muted" dir="ltr">{nextSkuPreview(chosen)}…</span>}
          </div>
        )}
        {fresh && (
          <div className="grid gap-2 sm:grid-cols-[1fr_7rem_6rem_auto_auto] sm:items-center">
            <Input value={fresh.name} maxLength={SKU_LIMITS.name} autoFocus onChange={(e) => setFresh({ ...fresh, name: e.target.value })} placeholder="קטגוריה — למשל תכשיטים" className="py-2" aria-label="שם הסדרה" />
            <Input value={fresh.prefix} maxLength={SKU_LIMITS.prefix} dir="ltr" onChange={(e) => setFresh({ ...fresh, prefix: skuPrefix(e.target.value) })} placeholder="JW" className="py-2" aria-label="קידומת" />
            <SmallSelect value={fresh.digits} onChange={(e) => setFresh({ ...fresh, digits: Number(e.target.value) })} aria-label="מספר ספרות">
              {[3, 4, 5, 6].map((d) => <option key={d} value={d}>{d} ספרות</option>)}
            </SmallSelect>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void create()}>שמירת הסדרה</Button>
            {series.length > 0 && <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>ביטול</Button>}
          </div>
        )}
        {fresh && fresh.prefix && <p className="text-xs text-muted" dir="ltr">{nextSkuPreview({ prefix: fresh.prefix, nextNo: 1, digits: fresh.digits })}, {nextSkuPreview({ prefix: fresh.prefix, nextNo: 2, digits: fresh.digits })}…</p>}
        <button type="button" className="justify-self-start text-xs text-muted" onClick={() => setOpen(false)}>סגירה</button>
      </>}
    </div>
  );
}
