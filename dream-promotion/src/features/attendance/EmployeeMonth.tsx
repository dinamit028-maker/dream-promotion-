'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, Field, Input, PageHead, Pill } from '@/components/ui/primitives';
import { Modal, Spinner } from '@/components/ui/feedback';
import { ClockCounterClockwise, MapPin } from '@/components/ui/Icon';
import { cx } from '@/lib/utils';
import { formatIL, israelParts } from '@/lib/il-time';
import { authHeaders } from '@/lib/services/http';
import { useAtt } from './AttendanceLayout';
import {
  attError, entryClose, entryFix, entryVoid, loadAbsences, loadEntries, loadHistory, loadMonthHistory, loadMonths, monthMark, shiftMoments,
  type Absence, type Entry, type HistoryLine, type MonthState,
} from './api';
import {
  ABSENCE_LABEL, DAY_NAMES, DAY_TYPE_LABEL, METHOD_LABEL, STATUS_LABEL, addDay, hm, monthReport, type DayRow, type ShiftRow,
} from './hours-engine';
import { DRAFT_NOTE, fileName, monthLabel, monthPdfBody, monthSheet, xlsx } from './exports';
import { OVERTIME_CONFIRMED, PCT_COLUMNS } from './overtime-rules';
import { canManage, isAdmin, trackSummary } from './people';
import { attendanceHref } from './routes';
import { MonthSwitch, Notice, ReasonModal, ShiftDialog, saveFile, thisMonth, XLSX_TYPE } from './ui';

/**
 * דוח שעות חודשי לעובד (2.107) — the reference's most important screen: a row for every day of the month (days without a report
 * too), the Hebrew day kind, the standard and its running total, in and out (how, and where — only the moment of each), the day's
 * total and the running total, the status; a missing clock-in / clock-out in red. A manager completes a report, corrects a shift
 * (the old one stays, voided — "היסטוריה"), closes a forgotten clock-out, voids an entry, approves and closes the month. Excel, PDF.
 * Every number is the hours engine's (hours-engine.ts) — the same as the dashboard and the payroll file.
 */
const STATE_LABEL: Record<MonthState, string> = { open: 'פתוח', approved: 'אושר', closed: 'נסגר' };
const mapUrl = (p: { lat: number; lng: number }) => `https://www.google.com/maps?q=${p.lat},${p.lng}`;
const EVENT_LABEL: Record<string, string> = { created: 'נרשם', replacement: 'רישום מתקן', clock_out: 'יציאה', voided: 'בוטל' };
const CHANNEL_LABEL: Record<string, string> = { clock: 'השעון של העובד/ת', app: 'מנהל/ת', server: 'המערכת' };

export function EmployeeMonth({ id }: { id: string }) {
  const att = useAtt();
  const { setup, role } = att;
  const params = useSearchParams();
  const router = useRouter();
  const month = params.get('month') && /^\d{4}-\d{2}$/.test(params.get('month')!) ? params.get('month')! : thisMonth();
  const setMonth = (m: string) => router.replace(`/attendance/employees/${encodeURIComponent(id)}?month=${m}`);
  const emp = setup.employees.find((e) => e.id === id) ?? null;
  const track = emp?.trackId ? setup.tracks.find((t) => t.id === emp.trackId) ?? null : null;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [state, setState] = useState<MonthState>('open');
  const [monthLog, setMonthLog] = useState<{ at: string; kind: string; reason: string; actorName: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'add'; date: string } | { kind: 'fix' | 'close' | 'void'; shift: ShiftRow; date: string } | { kind: 'history'; day: DayRow } | { kind: 'reopen' }>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [e, a, m, log] = await Promise.all([loadEntries(month, id), loadAbsences({ month, employeeId: id }), loadMonths(month), loadMonthHistory(id, month)]);
      setEntries(e); setAbsences(a); setState(m.get(id) ?? 'open'); setMonthLog(log); setError(null);
    } catch (e) { setError(attError(e)); }
  }, [id, month]);
  useEffect(() => { setEntries(null); void load(); }, [load]);

  const report = useMemo(() => (entries ? monthReport({ month, entries, absences, track, startDate: emp?.startDate, endDate: emp?.endDate }) : null),
    [entries, absences, month, track, emp?.startDate, emp?.endDate]);
  const manage = canManage(role) && state !== 'closed';
  const ended = month < thisMonth();
  const exportEmployee = emp ? { id: emp.id, name: emp.name, code: emp.code, department: setup.departments.find((d) => d.id === emp.departmentId)?.name ?? '', title: emp.title } : null;

  async function run(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try { await fn(); att.say(msg); await load(); } catch (e) { setError(attError(e)); } finally { setBusy(false); }
  }
  async function excel() {
    if (!report || !exportEmployee) return;
    saveFile(await xlsx([{ name: monthLabel(month), rows: monthSheet(report, exportEmployee) }]) as BlobPart, fileName(`נוכחות-${exportEmployee.name}`, month, 'xlsx'), XLSX_TYPE);
  }
  async function pdf() {
    if (!report || !exportEmployee) return;
    setBusy(true);
    try {
      const r = await fetch('/api/attendance/report-pdf', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify(monthPdfBody(report, exportEmployee, att.businessName)) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || 'pdf');
      saveFile(await r.blob(), fileName(`נוכחות-${exportEmployee.name}`, month, 'pdf'), 'application/pdf');
    } catch (e: any) { setError(e?.message && !/^pdf$/.test(e.message) ? e.message : 'ה-PDF לא נוצר. נסו שוב.'); } finally { setBusy(false); }
  }

  if (!emp) return <Notice tone="warn">העובד/ת לא נמצא/ה (או שאין לך גישה). <Link href={attendanceHref('employees')} className="underline">לרשימת העובדים</Link></Notice>;
  return (
    <>
      <PageHead title={emp.name} sub={[emp.code && `מספר עובד ${emp.code}`, setup.departments.find((d) => d.id === emp.departmentId)?.name, emp.title,
        track ? `${track.name} (${trackSummary(track)})` : 'בלי מסלול שעות תקן', !emp.active && 'לא פעיל/ה'].filter(Boolean).join(' · ')}
        action={<Pill tone={state === 'closed' ? 'default' : state === 'approved' ? 'ok' : 'ai'}>חודש {STATE_LABEL[state]}</Pill>} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <MonthSwitch month={month} onChange={setMonth} />
        <div className="flex flex-wrap gap-2">
          {manage && <Button variant="primary" disabled={busy} onClick={() => setDialog({ kind: 'add', date: israelParts(Date.now()).date.slice(0, 7) === month ? israelParts(Date.now()).date : `${month}-01` })}>השלמת דיווח</Button>}
          <Button variant="ghost" disabled={!report} onClick={() => void excel()}>אקסל</Button>
          <Button variant="ghost" disabled={!report || busy} onClick={() => void pdf()}>PDF</Button>
          {canManage(role) && state === 'open' && <Button variant="soft" disabled={busy} onClick={() => void run(() => monthMark(id, month, 'approved'), 'החודש אושר')}>אישור החודש</Button>}
          {isAdmin(role) && state !== 'closed' && ended && <Button variant="soft" disabled={busy} onClick={() => {
            if (window.confirm(`לסגור את ${monthLabel(month)} של ${emp.name}? אחרי הסגירה אי אפשר לשנות שום דבר בחודש, אלא בפתיחה מחדש עם סיבה.`)) void run(() => monthMark(id, month, 'closed'), 'החודש נסגר');
          }}>סגירת חודש</Button>}
          {isAdmin(role) && state === 'closed' && <Button variant="ghost" disabled={busy} onClick={() => setDialog({ kind: 'reopen' })}>פתיחה מחדש</Button>}
        </div>
      </div>
      {error && <Notice tone="warn">{error}</Notice>}
      {state === 'closed' && <Notice>החודש סגור — הדוח נעול. כל שינוי מחייב פתיחה מחדש עם סיבה (נרשם).</Notice>}
      {!OVERTIME_CONFIRMED && <Notice tone="warn">{DRAFT_NOTE} <Link href={attendanceHref('settings')} className="font-semibold underline">הכללים</Link></Notice>}
      {!report ? <div className="flex justify-center py-16"><Spinner /></div> : (
        <>
          <DaysTable report={report} manage={manage} onAdd={(date) => setDialog({ kind: 'add', date })}
            onShift={(kind, shift, date) => setDialog({ kind, shift, date })} onHistory={(day) => setDialog({ kind: 'history', day })} />
          <Totals report={report} />
          {absences.length > 0 && (
            <Card className="mt-4 p-4">
              <h3 className="mb-2 font-bold">היעדרויות בחודש</h3>
              <ul className="text-sm">{absences.map((a) => <li key={a.id} className={cx(a.status !== 'approved' && 'text-muted')}>
                {ABSENCE_LABEL[a.kind]} · {a.from.split('-').reverse().join('/')}{a.to !== a.from ? `–${a.to.split('-').reverse().join('/')}` : ''}{a.minutes ? ` · ${hm(a.minutes)}` : ''}
                {' · '}{a.status === 'approved' ? 'מאושרת' : a.status === 'pending' ? 'ממתינה' : a.status === 'rejected' ? 'נדחתה' : 'בוטלה'}{a.note ? ` · ${a.note}` : ''}</li>)}</ul>
            </Card>
          )}
          {monthLog.length > 0 && (
            <Card className="mt-4 p-4">
              <h3 className="mb-2 font-bold">היסטוריית החודש</h3>
              <ul className="text-sm text-ink-2">{monthLog.map((l, i) => <li key={i}>{formatIL(l.at)} · {l.kind === 'approved' ? 'אושר' : l.kind === 'closed' ? 'נסגר' : 'נפתח מחדש'} · {l.actorName}{l.reason ? ` · ${l.reason}` : ''}</li>)}</ul>
            </Card>
          )}
        </>
      )}

      {dialog?.kind === 'add' && <ShiftDialog open onClose={() => setDialog(null)} employees={setup.employees} employeeId={id} date={dialog.date} title="השלמת דיווח" onSaved={() => { att.say('נשמר'); void load(); }} />}
      {dialog?.kind === 'fix' && <FixDialog shift={dialog.shift} date={dialog.date} onClose={() => setDialog(null)} onSaved={() => { att.say('התיקון נשמר — הרישום הקודם נשמר בהיסטוריה'); void load(); }} />}
      {dialog?.kind === 'close' && <CloseDialog shift={dialog.shift} date={dialog.date} onClose={() => setDialog(null)} onSaved={() => { att.say('היציאה נרשמה'); void load(); }} />}
      {dialog?.kind === 'void' && <ReasonModal open title="ביטול רישום" action="ביטול הרישום" onClose={() => setDialog(null)}
        body={<>הרישום לא נמחק: הוא נשאר בהיסטוריה, מסומן כמבוטל, ויוצא מכל הסכומים. {dialog.shift.inTime}–{dialog.shift.outTime ?? '…'}</>}
        onDone={(r) => entryVoid(dialog.shift.id, r).then(() => { att.say('הרישום בוטל'); return load(); })} />}
      {dialog?.kind === 'reopen' && <ReasonModal open title={`פתיחה מחדש — ${monthLabel(month)}`} action="פתיחה מחדש" onClose={() => setDialog(null)}
        body="הפתיחה נרשמת בהיסטוריה של החודש, עם הסיבה. אחרי התיקון סוגרים שוב."
        onDone={(r) => monthMark(id, month, 'reopened', r).then(() => { att.say('החודש נפתח מחדש'); return load(); })} />}
      {dialog?.kind === 'history' && entries && <HistoryDialog day={dialog.day} employeeId={id} entries={entries} onClose={() => setDialog(null)} />}
    </>
  );
}

function DaysTable({ report, manage, onAdd, onShift, onHistory }: {
  report: ReturnType<typeof monthReport>; manage: boolean; onAdd: (date: string) => void;
  onShift: (kind: 'fix' | 'close' | 'void', s: ShiftRow, date: string) => void; onHistory: (d: DayRow) => void;
}) {
  const red = (d: DayRow) => d.status === 'missing' || d.status === 'open';
  const status = (d: DayRow) => (d.absence ? `${ABSENCE_LABEL[d.absence.kind]}${d.absence.minutes ? ` ${hm(d.absence.minutes)}` : ''}` : STATUS_LABEL[d.status]);
  const ot = (d: DayRow) => PCT_COLUMNS.filter((p) => p !== 100 && d.pct[p]).map((p) => `${p}%: ${hm(d.pct[p])}`).join(' · ');
  const place = (p: { lat: number; lng: number } | null, label: string) => p && (
    <a href={mapUrl(p)} target="_blank" rel="noopener noreferrer" aria-label={`מיקום ${label}`} className="ms-1 inline-flex text-muted hover:text-module"><MapPin size={14} aria-hidden /></a>
  );
  const typeLabel = (d: DayRow) => d.holiday || DAY_TYPE_LABEL[d.type];
  return (
    <>
      {/* computer: the reference's table */}
      <Card className="hidden overflow-x-auto p-0 lg:block">
        <table className="w-full min-w-[1100px] text-sm">
          <thead><tr className="border-b border-line text-muted">
            {['תאריך', 'יום', 'סוג יום', 'תקן', 'סה״כ תקן', 'כניסה', 'יציאה', 'סה״כ יומי', 'מצטבר', 'נוספות', 'סטטוס', ''].map((h) => <th key={h} className="p-2 text-start font-semibold">{h}</th>)}
          </tr></thead>
          <tbody>
            {report.days.map((d) => (
              <tr key={d.date} className={cx('border-b border-line align-top last:border-0', d.rest && 'bg-surface-2/50', red(d) && 'bg-red-500/5')}>
                <td className="p-2 tabular-nums">{d.date.slice(8)}/{d.date.slice(5, 7)}</td>
                <td className="p-2">{DAY_NAMES[d.weekday]}</td>
                <td className={cx('p-2', d.holiday && 'font-semibold')}>{typeLabel(d)}</td>
                <td className="p-2 tabular-nums">{d.standard ? hm(d.standard) : ''}</td>
                <td className="p-2 tabular-nums text-muted">{hm(d.standardCumulative)}</td>
                <td className="p-2">{d.shifts.map((s) => (
                  <div key={s.id} className="tabular-nums">{s.inTime}<span className="ms-1 text-xs text-muted">{METHOD_LABEL[s.method]}</span>{place(s.inPlace, 'כניסה')}</div>
                ))}{d.status === 'missing' && <span className="font-bold text-danger">חסר</span>}</td>
                <td className="p-2">{d.shifts.map((s) => (
                  <div key={s.id} className="tabular-nums">{s.outTime ? <>{s.outTime}{s.outNextDay && <span className="text-xs text-muted"> (למחרת)</span>}<span className="ms-1 text-xs text-muted">{s.outMethod ? METHOD_LABEL[s.outMethod] : ''}</span>{place(s.outPlace, 'יציאה')}</>
                    : <span className="font-bold text-danger">חסרה יציאה</span>}</div>
                ))}{d.status === 'missing' && <span className="font-bold text-danger">חסר</span>}</td>
                <td className="p-2 font-semibold tabular-nums">{d.paid ? hm(d.paid) : ''}{d.breakTaken ? <span className="block text-xs font-normal text-muted">הפסקה {hm(d.breakTaken)}</span> : null}</td>
                <td className="p-2 tabular-nums">{hm(d.cumulative)}</td>
                <td className="p-2 text-xs">{ot(d)}</td>
                <td className={cx('p-2', red(d) && 'font-bold text-danger')}>{status(d)}{d.late ? <span className="block text-xs text-warn">איחור {hm(d.late)}</span> : null}
                  {d.shifts.some((s) => s.corrected) && <span className="block text-xs text-muted">תוקן</span>}</td>
                <td className="p-2"><DayActions d={d} manage={manage} onAdd={onAdd} onShift={onShift} onHistory={onHistory} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {/* phone: a card per day */}
      <div className="grid gap-1.5 lg:hidden">
        {report.days.map((d) => (
          <div key={d.date} className={cx('rounded-2xl border p-3', red(d) ? 'border-red-500/40 bg-red-500/5' : 'border-line bg-(--glass)', d.status === 'future' && 'opacity-60')}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold">{DAY_NAMES[d.weekday]} {d.date.slice(8)}/{d.date.slice(5, 7)}<span className="ms-2 text-xs font-normal text-muted">{typeLabel(d)}{d.standard ? ` · תקן ${hm(d.standard)}` : ''}</span></span>
              <span className={cx('text-sm', red(d) ? 'font-bold text-danger' : 'text-muted')}>{status(d)}</span>
            </div>
            {d.shifts.map((s) => (
              <div key={s.id} className="mt-1 flex items-center justify-between gap-2 text-sm tabular-nums">
                <span>{s.inTime}{place(s.inPlace, 'כניסה')} ← {s.outTime ? <>{s.outTime}{s.outNextDay ? ' (למחרת)' : ''}{place(s.outPlace, 'יציאה')}</> : <strong className="text-danger">חסרה יציאה</strong>}
                  <span className="ms-1 text-xs text-muted">{METHOD_LABEL[s.method]}{s.corrected ? ' · תוקן' : ''}</span></span>
                <span className="font-semibold">{s.minutes ? hm(s.minutes) : ''}</span>
              </div>
            ))}
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-xs text-muted">{d.paid ? `יומי ${hm(d.paid)} · ` : ''}מצטבר {hm(d.cumulative)}{ot(d) ? ` · ${ot(d)}` : ''}</span>
              <DayActions d={d} manage={manage} onAdd={onAdd} onShift={onShift} onHistory={onHistory} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function DayActions({ d, manage, onAdd, onShift, onHistory }: { d: DayRow; manage: boolean; onAdd: (date: string) => void;
  onShift: (kind: 'fix' | 'close' | 'void', s: ShiftRow, date: string) => void; onHistory: (d: DayRow) => void }) {
  const [open, setOpen] = useState(false);
  if (d.status === 'future') return null;
  return (
    <div className="relative flex justify-end gap-1">
      {d.shifts.length > 0 && <button type="button" onClick={() => onHistory(d)} aria-label={`היסטוריה של ${d.date}`} className="grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-surface-2"><ClockCounterClockwise size={17} aria-hidden /></button>}
      {manage && (d.shifts.length ? (
        <>
          <Button size="sm" variant="soft" aria-expanded={open} onClick={() => setOpen(!open)}>עריכה</Button>
          {open && (
            <div className="absolute end-0 top-10 z-10 w-56 rounded-2xl border border-line bg-surface p-2 shadow-lg">
              {d.shifts.map((s) => (
                <div key={s.id} className="border-b border-line py-1 last:border-0">
                  <p className="px-2 text-xs text-muted">{s.inTime}–{s.outTime ?? '…'}</p>
                  {s.open && <MenuItem onClick={() => { setOpen(false); onShift('close', s, d.date); }}>רישום יציאה</MenuItem>}
                  {!s.open && <MenuItem onClick={() => { setOpen(false); onShift('fix', s, d.date); }}>תיקון שעות</MenuItem>}
                  <MenuItem onClick={() => { setOpen(false); onShift('void', s, d.date); }}>ביטול הרישום</MenuItem>
                </div>
              ))}
              <MenuItem onClick={() => { setOpen(false); onAdd(d.date); }}>הוספת משמרת ביום הזה</MenuItem>
            </div>
          )}
        </>
      ) : <Button size="sm" variant="soft" onClick={() => onAdd(d.date)}>השלמה</Button>)}
    </div>
  );
}
const MenuItem = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
  <button type="button" onClick={onClick} className="block min-h-10 w-full rounded-xl px-2 text-start text-sm font-semibold hover:bg-surface-2">{children}</button>
);

function Totals({ report }: { report: ReturnType<typeof monthReport> }) {
  const t = report.totals;
  const items: [string, string, boolean?][] = [
    ['ימי עבודה', String(t.workDays)], ['סה״כ שעות', hm(t.paid)], ['סה״כ תקן', hm(t.standard)],
    ...PCT_COLUMNS.map((p): [string, string, boolean] => [p === 100 ? 'רגילות' : `${p}%${OVERTIME_CONFIRMED ? '' : ' (טיוטה)'}`, hm(t.pct[p] ?? 0), p !== 100 && !OVERTIME_CONFIRMED]),
    ['בימי מנוחה', hm(t.restMinutes)], ['ימים חסרים', String(t.missingDays)], ['יציאות חסרות', String(t.openShifts)], ['איחורים', String(t.lateDays)],
    ...(['vacation', 'sick', 'reserve', 'other'] as const).filter((k) => t.absenceDays[k] || t.absenceMinutes[k])
      .map((k): [string, string] => [ABSENCE_LABEL[k], `${t.absenceDays[k] ? (t.absenceDays[k] === 1 ? 'יום אחד' : `${t.absenceDays[k]} ימים`) : ''}${t.absenceMinutes[k] ? ` ${hm(t.absenceMinutes[k])}` : ''}`.trim()]),
  ];
  return (
    <Card className="mt-4 grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 lg:grid-cols-7">
      {items.map(([l, v, draft]) => (
        <div key={l}><span className={cx('block font-display text-xl font-extrabold tabular-nums', (l === 'ימים חסרים' || l === 'יציאות חסרות') && v !== '0' && 'text-danger', draft && 'text-muted')}>{v}</span>
          <span className="text-xs font-semibold text-ink-2">{l}</span></div>
      ))}
    </Card>
  );
}

function FixDialog({ shift, date, onClose, onSaved }: { shift: ShiftRow; date: string; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ date, in: shift.inTime, out: shift.outTime ?? '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try { const m = shiftMoments(f.date, f.in, f.out); await entryFix(shift.id, m.in, m.out, f.reason.trim()); onSaved(); onClose(); }
    catch (e) { setErr(attError(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-2 font-display text-xl font-bold">תיקון שעות</h3>
      <p className="mb-3 text-sm text-ink-2">הרישום הקיים ({shift.inTime}–{shift.outTime}) לא נמחק: הוא נשאר בהיסטוריה, ובמקומו נרשם רישום חדש עם השעות האלה.</p>
      <div className="grid grid-cols-3 gap-2">
        <Field label="תאריך"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="כניסה"><Input type="time" value={f.in} onChange={(e) => setF({ ...f, in: e.target.value })} /></Field>
        <Field label="יציאה"><Input type="time" value={f.out} onChange={(e) => setF({ ...f, out: e.target.value })} /></Field>
      </div>
      {f.out && f.out <= f.in && <p className="-mt-2 mb-3 text-xs text-muted">היציאה למחרת ({addDay(f.date).split('-').reverse().join('/')}).</p>}
      <Field label="סיבת התיקון (חובה)"><Input value={f.reason} maxLength={300} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      {err && <p role="alert" className="mb-3 text-sm text-warn">{err}</p>}
      <div className="flex gap-2"><Button variant="primary" disabled={busy || !f.out || f.in === f.out || f.reason.trim().length < 2} onClick={() => void save()}>שמירת התיקון</Button><Button variant="ghost" onClick={onClose}>ביטול</Button></div>
    </Modal>
  );
}

function CloseDialog({ shift, date, onClose, onSaved }: { shift: ShiftRow; date: string; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ out: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try { const m = shiftMoments(date, shift.inTime, f.out); await entryClose(shift.id, m.out, f.reason.trim()); onSaved(); onClose(); }
    catch (e) { setErr(attError(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-2 font-display text-xl font-bold">רישום יציאה</h3>
      <p className="mb-3 text-sm text-ink-2">כניסה ב-{shift.inTime}, בלי יציאה. רושמים את שעת היציאה (שעה לפני הכניסה = למחרת).</p>
      <Field label="שעת יציאה"><Input type="time" value={f.out} onChange={(e) => setF({ ...f, out: e.target.value })} /></Field>
      <Field label="סיבה (חובה)"><Input value={f.reason} maxLength={300} placeholder="למשל: שכח/ה להחתים יציאה" onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      {err && <p role="alert" className="mb-3 text-sm text-warn">{err}</p>}
      <div className="flex gap-2"><Button variant="primary" disabled={busy || !f.out || f.out === shift.inTime || f.reason.trim().length < 2} onClick={() => void save()}>שמירה</Button><Button variant="ghost" onClick={onClose}>ביטול</Button></div>
    </Modal>
  );
}

/** every entry of the day — the live ones and the voided ones — with each change: what, who, when, why */
function HistoryDialog({ day, employeeId, entries, onClose }: { day: DayRow; employeeId: string; entries: Entry[]; onClose: () => void }) {
  const [lines, setLines] = useState<HistoryLine[] | null>(null);
  const ids = useMemo(() => {
    const live = new Set(day.shifts.map((s) => s.id));
    // the chain: the entries a live one replaced (voided), all of the same day
    const all = new Map(entries.map((e) => [e.id, e]));
    for (const s of day.shifts) { let e = all.get(s.id); while (e?.replaces) { live.add(e.replaces); e = all.get(e.replaces); } }
    for (const e of entries) if (e.voidedAt && israelParts(new Date(e.clockIn)).date === day.date) live.add(e.id);
    return [...live];
  }, [day, entries]);
  useEffect(() => { loadHistory(employeeId, ids).then(setLines, () => setLines([])); }, [employeeId, ids]);
  const t = (v: any) => (v ? formatIL(v, { hour: '2-digit', minute: '2-digit' }) : '—');
  return (
    <Modal open onClose={onClose} wide>
      <h3 className="mb-3 font-display text-xl font-bold">היסטוריה — {DAY_NAMES[day.weekday]} {day.date.split('-').reverse().join('/')}</h3>
      {!lines ? <Spinner /> : !lines.length ? <p className="text-sm text-muted">אין היסטוריה (רישום מלפני המערכת החדשה).</p> : (
        <ol className="grid gap-2 text-sm">
          {lines.map((l, i) => (
            <li key={i} className="rounded-xl bg-surface-2 p-2">
              <strong>{EVENT_LABEL[l.kind] ?? l.kind}</strong> · {formatIL(l.at)} · {l.actorName || CHANNEL_LABEL[l.channel] || ''}
              <span className="block text-ink-2">
                {l.kind === 'clock_out' ? `יציאה ${t(l.after?.clock_out)}` : l.kind === 'voided' ? `בוטל: ${t(l.before?.clock_in)}–${t(l.before?.clock_out)}`
                  : `${t(l.after?.clock_in)}–${t(l.after?.clock_out)}`}{l.after?.method ? ` · ${METHOD_LABEL[l.after.method as keyof typeof METHOD_LABEL] ?? ''}` : ''}
              </span>
              {l.reason && <span className="block text-muted">סיבה: {l.reason}</span>}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-4"><Button variant="ghost" onClick={onClose}>סגירה</Button></div>
    </Modal>
  );
}
