'use client';
import { useEffect, useMemo, useState, type DependencyList, type KeyboardEvent } from 'react';
import { Button, Card, Input, Select } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { useFinance } from './FinanceScreen';
import { logEvent } from './api';
import { loadSummary, type Summary } from './Overview';
import { periodOf } from './reports';
import {
  ADVANCE_NOTE, MANUAL_KEY, advanceEstimate, advanceTable, cellText, customerLedgerTable, categoriesTable, incomeTable, isNumeric, itemsTable, monthsTable, partyKey,
  pnlTable, reportFileName, supplierLedgerTable, suppliersTable, tableCsv, typesTable, withholdingRowsTable, withholdingTable, yearBefore, type ReportTable,
} from './statements';
import {
  downloadReportPdf, loadCustomerLedger, loadIncomeByCustomer, loadLeadsForLedger, loadSalesByItem, loadSupplierLedger, loadSuppliers, loadWithholding, type Res,
} from './reports-data';
import { LOAD_FAILED, LoadFailed, Note, ddmmyyyy, download, ils, periodNow, type Period } from './ui';

/**
 * The reports of 2.94 (docs/FINANCE_ADDITIONS_HE.md T8), each on the period picked above and the location picked at the top (the
 * database reads only what the member may see there): income by customer, sales by item and treatment type, a customer's card,
 * suppliers and kinds of expense (paid and not yet), a supplier's card, tax withheld at source, the income tax advances (an
 * estimate), and profit and loss against the same period a year before. Every table downloads as CSV and as PDF — the same
 * numbers as on the screen, the totals as the money screens'.
 */
export type ReportView = 'summary' | 'customers' | 'items' | 'cledger' | 'suppliers' | 'sledger' | 'withholding' | 'advances';
export const REPORT_VIEWS: { id: ReportView; label: string }[] = [
  { id: 'summary', label: 'סיכום' }, { id: 'customers', label: 'לפי לקוח' }, { id: 'items', label: 'לפי פריט וטיפול' }, { id: 'cledger', label: 'כרטסת לקוח' },
  { id: 'suppliers', label: 'ספקים והוצאות' }, { id: 'sledger', label: 'כרטסת ספק' }, { id: 'withholding', label: 'ניכוי במקור' }, { id: 'advances', label: 'מקדמות' },
];
export const isReportView = (v: string | null): v is ReportView => REPORT_VIEWS.some((x) => x.id === v);

type Loaded<T> = { data: T | null; error: string | null; retry: () => void };
function useLoad<T>(fn: () => Promise<Res<T>>, deps: DependencyList): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    fn().then((r) => { if (alive) { if (r.ok) setData(r.data); else setError(r.error); } }, () => alive && setError(LOAD_FAILED));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, retry: () => setN((x) => x + 1) };
}
function Waiting({ r }: { r: Loaded<unknown> }) {
  return r.error ? <LoadFailed message={r.error} onRetry={r.retry} /> : <div className="py-8 text-center"><Spinner /></div>;
}

/** a report's table on the screen, with "CSV" and "PDF" — a click on a row (when given) opens what it is about */
export function TableCard({ table, period, subtitle, onRow, rowHint, empty = 'אין נתונים לתקופה הזו.' }: {
  table: ReportTable; period: Period; subtitle: string; onRow?: (i: number) => void; rowHint?: string; empty?: string;
}) {
  const { fail, say } = useFinance();
  const [busy, setBusy] = useState(false);
  const cls = (i: number) => cx('px-2 py-1.5', isNumeric(table.columns[i].type) ? 'text-end tabular-nums whitespace-nowrap' : 'text-start');
  function csvFile() {
    download(reportFileName(table.title, period, 'csv'), tableCsv(table));
    void logEvent('report.exported', 'reports', table.title, { format: 'csv', from: period.from, to: period.to, rows: table.rows.length });
  }
  async function pdfFile() {
    setBusy(true);
    const e = await downloadReportPdf(table, subtitle, period);
    setBusy(false);
    if (e) { fail(e); return; }
    say('ה-PDF ירד.');
    void logEvent('report.exported', 'reports', table.title, { format: 'pdf', from: period.from, to: period.to, rows: table.rows.length });
  }
  return (
    <Card className="min-w-0 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-bold">{table.title}</p>
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={csvFile} aria-label={`${table.title} — הורדת CSV`}>CSV</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void pdfFile()} aria-label={`${table.title} — הורדת PDF`}>{busy ? <Spinner /> : 'PDF'}</Button>
        </div>
      </div>
      {!table.rows.length ? <p className="py-2 text-sm text-muted">{empty}</p> : (
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[520px] text-sm" aria-label={table.title}>
            <thead>
              <tr className="border-b border-line text-xs text-muted">{table.columns.map((c, i) => <th key={i} className={cx(cls(i), 'font-semibold')}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {table.rows.map((r, k) => (
                <tr key={k} className={cx('border-b border-line/60', onRow && 'cursor-pointer hover:bg-surface-2')}
                  {...(onRow ? { role: 'button', tabIndex: 0, onClick: () => onRow(k), onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') onRow(k); } } : {})}>
                  {r.map((v, i) => <td key={i} className={cls(i)}>{cellText(v, table.columns[i].type, 'show')}</td>)}
                </tr>
              ))}
              {table.total && <tr className="font-black">{table.total.map((v, i) => <td key={i} className={cls(i)}>{cellText(v, table.columns[i].type, 'show')}</td>)}</tr>}
            </tbody>
          </table>
        </div>
      )}
      {onRow && rowHint && table.rows.length > 0 && <p className="mt-1 text-xs text-muted">{rowHint}</p>}
      {table.note && <p className="mt-2 text-xs text-muted">{table.note}</p>}
    </Card>
  );
}

type ViewProps = { period: Period; subtitle: string };

export function CustomersView({ period, subtitle, openLedger }: ViewProps & { openLedger: (key: string, name: string) => void }) {
  const r = useLoad(() => loadIncomeByCustomer(period), [period.from, period.to]);
  if (!r.data) return <Waiting r={r} />;
  const d = r.data;
  // 2.96: the line of manual entries that belong to no customer has no card
  return <TableCard table={incomeTable(d)} period={period} subtitle={subtitle} onRow={(i) => { if (d.customers[i].key !== MANUAL_KEY) openLedger(d.customers[i].key, d.customers[i].name); }}
    rowHint="לחיצה על לקוח — הכרטסת שלו." />;
}

export function ItemsView({ period, subtitle }: ViewProps) {
  const r = useLoad(() => loadSalesByItem(period), [period.from, period.to]);
  if (!r.data) return <Waiting r={r} />;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <TableCard table={typesTable(r.data)} period={period} subtitle={subtitle} />
      <TableCard table={itemsTable(r.data)} period={period} subtitle={subtitle} />
    </div>
  );
}

/** a customer to open the card of: the CRM's cards; or one without a card, by dealer / company number or by name */
function CustomerPicker({ onPick }: { onPick: (key: string, name: string) => void }) {
  const [q, setQ] = useState('');
  const [leads, setLeads] = useState<{ key: string; name: string; phone: string }[] | null>(null);
  useEffect(() => { let alive = true; void loadLeadsForLedger().then((l) => { if (alive) setLeads(l); }); return () => { alive = false; }; }, []);
  const t = q.trim();
  const digits = t.replace(/\D/g, '');
  const matches = useMemo(() => (!t || !leads ? [] : leads.filter((l) => l.name.includes(t) || (digits.length >= 3 && l.phone.replace(/\D/g, '').includes(digits))).slice(0, 8)), [t, digits, leads]);
  return (
    <Card className="p-4">
      <p className="mb-2 font-bold">כרטסת של איזה לקוח?</p>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="שם, טלפון או ע.מ / ח.פ" aria-label="חיפוש לקוח לכרטסת" />
      {t && (
        <ul className="mt-2 grid gap-1 text-sm">
          {matches.map((l) => <li key={l.key}><button type="button" className="min-h-10 w-full rounded-xl px-2 text-start hover:bg-surface-2" onClick={() => onPick(l.key, l.name)}>{l.name}{l.phone ? <span className="text-xs text-muted"> · {l.phone}</span> : null}</button></li>)}
          {/^\d{9}$/.test(digits) && digits === t && <li><button type="button" className="min-h-10 w-full rounded-xl px-2 text-start hover:bg-surface-2" onClick={() => onPick(`d:${digits}`, `ע.מ / ח.פ ${digits}`)}>לקוח עם ע.מ / ח.פ {digits}</button></li>}
          {!/^\d+$/.test(t) && <li><button type="button" className="min-h-10 w-full rounded-xl px-2 text-start text-muted hover:bg-surface-2" onClick={() => onPick(partyKey({ name: t }), t)}>לקוח בלי כרטיס בשם &quot;{t}&quot;</button></li>}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">לקוח עם כרטיס ב-CRM — לפי הכרטיס. בלי כרטיס — לפי ע.מ / ח.פ, ואם אין — לפי השם כפי שנכתב במסמכים. אפשר גם ללחוץ על לקוח בדוח &quot;לפי לקוח&quot;.</p>
    </Card>
  );
}
export function CustomerLedgerView({ period, subtitle, pick, onPick }: ViewProps & { pick: { key: string; name: string } | null; onPick: (p: { key: string; name: string } | null) => void }) {
  const r = useLoad(() => (pick ? loadCustomerLedger(pick.key, period) : Promise.resolve({ ok: false as const, error: '' })), [pick?.key, period.from, period.to]);
  if (!pick) return <CustomerPicker onPick={(key, name) => onPick({ key, name })} />;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-semibold">{r.data?.name || pick.name}</span>
        <button type="button" className="min-h-9 rounded-full border border-line px-3 text-xs font-semibold" onClick={() => onPick(null)}>לקוח אחר</button></div>
      {!r.data ? <Waiting r={r} /> : <>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-sm">
          <Card className="p-3"><span className="block text-xs text-muted">יתרת פתיחה</span><strong className="tabular-nums">{ils(r.data.opening)}</strong></Card>
          <Card className="p-3"><span className="block text-xs text-muted">חויב בתקופה</span><strong className="tabular-nums">{ils(r.data.debit)}</strong></Card>
          <Card className="p-3"><span className="block text-xs text-muted">שולם / זוכה</span><strong className="tabular-nums">{ils(r.data.credit)}</strong></Card>
          <Card className="p-3"><span className="block text-xs text-muted">יתרה לסוף התקופה</span><strong className={cx('tabular-nums', r.data.closing > 0 && 'text-amber-600')}>{ils(r.data.closing)}</strong></Card>
        </div>
        <TableCard table={customerLedgerTable(r.data)} period={period} subtitle={`${subtitle} · ${r.data.name || pick.name}`} />
      </>}
    </div>
  );
}

export function SuppliersView({ period, subtitle, openLedger }: ViewProps & { openLedger: (key: string, name: string) => void }) {
  const r = useLoad(() => loadSuppliers(period), [period.from, period.to]);
  if (!r.data) return <Waiting r={r} />;
  const d = r.data;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="grid grid-cols-3 gap-2 text-sm">
        <Card className="p-3"><span className="block text-xs text-muted">הוצאות בתקופה</span><strong className="tabular-nums">{ils(d.total.total)}</strong></Card>
        <Card className="p-3"><span className="block text-xs text-muted">שולם</span><strong className="tabular-nums">{ils(d.total.paid)}</strong></Card>
        <Card className="p-3"><span className="block text-xs text-muted">עוד לא שולם</span><strong className={cx('tabular-nums', d.total.open > 0 && 'text-amber-600')}>{ils(d.total.open)}</strong></Card>
      </div>
      <TableCard table={suppliersTable(d)} period={period} subtitle={subtitle}
        onRow={(i) => { if (d.suppliers[i].key !== MANUAL_KEY) openLedger(d.suppliers[i].key, d.suppliers[i].name); }} rowHint="לחיצה על ספק — הכרטסת שלו." />
      <TableCard table={categoriesTable(d)} period={period} subtitle={subtitle} />
    </div>
  );
}

/** a supplier to open the card of: the period's suppliers, or one by dealer number / name */
function SupplierPicker({ period, onPick }: { period: Period; onPick: (key: string, name: string) => void }) {
  const r = useLoad(() => loadSuppliers(period), [period.from, period.to]);
  const [q, setQ] = useState('');
  const t = q.trim();
  return (
    <Card className="p-4">
      <p className="mb-2 font-bold">כרטסת של איזה ספק?</p>
      {r.data && r.data.suppliers.length > 0 && (
        <Select defaultValue="" onChange={(e) => { const s = r.data!.suppliers.find((x) => x.key === e.target.value); if (s) onPick(s.key, s.name); }} aria-label="ספק מהתקופה">
          <option value="" disabled>ספק מהתקופה…</option>
          {r.data.suppliers.map((s) => <option key={s.key} value={s.key}>{s.name}{s.dealer ? ` · ${s.dealer}` : ''}</option>)}
        </Select>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="או: ע.מ ספק (9 ספרות) או שם הספק" aria-label="ספק לפי מספר או שם" className="max-w-sm" />
        <Button size="sm" variant="ghost" disabled={!t} onClick={() => onPick(/^\d{9}$/.test(t) ? `d:${t}` : partyKey({ name: t }), t)}>לכרטסת</Button>
      </div>
      <p className="mt-2 text-xs text-muted">ספק עם ע.מ — לפי המספר; בלי — לפי השם (אותיות וספרות בלבד, כמו בבדיקת הכפילויות של ההוצאות).</p>
    </Card>
  );
}
export function SupplierLedgerView({ period, subtitle, pick, onPick }: ViewProps & { pick: { key: string; name: string } | null; onPick: (p: { key: string; name: string } | null) => void }) {
  const r = useLoad(() => (pick ? loadSupplierLedger(pick.key, period) : Promise.resolve({ ok: false as const, error: '' })), [pick?.key, period.from, period.to]);
  if (!pick) return <SupplierPicker period={period} onPick={(key, name) => onPick({ key, name })} />;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-semibold">{r.data?.name || pick.name}</span>
        <button type="button" className="min-h-9 rounded-full border border-line px-3 text-xs font-semibold" onClick={() => onPick(null)}>ספק אחר</button></div>
      {!r.data ? <Waiting r={r} /> : <>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-sm">
          <Card className="p-3"><span className="block text-xs text-muted">יתרת פתיחה</span><strong className="tabular-nums">{ils(r.data.opening)}</strong></Card>
          <Card className="p-3"><span className="block text-xs text-muted">חשבוניות בתקופה</span><strong className="tabular-nums">{ils(r.data.credit)}</strong></Card>
          <Card className="p-3"><span className="block text-xs text-muted">שולם / זוכה</span><strong className="tabular-nums">{ils(r.data.debit)}</strong></Card>
          <Card className="p-3"><span className="block text-xs text-muted">לתשלום לספק</span><strong className={cx('tabular-nums', r.data.closing > 0 && 'text-amber-600')}>{ils(r.data.closing)}</strong></Card>
        </div>
        <TableCard table={supplierLedgerTable(r.data)} period={period} subtitle={`${subtitle} · ${r.data.name || pick.name}`} />
      </>}
    </div>
  );
}

export function WithholdingView({ period, subtitle, setPeriod }: ViewProps & { setPeriod: (p: Period) => void }) {
  const r = useLoad(() => loadWithholding(period), [period.from, period.to]);
  const year = periodNow('year');
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      {period.kind !== 'year' && (
        <Note>הדוח השנתי לפי לקוח — לשנה שלמה. <button type="button" className="font-semibold underline" onClick={() => setPeriod(year)}>להציג את {year.label}</button></Note>
      )}
      {!r.data ? <Waiting r={r} /> : <>
        <TableCard table={withholdingTable(r.data)} period={period} subtitle={subtitle} empty="לא נרשם ניכוי במקור בקבלות של התקופה." />
        {r.data.rows.length > 0 && <TableCard table={withholdingRowsTable(r.data)} period={period} subtitle={subtitle} />}
      </>}
      <p className="text-xs text-muted">ניכוי במקור נרשם בקבלה, כאמצעי תשלום (&quot;ניכוי במקור&quot;) — כשהלקוח שילם פחות כי ניכה מס. הוא סוגר את החשבונית, אבל הוא לא כסף שנכנס: הוא לא בסכומי הקופה והבנק.</p>
    </div>
  );
}

export function AdvancesView({ period, subtitle }: ViewProps) {
  const { profile, vat, go } = useFinance();
  const r = useLoad(() => loadSummary(period).then((x): Res<Summary> => (x.ok ? { ok: true, data: x.s } : x)), [period.from, period.to]);
  if (profile.advancePct == null) {
    return <Note>לא נקבע שיעור מקדמה. את השיעור (מפנקס המקדמות של מס הכנסה) רושמים ב<button type="button" className="font-semibold underline" onClick={() => go('settings')}>הגדרות הכספים</button>, ואז רואים כאן הערכה לכל תקופה.</Note>;
  }
  if (!r.data) return <Waiting r={r} />;
  const e = advanceEstimate(r.data.revenue.net, profile.advancePct)!;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <Card className="p-4">
        <p className="mb-1 text-xs font-bold text-amber-700 dark:text-amber-300">הערכה בלבד</p>
        <p className="text-sm">מקדמה משוערת לתקופה: <strong className="text-lg tabular-nums">{ils(e.amount)}</strong></p>
        <p className="text-xs text-muted">{ils(e.base)} {vat ? 'הכנסות לפני מע״מ' : 'הכנסות (קבלות)'} × {e.pct}%</p>
        <p className="mt-2 text-xs text-muted">{ADVANCE_NOTE}</p>
      </Card>
      <TableCard table={advanceTable(e, r.data.withheld, vat)} period={period} subtitle={subtitle} />
    </div>
  );
}

/** profit and loss of the period against the same dates a year before — month by month when it spans more than one */
export function PnlCompare({ s, period, subtitle }: { s: Summary; period: Period; subtitle: string }) {
  const before = yearBefore(period);
  const r = useLoad(() => loadSummary(before).then((x): Res<Summary> => (x.ok ? { ok: true, data: x.s } : x)), [before.from, before.to]);
  const labelBefore = period.kind !== 'custom' ? periodOf(period.kind, before.from).label : `${ddmmyyyy(before.from)}–${ddmmyyyy(before.to)}`;
  if (!r.data) return r.error ? <LoadFailed message={r.error} onRetry={r.retry} /> : <Card className="p-4"><div className="py-3 text-center"><Spinner /></div></Card>;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <TableCard table={pnlTable(s, r.data, { now: period.label || 'התקופה', before: labelBefore })} period={period} subtitle={subtitle} />
      {s.months.length > 1 && <TableCard table={monthsTable(s.months, r.data.months)} period={period} subtitle={subtitle} />}
    </div>
  );
}
