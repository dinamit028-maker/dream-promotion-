'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Button, Card, PageHead } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { authHeaders } from '@/lib/services/http';
import { useAtt } from './AttendanceLayout';
import { attError, loadAbsences, loadEntries, loadMonthRows, trackFor, type Absence, type Entry, type MonthState } from './api';
import { hm, monthReport, pctColumns, shiftMonth } from './hours-engine';
import { REC, fileName, monthLabel, monthSheet, payrollCsv, payrollPdfBody, summarySheet, xlsx, type ExportEmployee } from './exports';
import { seesPrivate, type WorkTrack } from './people';
import { employeeMonthHref } from './routes';
import { MonthSwitch, Notice, saveFile, thisMonth, XLSX_TYPE } from './ui';

/**
 * דוחות וייצוא (2.107): the month of every employee — the same monthly reports as each employee's screen (a closed month: by the
 * track it was closed with) — as a table of hours; the payroll report as a PDF (number, days, total, standard, over it, days of
 * rest, absences, missing days); Excel and a payroll CSV only when the business allows files other than PDF (the owner of the
 * system, 23.10.2026: hours change only through the documented correction). The split by rates — a recommendation, marked so.
 */
export function Reports() {
  const att = useAtt();
  const { setup, role } = att;
  const [month, setMonth] = useState(shiftMonth(thisMonth(), -1));
  const [data, setData] = useState<{ entries: Entry[]; absences: Absence[]; months: Map<string, { status: MonthState; snapshot: WorkTrack | null }> } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setData(null);
    Promise.all([loadEntries(month), loadAbsences({ month }), loadMonthRows(month)])
      .then(([entries, absences, months]) => { setData({ entries, absences, months }); setErr(null); }, (e) => setErr(attError(e)));
  }, [month]);
  const tracks = useMemo(() => new Map(setup.tracks.map((t) => [t.id, t])), [setup.tracks]);
  const dept = useMemo(() => new Map(setup.departments.map((d) => [d.id, d.name])), [setup.departments]);
  const list = useMemo(() => (data ? setup.employees
    .filter((e) => e.active || data.entries.some((x) => x.employeeId === e.id))
    .map((e) => ({
      employee: { id: e.id, name: e.name, code: e.code, department: dept.get(e.departmentId ?? '') ?? '', title: e.title,
        idNumber: seesPrivate(role) ? setup.privates.get(e.id)?.idNumber ?? '' : '' } as ExportEmployee,
      report: monthReport({ month, entries: data.entries.filter((x) => x.employeeId === e.id), absences: data.absences.filter((a) => a.employeeId === e.id),
        track: trackFor(e.trackId ? tracks.get(e.trackId) : null, data.months.get(e.id)), startDate: e.startDate, endDate: e.endDate }),
    })) : []), [data, setup, month, tracks, dept, role]);
  const cols = useMemo(() => pctColumns(list.map((x) => x.report)), [list]);

  async function excel() {
    const sheets = [{ name: 'סיכום', rows: summarySheet(list, month) }, ...list.map((x) => ({ name: x.employee.name, rows: monthSheet(x.report, x.employee) }))];
    saveFile(await xlsx(sheets) as BlobPart, fileName('נוכחות', month, 'xlsx'), XLSX_TYPE);
  }
  function payrollFile() {
    saveFile(payrollCsv(list), fileName('שכר', month, 'csv'), 'text/csv;charset=utf-8');
  }
  async function payrollPdf() {
    const body = payrollPdfBody(list, month, att.businessName);
    setBusy(true);
    try {
      const r = await fetch('/api/attendance/report-pdf', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || 'pdf');
      saveFile(await r.blob(), fileName('דוח-שכר', month, 'pdf'), 'application/pdf');
    } catch (e: any) { setErr(e?.message && e.message !== 'pdf' ? e.message : 'ה-PDF לא נוצר. נסו שוב.'); } finally { setBusy(false); }
  }
  const open = list.reduce((a, x) => a + x.report.totals.openShifts, 0);
  const payrollAllowed = seesPrivate(role);

  return (
    <>
      <PageHead title="דוחות וייצוא" sub={monthLabel(month)} action={(
        <div className="flex flex-wrap gap-2">
          {payrollAllowed && <Button variant="primary" disabled={!data || busy} onClick={() => void payrollPdf()}>דוח שעות לשכר (PDF)</Button>}
          {!att.pdfOnly && <Button variant="ghost" disabled={!data} onClick={() => void excel()}>ייצוא לאקסל</Button>}
          {!att.pdfOnly && payrollAllowed && <Button variant="ghost" disabled={!data} onClick={payrollFile}>קובץ לתוכנת שכר (CSV)</Button>}
        </div>
      )} />
      <div className="mb-4"><MonthSwitch month={month} onChange={setMonth} /></div>
      {err && <Notice tone="warn">{err}</Notice>}
      <Notice>המערכת מחשבת שעות. העמודות באחוזים — המלצה בלבד לפי הגדרות המסלול; מה משולם — רואה החשבון והמעסיק מחליטים.</Notice>
      {att.pdfOnly && <Notice>השעות יוצאות מהמערכת ב-PDF בלבד — שינוי שעות רק דרך תיקון מתועד במערכת.</Notice>}
      {!payrollAllowed && <Notice>דוח השכר — רק למנהל הנוכחות ולרואה החשבון.</Notice>}
      {open > 0 && <Notice tone="bad">{open} משמרות בלי יציאה בחודש הזה — לא נספרות בשעות עד שנסגרות.</Notice>}
      {!data ? <div className="flex justify-center py-16"><Spinner /></div> : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[1000px] text-sm">
            <thead><tr className="border-b border-line text-muted">
              {['מספר', 'שם', 'מחלקה', 'ימי עבודה', 'שעות', 'תקן', 'מעבר לתקן', 'מנוחה וחג', 'חסרים', 'בלי יציאה'].map((h) => <th key={h} className="p-2 text-start font-semibold">{h}</th>)}
              {cols.map((p) => <th key={p} className="p-2 text-start text-xs font-semibold">{p}% <span className="font-normal">({REC})</span></th>)}
            </tr></thead>
            <tbody>
              {list.map(({ employee: e, report }) => {
                const t = report.totals;
                return (
                  <tr key={e.id} className="border-b border-line last:border-0">
                    <td className="p-2 tabular-nums">{e.code}</td>
                    <td className="p-2"><Link href={employeeMonthHref(e.id, month)} className="font-semibold text-module hover:underline">{e.name}</Link></td>
                    <td className="p-2">{e.department}</td>
                    <td className="p-2 tabular-nums">{t.workDays}</td>
                    <td className="p-2 font-semibold tabular-nums">{hm(t.paid)}</td>
                    <td className="p-2 tabular-nums">{hm(t.standard)}</td>
                    <td className="p-2 tabular-nums">{hm(t.overMinutes)}</td>
                    <td className="p-2 tabular-nums">{hm(t.restMinutes)}</td>
                    <td className={cx('p-2 tabular-nums', t.missingDays > 0 && 'font-bold text-danger')}>{t.missingDays}</td>
                    <td className={cx('p-2 tabular-nums', t.openShifts > 0 && 'font-bold text-danger')}>{t.openShifts}</td>
                    {cols.map((p) => <td key={p} className="p-2 tabular-nums text-muted">{hm(t.pct[p] ?? 0)}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
