'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { isCloudConfigured } from '@/lib/supabase/client';
import { Button, Card, Chip, Field, Input, PageHead, Select, Textarea } from '@/components/ui/primitives';
import { EmptyState, Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL, israelParts, israelToIso } from '@/lib/il-time';
import { CalendarPlus } from '@/components/ui/Icon';
import { telLink, waLink } from '@/features/crm/crm';
import { ContactSheet } from '@/features/crm/ContactSheet';
import { freeSlots, reminderText, type Hours } from './slots';
import { authHeaders } from '@/lib/services/http';
import { BookingAPI, DEFAULT_SETTINGS, bookingError, type Appointment, type ApptStatus, type BookingServiceRow, type BookingSettings } from './booking.service';
import { PaylinkList, SendPaylinkDialog, usePaylinks } from '@/features/finance/Paylinks';
import { afterDeposit, depositDays, paylinkOpen, paylinkPill, type DepositDoc } from '@/features/finance/paylinks';
import { loadDeposits } from '@/features/finance/deposits-data';
import { ils } from '@/features/register/money';
import { LocationField, locationColumn } from '@/features/locations/LocationSwitch';
import { atLocation, locationTag } from '@/features/locations/locations';
import { useLocations } from '@/features/locations/store';
import {
  CAL_VIEWS, addDays, apptCount, calendarHours, dayOf, dayTone, minuteOfDay, practitioners, shiftDate, staffColor, viewRange, viewTitle, type CalStaff, type CalView,
} from './calendar';
import { DayView, HolidayLine, MonthView, WeekView } from './CalendarViews';
import { chagDay, festivalDays, holidaysIn, type Holiday } from './holidays';
import { AppointmentSheet } from './AppointmentSheet';
import { StaffTab } from './StaffTab';
import { customerProblem, matchLead } from './new-customer';
import { apptRange, defaultEnd, lengthProblem, timesProblem } from './appt-times';
import { DurationPicker } from './DurationPicker';
import { PhoneAlerts } from './PhoneAlerts';
import { dayRange } from './alerts';

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const STATUS: Record<ApptStatus, { label: string; tone: string }> = {
  booked: { label: 'נקבע', tone: 'bg-sky-500/15 text-sky-600 dark:text-sky-300' },
  confirmed: { label: 'אושר', tone: 'bg-violet-500/15 text-violet-600 dark:text-violet-300' },
  done: { label: 'הגיע/ה', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  no_show: { label: 'לא הגיע/ה', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  cancelled: { label: 'בוטל', tone: 'bg-zinc-500/15 text-zinc-500' },
};
const hm = (iso: string) => israelParts(new Date(iso)).time;

/**
 * Appointments: the agenda, services, opening hours and the public booking page (toolbox stage 2). 2.88: a service may ask a
 * deposit (paid by link — sent from the appointment, or from the public booking page itself); the agenda shows its status,
 * and "💳 חיוב" offsets a deposit that was really paid (appointment_deposits — never a test one) from the final payment.
 * 2.105 (migration 5700): a calendar like Outlook's — a day (a column for each practitioner), a week, a month and the list; a
 * practitioner and her colour for every appointment ("מטפלות"), anyone of the business moves any appointment, and every change
 * is in its history. Before the migration: the same views, every appointment without a practitioner.
 * 2.106: the holidays of Israel in every view; Friday, Saturday and the holidays in a colour each, open for appointments like any
 * day; and "סגירה בחגים" in the opening hours — the coming year's festival days closed on the booking page (only when pressed,
 * saved with the hours; the calendar books them as before).
 */
export function AppointmentsScreen() {
  const { userId, brand, leads, addLeadNow, addActivity, updateLead } = useApp();
  // 2.109: a calendar member ("יומן ולידים") — the calendar only: no team, services, hours or booking page, no money, no client file
  const calendarOnly = useApp((x) => x.access === 'calendar');
  // T12א: with several locations and "כל הסניפים" picked, every appointment says where it is
  const locState = useLocations((x) => x.state);
  const where = (a: Appointment) => (locState.businessId ? locationTag(locState, a, locState.businessId) : '');
  const [tab, setTab] = useState<'agenda' | 'staff' | 'services' | 'hours' | 'page'>('agenda');
  // the calendar (2.105): the view this device used last (a phone opens on the day, a computer on the week), its day, whose
  const [view, setView] = useState<CalView>('day');
  const [date, setDate] = useState(() => israelParts(Date.now()).date);
  const [filter, setFilter] = useState<string>('all');
  const [staff, setStaff] = useState<CalStaff[]>([]);
  const [ready, setReady] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [prefill, setPrefill] = useState<{ date: string; time: string; staffId: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem('dp-cal-view'); } catch { /* a private window */ }
    setView(CAL_VIEWS.some((v) => v.key === saved) ? (saved as CalView) : window.matchMedia('(min-width: 1024px)').matches ? 'week' : 'day');
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const pickView = (v: CalView) => { setView(v); try { localStorage.setItem('dp-cal-view', v); } catch { /* a private window */ } };
  const [settings, setSettings] = useState<BookingSettings>(DEFAULT_SETTINGS);
  const [services, setServices] = useState<BookingServiceRow[]>([]);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  // 2.105: the spinner only until the first answer — moving between days, weeks and views keeps the calendar on the screen
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [contactId, setContactId] = useState<string | null>(null);
  // 2.112: the phone's notifications, and the day whose reminders a notification opened (/appointments?reminders=<day>)
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [remindDay, setRemindDay] = useState<string | null>(null);
  const [remindList, setRemindList] = useState<Appointment[] | null>(null);
  const [reminded, setReminded] = useState<Set<string>>(new Set());
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const day = q.get('reminders'), appt = q.get('appt');
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) setRemindDay(day);
    if (appt) setOpenId(appt);
  }, []);
  useEffect(() => {
    if (!remindDay || !userId) return;
    let live = true;
    setRemindList(null);
    const { from, to } = dayRange(remindDay);
    BookingAPI.appointments(userId, from, to).then((l) => { if (live) setRemindList(l.filter((a) => a.status === 'booked' || a.status === 'confirmed')); },
      () => { if (live) setRemindList([]); });
    return () => { live = false; };
  }, [remindDay, userId]);
  const [showPast, setShowPast] = useState(false);
  // deposits (2.88): what was really paid per appointment (the register offsets it), and the links of the appointments that ask one
  const [deposits, setDeposits] = useState<Record<string, number>>({});
  // 2.97 (migration 5200): the documents issued for them — the register's line names them
  const [depositDocs, setDepositDocs] = useState<Record<string, DepositDoc[]>>({});
  const [depositFor, setDepositFor] = useState<Appointment | null>(null);
  const [depOpen, setDepOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true); setError(null);
    try {
      const { from, to } = viewRange(view, date, israelParts(Date.now()).date, showPast);
      const [s, sv, ap, ok] = await Promise.all([BookingAPI.settings(userId), BookingAPI.services(userId), BookingAPI.appointments(userId, from, to), BookingAPI.calendarReady()]);
      setReady(ok);
      setStaff(ok ? await BookingAPI.staff() : []);
      setSettings(s.slug ? s : { ...s, title: s.title || brand.name, address: s.address || brand.city || '' });
      setServices(sv); setAppts(ap);
      const ids = calendarOnly ? [] : ap.filter((a) => (sv.find((x) => x.id === a.serviceId)?.deposit ?? 0) > 0).map((a) => a.id);
      const d = ids.length ? await loadDeposits(ids) : new Map();
      setDeposits(Object.fromEntries([...d].map(([id, x]) => [id, x.amount])));
      setDepositDocs(Object.fromEntries([...d].map(([id, x]) => [id, x.docs])));
    } catch (e) { setError(bookingError(e)); }
    finally { setLoading(false); setLoaded(true); }
  }, [userId, showPast, brand.name, brand.city, view, date, calendarOnly]);
  useEffect(() => { void load(); }, [load]);
  const reloadStaff = useCallback(async () => { if (ready) setStaff(await BookingAPI.staff()); }, [ready]);

  // the client file (2.86): an upcoming appointment of a customer with no valid health declaration for its treatment is
  // marked, with "שלח עכשיו". Asked again when a card closes (a declaration may have been sent or signed). Shown only to the
  // owner and the practitioners the owner marked — anyone else gets nothing back, and nothing is shown.
  const [gaps, setGaps] = useState<Record<string, { type: string | null }>>({});
  useEffect(() => {
    if (contactId) return;
    const today = israelParts(Date.now()).date;
    const list = appts.filter((a) => a.leadId && (a.status === 'booked' || a.status === 'confirmed'))
      .map((a) => ({ id: a.id, leadId: a.leadId!, service: a.serviceName, day: israelParts(new Date(a.start)).date }))
      .filter((a) => a.day >= today);
    if (!list.length) { setGaps({}); return; }
    let live = true;
    (async () => {
      try {
        const r = await fetch('/api/client-file/declarations', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
          body: JSON.stringify({ action: 'gaps', appointments: list }) });
        const j = r.ok ? await r.json() : null;
        if (live) setGaps(j?.gaps ?? {});
      } catch { if (live) setGaps({}); }
    })();
    return () => { live = false; };
  }, [appts, contactId]);

  const depositOf = (a: Appointment) => (calendarOnly ? 0 : services.find((x) => x.id === a.serviceId)?.deposit ?? 0);
  const depositIds = useMemo(() => appts.filter((a) => depositOf(a) > 0).map((a) => a.id), [appts, services]); // eslint-disable-line react-hooks/exhaustive-deps
  const depLinks = usePaylinks(depositIds.length ? { appointmentIds: depositIds } : null);
  const linksOf = (id: string) => (depLinks.links ?? []).filter((l) => l.appointmentId === id);

  const flash = (m: string) => { setSaved(m); setTimeout(() => setSaved(null), 2500); };
  async function saveSettings(next = settings) {
    if (!userId) return;
    try { await BookingAPI.saveSettings(userId, next); setSettings(next); flash('נשמר'); setError(null); }
    catch (e) { setError(bookingError(e)); }
  }

  if (!isCloudConfigured || !userId) {
    return (<><PageHead title="תורים" /><EmptyState icon={<CalendarPlus />} title="זימון תורים דורש חשבון מחובר" body="התחברו לחשבון כדי לנהל תורים ודף הזמנה." /></>);
  }

  const active = appts.filter((a) => a.status !== 'cancelled');
  const byDay = active.reduce<Record<string, Appointment[]>>((acc, a) => { const d = israelParts(new Date(a.start)).date; (acc[d] ||= []).push(a); return acc; }, {});
  const todayIL = israelParts(now).date;
  const first = loading && !loaded;
  // the list's days (2.106): their holidays, read once for all of them
  const listDays = Object.keys(byDay).sort();
  const listHolidays = view === 'list' && listDays.length ? holidaysIn(listDays[0], listDays[listDays.length - 1]) : new Map<string, Holiday[]>();
  const pageUrl = settings.slug && typeof window !== 'undefined' ? `${window.location.origin}/book/${settings.slug}` : '';
  // the calendar (2.105): its columns, whose appointments are shown, "רק שלי" (a practitioner linked to this account)
  const pract = practitioners(staff);
  const mine = pract.filter((x) => x.memberUserId === userId).map((x) => x.id);
  const shownStaff = filter === 'all' ? pract : filter === 'mine' ? pract.filter((x) => mine.includes(x.id)) : pract.filter((x) => x.id === filter);
  const shownAppts = filter === 'all' ? appts : appts.filter((a) => a.staffId && shownStaff.some((x) => x.id === a.staffId));
  const openAppt = openId ? appts.find((a) => a.id === openId) ?? null : null;
  const staffName = (id: string | null | undefined) => (id ? staff.find((x) => x.id === id)?.name ?? '' : '');
  /** a new appointment: on a day and an hour of the calendar, with its column's practitioner (or the one filtered on) */
  const book = (d: string, time: string, staffId: string | null) => {
    if (!services.length) return;
    setPrefill({ date: d, time, staffId: staffId ?? (filter !== 'all' && filter !== 'mine' ? filter : mine.length === 1 && filter === 'mine' ? mine[0] : '') });
    setAdding(true);
  };
  const viewSub = view === 'list'
    ? `${active.filter((a) => a.start >= new Date().toISOString()).length} תורים קרובים`
    : `${apptCount(shownAppts.filter((a) => a.status !== 'cancelled' && (view !== 'day' || dayOf(a.start) === date)).length)} ${view === 'day' ? 'ביום הזה' : view === 'week' ? 'בשבוע הזה' : 'בחודש הזה'}`;

  async function setStatus(a: Appointment, status: ApptStatus) {
    try {
      await BookingAPI.setStatus(a.id, status);
      setAppts((all) => all.map((x) => (x.id === a.id ? { ...x, status } : x)));
      setVersion((v) => v + 1);
      if (a.leadId && (status === 'done' || status === 'no_show' || status === 'cancelled')) {
        addActivity(a.leadId, status === 'done' ? 'meeting' : 'note', `${STATUS[status].label}: ${a.serviceName} · ${formatIL(a.start)}`);
        if (status === 'done') updateLead(a.leadId, { status: 'נסגר' });
      }
    } catch (e) { setError(bookingError(e)); }
  }
  function remind(a: Appointment) {
    const text = reminderText({ name: a.name, service: a.serviceName || 'הטיפול', whenHe: formatIL(a.start, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }), business: settings.title || brand.name, address: settings.address });
    const url = waLink(a.phone, text);
    if (url) { window.open(url, '_blank', 'noopener'); if (a.leadId) addActivity(a.leadId, 'whatsapp', 'נשלחה תזכורת לתור'); }
  }

  /** what an appointment offers — the same on the list's card and in the calendar's sheet */
  const extras = (a: Appointment) => (
    <>
      {gaps[a.id] && a.leadId && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-amber-500/15 px-2.5 py-1.5 text-xs font-semibold text-amber-800 dark:text-amber-200">
          <span>⚠️ אין הצהרת בריאות בתוקף{gaps[a.id].type ? ` ל${gaps[a.id].type}` : ''}</span>
          <button type="button" className="underline" onClick={() => setContactId(a.leadId!)}>שלח עכשיו</button>
        </div>
      )}
      {depositOf(a) > 0 && depLinks.ready && (() => {
        const ls = linksOf(a.id), last = ls[0];
        const pill = last ? paylinkPill(last) : null;
        const canSend = (a.status === 'booked' || a.status === 'confirmed') && a.end > new Date().toISOString()
          && !ls.some((l) => paylinkOpen(l) || l.status === 'paid');
        return (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-semibold">מקדמה {ils(depositOf(a))}:</span>
            {pill ? <button type="button" onClick={() => setDepOpen(depOpen === a.id ? null : a.id)}
              className={cx('rounded-full px-2 py-0.5 font-bold', pill.tone === 'ok' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : pill.tone === 'bad' ? 'bg-red-500/15 text-red-700 dark:text-red-300' : pill.tone === 'warn' ? 'bg-amber-500/15 text-amber-800 dark:text-amber-200' : pill.tone === 'info' ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-muted')}>
              {pill.text} {depOpen === a.id ? '▲' : '▼'}</button> : <span className="text-muted">לא נשלח לינק</span>}
            {canSend && <Button size="sm" variant="ghost" onClick={() => setDepositFor(a)}>💳 לינק למקדמה</Button>}
          </div>
        );
      })()}
      {depOpen === a.id && <PaylinkList links={linksOf(a.id)} title="לינקים למקדמה" showLabel={false} onChanged={() => { void depLinks.reload(); void load(); }} />}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {waLink(a.phone) && a.status !== 'done' && <Button size="sm" variant="ghost" onClick={() => remind(a)}>💬 תזכורת</Button>}
        {a.phone && <a href={telLink(a.phone)} className="rounded-full border border-line px-3 py-1 text-sm">📞</a>}
        {!calendarOnly && a.status !== 'cancelled' && a.status !== 'no_show' && (() => {
          const price = services.find((x) => x.id === a.serviceId)?.price;
          // a deposit that was really paid comes off the final payment (its own document is issued already)
          const line = afterDeposit(a.serviceName || 'טיפול', price ?? 0, deposits[a.id] ?? 0, depositDocs[a.id] ?? []);
          const q = new URLSearchParams({ name: a.name, phone: a.phone, appt: a.id, item: line.name, price: String(line.price), ...(a.leadId ? { lead: a.leadId } : {}) });
          return <a href={`/register?${q}`} className="rounded-full border border-line px-3 py-1 text-sm">💳 חיוב{deposits[a.id] ? ` (אחרי מקדמה ${ils(deposits[a.id])})` : ''}</a>;
        })()}
        {a.status === 'booked' && <Button size="sm" variant="ghost" onClick={() => setStatus(a, 'confirmed')}>אישור</Button>}
        {(a.status === 'booked' || a.status === 'confirmed') && <>
          <Button size="sm" variant="ghost" onClick={() => setStatus(a, 'done')}>הגיע/ה</Button>
          <Button size="sm" variant="ghost" onClick={() => setStatus(a, 'no_show')}>לא הגיע/ה</Button>
          <Button size="sm" variant="ghost" onClick={() => { if (window.confirm('לבטל את התור? השעה תתפנה.')) void setStatus(a, 'cancelled'); }}>ביטול</Button>
        </>}
      </div>
    </>
  );

  return (
    <>
      <PageHead title="תורים" sub={tab === 'agenda' ? viewSub : undefined}
        action={<div className="flex gap-2">
          <Button variant="ghost" onClick={() => setAlertsOpen(true)} aria-label="התראות בטלפון">🔔</Button>
          <Button variant="primary" onClick={() => book(view === 'list' ? todayIL : date, '', null)} disabled={!services.length}>+ תור</Button>
        </div>} />

      <div className="mb-5 flex gap-1.5 overflow-x-auto pb-1">
        {(calendarOnly ? [['agenda', 'יומן תורים'], ['services', 'שירותים']] as const
          : [['agenda', 'יומן תורים'], ['staff', 'מטפלות'], ['services', 'שירותים'], ['hours', 'שעות פעילות'], ['page', 'דף הזמנה']] as const).map(([k, l]) => (
          <Chip key={k} on={tab === k} onClick={() => setTab(k)} className="shrink-0 whitespace-nowrap">{l}</Chip>
        ))}
      </div>
      {error && <p className="mb-4 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p>}
      {saved && <p className="mb-4 text-sm font-semibold text-emerald-600">✓ {saved}</p>}
      {first && <div className="py-8 text-center"><Spinner /></div>}

      {!first && tab === 'agenda' && (
        !services.length ? (
          <EmptyState icon={<CalendarPlus />} title="מתחילים בשירותים" body="הוסיפו את מה שאפשר לקבוע (למשל: טיפול לייזר · 45 דקות), ואז קבעו שעות פעילות."
            action={<Button variant="primary" onClick={() => setTab('services')}>הוספת שירות</Button>} />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-xl bg-bg-2 p-1" role="tablist" aria-label="תצוגת היומן">
                {CAL_VIEWS.map((v) => (
                  <button key={v.key} type="button" role="tab" aria-selected={view === v.key} onClick={() => pickView(v.key)}
                    className={cx('rounded-lg px-3.5 py-1.5 text-sm font-semibold', view === v.key ? 'bg-surface text-ink shadow-sm' : 'text-ink-2')}>{v.label}</button>
                ))}
              </div>
              {view !== 'list' && (
                <div className="flex items-center gap-1.5">
                  <button type="button" aria-label="הקודם" onClick={() => setDate(shiftDate(view, date, -1))}
                    className="grid h-9 w-9 place-items-center rounded-xl border border-line bg-surface text-lg">›</button>
                  <strong className="px-1 font-display text-base">{viewTitle(view, date)}</strong>
                  {loading && <Spinner />}
                  <button type="button" aria-label="הבא" onClick={() => setDate(shiftDate(view, date, 1))}
                    className="grid h-9 w-9 place-items-center rounded-xl border border-line bg-surface text-lg">‹</button>
                  {date !== todayIL && <Button size="sm" variant="ghost" onClick={() => setDate(todayIL)}>היום</Button>}
                </div>
              )}
            </div>
            {pract.length > 0 && (
              <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="סינון לפי מטפל/ת">
                <Chip on={filter === 'all'} onClick={() => setFilter('all')} className="shrink-0 whitespace-nowrap">הכול</Chip>
                {pract.map((x) => (
                  <Chip key={x.id} on={filter === x.id} onClick={() => setFilter(x.id)} className="shrink-0 whitespace-nowrap">
                    <span className={cx('cal-dot me-1.5 inline-block h-2.5 w-2.5 rounded-full', `cal-${staffColor(staff, x.id)}`)} aria-hidden="true" />{x.name}
                  </Chip>
                ))}
                {mine.length > 0 && <Chip on={filter === 'mine'} onClick={() => setFilter('mine')} className="shrink-0 whitespace-nowrap">רק שלי</Chip>}
              </div>
            )}
            {view === 'day' && <DayView date={date} columns={shownStaff} appts={shownAppts} staff={staff} hours={settings.hours} closedDates={settings.closedDates} today={todayIL}
              nowMinute={minuteOfDay(new Date(now).toISOString())} onOpen={(a) => setOpenId(a.id)} onSlot={book} />}
            {view === 'week' && <WeekView date={date} appts={shownAppts} staff={staff} hours={settings.hours} closedDates={settings.closedDates} today={todayIL}
              nowMinute={minuteOfDay(new Date(now).toISOString())} onOpen={(a) => setOpenId(a.id)} onSlot={book} />}
            {view === 'month' && <MonthView date={date} onPick={setDate} appts={shownAppts} staff={staff} hours={settings.hours} closedDates={settings.closedDates} today={todayIL}
              nowMinute={minuteOfDay(new Date(now).toISOString())} onOpen={(a) => setOpenId(a.id)} onSlot={book} />}
            {view === 'list' && <>
              {!settings.enabled && (
                <button type="button" onClick={() => setTab('page')} className="mb-4 w-full rounded-2xl bg-primary-soft px-4 py-3 text-start text-sm">
                  <strong>דף ההזמנות עוד לא פעיל.</strong> הפעילו אותו כדי שלקוחות יקבעו לבד ←
                </button>
              )}
              <label className="mb-3 flex items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} /> הצגת 30 הימים האחרונים
              </label>
              {Object.keys(byDay).length === 0 && <p className="py-6 text-center text-sm text-muted">אין תורים בתקופה הזו.</p>}
              <div className="grid gap-5">
                {Object.entries(byDay).map(([d, list]) => (
                  <section key={d}>
                    <h3 className={cx('mb-2 rounded-lg px-2 py-1 text-sm font-bold', dayTone(d, chagDay(listHolidays.get(d) ?? [])), d === todayIL ? 'cal-accent' : 'text-ink-2')}>
                      {d === todayIL ? 'היום · ' : ''}{formatIL(israelToIso(d, '12:00'), { weekday: 'long', day: 'numeric', month: 'long' })}
                      {listHolidays.has(d) && <> · <HolidayLine list={listHolidays.get(d)!} inline /></>}
                    </h3>
                    <div className="grid grid-cols-1 gap-2">
                      {list.filter((a) => filter === 'all' || shownAppts.includes(a)).map((a) => (
                        <Card key={a.id} className={cx('min-w-0 p-3', pract.length > 0 && `cal-${staffColor(staff, a.staffId)} border-s-4 border-s-[var(--cal-bar)]`)}>
                          <div className="flex items-start justify-between gap-2">
                            <button type="button" className="min-w-0 text-start" onClick={() => a.leadId && setContactId(a.leadId)}>
                              <span className="block font-bold tabular-nums">{hm(a.start)}–{hm(a.end)} · <span className="font-semibold">{a.name}</span></span>
                              <span className="block truncate text-xs text-muted">{a.serviceName}{where(a) ? ` · ${where(a)}` : ''}{a.source === 'public' ? ' · הוזמן אונליין' : ''}{a.note ? ` · "${a.note}"` : ''}</span>
                            </button>
                            <span className={cx('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold', STATUS[a.status].tone)}>{STATUS[a.status].label}</span>
                          </div>
                          {pract.length > 0 && (
                            <button type="button" onClick={() => setOpenId(a.id)} className="mt-1.5 text-xs font-semibold text-ink-2">
                              {a.staffId ? `מטפל/ת: ${staffName(a.staffId)}` : 'בלי מטפל/ת — לשיבוץ'} · <span className="text-primary">שינוי והיסטוריה ›</span>
                            </button>
                          )}
                          {!pract.length && <button type="button" onClick={() => setOpenId(a.id)} className="mt-1.5 text-xs font-semibold text-primary">{ready ? 'הזזה והיסטוריה ›' : 'הזזה ›'}</button>}
                          {extras(a)}
                        </Card>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </>}
          </>
        )
      )}

      {!first && tab === 'staff' && <StaffTab ready={ready} onChanged={() => void reloadStaff()} />}

      {!first && tab === 'services' && <ServicesTab userId={userId} services={services} money={!calendarOnly} onChange={load} onError={(e) => setError(bookingError(e))} />}

      {!first && tab === 'hours' && (
        <HoursTab settings={settings} onChange={setSettings} onSave={() => saveSettings()} />
      )}

      {!first && tab === 'page' && (
        <Card className="p-4">
          <label className="mb-4 flex items-center justify-between gap-3 rounded-2xl bg-surface-2 p-3">
            <span><strong className="block">דף הזמנות פעיל</strong><span className="text-xs text-muted">לקוחות קובעים לבד, והתור מופיע כאן ובלקוחות</span></span>
            <input type="checkbox" className="h-5 w-5" checked={settings.enabled} onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })} />
          </label>
          <Field label="כתובת הדף (באנגלית)">
            <div className="flex items-center gap-2" dir="ltr">
              <span className="shrink-0 text-xs text-muted">/book/</span>
              <Input value={settings.slug ?? ''} placeholder="sagaboot"
                onChange={(e) => setSettings({ ...settings, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) })} />
            </div>
          </Field>
          <Field label="שם העסק בדף"><Input value={settings.title} onChange={(e) => setSettings({ ...settings, title: e.target.value })} /></Field>
          <Field label="כתובת"><Input value={settings.address} onChange={(e) => setSettings({ ...settings, address: e.target.value })} /></Field>
          <Field label="טלפון / וואטסאפ של העסק"><Input value={settings.phone} onChange={(e) => setSettings({ ...settings, phone: e.target.value })} inputMode="tel" dir="ltr" /></Field>
          <Field label="הודעה בראש הדף (לא חובה)"><Textarea value={settings.message} onChange={(e) => setSettings({ ...settings, message: e.target.value })} className="min-h-[70px]" placeholder="למשל: נא להגיע 5 דקות לפני. ביטול עד 24 שעות מראש." /></Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => saveSettings()} disabled={settings.enabled && !(settings.slug && settings.slug.length >= 3)}>שמירה</Button>
            {pageUrl && settings.enabled && <>
              <Button variant="ghost" onClick={() => { void navigator.clipboard?.writeText(pageUrl); flash('הקישור הועתק'); }}>העתקת קישור</Button>
              <a href={pageUrl} target="_blank" rel="noopener" className="text-sm font-semibold text-primary">פתיחת הדף ←</a>
            </>}
          </div>
          {pageUrl && <p className="mt-3 break-all text-xs text-muted" dir="ltr">{pageUrl}</p>}
          <p className="mt-3 text-xs text-muted">שמים את הקישור בביו של האינסטגרם, בוואטסאפ העסקי ובאתר.</p>
        </Card>
      )}

      <NewAppointment open={adding} onClose={() => { setAdding(false); setPrefill(null); }} services={services.filter((s) => s.active)} settings={settings} busy={active}
        staff={staff} ready={ready} prefill={prefill} phoneRequired={calendarOnly}
        onAddService={async (name, minutes) => {
          if (!userId) return { error: 'אין חיבור' };
          try {
            const id = await BookingAPI.saveService(userId, { name, minutes, price: null, active: true, sort: services.length });
            await load();
            return id ? { id } : { error: 'השירות נשמר — בחרו אותו מהרשימה.' };
          } catch (e) { return { error: bookingError(e) }; }
        }}
        onCreate={async (a, customer) => {
          if (!userId) return 'אין חיבור';
          const problem = customerProblem(leads, customer, calendarOnly);
          if (problem) return problem;
          let leadId = matchLead(leads, customer)?.id;
          // a new customer is saved first: the appointment points to it (before 2.52.1 the first appointment of a new
          // customer could reach the server before the customer did, and fail)
          if (!leadId) leadId = await addLeadNow({ name: customer.name, phone: customer.phone, source: 'תור', date: todayIL, status: 'נקבע תור', value: 0 });
          try {
            const created = await BookingAPI.create(userId, { ...a, leadId, name: customer.name, phone: customer.phone, email: '', note: customer.note, status: 'booked' });
            setAppts((all) => [...all, created].sort((x, y) => x.start.localeCompare(y.start)));
            addActivity(leadId, 'meeting', `נקבע תור: ${a.serviceName} · ${formatIL(a.start)}`);
            const l = leads.find((x) => x.id === leadId);
            if (l && l.status !== 'נסגר') updateLead(leadId, { status: 'נקבע תור' });
            return null;
          } catch (e) { return bookingError(e); }
        }} />

      <ContactSheet leadId={contactId} onClose={() => setContactId(null)} />
      {userId && <PhoneAlerts open={alertsOpen} onClose={() => setAlertsOpen(false)} userId={userId} />}
      <Modal open={Boolean(remindDay)} onClose={() => setRemindDay(null)}>
        <h3 className="mb-1 font-display text-xl font-extrabold">תזכורות ל{remindDay ? formatIL(israelToIso(remindDay, '12:00'), { weekday: 'long', day: 'numeric', month: 'long' }) : ''}</h3>
        <p className="mb-3 text-sm text-muted">כל לחיצה פותחת וואטסאפ עם הודעה מוכנה — מהוואטסאפ שלכם.</p>
        {!remindList ? <div className="py-6 text-center"><Spinner /></div> : !remindList.length ? <p className="text-sm text-muted">אין תורים ביום הזה.</p> : (
          <ul className="grid gap-2">
            {remindList.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line p-3">
                <span className="min-w-0"><strong className="block">{formatIL(a.start, { hour: '2-digit', minute: '2-digit' })} · {a.name}</strong>
                  <span className="text-xs text-muted">{a.serviceName}{a.phone ? ` · ${a.phone}` : ' · אין טלפון'}</span></span>
                {waLink(a.phone)
                  ? <Button size="sm" variant={reminded.has(a.id) ? 'ghost' : 'primary'} onClick={() => { remind(a); setReminded((x) => new Set(x).add(a.id)); }}>
                      {reminded.has(a.id) ? '✓ נשלח — שוב' : '💬 תזכורת'}</Button>
                  : <span className="text-xs text-warn">אין טלפון</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end"><Button variant="ghost" onClick={() => setRemindDay(null)}>סגירה</Button></div>
      </Modal>
      <AppointmentSheet appt={openAppt} staff={staff} ready={ready} version={version} extras={extras} where={where}
        onClose={() => setOpenId(null)} onContact={(id) => { setOpenId(null); setContactId(id); }}
        onSaved={(a) => { setAppts((all) => all.map((x) => (x.id === a.id ? a : x)).sort((x, y) => x.start.localeCompare(y.start))); setVersion((v) => v + 1); flash('נשמר'); }} />
      {depositFor && (
        <SendPaylinkDialog kind="deposit" target={depositFor.id} left={depositOf(depositFor)} maxDays={depositDays(depositFor.start)}
          what={`מקדמה לתור: ${depositFor.serviceName} · ${formatIL(depositFor.start)} · ${depositFor.name}`}
          customer={{ name: depositFor.name, phone: depositFor.phone, email: depositFor.email }}
          onClose={() => setDepositFor(null)} onSent={() => void depLinks.reload()} />
      )}
    </>
  );
}

/** a deposit typed by the owner: '' = none; else a sum of more than zero, up to the price (the database checks it again) */
export function depositError(raw: string, price: number | null): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(t) || !(Number(t) > 0)) return 'המקדמה: סכום בשקלים, גדול מאפס.';
  if (price != null && Number(t) > price) return 'המקדמה לא יכולה להיות גדולה ממחיר השירות.';
  return null;
}

/**
 * The treatments (services): a name and a default length each — an appointment may still end at another hour ("סיום").
 * 2.110: a calendar member ("יומן ולידים") adds and changes them too, never the price or the deposit (`money` = false) and
 * never deletes — hides (the database: b_booking_services_calendar_money, migration 20261030006100).
 */
const LENGTHS = [10, 15, 20, 30, 40, 45, 60, 75, 90, 120, 180];
function ServicesTab({ userId, services, money, onChange, onError }: { userId: string; services: BookingServiceRow[]; money: boolean; onChange: () => void; onError: (e: unknown) => void }) {
  const [draft, setDraft] = useState({ name: '', minutes: '30', price: '', deposit: '' });
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string; minutes: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const draftProblem = !draft.name.trim() ? 'שם הטיפול' : lengthProblem(Number(draft.minutes));
  async function add() {
    if (draftProblem) return;
    const price = !money || draft.price === '' ? null : Number(draft.price);
    const bad = money ? depositError(draft.deposit, price) : null;
    if (bad) { setErr(bad); return; }
    setErr(null);
    try {
      await BookingAPI.saveService(userId, { name: draft.name, minutes: Number(draft.minutes), price, active: true, sort: services.length,
        ...(money && draft.deposit.trim() ? { deposit: Number(draft.deposit) } : {}) });
      setDraft({ name: '', minutes: '30', price: '', deposit: '' }); onChange();
    } catch (e) { onError(e); }
  }
  async function saveDeposit(s: BookingServiceRow, value: string) {
    const bad = depositError(value, s.price);
    if (bad) { setErr(bad); return; }
    setErr(null);
    try { await BookingAPI.saveService(userId, { ...s, deposit: value.trim() ? Number(value) : null }); setEditing(null); onChange(); } catch (e) { onError(e); }
  }
  async function saveName(s: BookingServiceRow) {
    if (!renaming) return;
    const bad = !renaming.name.trim() ? 'חסר שם לטיפול.' : lengthProblem(Number(renaming.minutes));
    if (bad) { setErr(bad); return; }
    setErr(null);
    try { await BookingAPI.saveService(userId, { ...s, name: renaming.name, minutes: Number(renaming.minutes) }); setRenaming(null); onChange(); } catch (e) { onError(e); }
  }
  return (
    <div className="grid gap-3">
      {err && <p className="rounded-2xl bg-warn/10 p-3 text-sm text-warn">{err}</p>}
      <datalist id="svc-lengths">{LENGTHS.map((m) => <option key={m} value={m} />)}</datalist>
      <Card className="p-3">
        <p className="mb-2 text-sm font-semibold">+ שירות חדש</p>
        <div className={cx('grid gap-2', money ? 'sm:grid-cols-[1fr_120px_120px_120px_auto]' : 'sm:grid-cols-[1fr_140px_auto]')}>
          <Input value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="למשל: לייזר — ידיים" aria-label="שם הטיפול" />
          <Input type="number" inputMode="numeric" min={5} max={480} step={5} value={draft.minutes} onChange={(e) => setDraft({ ...draft, minutes: e.target.value })} list="svc-lengths" aria-label="משך (דקות)" />
          {money && <Input type="number" inputMode="decimal" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} placeholder="מחיר ₪ (לא חובה)" />}
          {money && <Input type="number" inputMode="decimal" value={draft.deposit} onChange={(e) => setDraft({ ...draft, deposit: e.target.value })} placeholder="מקדמה ₪ (לא חובה)" aria-label="מקדמה" />}
          <Button variant="primary" onClick={add} disabled={Boolean(draftProblem)}>הוספה</Button>
        </div>
        {draft.name.trim() && draftProblem && <p className="mt-1 text-xs text-warn">{draftProblem}</p>}
      </Card>
      <p className="text-xs text-muted">המשך הוא ברירת המחדל של תור חדש. בכל תור אפשר לקבוע שעת סיום אחרת.</p>
      {services.map((s) => (
        <Card key={s.id} className="min-w-0 p-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1"><strong className={cx('block truncate', !s.active && 'text-muted line-through')}>{s.name}</strong>
              <span className="text-xs text-muted">{s.minutes} דק׳{money && s.price != null ? ` · ₪${s.price}` : ''}{money && s.deposit ? ` · מקדמה ₪${s.deposit}` : ''}</span></span>
            <Button size="sm" variant="ghost" onClick={() => setRenaming(renaming?.id === s.id ? null : { id: s.id, name: s.name, minutes: String(s.minutes) })}>עריכה</Button>
            {money && s.deposit !== undefined && <Button size="sm" variant="ghost" onClick={() => setEditing(editing?.id === s.id ? null : { id: s.id, value: s.deposit ? String(s.deposit) : '' })}>מקדמה</Button>}
            <Button size="sm" variant="ghost" onClick={async () => { try { await BookingAPI.saveService(userId, { ...s, active: !s.active }); onChange(); } catch (e) { onError(e); } }}>{s.active ? 'הסתרה' : 'הצגה'}</Button>
            {money && <Button size="sm" variant="ghost" onClick={async () => { if (!window.confirm(`למחוק את "${s.name}"? תורים קיימים יישארו.`)) return; try { await BookingAPI.deleteService(s.id); onChange(); } catch (e) { onError(e); } }}>מחיקה</Button>}
          </div>
          {renaming?.id === s.id && (
            <form className="mt-2 grid gap-2 sm:grid-cols-[1fr_140px_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); void saveName(s); }}>
              <Field label="שם הטיפול"><Input value={renaming.name} maxLength={80} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} /></Field>
              <Field label="משך (דקות)"><Input type="number" inputMode="numeric" min={5} max={480} step={5} value={renaming.minutes} onChange={(e) => setRenaming({ ...renaming, minutes: e.target.value })} list="svc-lengths" /></Field>
              <Button size="sm" variant="primary" type="submit">שמירה</Button>
            </form>
          )}
          {money && editing?.id === s.id && (
            <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void saveDeposit(s, editing.value); }}>
              <Field label="מקדמה ₪ (ריק = בלי מקדמה)"><Input value={editing.value} onChange={(e) => setEditing({ id: s.id, value: e.target.value })} inputMode="decimal" dir="ltr" className="w-32" /></Field>
              <Button size="sm" variant="primary" type="submit">שמירה</Button>
              <p className="w-full text-xs text-muted">בהזמנה אונליין הלקוח/ה מקבלים לינק לתשלום המקדמה (רק ממסוף סליקה מאומת); המקדמה תקוזז מהתשלום על התור.</p>
            </form>
          )}
        </Card>
      ))}
    </div>
  );
}

/** "22.4.2027" */
const dateLabel = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(0, 4)}`;

function HoursTab({ settings, onChange, onSave }: { settings: BookingSettings; onChange: (s: BookingSettings) => void; onSave: () => void }) {
  const [closed, setClosed] = useState('');
  // 2.106: "סגירה בחגים" — the festival days of the coming year (holidays.ts) added to the closed days; the ones there stay
  const [holidayNote, setHolidayNote] = useState<string | null>(null);
  const closeHolidays = () => {
    const today = israelParts(Date.now()).date;
    const added = festivalDays(today, addDays(today, 365)).filter((d) => !settings.closedDates.includes(d));
    if (added.length) onChange({ ...settings, closedDates: [...settings.closedDates, ...added].sort() });
    setHolidayNote(added.length ? `נוספו ${added.length === 1 ? 'יום חג אחד' : `${added.length} ימי חג`} — כדי שיישמרו, לחצו "שמירת שעות".` : 'כל ימי החג של השנה הקרובה כבר בימים הסגורים.');
  };
  const holidayOf = (d: string) => (holidaysIn(d, d).get(d) ?? []).map((h) => h.name).join(' · ');
  const setDay = (d: number, ranges: [string, string][]) => {
    const hours: Hours = { ...settings.hours };
    if (ranges.length) hours[String(d)] = ranges; else delete hours[String(d)];
    onChange({ ...settings, hours });
  };
  return (
    <Card className="p-4">
      <div className="grid gap-2">
        {DAYS.map((name, d) => {
          const r = settings.hours[String(d)] ?? [];
          const open = r.length > 0;
          return (
            <div key={d} className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface-2 px-3 py-2">
              <label className="flex w-24 items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={open} onChange={(e) => setDay(d, e.target.checked ? [['09:00', '17:00']] : [])} />{name}
              </label>
              {open ? r.map((rg, i) => (
                <span key={i} className="flex items-center gap-1" dir="ltr">
                  <Input type="time" value={rg[0]} className="h-9 w-[104px] py-1" onChange={(e) => setDay(d, r.map((x, k) => (k === i ? [e.target.value, x[1]] : x)) as [string, string][])} aria-label={`${name} מ-`} />
                  <span>–</span>
                  <Input type="time" value={rg[1]} className="h-9 w-[104px] py-1" onChange={(e) => setDay(d, r.map((x, k) => (k === i ? [x[0], e.target.value] : x)) as [string, string][])} aria-label={`${name} עד`} />
                  {i > 0 && <button type="button" className="text-xs text-muted" onClick={() => setDay(d, r.filter((_, k) => k !== i))}>✕</button>}
                </span>
              )) : <span className="text-sm text-muted">סגור</span>}
              {open && r.length < 2 && <button type="button" className="text-xs text-primary" onClick={() => setDay(d, [...r, ['16:00', '19:00']])}>+ משמרת שנייה</button>}
            </div>
          );
        })}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Field label="מרווח בין שעות">
          <Select value={settings.slotMinutes} onChange={(e) => onChange({ ...settings, slotMinutes: Number(e.target.value) })}>
            {[10, 15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>כל {m} דקות</option>)}
          </Select>
        </Field>
        <Field label="הזמנה לפחות">
          <Select value={settings.minNoticeMinutes} onChange={(e) => onChange({ ...settings, minNoticeMinutes: Number(e.target.value) })}>
            {[[0, 'בלי הגבלה'], [60, 'שעה מראש'], [120, 'שעתיים מראש'], [240, '4 שעות מראש'], [1440, 'יום מראש']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="אפשר לקבוע עד">
          <Select value={settings.maxDaysAhead} onChange={(e) => onChange({ ...settings, maxDaysAhead: Number(e.target.value) })}>
            {[7, 14, 30, 60, 90].map((v) => <option key={v} value={v}>{v} ימים קדימה</option>)}
          </Select>
        </Field>
      </div>
      <Field label="ימים סגורים (חג, חופשה)">
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={closed} onChange={(e) => setClosed(e.target.value)} className="h-9 w-auto py-1" />
          <Button size="sm" variant="ghost" onClick={() => { if (closed && !settings.closedDates.includes(closed)) onChange({ ...settings, closedDates: [...settings.closedDates, closed].sort() }); setClosed(''); }}>הוספה</Button>
          <Button size="sm" variant="ghost" onClick={closeHolidays}>סגירה בחגים</Button>
          {settings.closedDates.map((d) => (
            <Chip key={d} on onClick={() => onChange({ ...settings, closedDates: settings.closedDates.filter((x) => x !== d) })}
              aria-label={`${dateLabel(d)}${holidayOf(d) ? ` ${holidayOf(d)}` : ''} — הסרה`}>
              <span dir="ltr">{dateLabel(d)}</span>{holidayOf(d) ? ` · ${holidayOf(d)}` : ''} ✕
            </Chip>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">"סגירה בחגים" סוגר לקביעה בדף ההזמנה (ללקוחות) את ימי החג של השנה הקרובה: ראש השנה, יום כיפור, סוכות, שמחת תורה, פסח, שביעי של פסח ושבועות. ביומן עצמו קובעים בהם תורים כרגיל. לחיצה על יום מורידה אותו.</p>
        {holidayNote && <p className="mt-1 text-sm font-semibold text-primary" role="status">{holidayNote}</p>}
      </Field>
      <Button variant="primary" onClick={onSave}>שמירת שעות</Button>
    </Card>
  );
}

function NewAppointment({ open, onClose, services, settings, busy, staff, ready, prefill, phoneRequired, onAddService, onCreate }: {
  open: boolean; onClose: () => void; services: BookingServiceRow[]; settings: BookingSettings; busy: Appointment[];
  /** 2.105: the team for the calendar, whether migration 5700 is there, and the day / hour / practitioner tapped on the calendar */
  staff: CalStaff[]; ready: boolean; prefill: { date: string; time: string; staffId: string } | null;
  /** 2.109: a calendar member — a new customer only with a phone */
  phoneRequired: boolean;
  /** 2.110.2: "+ שירות חדש" from the appointment itself — a name and a length (no price: the owner sets it in "שירותים") */
  onAddService: (name: string, minutes: number) => Promise<{ id: string } | { error: string }>;
  onCreate: (a: { serviceId: string; serviceName: string; start: string; end: string; locationId?: string; staffId?: string | null }, customer: { name: string; phone: string; note: string }) => Promise<string | null>;
}) {
  const { userId, leads } = useApp();
  const pract = practitioners(staff);
  const [staffId, setStaffId] = useState('');
  const [staffTouched, setStaffTouched] = useState(false);
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState(israelParts(Date.now()).date);
  // the hours taken on the day chosen, read for that day (2.105: a view of the calendar loads only its own days); until then — the view's
  const [dayBusy, setDayBusy] = useState<Appointment[] | null>(null);
  useEffect(() => {
    if (!open || !userId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    let live = true;
    setDayBusy(null);
    BookingAPI.appointments(userId, israelToIso(date, '00:00'), israelToIso(addDays(date, 1), '00:00'))
      .then((list) => { if (live) setDayBusy(list.filter((a) => a.status !== 'cancelled')); }, () => { if (live) setDayBusy(null); });
    return () => { live = false; };
  }, [open, date, userId]);
  const taken = dayBusy ?? busy;
  // T12א: appointments overlap only within a location — the free hours are the chosen location's (one location: as before);
  // 2.105: with a practitioner — hers, wherever they are; without one — the location's appointments that have none
  const locState = useLocations((x) => x.state);
  const [locationId, setLocationId] = useState<string | null>(null);
  const at = locationColumn(locState, locationId).location_id;
  const here = useMemo(() => {
    if (ready && staffId) return taken.filter((b) => b.staffId === staffId);
    const atHere = locState.businessId ? atLocation(taken, at, locState.businessId) : taken;
    return ready ? atHere.filter((b) => !b.staffId) : atHere;
  }, [taken, at, locState.businessId, ready, staffId]);
  const [newService, setNewService] = useState<{ name: string; minutes: string; busy: boolean; error: string | null } | null>(null);
  async function addService() {
    if (!newService) return;
    const bad = !newService.name.trim() ? 'חסר שם לשירות.' : lengthProblem(Number(newService.minutes));
    if (bad) { setNewService({ ...newService, error: bad }); return; }
    setNewService({ ...newService, busy: true, error: null });
    const r = await onAddService(newService.name.trim(), Number(newService.minutes));
    if ('id' in r) { setServiceId(r.id); setTime(''); setNewService(null); }
    else setNewService({ ...newService, busy: false, error: r.error });
  }
  const [time, setTime] = useState('');
  // 2.110: until what hour — the treatment's length, unless set by hand for this appointment
  const [endTime, setEndTime] = useState('');
  const [endTouched, setEndTouched] = useState(false);
  const [customer, setCustomer] = useState({ name: '', phone: '', note: '' });
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const service = services.find((s) => s.id === serviceId) ?? services[0];
  // the business books outside the public rules (no notice, any day — 2.106: Friday, Saturday and the holidays too, in the usual
  // hours when they have none); overlaps are still blocked
  const slots = useMemo(() => service ? freeSlots(date, service.minutes, {
    ...settings, hours: calendarHours(settings.hours, date, chagDay(holidaysIn(date, date).get(date) ?? [])), minNoticeMinutes: 0, maxDaysAhead: 365, closedDates: [],
  }, here.map((b) => ({ start: b.start, end: b.end }))) : [], [service, date, settings, here]);
  useEffect(() => {
    if (!open) return;
    setErr(null);
    setDate(prefill?.date || israelParts(Date.now()).date);
    setTime(prefill?.time ?? '');
    setEndTouched(false);
    setNewService(null);
    setStaffId(prefill?.staffId ?? '');
    setStaffTouched(Boolean(prefill?.staffId));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // the end follows the start and the treatment until it is set by hand
  useEffect(() => { if (!endTouched) setEndTime(service && time ? defaultEnd(time, service.minutes) : ''); }, [time, service?.id, service?.minutes, endTouched]); // eslint-disable-line react-hooks/exhaustive-deps
  const timeProblem = time ? timesProblem(time, endTime) : null;
  async function create() {
    if (!service || !time || !customer.name.trim()) return;
    if (timeProblem) { setErr(timeProblem); return; }
    setSaving(true);
    const { start, end } = apptRange(date, time, endTime);
    const e = await onCreate({ serviceId: service.id, serviceName: service.name, start, end, ...(at ? { locationId: at } : {}), ...(ready && staffId ? { staffId } : {}) }, { ...customer, name: customer.name.trim() });
    setSaving(false);
    if (e) setErr(e); else { setCustomer({ name: '', phone: '', note: '' }); onClose(); }
  }
  return (
    <Modal open={open} onClose={onClose}>
      <h3 className="mb-4 font-display text-xl font-extrabold">תור חדש</h3>
      <Field label="שירות">
        <Select value={service?.id ?? ''} onChange={(e) => { setServiceId(e.target.value); setTime(''); }}>
          {services.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.minutes} דק׳</option>)}
        </Select>
      </Field>
      {!newService ? (
        <button type="button" className="-mt-2 mb-3 text-sm font-semibold text-primary" onClick={() => setNewService({ name: '', minutes: '30', busy: false, error: null })}>+ שירות חדש</button>
      ) : (
        <div className="mb-3 rounded-2xl border border-line p-3" role="group" aria-label="שירות חדש">
          <div className="grid gap-2 sm:grid-cols-[1fr_120px]">
            <Field label="שם השירות"><Input value={newService.name} maxLength={80} autoFocus placeholder="למשל: לייזר — גב" onChange={(e) => setNewService({ ...newService, name: e.target.value, error: null })} /></Field>
            <Field label="משך (דקות)"><Input type="number" inputMode="numeric" min={5} max={480} step={5} list="new-svc-lengths" value={newService.minutes} onChange={(e) => setNewService({ ...newService, minutes: e.target.value, error: null })} /></Field>
          </div>
          <datalist id="new-svc-lengths">{[15, 20, 30, 40, 45, 60, 75, 90, 120].map((m) => <option key={m} value={m} />)}</datalist>
          {newService.error && <p className="mb-2 text-sm text-warn">{newService.error}</p>}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={newService.busy || !newService.name.trim()} onClick={() => void addService()}>{newService.busy ? 'שומר…' : 'שמירת השירות'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setNewService(null)}>ביטול</Button>
          </div>
        </div>
      )}
      <LocationField value={locationId} onChange={(id) => { setLocationId(id); setTime(''); }} />
      {ready && pract.length > 0 && (
        <Field label="מטפל/ת">
          <Select value={staffId} onChange={(e) => { setStaffId(e.target.value); setStaffTouched(true); setTime(''); }}>
            <option value="">בלי מטפל/ת (לשיבוץ אחר כך)</option>
            {pract.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </Field>
      )}
      <Field label="תאריך"><Input type="date" value={date} onChange={(e) => { setDate(e.target.value); setTime(''); }} /></Field>
      <p className="mb-1.5 text-sm font-semibold">שעה</p>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {slots.slice(0, 40).map((s) => <Chip key={s.start} on={time === s.time} onClick={() => setTime(s.time)}>{s.time}</Chip>)}
        {!slots.length && <span className="text-sm text-muted">אין שעות פנויות לפי שעות הפעילות.</span>}
      </div>
      <div className="flex flex-wrap gap-x-3">
        <Field label="או שעה אחרת"><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-auto" /></Field>
        <Field label="סיום"><Input type="time" value={endTime} step={300} onChange={(e) => { setEndTime(e.target.value); setEndTouched(true); }} className="w-auto" disabled={!time} /></Field>
      </div>
      <DurationPicker start={time} end={endTime} onPick={(e) => { setEndTime(e); setEndTouched(true); }} disabled={!time} />
      {time && timeProblem && <p className="mb-2 text-sm text-warn">{timeProblem}</p>}
      <Field label="שם הלקוח/ה">
        <Input list="crm-names" value={customer.name} onChange={(e) => {
          const name = e.target.value; const l = leads.find((x) => x.name === name);
          setCustomer({ ...customer, name, phone: l?.phone ?? customer.phone });
          if (!staffTouched && l?.assignedStaffId && pract.some((x) => x.id === l.assignedStaffId)) setStaffId(l.assignedStaffId);
        }} />
        <datalist id="crm-names">{leads.slice(0, 300).map((l) => <option key={l.id} value={l.name} />)}</datalist>
      </Field>
      <Field label={phoneRequired && !matchLead(leads, customer) ? 'טלפון (חובה ללקוח/ה חדש/ה)' : 'טלפון'}><Input value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} inputMode="tel" dir="ltr" /></Field>
      <Field label="הערה (לא חובה)"><Input value={customer.note} onChange={(e) => setCustomer({ ...customer, note: e.target.value })} /></Field>
      {err && <p className="mb-3 text-sm text-warn">{err}</p>}
      <div className="flex gap-3">
        <Button variant="primary" onClick={create} disabled={saving || !time || Boolean(timeProblem) || Boolean(customerProblem(leads, customer, phoneRequired))}>{saving ? 'שומר…' : 'קביעת התור'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}
