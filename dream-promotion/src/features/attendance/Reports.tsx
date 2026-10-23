'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Button, Card, PageHead } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { useAtt } from './AttendanceLayout';
import { attError, loadAbsences, loadEntries, type Absence, type Entry } from './api';
import { hm, monthReport, shiftMonth } from './hours-engine';
import { DRAFT_NOTE, fileName, monthLabel, monthSheet, payrollCsv, summarySheet, xlsx, type ExportEmployee } from './exports';
import { OVERTIME_CONFIRMED, PCT_COLUMNS } from './overtime-rules';
import { seesPrivate } from './people';
import { attendanceHref, employeeMonthHref } from './routes';
import { MonthSwitch, Notice, saveFile, thisMonth, XLSX_TYPE } from './ui';

/**
 * דוחות וייצוא (2.107): the month of every employee — the same monthly reports as each employee's screen — as a table, as Excel
 * (a summary sheet and a sheet per employee), and the payroll file (CSV: employee number, days, regular hours, 125%, 150%, …,
 * absences by kind). The payroll file is produced only after the overtime rules are confirmed (overtime-rules.ts).
 */
export function Reports() {
  const att = useAtt();
  const { setup, role } = att;
  const [month, setMonth] = useState(shiftMonth(thisMonth(), -1));
  const [data, setData] = useState<{ entries: Entry[]; absences: Absence[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    Promise.all([loadEntries(month), loadAbsences({ month })]).then(([entries, absences]) => { setData({ entries, absences }); setErr(null); }, (e) => setErr(attError(e)));
  }, [month]);
  const tracks = useMemo(() => new Map(setup.tracks.map((t) => [t.id, t])), [setup.tracks]);
  const dept = useMemo(() => new Map(setup.departments.map((d) => [d.id, d.name])), [setup.departments]);
  const list = useMemo(() => (data ? setup.employees
    .filter((e) => e.active || data.entries.some((x) => x.employeeId === e.id))
    .map((e) => ({
      employee: { id: e.id, name: e.name, code: e.code, department: dept.get(e.departmentId ?? '') ?? '', title: e.title,
        idNumber: seesPrivate(role) ? setup.privates.get(e.id)?.idNumber ?? '' : '' } as ExportEmployee,
      report: monthReport({ month, entries: data.entries.filter((x) => x.employeeId === e.id), absences: data.absences.filter((a) => a.employeeId === e.id),
        track: e.trackId ? tracks.get(e.trackId) : null, startDate: e.startDate, endDate: e.endDate }),
    })) : []), [data, setup, month, tracks, dept, role]);

  async function excel() {
    const sheets = [{ name: 'סיכום', rows: summarySheet(list, month) }, ...list.map((x) => ({ name: x.employee.name, rows: monthSheet(x.report, x.employee) }))];
    saveFile(await xlsx(sheets) as BlobPart, fileName('נוכחות', month, 'xlsx'), XLSX_TYPE);
  }
  function payroll() {
    const csv = payrollCsv(list);
    if (csv) saveFile(csv, fileName('שכר', month, 'csv'), 'text/csv;charset=utf-8');
  }
  const open = list.reduce((a, x) => a + x.report.totals.openShifts, 0);

  return (
    <>
      <PageHead title="דוחות וייצוא" sub={monthLabel(month)} action={(
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={!data} onClick={() => void excel()}>ייצוא לאקסל</Button>
          <Button variant="ghost" disabled={!data || !OVERTIME_CONFIRMED || !seesPrivate(role)} onClick={payroll}>קובץ לתוכנת שכר (CSV)</Button>
        </div>
      )} />
      <div className="mb-4"><MonthSwitch month={month} onChange={setMonth} /></div>
      {err && <Notice tone="warn">{err}</Notice>}
      {!OVERTIME_CONFIRMED && <Notice tone="warn">{DRAFT_NOTE} לכן הקובץ לתוכנת השכר עוד לא יוצא. <Link href={attendanceHref('settings')} className="font-semibold underline">הכללים</Link></Notice>}
      {OVERTIME_CONFIRMED && !seesPrivate(role) && <Notice>הקובץ לתוכנת השכר — רק למנהל הנוכחות ולרואה החשבון.</Notice>}
      {open > 0 && <Notice tone="bad">{open} משמרות בלי יציאה בחודש הזה — לא נספרות בשעות עד שנסגרות.</Notice>}
      {!data ? <div className="flex justify-center py-16"><Spinner /></div> : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[900px] text-sm">
            <thead><tr className="border-b border-line text-muted">
              {['מספר', 'שם', 'מחלקה', 'ימי עבודה', 'שעות', 'תקן', ...PCT_COLUMNS.map((p) => (p === 100 ? 'רגילות' : `${p}%`)), 'חסרים', 'בלי יציאה'].map((h) => <th key={h} className="p-2 text-start font-semibold">{h}</th>)}
            </tr></thead>
            <tbody>
              {list.map(({ employee: e, report: { totals: t } }) => (
                <tr key={e.id} className="border-b border-line last:border-0">
                  <td className="p-2 tabular-nums">{e.code}</td>
                  <td className="p-2"><Link href={employeeMonthHref(e.id, month)} className="font-semibold text-module hover:underline">{e.name}</Link></td>
                  <td className="p-2">{e.department}</td>
                  <td className="p-2 tabular-nums">{t.workDays}</td>
                  <td className="p-2 font-semibold tabular-nums">{hm(t.paid)}</td>
                  <td className="p-2 tabular-nums">{hm(t.standard)}</td>
                  {PCT_COLUMNS.map((p) => <td key={p} className={cx('p-2 tabular-nums', p !== 100 && !OVERTIME_CONFIRMED && 'text-muted')}>{hm(t.pct[p] ?? 0)}</td>)}
                  <td className={cx('p-2 tabular-nums', t.missingDays > 0 && 'font-bold text-danger')}>{t.missingDays}</td>
                  <td className={cx('p-2 tabular-nums', t.openShifts > 0 && 'font-bold text-danger')}>{t.openShifts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
