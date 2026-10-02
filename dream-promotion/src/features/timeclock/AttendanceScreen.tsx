'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { supabase, isCloudConfigured } from '@/lib/supabase/client';
import { Button, Card, Chip, Field, Input, PageHead } from '@/components/ui/primitives';
import { EmptyState, Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL, israelParts, israelToIso } from '@/lib/il-time';
import { IdentificationBadge } from '@/components/ui/Icon';
import { waLink } from '@/features/crm/crm';
import { dayOf, hhmm, minutesOf, monthRange, newToken, reportCsv, totals, type Employee, type Entry } from './hours';

/** Owner side of the time clock (toolbox stage 6). Runs with the owner's session — RLS separates businesses. */
const toEmp = (r: any): Employee => ({ id: r.id, name: r.name, phone: r.phone ?? '', hourlyRate: r.hourly_rate == null ? null : Number(r.hourly_rate), active: r.active, token: r.token });
const toEntry = (r: any): Entry => ({ id: r.id, employeeId: r.employee_id, clockIn: r.clock_in, clockOut: r.clock_out, edited: r.edited, source: r.source, note: r.note ?? '', inLat: r.in_lat, inLng: r.in_lng });
const errText = (e: any) => {
  const m = String(e?.message ?? e ?? '');
  if (/relation .* does not exist|schema cache/i.test(m)) return 'צריך להריץ את מיגרציית שעון הנוכחות ב-Supabase (20261003001100).';
  if (e?.code === '23505' || /time_entries_one_open/.test(m)) return 'לעובד/ת הזה/ו כבר יש משמרת פתוחה.';
  if (/time_entries_check|check constraint/i.test(m)) return 'שעת היציאה חייבת להיות אחרי שעת הכניסה.';
  return 'משהו השתבש. נסו שוב.';
};
const time = (iso: string) => israelParts(new Date(iso)).time;

export function AttendanceScreen() {
  const { userId, brand } = useApp();
  const [tab, setTab] = useState<'now' | 'report' | 'team'>('now');
  const [emps, setEmps] = useState<Employee[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [month, setMonth] = useState(israelParts(Date.now()).date.slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [editing, setEditing] = useState<Entry | { employeeId: string } | null>(null);
  const [openEmp, setOpenEmp] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', rate: '' });
  const [tick, setTick] = useState(Date.now());

  const { from, to } = monthRange(month);
  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true); setError(null);
    try {
      const sb = supabase();
      const fromIso = israelToIso(from, '00:00');
      const toIso = new Date(new Date(israelToIso(to, '00:00')).getTime() + 864e5).toISOString();
      const [e, t, open] = await Promise.all([
        sb.from('employees').select('*').eq('user_id', userId).order('created_at'),
        sb.from('time_entries').select('*').eq('user_id', userId).gte('clock_in', fromIso).lt('clock_in', toIso).order('clock_in'),
        sb.from('time_entries').select('*').eq('user_id', userId).is('clock_out', null),
      ]);
      if (e.error) throw e.error; if (t.error) throw t.error;
      setEmps((e.data ?? []).map(toEmp));
      const all = new Map<string, Entry>();
      for (const r of [...(t.data ?? []), ...(open.data ?? [])]) all.set(r.id, toEntry(r));
      setEntries([...all.values()]);
    } catch (e) { setError(errText(e)); }
    finally { setLoading(false); }
  }, [userId, from, to]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setInterval(() => setTick(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(null), 2500); };

  const sums = useMemo(() => totals(entries, emps, from, to), [entries, emps, from, to]);
  const openNow = entries.filter((e) => !e.clockOut);
  const link = (e: Employee) => (typeof window !== 'undefined' ? `${window.location.origin}/clock/${e.token}` : '');

  async function run(fn: () => PromiseLike<{ error: any }>, ok?: string) {
    const { error: e } = await fn();
    if (e) { setError(errText(e)); return false; }
    setError(null); if (ok) say(ok); await load(); return true;
  }
  const addEmployee = () => form.name.trim() && run(() => supabase().from('employees').insert({
    user_id: userId, name: form.name.trim(), phone: form.phone.trim(), hourly_rate: form.rate === '' ? null : Number(form.rate), token: newToken(),
  }), 'העובד/ת נוסף/ה').then((ok) => ok && setForm({ name: '', phone: '', rate: '' }));
  const closeShift = (e: Entry) => run(() => supabase().from('time_entries').update({ clock_out: new Date().toISOString(), edited: true, note: e.note ? e.note : 'נסגר ע״י המנהל/ת' }).eq('id', e.id), 'המשמרת נסגרה');
  function exportCsv() {
    const blob = new Blob([reportCsv(entries, emps, from, to)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `נוכחות-${month}.csv`; a.click();
  }

  if (!isCloudConfigured || !userId) return (<><PageHead title="שעון נוכחות" /><EmptyState icon={<IdentificationBadge />} title="שעון הנוכחות דורש חשבון מחובר" body="התחברו לחשבון כדי לנהל עובדים ושעות." /></>);

  return (
    <>
      <PageHead title="שעון נוכחות" sub={`${openNow.length} במשמרת עכשיו · ${emps.filter((e) => e.active).length} עובדים`} />
      <div className="mb-5 flex gap-1.5 overflow-x-auto pb-1">
        {([['now', 'עכשיו'], ['report', 'דוח חודשי'], ['team', 'עובדים']] as const).map(([k, l]) => <Chip key={k} on={tab === k} onClick={() => setTab(k)}>{l}</Chip>)}
      </div>
      {error && <p className="mb-4 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p>}
      {flash && <p className="mb-4 text-sm font-semibold text-emerald-600">✓ {flash}</p>}
      {loading && <div className="py-8 text-center"><Spinner /></div>}

      {!loading && !emps.length && tab !== 'team' && (
        <EmptyState icon={<IdentificationBadge />} title="עוד אין עובדים" body="הוסיפו עובד/ת, ושלחו לו/ה קישור אישי. משם — כניסה ויציאה בלחיצה מהטלפון."
          action={<Button variant="primary" onClick={() => setTab('team')}>הוספת עובד/ת</Button>} />
      )}

      {!loading && tab === 'now' && emps.length > 0 && (
        <div className="grid grid-cols-1 gap-2">
          {emps.filter((e) => e.active).map((emp) => {
            const open = openNow.find((x) => x.employeeId === emp.id);
            const min = open ? minutesOf(open, tick) : 0;
            return (
              <Card key={emp.id} className="flex min-w-0 items-center gap-3 p-3">
                <span className={cx('h-3 w-3 shrink-0 rounded-full', open ? 'bg-emerald-500' : 'bg-zinc-400')} />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate">{emp.name}</strong>
                  <span className={cx('text-xs', open && min > 10 * 60 ? 'font-bold text-warn' : 'text-muted')}>
                    {open ? `במשמרת מ-${time(open.clockIn)}${dayOf(open.clockIn) !== israelParts(tick).date ? ` (${formatIL(open.clockIn, { dateStyle: 'short' })})` : ''} · ${hhmm(min)}${min > 10 * 60 ? ' — שכח/ה לצאת?' : ''}` : 'לא במשמרת'}
                  </span>
                </span>
                {open && <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`לסגור את המשמרת של ${emp.name} עכשיו?`)) void closeShift(open); }}>סגירת משמרת</Button>}
              </Card>
            );
          })}
        </div>
      )}

      {!loading && tab === 'report' && emps.length > 0 && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="h-10 w-auto py-1" aria-label="חודש" />
            <Button variant="ghost" onClick={exportCsv}>ייצוא לאקסל</Button>
          </div>
          <div className="grid grid-cols-1 gap-2">
            {emps.map((emp) => {
              const t = sums.find((x) => x.employeeId === emp.id)!;
              const mine = entries.filter((e) => e.employeeId === emp.id && dayOf(e.clockIn) >= from && dayOf(e.clockIn) <= to).sort((a, b) => a.clockIn.localeCompare(b.clockIn));
              if (!mine.length && !emp.active) return null;
              return (
                <Card key={emp.id} className="min-w-0 p-3">
                  <button type="button" className="flex w-full items-center justify-between gap-2 text-start" onClick={() => setOpenEmp(openEmp === emp.id ? null : emp.id)}>
                    <span className="min-w-0"><strong className="block truncate">{emp.name}</strong>
                      <span className="text-xs text-muted">{t.days} ימים · {t.shifts} משמרות{t.open ? ` · ${t.open} פתוחה` : ''}</span></span>
                    <span className="text-end"><strong className="block text-lg tabular-nums">{hhmm(t.minutes)}</strong>
                      {t.pay != null && <span className="text-xs text-muted">₪{t.pay.toLocaleString('he-IL')}</span>}</span>
                  </button>
                  {t.longDays.length > 0 && <p className="mt-2 text-xs text-warn">ימים של יותר מ-9 שעות: {t.longDays.map((d) => d.slice(8, 10) + '.' + d.slice(5, 7)).join(', ')} — שעות נוספות, או שכחו לצאת?</p>}
                  {openEmp === emp.id && (
                    <div className="mt-3 grid gap-1.5">
                      {mine.map((e) => (
                        <button key={e.id} type="button" onClick={() => setEditing(e)} className="flex items-center justify-between rounded-xl bg-surface-2 px-3 py-2 text-start text-sm tabular-nums hover:ring-1 hover:ring-primary">
                          <span>{formatIL(e.clockIn, { weekday: 'short', day: 'numeric', month: 'numeric' })}{(e.edited || e.source === 'manual') && <span className="ms-1 text-[10px] text-warn">· תוקן</span>}</span>
                          <span>{time(e.clockIn)}–{e.clockOut ? time(e.clockOut) : '…'} · {e.clockOut ? hhmm(minutesOf(e)) : 'פתוחה'}</span>
                        </button>
                      ))}
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ employeeId: emp.id })}>+ משמרת ידנית</Button>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-muted">משמרת שייכת ליום שבו התחילה. תיקונים ידניים מסומנים &quot;תוקן&quot; גם בדוח ובאקסל. השכר הוא הערכה לפי תעריף שעתי, בלי תוספות.</p>
        </>
      )}

      {!loading && tab === 'team' && (
        <div className="grid gap-3">
          {emps.map((emp) => (
            <Card key={emp.id} className="min-w-0 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0"><strong className={cx('block truncate', !emp.active && 'text-muted line-through')}>{emp.name}</strong>
                  <span className="text-xs text-muted">{emp.phone || 'בלי טלפון'}{emp.hourlyRate != null ? ` · ₪${emp.hourlyRate} לשעה` : ''}</span></span>
                <span className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(link(emp)); say('הקישור הועתק'); }}>העתקת קישור</Button>
                  {waLink(emp.phone) && <a className="rounded-full border border-line px-3 py-1 text-sm" target="_blank" rel="noopener"
                    href={waLink(emp.phone, `היי ${emp.name.split(' ')[0]}, זה הקישור האישי שלך לשעון הנוכחות של ${brand.name || 'העסק'}: ${link(emp)}\nכניסה ויציאה בלחיצה. כדאי להוסיף למסך הבית.`)}>💬 שליחה</a>}
                  <Button size="sm" variant="ghost" onClick={() => { if (window.confirm('ליצור קישור חדש? הקישור הישן יפסיק לעבוד מיד.')) void run(() => supabase().from('employees').update({ token: newToken() }).eq('id', emp.id), 'נוצר קישור חדש'); }}>קישור חדש</Button>
                  <Button size="sm" variant="ghost" onClick={() => void run(() => supabase().from('employees').update({ active: !emp.active }).eq('id', emp.id))}>{emp.active ? 'השבתה' : 'הפעלה'}</Button>
                </span>
              </div>
            </Card>
          ))}
          <Card className="p-3">
            <p className="mb-2 text-sm font-semibold">עובד/ת חדש/ה</p>
            <div className="grid gap-2 sm:grid-cols-[1fr_160px_130px_auto]">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="שם" />
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="טלפון" inputMode="tel" dir="ltr" />
              <Input type="number" inputMode="decimal" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} placeholder="₪ לשעה (לא חובה)" />
              <Button variant="primary" onClick={() => void addEmployee()} disabled={!form.name.trim()}>הוספה</Button>
            </div>
            <p className="mt-2 text-xs text-muted">כל עובד/ת מקבל/ת קישור אישי. מי שיש לו את הקישור יכול להחתים — אם קישור דלף, צרו קישור חדש.</p>
          </Card>
        </div>
      )}

      <EntryEditor value={editing} emps={emps} onClose={() => setEditing(null)}
        onSave={async (v) => {
          const row = { clock_in: v.clockIn, clock_out: v.clockOut, note: v.note, edited: true };
          const ok = 'id' in v && v.id
            ? await run(() => supabase().from('time_entries').update(row).eq('id', v.id!), 'המשמרת עודכנה')
            : await run(() => supabase().from('time_entries').insert({ ...row, user_id: userId, employee_id: v.employeeId, source: 'manual' }), 'המשמרת נוספה');
          if (ok) setEditing(null);
        }}
        onDelete={async (id) => { if (await run(() => supabase().from('time_entries').delete().eq('id', id), 'המשמרת נמחקה')) setEditing(null); }} />
    </>
  );
}

function EntryEditor({ value, emps, onClose, onSave, onDelete }: {
  value: Entry | { employeeId: string } | null; emps: Employee[]; onClose: () => void;
  onSave: (v: { id?: string; employeeId: string; clockIn: string; clockOut: string | null; note: string }) => void; onDelete: (id: string) => void;
}) {
  const existing = value && 'id' in value ? value : null;
  const [f, setF] = useState({ date: '', in: '09:00', outDate: '', out: '17:00', note: '' });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!value) return;
    const today = israelParts(Date.now()).date;
    if (existing) {
      const i = israelParts(new Date(existing.clockIn)), o = existing.clockOut ? israelParts(new Date(existing.clockOut)) : null;
      setF({ date: i.date, in: i.time, outDate: o?.date ?? i.date, out: o?.time ?? '', note: existing.note ?? '' });
    } else setF({ date: today, in: '09:00', outDate: today, out: '17:00', note: '' });
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  if (!value) return null;
  const emp = emps.find((e) => e.id === value.employeeId);
  function save() {
    const clockIn = israelToIso(f.date, f.in);
    const clockOut = f.out ? israelToIso(f.outDate || f.date, f.out) : null;
    if (clockOut && clockOut <= clockIn) { setErr('שעת היציאה חייבת להיות אחרי הכניסה (משמרת לילה — בחרו את תאריך היציאה של מחרת).'); return; }
    onSave({ id: existing?.id, employeeId: value!.employeeId, clockIn, clockOut, note: f.note });
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-4 font-display text-xl font-extrabold">{existing ? 'תיקון משמרת' : 'משמרת ידנית'} · {emp?.name}</h3>
      <div className="grid grid-cols-2 gap-2">
        <Field label="תאריך כניסה"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value, outDate: f.outDate < e.target.value ? e.target.value : f.outDate })} /></Field>
        <Field label="שעת כניסה"><Input type="time" value={f.in} onChange={(e) => setF({ ...f, in: e.target.value })} /></Field>
        <Field label="תאריך יציאה"><Input type="date" value={f.outDate} onChange={(e) => setF({ ...f, outDate: e.target.value })} /></Field>
        <Field label="שעת יציאה"><Input type="time" value={f.out} onChange={(e) => setF({ ...f, out: e.target.value })} /></Field>
      </div>
      <Field label="סיבת התיקון (נשמר בדוח)"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="למשל: שכחה להחתים יציאה" /></Field>
      {existing?.inLat != null && <a className="mb-3 block text-sm text-primary" target="_blank" rel="noopener" href={`https://maps.google.com/?q=${existing.inLat},${existing.inLng}`}>📍 מיקום הכניסה</a>}
      {err && <p className="mb-3 text-sm text-warn">{err}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex gap-2"><Button variant="primary" onClick={save}>שמירה</Button><Button variant="ghost" onClick={onClose}>ביטול</Button></span>
        {existing && <button type="button" className="text-xs text-[var(--danger)]" onClick={() => { if (window.confirm('למחוק את המשמרת?')) onDelete(existing.id); }}>מחיקת משמרת</button>}
      </div>
    </Modal>
  );
}
