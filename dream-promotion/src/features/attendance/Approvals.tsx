'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, PageHead, Pill } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { formatIL } from '@/lib/il-time';
import { useAtt } from './AttendanceLayout';
import { absenceDecide, absenceFileUrl, attError, loadAbsences, loadMonths, loadRequests, monthMark, requestDecide, type Absence, type MonthState, type TimeRequest } from './api';
import { ABSENCE_LABEL, hm, shiftMonth } from './hours-engine';
import { monthLabel } from './exports';
import { canManage, isAdmin } from './people';
import { employeeMonthHref } from './routes';
import { MonthSwitch, Notice, ReasonModal, thisMonth } from './ui';

/**
 * אישור דיווחים (2.107): the employees' requests to complete a report and their absences, waiting for a manager; and the month —
 * approved by an approver (or the admin), closed by the admin (refused with an open shift or anything waiting), reopened with a
 * reason. An approver sees only their people (row-level security).
 */
const KIND_LABEL: Record<TimeRequest['kind'], string> = { missing_in: 'כניסה חסרה', missing_out: 'יציאה חסרה', shift: 'משמרת שלא דווחה', fix: 'תיקון שעות' };
const STATE: Record<MonthState, string> = { open: 'פתוח', approved: 'אושר', closed: 'נסגר' };
const t = (iso: string | null) => (iso ? formatIL(iso, { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const dmy = (d: string) => d.split('-').reverse().join('/');

export function Approvals() {
  const att = useAtt();
  const { setup, role } = att;
  const [requests, setRequests] = useState<TimeRequest[] | null>(null);
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [month, setMonth] = useState(shiftMonth(thisMonth(), -1));
  const [months, setMonths] = useState<Map<string, MonthState>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reject, setReject] = useState<{ kind: 'request' | 'absence'; id: string } | null>(null);
  const [report, setReport] = useState<string[]>([]);
  const name = (id: string) => setup.employees.find((e) => e.id === id)?.name ?? '';

  const load = useCallback(async () => {
    try {
      const [r, a, m] = await Promise.all([loadRequests(), loadAbsences({ status: 'pending' }), loadMonths(month)]);
      setRequests(r); setAbsences(a); setMonths(m); setErr(null);
    } catch (e) { setErr(attError(e)); }
  }, [month]);
  useEffect(() => { void load(); }, [load]);
  async function run(fn: () => Promise<unknown>, msg: string) {
    setBusy(true); setErr(null);
    try { await fn(); att.say(msg); await load(); } catch (e) { setErr(attError(e)); } finally { setBusy(false); }
  }
  /** close the month of everyone it can be closed for; say who could not, and why */
  async function closeAll() {
    if (!window.confirm(`לסגור את ${monthLabel(month)} לכל העובדים? אחרי הסגירה החודש נעול.`)) return;
    setBusy(true); setReport([]);
    const out: string[] = [];
    let n = 0;
    for (const e of setup.employees.filter((x) => x.active || x.endDate == null || x.endDate >= `${month}-01`)) {
      if (months.get(e.id) === 'closed') continue;
      try { await monthMark(e.id, month, 'closed'); n += 1; } catch (x) { out.push(`${e.name}: ${attError(x)}`); }
    }
    setReport(out); att.say(`נסגרו ${n} חודשים`); setBusy(false); await load();
  }
  const manage = canManage(role);
  const ended = month < thisMonth();

  return (
    <>
      <PageHead title="אישור דיווחים" sub="בקשות השלמה, היעדרויות ואישור וסגירת חודש" />
      {err && <Notice tone="warn">{err}</Notice>}
      {!requests ? <div className="flex justify-center py-16"><Spinner /></div> : (
        <div className="grid gap-4">
          <Card className="p-4">
            <h3 className="mb-3 font-bold">בקשות השלמת דיווח ({requests.length})</h3>
            {!requests.length ? <p className="text-sm text-muted">אין בקשות שממתינות.</p> : (
              <ul className="divide-y divide-line">
                {requests.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <div className="text-sm">
                      <Link href={employeeMonthHref(r.employeeId)} className="font-bold text-module">{name(r.employeeId)}</Link> · {KIND_LABEL[r.kind]}
                      <span className="block tabular-nums">{r.clockIn ? t(r.clockIn) : ''}{r.clockOut ? ` ← ${t(r.clockOut)}` : ''}</span>
                      {r.note && <span className="block text-muted">״{r.note}״</span>}
                    </div>
                    {manage && <div className="flex gap-1">
                      <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => requestDecide(r.id, true, ''), 'הבקשה אושרה ונרשמה')}>אישור</Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReject({ kind: 'request', id: r.id })}>דחייה</Button>
                    </div>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <h3 className="mb-3 font-bold">היעדרויות שממתינות ({absences.length})</h3>
            {!absences.length ? <p className="text-sm text-muted">אין היעדרויות שממתינות.</p> : (
              <ul className="divide-y divide-line">
                {absences.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                    <div>
                      <strong>{name(a.employeeId)}</strong> · {ABSENCE_LABEL[a.kind]} · {dmy(a.from)}{a.to !== a.from ? `–${dmy(a.to)}` : ''}{a.minutes ? ` · ${hm(a.minutes)}` : ''}
                      {a.note && <span className="block text-muted">״{a.note}״</span>}
                      {a.filePath && <button type="button" className="text-module underline" onClick={async () => { const w = window.open('', '_blank'); const u = await absenceFileUrl(a.filePath); if (w && u) w.location.href = u; else w?.close(); }}>האישור המצורף</button>}
                    </div>
                    {manage && <div className="flex gap-1">
                      <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => absenceDecide(a.id, 'approved', ''), 'ההיעדרות אושרה')}>אישור</Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReject({ kind: 'absence', id: a.id })}>דחייה</Button>
                    </div>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-bold">אישור וסגירת חודש</h3>
              {isAdmin(role) && ended && <Button variant="primary" disabled={busy} onClick={() => void closeAll()}>סגירת החודש לכולם</Button>}
            </div>
            <div className="mb-3"><MonthSwitch month={month} onChange={setMonth} /></div>
            {!ended && <Notice>סוגרים חודש רק אחרי שהוא נגמר. אפשר לאשר אותו כבר עכשיו.</Notice>}
            {report.length > 0 && <Notice tone="warn"><strong>לא נסגרו:</strong><ul className="mt-1">{report.map((x) => <li key={x}>{x}</li>)}</ul></Notice>}
            <ul className="divide-y divide-line">
              {setup.employees.filter((e) => e.active || months.has(e.id)).map((e) => {
                const s = months.get(e.id) ?? 'open';
                return (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link href={employeeMonthHref(e.id, month)} className="font-semibold text-module">{e.name}</Link>
                    <div className="flex items-center gap-1">
                      <Pill tone={s === 'closed' ? 'default' : s === 'approved' ? 'ok' : 'ai'}>{STATE[s]}</Pill>
                      {manage && s === 'open' && <Button size="sm" variant="soft" disabled={busy} onClick={() => void run(() => monthMark(e.id, month, 'approved'), `החודש של ${e.name} אושר`)}>אישור</Button>}
                      {isAdmin(role) && s !== 'closed' && ended && <Button size="sm" variant="soft" disabled={busy} onClick={() => void run(() => monthMark(e.id, month, 'closed'), `החודש של ${e.name} נסגר`)}>סגירה</Button>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      )}
      <ReasonModal open={Boolean(reject)} title="דחייה" action="דחייה" onClose={() => setReject(null)} body="הסיבה נשמרת, ותוצג לעובד/ת."
        onDone={(why) => (reject!.kind === 'request' ? requestDecide(reject!.id, false, why) : absenceDecide(reject!.id, 'rejected', why)).then(() => { att.say('נדחה'); return load(); })} />
    </>
  );
}
