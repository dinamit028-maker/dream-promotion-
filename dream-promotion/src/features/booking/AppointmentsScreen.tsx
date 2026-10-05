'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { isCloudConfigured } from '@/lib/supabase/client';
import { Button, Card, Chip, Field, Input, PageHead, Select, Textarea } from '@/components/ui/primitives';
import { EmptyState, Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL, israelParts, israelToIso } from '@/lib/il-time';
import { CalendarPlus } from '@/components/ui/Icon';
import { phoneDigits, telLink, waLink } from '@/features/crm/crm';
import { ContactSheet } from '@/features/crm/ContactSheet';
import { freeSlots, reminderText, type Hours } from './slots';
import { BookingAPI, DEFAULT_SETTINGS, bookingError, type Appointment, type ApptStatus, type BookingServiceRow, type BookingSettings } from './booking.service';

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const STATUS: Record<ApptStatus, { label: string; tone: string }> = {
  booked: { label: 'נקבע', tone: 'bg-sky-500/15 text-sky-600 dark:text-sky-300' },
  confirmed: { label: 'אושר', tone: 'bg-violet-500/15 text-violet-600 dark:text-violet-300' },
  done: { label: 'הגיע/ה', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  no_show: { label: 'לא הגיע/ה', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  cancelled: { label: 'בוטל', tone: 'bg-zinc-500/15 text-zinc-500' },
};
const hm = (iso: string) => israelParts(new Date(iso)).time;

/** Appointments: the agenda, services, opening hours and the public booking page (toolbox stage 2). */
export function AppointmentsScreen() {
  const { userId, brand, leads, addLeadNow, addActivity, updateLead } = useApp();
  const [tab, setTab] = useState<'agenda' | 'services' | 'hours' | 'page'>('agenda');
  const [settings, setSettings] = useState<BookingSettings>(DEFAULT_SETTINGS);
  const [services, setServices] = useState<BookingServiceRow[]>([]);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [contactId, setContactId] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true); setError(null);
    try {
      const from = israelToIso(israelParts(Date.now() - (showPast ? 30 : 0) * 864e5).date, '00:00');
      const to = new Date(Date.now() + 120 * 864e5).toISOString();
      const [s, sv, ap] = await Promise.all([BookingAPI.settings(userId), BookingAPI.services(userId), BookingAPI.appointments(userId, from, to)]);
      setSettings(s.slug ? s : { ...s, title: s.title || brand.name, address: s.address || brand.city || '' });
      setServices(sv); setAppts(ap);
    } catch (e) { setError(bookingError(e)); }
    finally { setLoading(false); }
  }, [userId, showPast, brand.name, brand.city]);
  useEffect(() => { void load(); }, [load]);

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
  const todayIL = israelParts(Date.now()).date;
  const pageUrl = settings.slug && typeof window !== 'undefined' ? `${window.location.origin}/book/${settings.slug}` : '';

  async function setStatus(a: Appointment, status: ApptStatus) {
    try {
      await BookingAPI.setStatus(a.id, status);
      setAppts((all) => all.map((x) => (x.id === a.id ? { ...x, status } : x)));
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

  return (
    <>
      <PageHead title="תורים" sub={`${active.filter((a) => a.start >= new Date().toISOString()).length} תורים קרובים`}
        action={<Button variant="primary" onClick={() => setAdding(true)} disabled={!services.length}>+ תור</Button>} />

      <div className="mb-5 flex gap-1.5 overflow-x-auto pb-1">
        {([['agenda', 'יומן תורים'], ['services', 'שירותים'], ['hours', 'שעות פעילות'], ['page', 'דף הזמנה']] as const).map(([k, l]) => (
          <Chip key={k} on={tab === k} onClick={() => setTab(k)}>{l}</Chip>
        ))}
      </div>
      {error && <p className="mb-4 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p>}
      {saved && <p className="mb-4 text-sm font-semibold text-emerald-600">✓ {saved}</p>}
      {loading && <div className="py-8 text-center"><Spinner /></div>}

      {!loading && tab === 'agenda' && (
        !services.length ? (
          <EmptyState icon={<CalendarPlus />} title="מתחילים בשירותים" body="הוסיפו את מה שאפשר לקבוע (למשל: טיפול לייזר · 45 דקות), ואז קבעו שעות פעילות."
            action={<Button variant="primary" onClick={() => setTab('services')}>הוספת שירות</Button>} />
        ) : (
          <>
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
                  <h3 className={cx('mb-2 text-sm font-bold', d === todayIL ? 'text-primary' : 'text-ink-2')}>
                    {d === todayIL ? 'היום · ' : ''}{formatIL(israelToIso(d, '12:00'), { weekday: 'long', day: 'numeric', month: 'long' })}
                  </h3>
                  <div className="grid grid-cols-1 gap-2">
                    {list.map((a) => (
                      <Card key={a.id} className="min-w-0 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <button type="button" className="min-w-0 text-start" onClick={() => a.leadId && setContactId(a.leadId)}>
                            <span className="block font-bold tabular-nums">{hm(a.start)}–{hm(a.end)} · <span className="font-semibold">{a.name}</span></span>
                            <span className="block truncate text-xs text-muted">{a.serviceName}{a.source === 'public' ? ' · הוזמן אונליין' : ''}{a.note ? ` · "${a.note}"` : ''}</span>
                          </button>
                          <span className={cx('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold', STATUS[a.status].tone)}>{STATUS[a.status].label}</span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {waLink(a.phone) && a.status !== 'done' && <Button size="sm" variant="ghost" onClick={() => remind(a)}>💬 תזכורת</Button>}
                          {a.phone && <a href={telLink(a.phone)} className="rounded-full border border-line px-3 py-1 text-sm">📞</a>}
                          {a.status !== 'cancelled' && a.status !== 'no_show' && (() => {
                            const price = services.find((x) => x.id === a.serviceId)?.price;
                            const q = new URLSearchParams({ name: a.name, phone: a.phone, appt: a.id, item: a.serviceName || 'טיפול', price: String(price ?? 0), ...(a.leadId ? { lead: a.leadId } : {}) });
                            return <a href={`/register?${q}`} className="rounded-full border border-line px-3 py-1 text-sm">💳 חיוב</a>;
                          })()}
                          {a.status === 'booked' && <Button size="sm" variant="ghost" onClick={() => setStatus(a, 'confirmed')}>אישור</Button>}
                          {(a.status === 'booked' || a.status === 'confirmed') && <>
                            <Button size="sm" variant="ghost" onClick={() => setStatus(a, 'done')}>הגיע/ה</Button>
                            <Button size="sm" variant="ghost" onClick={() => setStatus(a, 'no_show')}>לא הגיע/ה</Button>
                            <Button size="sm" variant="ghost" onClick={() => { if (window.confirm('לבטל את התור? השעה תתפנה.')) void setStatus(a, 'cancelled'); }}>ביטול</Button>
                          </>}
                        </div>
                      </Card>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )
      )}

      {!loading && tab === 'services' && <ServicesTab userId={userId} services={services} onChange={load} onError={(e) => setError(bookingError(e))} />}

      {!loading && tab === 'hours' && (
        <HoursTab settings={settings} onChange={setSettings} onSave={() => saveSettings()} />
      )}

      {!loading && tab === 'page' && (
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

      <NewAppointment open={adding} onClose={() => setAdding(false)} services={services.filter((s) => s.active)} settings={settings} busy={active}
        onCreate={async (a, customer) => {
          if (!userId) return 'אין חיבור';
          let leadId = leads.find((l) => customer.phone && phoneDigits(l.phone) === phoneDigits(customer.phone))?.id
            ?? leads.find((l) => !customer.phone && l.name === customer.name)?.id;
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
    </>
  );
}

function ServicesTab({ userId, services, onChange, onError }: { userId: string; services: BookingServiceRow[]; onChange: () => void; onError: (e: unknown) => void }) {
  const [draft, setDraft] = useState({ name: '', minutes: 30, price: '' });
  async function add() {
    if (!draft.name.trim()) return;
    try { await BookingAPI.saveService(userId, { name: draft.name, minutes: draft.minutes, price: draft.price === '' ? null : Number(draft.price), active: true, sort: services.length }); setDraft({ name: '', minutes: 30, price: '' }); onChange(); }
    catch (e) { onError(e); }
  }
  return (
    <div className="grid gap-3">
      {services.map((s) => (
        <Card key={s.id} className="flex min-w-0 flex-wrap items-center gap-2 p-3">
          <span className="min-w-0 flex-1"><strong className={cx('block truncate', !s.active && 'text-muted line-through')}>{s.name}</strong><span className="text-xs text-muted">{s.minutes} דק׳{s.price != null ? ` · ₪${s.price}` : ''}</span></span>
          <Button size="sm" variant="ghost" onClick={async () => { try { await BookingAPI.saveService(userId, { ...s, active: !s.active }); onChange(); } catch (e) { onError(e); } }}>{s.active ? 'הסתרה' : 'הצגה'}</Button>
          <Button size="sm" variant="ghost" onClick={async () => { if (!window.confirm(`למחוק את "${s.name}"? תורים קיימים יישארו.`)) return; try { await BookingAPI.deleteService(s.id); onChange(); } catch (e) { onError(e); } }}>מחיקה</Button>
        </Card>
      ))}
      <Card className="p-3">
        <p className="mb-2 text-sm font-semibold">שירות חדש</p>
        <div className="grid gap-2 sm:grid-cols-[1fr_120px_120px_auto]">
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="למשל: הסרת שיער בלייזר — פנים" />
          <Select value={draft.minutes} onChange={(e) => setDraft({ ...draft, minutes: Number(e.target.value) })} aria-label="משך">
            {[10, 15, 20, 30, 45, 60, 75, 90, 120, 180].map((m) => <option key={m} value={m}>{m} דקות</option>)}
          </Select>
          <Input type="number" inputMode="decimal" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} placeholder="מחיר ₪ (לא חובה)" />
          <Button variant="primary" onClick={add} disabled={!draft.name.trim()}>הוספה</Button>
        </div>
      </Card>
    </div>
  );
}

function HoursTab({ settings, onChange, onSave }: { settings: BookingSettings; onChange: (s: BookingSettings) => void; onSave: () => void }) {
  const [closed, setClosed] = useState('');
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
          {settings.closedDates.map((d) => <Chip key={d} on onClick={() => onChange({ ...settings, closedDates: settings.closedDates.filter((x) => x !== d) })}>{d} ✕</Chip>)}
        </div>
      </Field>
      <Button variant="primary" onClick={onSave}>שמירת שעות</Button>
    </Card>
  );
}

function NewAppointment({ open, onClose, services, settings, busy, onCreate }: {
  open: boolean; onClose: () => void; services: BookingServiceRow[]; settings: BookingSettings; busy: Appointment[];
  onCreate: (a: { serviceId: string; serviceName: string; start: string; end: string }, customer: { name: string; phone: string; note: string }) => Promise<string | null>;
}) {
  const { leads } = useApp();
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState(israelParts(Date.now()).date);
  const [time, setTime] = useState('');
  const [customer, setCustomer] = useState({ name: '', phone: '', note: '' });
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const service = services.find((s) => s.id === serviceId) ?? services[0];
  // the owner may book outside the public rules (no notice, any open day); overlaps are still blocked
  const slots = useMemo(() => service ? freeSlots(date, service.minutes, { ...settings, minNoticeMinutes: 0, maxDaysAhead: 365, closedDates: [] }, busy.map((b) => ({ start: b.start, end: b.end }))) : [], [service, date, settings, busy]);
  useEffect(() => { if (open) { setErr(null); setTime(''); } }, [open]);

  async function create() {
    if (!service || !time || !customer.name.trim()) return;
    setSaving(true);
    const start = israelToIso(date, time);
    const end = new Date(new Date(start).getTime() + service.minutes * 60_000).toISOString();
    const e = await onCreate({ serviceId: service.id, serviceName: service.name, start, end }, { ...customer, name: customer.name.trim() });
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
      <Field label="תאריך"><Input type="date" value={date} onChange={(e) => { setDate(e.target.value); setTime(''); }} /></Field>
      <p className="mb-1.5 text-sm font-semibold">שעה</p>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {slots.slice(0, 40).map((s) => <Chip key={s.start} on={time === s.time} onClick={() => setTime(s.time)}>{s.time}</Chip>)}
        {!slots.length && <span className="text-sm text-muted">אין שעות פנויות לפי שעות הפעילות.</span>}
      </div>
      <Field label="או שעה אחרת"><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-auto" /></Field>
      <Field label="שם הלקוח/ה">
        <Input list="crm-names" value={customer.name} onChange={(e) => {
          const name = e.target.value; const l = leads.find((x) => x.name === name);
          setCustomer({ ...customer, name, phone: l?.phone ?? customer.phone });
        }} />
        <datalist id="crm-names">{leads.slice(0, 300).map((l) => <option key={l.id} value={l.name} />)}</datalist>
      </Field>
      <Field label="טלפון"><Input value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} inputMode="tel" dir="ltr" /></Field>
      <Field label="הערה (לא חובה)"><Input value={customer.note} onChange={(e) => setCustomer({ ...customer, note: e.target.value })} /></Field>
      {err && <p className="mb-3 text-sm text-warn">{err}</p>}
      <div className="flex gap-3">
        <Button variant="primary" onClick={create} disabled={saving || !time || !customer.name.trim()}>{saving ? 'שומר…' : 'קביעת התור'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}
