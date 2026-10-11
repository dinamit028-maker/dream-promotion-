'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { Button, Card } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { financeError } from './api';
import { compareCsv, compareTotals, leader, shareOf, toComparison, type Comparison } from './compare';
import { download, ils } from './ui';
import { MIGRATION_4800 } from '@/features/catalog/serials';

/**
 * "השוואת סניפים" (2.93 — T12ד): every location the member may use, side by side, in the period of the reports — revenue and
 * estimated profit by finance_summary's rules, sales and refunds, the best sellers, the stock now. From location_compare() in the
 * database; shown only with more than one location (Reports decides). The location picked at the top does not hide the others.
 */
export function LocationCompare({ period }: { period: { from: string; to: string; label: string } }) {
  const [c, setC] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setC(null); setError(null);
    void supabase().rpc('location_compare', { p_from: period.from, p_to: period.to }).then(({ data, error: e }) => {
      if (!alive) return;
      if (e) { setError(/location_compare|PGRST202|42883|schema cache/.test(`${e.message} ${e.code}`) ? MIGRATION_4800 : financeError(e)); return; }
      const x = toComparison(data);
      if (x) setC(x); else setError('ההשוואה לא נטענה — נסו שוב.');
    }, () => alive && setError('ההשוואה לא נטענה — נסו שוב.'));
    return () => { alive = false; };
  }, [period.from, period.to]);

  if (error) return <Card className="p-4"><p className="mb-1 font-bold">השוואת סניפים</p><p className="text-sm text-warn">{error}</p></Card>;
  if (!c) return <Card className="p-4"><p className="mb-1 font-bold">השוואת סניפים</p><div className="py-4 text-center"><Spinner /></div></Card>;
  const t = compareTotals(c.locations);
  const top = leader(c.locations, (r) => r.profit);
  const cell = 'px-2 py-1.5 text-end tabular-nums';
  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-bold">השוואת סניפים · {period.label}</p>
        <Button size="sm" variant="ghost" onClick={() => download(`השוואת-סניפים-${c.from}-${c.to}.csv`, compareCsv(c))}>ייצוא CSV</Button>
      </div>
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[640px] text-sm" aria-label="השוואת סניפים">
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              <th className="px-2 py-1.5 text-start font-semibold">סניף</th>
              <th className={cell}>הכנסות</th><th className={cell}>רווח משוער</th><th className={cell}>מכירות</th><th className={cell}>החזרים</th>
              <th className={cell}>במלאי</th><th className={cell}>שווי המלאי</th>
            </tr>
          </thead>
          <tbody>
            {c.locations.map((r) => (
              <tr key={r.id} className="border-b border-line/60" data-location={r.name}>
                <td className="px-2 py-1.5 font-semibold">{r.name}{r.active ? '' : ' (סגור)'}{top === r.id && <span className="ms-1 text-xs text-emerald-600">▲</span>}</td>
                <td className={cell}>{ils(r.revenue.net)} <span className="text-xs text-muted">{shareOf(r.revenue.net, t.revenue)}</span></td>
                <td className={cx(cell, r.profit < 0 && 'text-red-600')}>{ils(r.profit)}</td>
                <td className={cell}>{r.sales.count} · {ils(r.sales.total)}{r.sales.online ? <span className="block text-xs text-muted">מהן באתר {r.sales.online}</span> : null}</td>
                <td className={cell}>{r.sales.refunds ? `−${ils(r.sales.refunds)}` : '—'}</td>
                <td className={cell}>{r.stock.units}</td>
                <td className={cell}>{ils(r.stock.value)}</td>
              </tr>
            ))}
            <tr className="font-black">
              <td className="px-2 py-1.5">סה״כ</td><td className={cell}>{ils(t.revenue)}</td><td className={cell}>{ils(t.profit)}</td>
              <td className={cell}>{t.sales} · {ils(t.salesTotal)}</td><td className={cell}>{t.refunds ? `−${ils(t.refunds)}` : '—'}</td>
              <td className={cell}>{t.units}</td><td className={cell}>{ils(t.value)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {c.locations.map((r) => (
          <div key={r.id} className="rounded-xl bg-surface-2 p-3 text-sm">
            <p className="mb-1 font-semibold">הנמכרים ביותר · {r.name}</p>
            {!r.items.length ? <p className="text-xs text-muted">אין מכירות בתקופה.</p> : (
              <ol className="grid gap-0.5 text-xs">{r.items.slice(0, 5).map((i, k) => <li key={k} className="flex justify-between gap-2"><span className="min-w-0 truncate">{i.name}</span><span className="tabular-nums">×{i.qty} · {ils(i.total)}</span></li>)}</ol>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">הכנסות ורווח — לפי המסמכים וההוצאות של כל סניף (כמו בדוחות כשבוחרים סניף למעלה). מכירות — בקופות ובאתר, כולל מע״מ. המלאי — עכשיו, ושוויו במחיר המכירה. הערכה לעבודה, לא דוח רשמי.</p>
    </Card>
  );
}
