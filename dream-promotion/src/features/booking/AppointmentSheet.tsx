'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Field, Input, Select } from '@/components/ui/primitives';
import { Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { israelToIso } from '@/lib/il-time';
import { BookingAPI, bookingError, type Appointment } from './booking.service';
import { apptColor, dayOf, eventLine, eventWhen, eventWho, minuteOfDay, practitioners, shortDay, type ApptEvent, type CalStaff } from './calendar';

/**
 * One appointment, opened from the calendar (2.105): its day, hour and practitioner — changed and saved here by anyone of the
 * business, the same length kept (the database refuses a practitioner twice at once); everything the agenda's card offers
 * (`extras`: the reminder, the call, the charge, the deposit, the statuses); and its history — who changed what and when,
 * written by the database (appointment_events), read only.
 */
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const STATUS_LABEL: Record<string, string> = { booked: 'נקבע', confirmed: 'אושר', done: 'הגיע/ה', no_show: 'לא הגיע/ה', cancelled: 'בוטל' };

export function AppointmentSheet({ appt, staff, ready, version, extras, onClose, onSaved, onContact, where }: {
  appt: Appointment | null; staff: CalStaff[]; ready: boolean;
  /** a change made outside the sheet (a status): read the history again */
  version: number;
  extras: (a: Appointment) => ReactNode;
  onClose: () => void; onSaved: (a: Appointment) => void; onContact: (leadId: string) => void;
  where: (a: Appointment) => string;
}) {
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [staffId, setStaffId] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<ApptEvent[] | null>(null);

  useEffect(() => {
    if (!appt) return;
    setDay(dayOf(appt.start)); setTime(hm(minuteOfDay(appt.start))); setStaffId(appt.staffId ?? ''); setErr(null);
  }, [appt?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!appt || !ready) { setHistory(null); return; }
    let live = true;
    setHistory(null);
    void BookingAPI.history(appt.id).then((h) => { if (live) setHistory(h); });
    return () => { live = false; };
  }, [appt?.id, appt?.start, appt?.staffId, appt?.status, version, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // a practitioner who left still shows on her own appointments; the choice is of the active ones
  const choices = useMemo(() => {
    const act = practitioners(staff);
    const own = appt?.staffId ? staff.find((s) => s.id === appt.staffId) : undefined;
    return own && !act.some((s) => s.id === own.id) ? [...act, own] : act;
  }, [staff, appt?.staffId]);

  if (!appt) return <Modal open={false} onClose={onClose}>{null}</Modal>;
  const minutes = Math.round((new Date(appt.end).getTime() - new Date(appt.start).getTime()) / 60000);
  const changed = day !== dayOf(appt.start) || time !== hm(minuteOfDay(appt.start)) || (ready && (staffId || null) !== (appt.staffId ?? null));
  const open = appt.status === 'booked' || appt.status === 'confirmed';
  const color = apptColor(staff, appt.staffId);

  async function save() {
    if (!appt || !day || !/^\d{2}:\d{2}$/.test(time)) return;
    setSaving(true); setErr(null);
    try {
      const start = israelToIso(day, time);
      const end = new Date(new Date(start).getTime() + minutes * 60000).toISOString();
      const next = await BookingAPI.move(appt.id, { start, end, ...(ready ? { staffId: staffId || null } : {}) });
      onSaved(next);
    } catch (e) { setErr(bookingError(e)); }
    finally { setSaving(false); }
  }

  return (
    <Modal open onClose={onClose}>
      <div className="flex items-start gap-3">
        <span className={cx('cal-dot mt-1.5 h-3 w-3 shrink-0 rounded-full', `cal-${color}`)} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <button type="button" className="text-start font-display text-xl font-extrabold" onClick={() => appt.leadId && onContact(appt.leadId)} disabled={!appt.leadId}>
            {appt.name}
          </button>
          <p className="text-sm text-muted">
            {appt.serviceName || 'תור'} · {minutes} דק׳{where(appt) ? ` · ${where(appt)}` : ''}{appt.source === 'public' ? ' · הוזמן אונליין' : ''}{appt.note ? ` · "${appt.note}"` : ''}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-bold text-primary">{STATUS_LABEL[appt.status]}</span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-3">
        <Field label="יום"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} disabled={!open} /></Field>
        <Field label="שעה"><Input type="time" value={time} step={300} onChange={(e) => setTime(e.target.value)} disabled={!open} /></Field>
      </div>
      {ready && (choices.length > 0 || appt.staffId) && (
        <Field label="מטפל/ת">
          <Select value={staffId} onChange={(e) => setStaffId(e.target.value)} disabled={!open}>
            <option value="">בלי מטפל/ת</option>
            {choices.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? '' : ' (לא פעיל/ה)'}</option>)}
          </Select>
        </Field>
      )}
      {changed && open && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'שומר…' : 'שמירת השינוי'}</Button>
          <Button variant="ghost" onClick={() => { setDay(dayOf(appt.start)); setTime(hm(minuteOfDay(appt.start))); setStaffId(appt.staffId ?? ''); setErr(null); }}>ביטול השינוי</Button>
          <span className="text-xs text-muted">{shortDay(day || dayOf(appt.start))} · {time} · {minutes} דק׳</span>
        </div>
      )}
      {err && <p className="mb-3 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{err}</p>}

      {extras(appt)}

      {ready && (
        <section className="mt-4 border-t border-line pt-3">
          <h4 className="mb-1.5 flex items-baseline gap-2 font-bold">היסטוריה <span className="text-xs font-semibold text-muted">מי שינה מה ומתי</span></h4>
          {history === null ? <div className="py-2"><Spinner /></div>
            : !history.length ? <p className="text-sm text-muted">אין עדיין שינויים רשומים.</p>
              : (
                <ul className="grid gap-0.5">
                  {[...history].reverse().map((e) => (
                    <li key={e.id} className="grid grid-cols-[78px_1fr] gap-2 border-b border-dashed border-line py-1.5 text-sm last:border-0">
                      <time className="text-xs tabular-nums text-muted">{eventWhen(e.at)}</time>
                      <span><b>{eventWho(e)}</b> · {eventLine(e)}</span>
                    </li>
                  ))}
                </ul>
              )}
        </section>
      )}
    </Modal>
  );
}
