'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useApp } from '@/lib/store';
import { Button, Card, Chip, Input } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { israelParts } from '@/lib/il-time';
import { ils, type ItemKind, type Line, type Refund, type Sale } from './money';
import { cleanPct, commissionReport, commissionsCsv, type CommissionEmployee } from './commissions';

/**
 * "עמלות": a percent per employee for treatments and for products, and the month's report —
 * on the amount before VAT, after discounts, minus that month's refunds. Export for payroll.
 */
const monthName = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' });
const prevMonth = (m: string) => israelParts(new Date(`${m}-01T12:00:00Z`).getTime() - 864e5).date.slice(0, 7);

export function CommissionsTab({ sales, refunds, catalog, onLoadOlder }: {
  sales: Sale[]; refunds: Refund[]; catalog: { name: string; kind: ItemKind }[]; onLoadOlder?: () => Promise<void>;
}) {
  const thisMonth = israelParts(Date.now()).date.slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [emps, setEmps] = useState<CommissionEmployee[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase().from('employees').select('id, name, active, commission_service_pct, commission_product_pct').order('created_at');
    if (e) { setError(/commission_/.test(e.message) ? 'צריך להריץ את מיגרציה 20261004003000 (עמלות) ב-Supabase.' : 'לא הצלחנו לטעון עובדים.'); setEmps([]); return; }
    setEmps(((data ?? []) as any[]).map((r) => ({ id: r.id, name: r.name, servicePct: Number(r.commission_service_pct ?? 0), productPct: Number(r.commission_product_pct ?? 0) })));
  }, []);
  useEffect(() => { void load(); }, [load]);

  // lines saved before 2.50 have no kind — the price list tells (unknown = a treatment)
  const kinds = useMemo(() => new Map(catalog.map((c) => [c.name, c.kind])), [catalog]);
  const kindOf = useCallback((l: Line) => l.kind ?? kinds.get(l.name), [kinds]);
  const rep = useMemo(() => (emps ? commissionReport(sales, refunds, emps, month, kindOf) : null), [emps, sales, refunds, month, kindOf]);
  const oldest = sales.reduce((a, s) => ((s.paidAt ?? s.createdAt) < a ? (s.paidAt ?? s.createdAt) : a), new Date().toISOString()).slice(0, 7);

  async function savePct(e: CommissionEmployee, field: 'servicePct' | 'productPct', raw: string) {
    const v = cleanPct(raw);
    if (v === e[field]) return;
    const col = field === 'servicePct' ? 'commission_service_pct' : 'commission_product_pct';
    const { error: err } = await supabase().from('employees').update({ [col]: v }).eq('id', e.id);
    if (err) { setError('השינוי לא נשמר. נסו שוב.'); return; }
    setEmps((all) => (all ?? []).map((x) => (x.id === e.id ? { ...x, [field]: v } : x)));
    setSaved(`נשמר: ${e.name} · ${field === 'servicePct' ? 'טיפולים' : 'מוצרים'} ${v}%`); setTimeout(() => setSaved(null), 2500);
  }
  /** the month's commissions as one expense in "כספים" (no VAT; recorded once per month — 2.51) */
  async function recordExpense() {
    if (!rep || rep.totals.commission <= 0) return;
    const desc = `עמלות עובדים ${month}`;
    const { data: same, error: e1 } = await supabase().from('expenses').select('id').eq('description', desc).neq('status', 'void').limit(1);
    if (e1) { setError(/schema cache|does not exist|PGRST20/.test(e1.message) ? 'צריך להריץ את מיגרציה 20261004003100 (כספים) ב-Supabase.' : 'לא הצלחנו לבדוק.'); return; }
    if (same?.length && !window.confirm(`העמלות של ${monthName(month)} כבר נרשמו כהוצאה. לרשום שוב?`)) return;
    const today = israelParts(Date.now()).date;
    const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const total = Math.round(rep.totals.commission * 100) / 100;
    const { error: e2 } = await supabase().from('expenses').insert({ user_id: useApp.getState().userId, supplier_name: 'עמלות עובדים', supplier_doc_type: 'other', category: 'commissions',
      description: desc, doc_date: end < today ? end : today, amount_before_vat: total, vat_amount: 0, total, vat_deductible_pct: 0, status: 'confirmed' });
    if (e2) { setError(/period_locked/.test(e2.message) ? 'הספרים סגורים לחודש הזה.' : 'ההוצאה לא נרשמה.'); return; }
    setSaved(`העמלות נרשמו כהוצאה בכספים: ${ils(total)}`); setTimeout(() => setSaved(null), 3500);
  }
  function exportCsv() {
    if (!rep) return;
    const blob = new Blob([commissionsCsv(rep.rows, month)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `עמלות-${month}.csv`; a.click();
  }

  if (!emps || !rep) return <div className="py-8 text-center"><Spinner /></div>;
  return (
    <div className="grid gap-4">
      {error && <p className="rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p>}
      {saved && <p role="status" className="rounded-2xl bg-emerald-500/15 p-3 text-sm font-semibold">✓ {saved}</p>}

      <Card className="p-4">
        <p className="mb-1 font-bold">אחוזי עמלה</p>
        <p className="mb-3 text-xs text-muted">העמלה מחושבת על הסכום <strong>לפני מע״מ</strong>, אחרי הנחות, ובניכוי החזרים של אותו חודש. טיפולים = טיפולים, חבילות ואחר; מוצרים = מוצרים מהמחירון.</p>
        {!emps.length ? <p className="text-sm text-muted">אין עובדים עדיין — מוסיפים אותם במסך &quot;נוכחות&quot;.</p> : (
          <div className="grid gap-2">
            {emps.map((e) => (
              <div key={e.id} className="grid grid-cols-[minmax(0,1fr)_6.5rem_6.5rem] items-center gap-2 text-sm">
                <strong className="truncate">{e.name}</strong>
                <label className="grid gap-0.5 text-xs text-muted">טיפולים %
                  <Input type="number" inputMode="decimal" min={0} max={100} defaultValue={e.servicePct} onBlur={(ev) => void savePct(e, 'servicePct', ev.target.value)} className="h-10 py-1 text-center" aria-label={`אחוז עמלה על טיפולים: ${e.name}`} />
                </label>
                <label className="grid gap-0.5 text-xs text-muted">מוצרים %
                  <Input type="number" inputMode="decimal" min={0} max={100} defaultValue={e.productPct} onBlur={(ev) => void savePct(e, 'productPct', ev.target.value)} className="h-10 py-1 text-center" aria-label={`אחוז עמלה על מוצרים: ${e.name}`} />
                </label>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <Chip on={month === thisMonth} onClick={() => setMonth(thisMonth)}>החודש</Chip>
          <Chip on={month === prevMonth(thisMonth)} onClick={() => setMonth(prevMonth(thisMonth))}>חודש קודם</Chip>
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="חודש"
            className="h-9 rounded-full border border-line bg-surface px-3 text-sm font-semibold outline-hidden focus:border-primary" />
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={exportCsv}>ייצוא לאקסל</Button>
          {rep.totals.commission > 0 && <Button size="sm" variant="ghost" onClick={() => void recordExpense()}>רישום כהוצאה בכספים</Button>}
        </div>
        <p className="mb-2 font-bold">עמלות · {monthName(month)}</p>
        {month < oldest && onLoadOlder && <p className="mb-2 text-xs text-muted">החודש הזה ישן מהעסקאות שנטענו. <button type="button" className="font-semibold text-primary" onClick={() => void onLoadOlder()}>טעינת עסקאות קודמות</button></p>}
        {!rep.rows.length ? <p className="text-sm text-muted">אין מכירות בחודש הזה.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm tabular-nums">
              <thead><tr className="text-xs text-muted">
                <th className="py-1 text-start font-semibold">עובד/ת</th><th className="font-semibold">מכירות</th><th className="font-semibold">סה״כ (כולל מע״מ)</th>
                <th className="font-semibold">בסיס טיפולים</th><th className="font-semibold">בסיס מוצרים</th><th className="font-semibold">עמלה</th>
              </tr></thead>
              <tbody>
                {rep.rows.map((r) => (
                  <tr key={r.employeeId ?? 'none'} className="border-t border-line">
                    <td className="py-2 font-semibold">{r.name}{r.refunds ? <span className="block text-xs font-normal text-muted">החזרים: −{ils(r.refunds)}</span> : null}</td>
                    <td className="text-center">{r.sales}</td>
                    <td className="text-center">{ils(r.gross)}</td>
                    <td className="text-center">{ils(r.base.service)}{r.employeeId ? <span className="block text-xs text-muted">{r.servicePct}%</span> : null}</td>
                    <td className="text-center">{ils(r.base.product)}{r.employeeId ? <span className="block text-xs text-muted">{r.productPct}%</span> : null}</td>
                    <td className="text-center text-base font-black">{r.employeeId ? ils(r.commission) : '—'}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-line font-bold">
                  <td className="py-2">סה״כ</td><td className="text-center">{rep.totals.sales}</td><td className="text-center">{ils(rep.totals.gross)}</td><td /><td />
                  <td className="text-center text-base font-black">{ils(rep.totals.commission)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-muted">מכירה נספרת לפי המוכר/ת שנבחר/ה בקופה. עסקאות בלי מוכר/ת מופיעות בשורה נפרדת, בלי עמלה.</p>
      </Card>
    </div>
  );
}
