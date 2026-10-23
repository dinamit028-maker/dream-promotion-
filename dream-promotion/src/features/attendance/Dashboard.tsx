'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, Card, Chip, PageHead } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { useAtt } from './AttendanceLayout';
import { attError, loadAbsences, loadEntries, loadRequests, type Absence, type Entry } from './api';
import { dailyStatus, monthlyStatus, type DailyKey } from './dashboard';
import { hm, monthReport, shiftMonth, type MonthReport } from './hours-engine';
import { monthLabel } from './exports';
import { canManage, type Employee } from './people';
import { attendanceHref, employeeMonthHref } from './routes';
import { ShiftDialog, thisMonth, today } from './ui';

/**
 * לוח הבקרה (2.107) — the reference's daily status (reported in full / not reported / absences / late) with the list of people,
 * and the monthly status (this month / the one before): the share of missing days, the hours, active / inactive employees.
 * Every number from the same monthly reports as the employee's report (hours-engine.ts, dashboard.ts).
 */
export function Dashboard() {
  const { setup, role } = useAtt();
  const params = useSearchParams();
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState<{ entries: Entry[]; absences: Absence[]; pending: number; prev: { entries: Entry[]; absences: Absence[] } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState(params.get('report') === '1');
  const [show, setShow] = useState<DailyKey | null>(null);

  const load = useCallback(async () => {
    try {
      const prevMonth = shiftMonth(thisMonth(), -1);
      const [entries, absences, requests, pe, pa] = await Promise.all([
        loadEntries(thisMonth()), loadAbsences({ month: thisMonth() }), canManage(role) ? loadRequests() : Promise.resolve([]),
        loadEntries(prevMonth), loadAbsences({ month: prevMonth }),
      ]);
      const pendingAbs = canManage(role) ? (await loadAbsences({ status: 'pending' })).length : 0;
      setData({ entries, absences, pending: requests.length + pendingAbs, prev: { entries: pe, absences: pa } });
      setError(null);
    } catch (e) { setError(attError(e)); }
  }, [role]);
  useEffect(() => { void load(); }, [load]);

  const tracks = useMemo(() => new Map(setup.tracks.map((t) => [t.id, t])), [setup.tracks]);
  const reports = useCallback((m: string, entries: Entry[], absences: Absence[]) => setup.employees.map((e) => ({
    employee: e,
    report: monthReport({ month: m, entries: entries.filter((x) => x.employeeId === e.id), absences: absences.filter((a) => a.employeeId === e.id),
      track: e.trackId ? tracks.get(e.trackId) : null, startDate: e.startDate, endDate: e.endDate }),
  })), [setup.employees, tracks]);
  const now = useMemo(() => (data ? reports(thisMonth(), data.entries, data.absences) : []), [data, reports]);
  const prev = useMemo(() => (data ? reports(shiftMonth(thisMonth(), -1), data.prev.entries, data.prev.absences) : []), [data, reports]);
  const daily = useMemo(() => dailyStatus(now, today()), [now]);
  const monthly = useMemo(() => monthlyStatus(month === thisMonth() ? now : prev, month === thisMonth() ? today() : '9999-12-31'), [month, now, prev]);

  const tiles: { key: DailyKey; label: string; tone: string }[] = [
    { key: 'working', label: 'בעבודה עכשיו', tone: 'text-ok' },
    { key: 'reported', label: 'דיווח מלא', tone: 'text-ok' },
    { key: 'notReported', label: 'לא דיווחו', tone: 'text-danger' },
    { key: 'absent', label: 'היעדרויות', tone: 'text-ink' },
    { key: 'late', label: 'איחור בכניסה', tone: 'text-warn' },
    { key: 'openOld', label: 'שכחו לצאת', tone: 'text-danger' },
  ];

  return (
    <>
      <PageHead title="לוח בקרה" sub={`${setup.employees.filter((e) => e.active).length} עובדים פעילים`}
        action={canManage(role) && (
          <div className="flex flex-wrap gap-2">
            {role === 'admin' && <Link href={attendanceHref('employees', { new: '1' })}><Button variant="primary">הוספת עובד/ת</Button></Link>}
            <Button variant="ghost" onClick={() => setReport(true)}>דיווח שעות</Button>
          </div>
        )} />
      {error && <p role="alert" className="mb-4 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p>}
      {!data ? <div className="flex justify-center py-16"><Spinner /></div> : (
        <>
          {data.pending > 0 && (
            <Link href={attendanceHref('approvals')} className="mb-4 block rounded-2xl bg-module-soft px-4 py-3 text-sm font-semibold">
              {data.pending} בקשות והיעדרויות ממתינות לאישור ←
            </Link>
          )}
          <h3 className="mb-2 font-display text-lg font-bold">סטטוס יומי</h3>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {tiles.map((t) => (
              <button key={t.key} type="button" onClick={() => setShow(show === t.key ? null : t.key)} aria-expanded={show === t.key}
                className={cx('rounded-lg border bg-(--glass) p-4 text-start shadow-sm', show === t.key ? 'border-module' : 'border-line')}>
                <span className={cx('block font-display text-3xl font-extrabold', t.tone)}>{daily[t.key].length}</span>
                <span className="text-sm font-semibold text-ink-2">{t.label}</span>
              </button>
            ))}
          </div>
          {show && (
            <Card className="mb-6 p-3">
              {daily[show].length ? (
                <ul className="divide-y divide-line">
                  {daily[show].map((e: Employee) => (
                    <li key={e.id}><Link href={employeeMonthHref(e.id)} className="flex min-h-11 items-center justify-between gap-2 px-2 font-semibold">
                      <span>{e.name}</span><span className="text-xs text-muted">{e.code}</span></Link></li>
                  ))}
                </ul>
              ) : <p className="p-2 text-sm text-muted">אין.</p>}
            </Card>
          )}

          <div className="mb-2 mt-6 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-lg font-bold">סטטוס חודשי — {monthLabel(month)}</h3>
            <div className="flex gap-1.5">
              <Chip on={month === thisMonth()} onClick={() => setMonth(thisMonth())} className="min-h-10">חודש נוכחי</Chip>
              <Chip on={month !== thisMonth()} onClick={() => setMonth(shiftMonth(thisMonth(), -1))} className="min-h-10">חודש קודם</Chip>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Stat label="אחוז חוסרים" value={`${monthly.missingPct}%`} sub={`${monthly.missingDays} מתוך ${monthly.expectedDays} ימי עבודה`} tone={monthly.missingPct > 0 ? 'text-danger' : 'text-ok'} />
            <Stat label="סה״כ שעות בחודש" value={hm(monthly.paid)} sub={monthly.openShifts ? `${monthly.openShifts} יציאות חסרות` : 'בלי יציאות חסרות'} />
            <Stat label="עובדים פעילים" value={String(monthly.active)} />
            <Stat label="עובדים לא פעילים" value={String(monthly.inactive)} />
          </div>
          <MonthTable list={month === thisMonth() ? now : prev} month={month} />
        </>
      )}
      <ShiftDialog open={report} onClose={() => setReport(false)} employees={setup.employees} onSaved={() => void load()} />
    </>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card className="p-4">
      <span className={cx('block font-display text-2xl font-extrabold', tone)}>{value}</span>
      <span className="block text-sm font-semibold text-ink-2">{label}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </Card>
  );
}

/** the month of every active employee: hours, missing days, missing clock-outs — each opens the employee's report */
function MonthTable({ list, month }: { list: { employee: Employee; report: MonthReport }[]; month: string }) {
  const rows = list.filter((x) => x.employee.active);
  if (!rows.length) return null;
  return (
    <Card className="mt-3 overflow-x-auto p-0">
      <table className="w-full min-w-[480px] text-sm">
        <thead><tr className="border-b border-line text-start text-muted">
          <th className="p-3 text-start">עובד/ת</th><th className="p-3 text-start">שעות</th><th className="p-3 text-start">ימי עבודה</th><th className="p-3 text-start">חסרים</th><th className="p-3 text-start">יציאות חסרות</th>
        </tr></thead>
        <tbody>
          {rows.map(({ employee: e, report: { totals: t } }) => (
            <tr key={e.id} className="border-b border-line last:border-0">
              <td className="p-3"><Link href={employeeMonthHref(e.id, month)} className="font-semibold text-module underline-offset-2 hover:underline">{e.name}</Link></td>
              <td className="p-3 tabular-nums">{hm(t.paid)}</td>
              <td className="p-3 tabular-nums">{t.workDays}</td>
              <td className={cx('p-3 tabular-nums', t.missingDays > 0 && 'font-bold text-danger')}>{t.missingDays}</td>
              <td className={cx('p-3 tabular-nums', t.openShifts > 0 && 'font-bold text-danger')}>{t.openShifts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
