'use client';
import { useState, type ReactNode } from 'react';
import { Button, Chip, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { israelParts } from '@/lib/il-time';
import { shiftMonth } from './hours-engine';
import { monthLabel } from './exports';
import { attError, entryAdd, shiftMoments } from './api';
import type { Employee } from './people';

/** the screens' small pieces (2.107): the month switch of the reference, a reason dialog, a shift dialog, files to save */
export const thisMonth = () => israelParts(Date.now()).date.slice(0, 7);
export const today = () => israelParts(Date.now()).date;

/** "חודש נוכחי / קודם / לפני חודשיים", and any month */
export function MonthSwitch({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const now = thisMonth();
  const quick = [{ m: now, l: 'חודש נוכחי' }, { m: shiftMonth(now, -1), l: 'חודש קודם' }, { m: shiftMonth(now, -2), l: 'לפני חודשיים' }];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {quick.map((q) => <Chip key={q.m} on={month === q.m} onClick={() => onChange(q.m)} className="min-h-10">{q.l}</Chip>)}
      <Input type="month" aria-label="חודש" value={month} max={now} onChange={(e) => e.target.value && onChange(e.target.value)} className="h-10 w-auto py-1" />
      <span className="text-sm font-semibold text-muted">{monthLabel(month)}</span>
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad'; children: ReactNode }) {
  return (
    <div role={tone === 'info' ? 'note' : 'alert'} className={cx('mb-4 rounded-2xl p-3 text-sm',
      tone === 'bad' ? 'bg-red-500/10 text-red-700 dark:text-red-300' : tone === 'warn' ? 'bg-(--warn-soft) text-warn' : 'bg-module-soft text-ink')}>
      {children}
    </div>
  );
}

/** a dialog that asks why (required — the database refuses an empty reason too) */
export function ReasonModal({ open, title, body, action, onClose, onDone, optional }: {
  open: boolean; title: string; body?: ReactNode; action: string; optional?: boolean;
  onClose: () => void; onDone: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = optional || reason.trim().length >= 2;
  async function go() {
    setBusy(true); setErr(null);
    try { await onDone(reason.trim()); setReason(''); onClose(); }
    catch (e) { setErr(attError(e)); }
    finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose}>
      <h3 className="mb-2 font-display text-xl font-bold">{title}</h3>
      {body && <div className="mb-3 text-sm text-ink-2">{body}</div>}
      <Field label={optional ? 'הערה (לא חובה)' : 'סיבה (חובה — נשמרת בהיסטוריה)'}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-20" />
      </Field>
      {err && <p role="alert" className="mb-3 text-sm text-warn">{err}</p>}
      <div className="flex gap-2"><Button variant="primary" disabled={!ok || busy} onClick={() => void go()}>{action}</Button><Button variant="ghost" onClick={onClose}>ביטול</Button></div>
    </Modal>
  );
}

/** a shift a manager reports — a date, in and out (an out before the in = the next morning), and why */
export function ShiftDialog({ open, onClose, employees, employeeId, date, onSaved, title = 'דיווח שעות' }: {
  open: boolean; onClose: () => void; employees: Employee[]; employeeId?: string; date?: string; onSaved: () => void; title?: string;
}) {
  const [f, setF] = useState({ emp: employeeId ?? '', date: date ?? today(), in: '08:00', out: '16:00', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const emp = f.emp || employeeId || '';
  const next = f.out <= f.in;
  async function save() {
    setBusy(true); setErr(null);
    try {
      const m = shiftMoments(f.date, f.in, f.out);
      await entryAdd(emp, m.in, m.out, f.reason.trim());
      onSaved(); onClose(); setF((x) => ({ ...x, reason: '' }));
    } catch (e) { setErr(attError(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose}>
      <h3 className="mb-3 font-display text-xl font-bold">{title}</h3>
      {!employeeId && (
        <Field label="עובד/ת">
          <Select value={emp} onChange={(e) => setF({ ...f, emp: e.target.value })}>
            <option value="">בחרו…</option>
            {employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.name}{e.code ? ` (${e.code})` : ''}</option>)}
          </Select>
        </Field>
      )}
      <div className="grid grid-cols-3 gap-2">
        <Field label="תאריך"><Input type="date" value={f.date} max={today()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="כניסה"><Input type="time" value={f.in} onChange={(e) => setF({ ...f, in: e.target.value })} /></Field>
        <Field label="יציאה"><Input type="time" value={f.out} onChange={(e) => setF({ ...f, out: e.target.value })} /></Field>
      </div>
      {next && <p className="-mt-2 mb-3 text-xs text-muted">היציאה למחרת בבוקר (משמרת לילה).</p>}
      <Field label="סיבה (חובה — נשמרת בהיסטוריה)"><Input value={f.reason} maxLength={300} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="למשל: שכח/ה להחתים" /></Field>
      {err && <p role="alert" className="mb-3 text-sm text-warn">{err}</p>}
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy || !emp || f.reason.trim().length < 2 || f.in === f.out} onClick={() => void save()}>שמירה</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}

/** a file to the phone / computer (opened from the tap itself where a window is involved — here a download link) */
export function saveFile(bytes: BlobPart, name: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type }));
  // in the page while clicked: a link outside the document loses its file name after an await (Chromium)
  a.download = name; a.hidden = true;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
