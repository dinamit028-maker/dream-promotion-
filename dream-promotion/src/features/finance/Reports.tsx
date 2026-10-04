'use client';
import { useEffect, useState } from 'react';
import { Button, Card } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { useFinance } from './FinanceScreen';
import { loadSummary, type Summary } from './Overview';
import { logEvent } from './api';
import { categoryLabel } from './expenses';
import { payLabel } from './payments';
import { vatReportRows } from './reports';
import { Note, PeriodPicker, ils, periodNow, type Period } from './ui';

/**
 * "דוחות": profit and loss (estimate), the VAT working paper of a period, expenses by category, money by method — all from
 * finance_summary() (the same numbers as the overview and the accountant's package). Printable. A working paper, not a filing.
 */
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function reportHtml(s: Summary, title: string, business: { name: string; dealerNumber: string }) {
  const row = (k: string, v: number, strong = false) => `<tr${strong ? ' class="tot"' : ''}><td>${esc(k)}</td><td>${v.toFixed(2)}</td></tr>`;
  const cats = s.expenses.byCategory.map((c) => row(`${categoryLabel(c.category)} (${c.count})`, c.total)).join('');
  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:Arial,system-ui,sans-serif;color:#111;margin:24px}table{width:100%;border-collapse:collapse;margin:10px 0}td,th{border:1px solid #bbb;padding:6px;text-align:right;font-size:13px}.tot td{font-weight:bold}.muted{color:#666;font-size:12px}</style></head>
<body><h2>${esc(business.name)} · ${esc(business.dealerNumber)}</h2><p>${esc(title)} · ${s.from.split('-').reverse().join('/')} – ${s.to.split('-').reverse().join('/')}</p>
<h3>רווח והפסד (הערכה)</h3><table>${row('הכנסות (לפני מע״מ)', s.revenue.net)}${row('הוצאות (לפני מע״מ)', s.expenses.net)}${row('מע״מ תשומות שאינו מקוזז', s.expenses.vat - s.expenses.vatDeductible)}${row('רווח משוער', s.profit, true)}</table>
${s.vat ? `<h3>מע״מ</h3><table>${vatReportRows(s).map(([k, v], i) => row(k, v, i === 5)).join('')}</table>` : '<p>עוסק פטור — אין דיווח מע״מ תקופתי על עסקאות.</p>'}
${cats ? `<h3>הוצאות לפי קטגוריה</h3><table>${cats}</table>` : ''}
<p class="muted">דוח עבודה מתוך Dream Promotion — לא דוח שהוגש לרשות המסים. ההגשה נעשית על ידי העסק או רואה החשבון.</p>
<script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`;
}

export function Reports() {
  const { profile, business, vat, fail } = useFinance();
  const [period, setPeriod] = useState<Period>(() => periodNow(profile.vatPeriod === 'monthly' ? 'month' : 'bimonth'));
  const [s, setS] = useState<Summary | null>(null);
  useEffect(() => { setS(null); void loadSummary(period).then((r) => (r.ok ? setS(r.s) : fail(r.error))); }, [period, fail]);
  function print() {
    if (!s) return;
    const w = window.open('', '_blank'); if (!w) return;
    w.document.write(reportHtml(s, `דוח ${period.label}`, business)); w.document.close();
    void logEvent('report.printed', 'reports', '', { from: period.from, to: period.to });
  }
  return (
    <div className="grid gap-3">
      <PeriodPicker value={period} onChange={setPeriod} vatKind={profile.vatPeriod === 'monthly' ? 'month' : 'bimonth'} />
      {!s ? <div className="py-8 text-center"><Spinner /></div> : <>
        <Card className="p-4">
          <p className="mb-2 font-bold">רווח והפסד (הערכה)</p>
          <dl className="grid gap-1 text-sm tabular-nums">
            <div className="flex justify-between"><dt>הכנסות (לפני מע״מ)</dt><dd>{ils(s.revenue.net)}</dd></div>
            <div className="flex justify-between"><dt>הוצאות (לפני מע״מ)</dt><dd>−{ils(s.expenses.net)}</dd></div>
            {s.expenses.vat - s.expenses.vatDeductible !== 0 && <div className="flex justify-between"><dt>מע״מ על הוצאות שלא מקוזז</dt><dd>−{ils(s.expenses.vat - s.expenses.vatDeductible)}</dd></div>}
            <div className="flex justify-between border-t border-line pt-1 text-base font-black"><dt>רווח משוער</dt><dd>{ils(s.profit)}</dd></div>
          </dl>
        </Card>
        {vat ? (
          <Card className="p-4">
            <p className="mb-2 font-bold">מע״מ · {period.label}</p>
            <dl className="grid gap-1 text-sm tabular-nums">{vatReportRows(s).map(([k, v], i) => <div key={k} className={i === 5 ? 'flex justify-between border-t border-line pt-1 font-black' : 'flex justify-between'}><dt>{k}</dt><dd>{ils(v)}</dd></div>)}</dl>
            {s.allocationMissing > 0 && <p className="mt-2 text-sm text-warn">{s.allocationMissing} חשבוניות מס מעל הסף בלי מספר הקצאה בתקופה הזו.</p>}
          </Card>
        ) : <Note>עוסק פטור — אין דיווח מע״מ תקופתי. ההכנסות לפי הקבלות.</Note>}
        <div className="grid gap-3 md:grid-cols-2">
          <Card className="p-4"><p className="mb-2 font-bold">הוצאות לפי קטגוריה</p>
            {!s.expenses.byCategory.length ? <p className="text-sm text-muted">אין הוצאות מאושרות.</p> : <ul className="grid gap-1 text-sm">{s.expenses.byCategory.map((c) => <li key={c.category} className="flex justify-between gap-2"><span>{categoryLabel(c.category)} · {c.count}</span><strong className="tabular-nums">{ils(c.total)}</strong></li>)}</ul>}
          </Card>
          <Card className="p-4"><p className="mb-2 font-bold">כסף לפי אמצעי תשלום</p>
            {!s.cash.byMethod.length ? <p className="text-sm text-muted">אין תשלומים.</p> : <ul className="grid gap-1 text-sm">{s.cash.byMethod.map((m) => <li key={m.method} className="flex justify-between gap-2"><span>{payLabel(m.method)}</span><span className="tabular-nums">נכנס {ils(Number(m.in ?? 0))} · יצא {ils(Number(m.out ?? 0))}</span></li>)}</ul>}
          </Card>
        </div>
        <div><Button variant="ghost" onClick={print}>הדפסת הדוח</Button></div>
        <p className="text-xs text-muted">דוח עבודה — לא הגשה. Dream Promotion לא מגיש דיווחים לרשות המסים.</p>
      </>}
    </div>
  );
}
