'use client';
import { useEffect, useState } from 'react';
import { Button, Card, Chip } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { useFinance } from './FinanceScreen';
import { loadSummary, type Summary } from './Overview';
import { logEvent } from './api';
import { categoryLabel } from './expenses';
import { payLabel } from './payments';
import { vatReportRows } from './reports';
import { LOAD_FAILED, LoadFailed, Note, PeriodPicker, ddmmyyyy, ils, periodNow, type Period } from './ui';
import { LocationCompare } from './LocationCompare';
import { useLocations } from '@/features/locations/store';
import { multiLocation, switchLabel } from '@/features/locations/locations';
import { useReportsReady } from './reports-data';
import {
  AdvancesView, CustomerLedgerView, CustomersView, ItemsView, PnlCompare, REPORT_VIEWS, SupplierLedgerView, SuppliersView, WithholdingView, isReportView, type ReportView,
} from './ReportBook';

/**
 * "דוחות": profit and loss (estimate), the VAT working paper of a period, expenses by category, money by method — all from
 * finance_summary() (the same numbers as the overview and the accountant's package). Printable. A working paper, not a filing.
 * 2.94 (T8): profit and loss against the same period a year before, and — once migration 20261011004900 is in the database —
 * the reports of ReportBook.tsx (by customer, by item and treatment type, the cards of a customer and of a supplier, suppliers
 * paid and not yet, tax withheld at source, the advances' estimate), each with CSV and PDF.
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
  const { profile, business, vat, params } = useFinance();
  // "השוואת סניפים" (2.93 — T12ד): only with more than one location (a business with one sees the reports as before)
  const multi = useLocations((x) => multiLocation(x.state));
  const where = useLocations((x) => switchLabel(x.state));
  const ready = useReportsReady();
  // a customer's card opened from the CRM shows the year; every other report starts on the VAT period
  const [period, setPeriod] = useState<Period>(() => periodNow(params.get('view') === 'cledger' ? 'year' : profile.vatPeriod === 'monthly' ? 'month' : 'bimonth'));
  // which report (the address may say: ?view=cledger&key=l:…&name=… opens a customer's card)
  const [view, setView] = useState<ReportView>(() => { const v = params.get('view'); return isReportView(v) ? v : 'summary'; });
  const [customer, setCustomer] = useState<{ key: string; name: string } | null>(() =>
    params.get('view') === 'cledger' && /^(l|d|n):/.test(params.get('key') ?? '') ? { key: params.get('key')!, name: params.get('name') ?? '' } : null);
  const [supplier, setSupplier] = useState<{ key: string; name: string } | null>(null);
  const subtitle = `${period.kind === 'custom' ? '' : `${period.label} · `}${ddmmyyyy(period.from)} – ${ddmmyyyy(period.to)}${multi ? ` · ${where}` : ''}`;
  const [s, setS] = useState<Summary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setS(null); setLoadError(null);
    void loadSummary(period).then((r) => { if (alive) { if (r.ok) setS(r.s); else setLoadError(r.error); } }, () => alive && setLoadError(LOAD_FAILED));
    return () => { alive = false; };
  }, [period, attempt]);
  function print() {
    if (!s) return;
    const w = window.open('', '_blank'); if (!w) return;
    w.document.write(reportHtml(s, `דוח ${period.label}`, business)); w.document.close();
    void logEvent('report.printed', 'reports', '', { from: period.from, to: period.to });
  }
  const shown = ready ? view : 'summary';
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <PeriodPicker value={period} onChange={setPeriod} vatKind={profile.vatPeriod === 'monthly' ? 'month' : 'bimonth'} />
      {ready && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="איזה דוח">
          {REPORT_VIEWS.map((v) => <Chip key={v.id} on={shown === v.id} onClick={() => setView(v.id)}>{v.label}</Chip>)}
        </div>
      )}
      {shown === 'customers' && <CustomersView period={period} subtitle={subtitle} openLedger={(key, name) => { setCustomer({ key, name }); setView('cledger'); }} />}
      {shown === 'items' && <ItemsView period={period} subtitle={subtitle} />}
      {shown === 'cledger' && <CustomerLedgerView period={period} subtitle={subtitle} pick={customer} onPick={setCustomer} />}
      {shown === 'suppliers' && <SuppliersView period={period} subtitle={subtitle} openLedger={(key, name) => { setSupplier({ key, name }); setView('sledger'); }} />}
      {shown === 'sledger' && <SupplierLedgerView period={period} subtitle={subtitle} pick={supplier} onPick={setSupplier} />}
      {shown === 'withholding' && <WithholdingView period={period} subtitle={subtitle} setPeriod={setPeriod} />}
      {shown === 'advances' && <AdvancesView period={period} subtitle={subtitle} />}
      {shown === 'summary' && (!s ? (loadError ? <LoadFailed message={loadError} onRetry={() => setAttempt((n) => n + 1)} /> : <div className="py-8 text-center"><Spinner /></div>) : <>
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
            {s.withheld !== 0 && <p className="mt-2 flex justify-between gap-2 border-t border-line pt-1 text-sm"><span>ניכוי במקור (לא כסף — שילם חשבוניות)</span><span className="tabular-nums">{ils(s.withheld)}</span></p>}
          </Card>
        </div>
        <PnlCompare s={s} period={period} subtitle={subtitle} />
        {multi && <LocationCompare period={period} />}
        <div><Button variant="ghost" onClick={print}>הדפסת הדוח</Button></div>
        <p className="text-xs text-muted">דוח עבודה — לא הגשה. Dream Promotion לא מגיש דיווחים לרשות המסים.</p>
      </>)}
    </div>
  );
}
