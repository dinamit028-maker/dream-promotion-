'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { Button, Card } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { DOC_LABEL } from '@/features/documents/documents';
import { useFinance } from './FinanceScreen';
import { financeError } from './api';
import { categoryLabel } from './expenses';
import { payLabel } from './payments';
import { Note, PeriodPicker, Stat, ils, periodNow, type Period } from './ui';

/**
 * The overview: real numbers only — every figure comes from finance_summary() in the database (documents, the payments
 * ledger, confirmed expenses, receivables). Nothing is estimated on the screen; empty means zero, and says so.
 */
export interface Summary {
  from: string; to: string; entity: string; vat: boolean;
  revenue: { net: number; vat: number; gross: number };
  documents: Record<string, { count: number; total: number; cancelled: number }>;
  expenses: { net: number; vat: number; vatDeductible: number; total: number; count: number; byCategory: { category: string; net: number; vat: number; total: number; count: number }[] };
  vatPayable: number; profit: number;
  cash: { in: number; out: number; net: number; byMethod: { method: string; in: number | null; out: number | null }[] };
  receivables: { open: number; count: number; overdue: number; overdueCount: number };
  pending: { count: number; total: number }; posWithoutDocument: { count: number; total: number }; allocationMissing: number;
  months: { month: string; revenue: number; expenses: number }[]; lockedUntil: string | null;
}
const num = (v: unknown) => Number(v ?? 0);
export const toSummary = (j: any): Summary => ({
  ...j, revenue: { net: num(j.revenue?.net), vat: num(j.revenue?.vat), gross: num(j.revenue?.gross) },
  expenses: { ...j.expenses, net: num(j.expenses?.net), vat: num(j.expenses?.vat), vatDeductible: num(j.expenses?.vatDeductible), total: num(j.expenses?.total), count: num(j.expenses?.count),
    byCategory: (j.expenses?.byCategory ?? []).map((c: any) => ({ ...c, net: num(c.net), vat: num(c.vat), total: num(c.total), count: num(c.count) })) },
  vatPayable: num(j.vatPayable), profit: num(j.profit),
  cash: { in: num(j.cash?.in), out: num(j.cash?.out), net: num(j.cash?.net), byMethod: j.cash?.byMethod ?? [] },
  receivables: { open: num(j.receivables?.open), count: num(j.receivables?.count), overdue: num(j.receivables?.overdue), overdueCount: num(j.receivables?.overdueCount) },
  pending: { count: num(j.pending?.count), total: num(j.pending?.total) }, posWithoutDocument: { count: num(j.posWithoutDocument?.count), total: num(j.posWithoutDocument?.total) },
  allocationMissing: num(j.allocationMissing), months: (j.months ?? []).map((m: any) => ({ month: m.month, revenue: num(m.revenue), expenses: num(m.expenses) })),
});
export async function loadSummary(p: { from: string; to: string }): Promise<{ ok: true; s: Summary } | { ok: false; error: string }> {
  const { data, error } = await supabase().rpc('finance_summary', { p_from: p.from, p_to: p.to });
  return error || !data ? { ok: false, error: financeError(error) } : { ok: true, s: toSummary(data) };
}

export function Overview() {
  const { go, profile, vat } = useFinance();
  const [period, setPeriod] = useState<Period>(() => periodNow('month'));
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setS(null);
    void loadSummary(period).then((r) => { if (!alive) return; if (r.ok) { setS(r.s); setError(null); } else setError(r.error); });
    return () => { alive = false; };
  }, [period]);

  return (
    <div className="grid gap-4">
      <PeriodPicker value={period} onChange={setPeriod} vatKind={profile.vatPeriod === 'monthly' ? 'month' : 'bimonth'} />
      {error && <Note tone="warn">{error}</Note>}
      {!s && !error && <div className="py-8 text-center"><Spinner /></div>}
      {s && <>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Stat label={vat ? 'הכנסות (לפני מע״מ)' : 'הכנסות (קבלות)'} value={ils(s.revenue.net)} hint={vat ? `מע״מ עסקאות ${ils(s.revenue.vat)}` : 'עוסק פטור — לפי קבלות'} />
          <Stat label="הוצאות" value={ils(s.expenses.net + s.expenses.vat - s.expenses.vatDeductible)} hint={`${s.expenses.count} הוצאות מאושרות`} onClick={() => go('expenses')} />
          <Stat label="רווח משוער" value={ils(s.profit)} tone={s.profit >= 0 ? 'ok' : 'bad'} hint="הכנסות פחות הוצאות (לפני מס הכנסה)" />
          {vat ? <Stat label="מע״מ לתשלום (משוער)" value={ils(s.vatPayable)} hint={`תשומות לקיזוז ${ils(s.expenses.vatDeductible)}`} onClick={() => go('reports')} />
            : <Stat label="מע״מ" value="—" hint="עוסק פטור לא גובה מע״מ" />}
          <Stat label="נכנס לקופה ולבנק" value={ils(s.cash.in)} hint={`יצא ${ils(s.cash.out)} · נטו ${ils(s.cash.net)}`} onClick={() => go('income')} />
          <Stat label="חייבים פתוחים" value={ils(s.receivables.open)} hint={`${s.receivables.count} מסמכים`} onClick={() => go('receivables')} />
          <Stat label="באיחור" value={ils(s.receivables.overdue)} tone={s.receivables.overdueCount ? 'bad' : undefined} hint={`${s.receivables.overdueCount} מסמכים`} onClick={() => go('receivables')} />
          <Stat label="בקשות תשלום מהקופה" value={ils(s.pending.total)} hint={`${s.pending.count} ממתינות`} />
        </div>

        {(s.posWithoutDocument.count > 0 || s.allocationMissing > 0) && (
          <div className="grid gap-2">
            {s.posWithoutDocument.count > 0 && <Note tone="warn">{s.posWithoutDocument.count} מכירות ששולמו בקופה בתקופה הזו בלי מסמך ({ils(s.posWithoutDocument.total)}). <button type="button" className="font-semibold underline" onClick={() => go('income')}>להפקת המסמכים החסרים</button></Note>}
            {s.allocationMissing > 0 && <Note tone="warn">{s.allocationMissing} חשבוניות מס מעל הסף לעוסק — בלי מספר הקצאה. <button type="button" className="font-semibold underline" onClick={() => go('documents', { filter: 'allocation' })}>לרשימה</button></Note>}
          </div>
        )}

        <Card className="p-4">
          <p className="mb-3 font-bold">הכנסות והוצאות לפי חודש</p>
          <MonthBars months={s.months} />
        </Card>

        <div className="grid gap-3 md:grid-cols-2">
          <Card className="p-4">
            <p className="mb-2 font-bold">מסמכים בתקופה</p>
            {Object.keys(s.documents).length === 0 ? <p className="text-sm text-muted">לא הופקו מסמכים בתקופה הזו.</p> : (
              <ul className="grid gap-1 text-sm">{Object.entries(s.documents).sort(([a], [b]) => Number(a) - Number(b)).map(([t, v]) => (
                <li key={t} className="flex justify-between gap-2"><span>{DOC_LABEL[Number(t)] ?? t} · {v.count}{v.cancelled ? ` (${v.cancelled} בוטלו)` : ''}</span><strong className="tabular-nums">{ils(Number(v.total))}</strong></li>
              ))}</ul>
            )}
          </Card>
          <Card className="p-4">
            <p className="mb-2 font-bold">איך נכנס הכסף</p>
            {!s.cash.byMethod.length ? <p className="text-sm text-muted">אין תשלומים בתקופה הזו.</p> : (
              <ul className="grid gap-1 text-sm">{s.cash.byMethod.map((m) => (
                <li key={m.method} className="flex justify-between gap-2"><span>{payLabel(m.method)}</span><strong className="tabular-nums">{ils(Number(m.in ?? 0))}{m.out ? <span className="text-xs font-normal text-muted"> · יצא {ils(Number(m.out))}</span> : null}</strong></li>
              ))}</ul>
            )}
            {s.expenses.byCategory.length > 0 && <>
              <p className="mb-2 mt-4 font-bold">הוצאות לפי קטגוריה</p>
              <ul className="grid gap-1 text-sm">{s.expenses.byCategory.slice(0, 6).map((c) => (
                <li key={c.category} className="flex justify-between gap-2"><span>{categoryLabel(c.category)} · {c.count}</span><strong className="tabular-nums">{ils(c.total)}</strong></li>
              ))}</ul>
            </>}
          </Card>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => go('documents', { new: '1' })}>+ מסמך חדש</Button>
          <Button variant="ghost" onClick={() => go('expenses', { new: '1' })}>+ הוצאה</Button>
          <Button variant="ghost" onClick={() => go('quotes', { new: '1' })}>+ הצעת מחיר</Button>
        </div>
        <p className="text-xs text-muted">כל המספרים מחושבים במסד הנתונים מהמסמכים שהופקו, מיומן התשלומים ומההוצאות המאושרות. הרווח והמע״מ הם הערכה לעבודה — הדוח הרשמי הוא של רואה החשבון.</p>
      </>}
    </div>
  );
}

/** a plain CSS bar chart: income and expenses per month (no chart library) */
function MonthBars({ months }: { months: Summary['months'] }) {
  const max = Math.max(1, ...months.flatMap((m) => [Math.abs(m.revenue), Math.abs(m.expenses)]));
  if (!months.length) return <p className="text-sm text-muted">אין נתונים.</p>;
  return (
    <div className="flex items-end gap-2 overflow-x-auto pb-1" style={{ minHeight: 140 }} role="img" aria-label="גרף הכנסות והוצאות לפי חודש">
      {months.map((m) => (
        <div key={m.month} className="flex min-w-[46px] flex-1 flex-col items-center gap-1">
          <div className="flex h-28 items-end gap-1">
            <span title={`הכנסות ${ils(m.revenue)}`} className="w-3 rounded-t bg-primary" style={{ height: `${Math.max(2, (Math.max(0, m.revenue) / max) * 100)}%` }} />
            <span title={`הוצאות ${ils(m.expenses)}`} className="w-3 rounded-t bg-amber-500" style={{ height: `${Math.max(2, (Math.max(0, m.expenses) / max) * 100)}%` }} />
          </div>
          <span className="text-[11px] text-muted" dir="ltr">{m.month.slice(5)}/{m.month.slice(2, 4)}</span>
        </div>
      ))}
      <div className="ms-2 self-start text-xs text-muted"><span className="me-1 inline-block h-2 w-2 rounded bg-primary" />הכנסות <span className="me-1 ms-2 inline-block h-2 w-2 rounded bg-amber-500" />הוצאות</div>
    </div>
  );
}
