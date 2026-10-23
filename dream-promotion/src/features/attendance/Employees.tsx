'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, Chip, Field, Input, PageHead, Select } from '@/components/ui/primitives';
import { EmptyState, Modal } from '@/components/ui/feedback';
import { IdentificationBadge, WhatsappLogo } from '@/components/ui/Icon';
import { cx } from '@/lib/utils';
import { formatIL } from '@/lib/il-time';
import { useAtt } from './AttendanceLayout';
import { addDepartment, addEmployee, attError, loadSetup, markInvited, newLink, saveEmployee, savePrivate, setEmployeeActive, type EmployeeForm } from './api';
import { detectImportColumns, planImport, readSheet, type ImportPlan } from './import';
import { agorotOf, inviteLink, isAdmin, seesPrivate, shekels, trackSummary, validIsraeliId, type Employee, type PrivateDetails } from './people';
import { employeeMonthHref } from './routes';
import { xlsx } from './exports';
import { saveFile, today, XLSX_TYPE } from './ui';

/**
 * עובדים (2.107) — the reference's table: code, name, department, title, phone, hours track, created, last active, active,
 * the monthly report, edit; and add, invite to register (WhatsApp with the personal link), export to Excel, import from a file.
 * An employee is never deleted: "העברה לארכיון" ends them (active off, an end date) — their hours stay.
 */
const dmy = (d: string | null) => (d ? formatIL(d, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
const clockLink = (e: Employee) => (typeof window !== 'undefined' ? `${window.location.origin}/clock/${e.token}` : '');

export function Employees() {
  const att = useAtt();
  const { setup, role } = att;
  const params = useSearchParams();
  const router = useRouter();
  const [editing, setEditing] = useState<Employee | 'new' | null>(params.get('new') === '1' ? 'new' : null);
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState<'active' | 'all' | 'archived'>('active');
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (params.get('new') === '1') setEditing('new'); }, [params]);
  const dept = useMemo(() => new Map(setup.departments.map((d) => [d.id, d.name])), [setup.departments]);
  const track = useMemo(() => new Map(setup.tracks.map((t) => [t.id, t])), [setup.tracks]);
  const list = setup.employees
    .filter((e) => (filter === 'all' ? true : filter === 'active' ? e.active : !e.active))
    .filter((e) => !q.trim() || `${e.name} ${e.code} ${e.phone} ${e.title}`.toLowerCase().includes(q.trim().toLowerCase()));
  const admin = isAdmin(role);
  const close = () => { setEditing(null); if (params.get('new')) router.replace('/attendance/employees'); };

  async function invite(e: Employee) {
    const url = inviteLink(e, att.businessName, clockLink(e));
    if (!url) { setErr(`ל${e.name} אין מספר טלפון תקין.`); return; }
    window.open(url, '_blank', 'noopener');
    try { await markInvited(e.id); await att.reload(); } catch { /* the message was opened anyway */ }
  }
  async function exportExcel() {
    const rows = [['קוד עובד', 'שם', 'מחלקה', 'תואר', 'טלפון', 'מסלול', 'תאריך תחילה', 'תאריך יצירה', 'פעיל לאחרונה', 'סטטוס'],
      ...list.map((e) => [e.code, e.name, dept.get(e.departmentId ?? '') ?? '', e.title, e.phone, track.get(e.trackId ?? '')?.name ?? '', dmy(e.startDate),
        dmy(e.createdAt), e.lastActiveAt ? formatIL(e.lastActiveAt) : '', e.active ? 'פעיל' : 'לא פעיל'])];
    saveFile(await xlsx([{ name: 'עובדים', rows }]) as BlobPart, `עובדים-${today()}.xlsx`, XLSX_TYPE);
  }

  return (
    <>
      <PageHead title="עובדים" sub={`${setup.employees.filter((e) => e.active).length} פעילים · ${setup.employees.filter((e) => !e.active).length} בארכיון`}
        action={(
          <div className="flex flex-wrap gap-2">
            {admin && <Button variant="primary" onClick={() => setEditing('new')}>הוספת עובד/ת</Button>}
            {admin && <Button variant="ghost" onClick={() => setImporting(true)}>ייבוא מקובץ</Button>}
            <Button variant="ghost" onClick={() => void exportExcel()}>ייצוא לאקסל</Button>
          </div>
        )} />
      {err && <p role="alert" className="mb-4 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{err}</p>}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {([['active', 'פעילים'], ['archived', 'ארכיון'], ['all', 'הכול']] as const).map(([k, l]) => <Chip key={k} on={filter === k} onClick={() => setFilter(k)} className="min-h-10">{l}</Chip>)}
        <Input type="search" placeholder="חיפוש לפי שם, קוד או טלפון" aria-label="חיפוש עובד" value={q} onChange={(e) => setQ(e.target.value)} className="h-10 max-w-xs py-1" />
      </div>
      {!setup.employees.length ? (
        <EmptyState icon={<IdentificationBadge />} title="עוד אין עובדים" body="מוסיפים עובד/ת, ושולחים קישור אישי בוואטסאפ. משם — כניסה ויציאה בלחיצה מהטלפון."
          action={admin ? <Button variant="primary" onClick={() => setEditing('new')}>הוספת עובד/ת</Button> : undefined} />
      ) : (
        <>
          {/* phone: cards */}
          <div className="grid gap-2 md:hidden">
            {list.map((e) => (
              <Card key={e.id} className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={employeeMonthHref(e.id)} className="block truncate font-bold text-module">{e.name}</Link>
                    <span className="text-xs text-muted">{[e.code && `#${e.code}`, dept.get(e.departmentId ?? ''), e.title].filter(Boolean).join(' · ')}</span>
                  </div>
                  <span className={cx('shrink-0 rounded-full px-2 py-0.5 text-xs font-bold', e.active ? 'bg-(--ok-soft) text-ok' : 'bg-surface-2 text-muted')}>{e.active ? 'פעיל' : 'לא פעיל'}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Link href={employeeMonthHref(e.id)}><Button size="sm" variant="soft">דוח חודשי</Button></Link>
                  {admin && e.active && <Button size="sm" variant="soft" onClick={() => void invite(e)}><WhatsappLogo size={16} aria-hidden />זימון</Button>}
                  {admin && <Button size="sm" variant="ghost" onClick={() => setEditing(e)}>עריכה</Button>}
                </div>
              </Card>
            ))}
          </div>
          {/* computer: the reference's table */}
          <Card className="hidden overflow-x-auto p-0 md:block">
            <table className="w-full min-w-[960px] text-sm">
              <thead><tr className="border-b border-line text-muted">
                {['קוד', 'שם', 'מחלקה', 'תואר', 'טלפון', 'מסלול', 'נוצר', 'פעיל לאחרונה', 'סטטוס', ''].map((h) => <th key={h} className="p-3 text-start font-semibold">{h}</th>)}
              </tr></thead>
              <tbody>
                {list.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0">
                    <td className="p-3 tabular-nums">{e.code}</td>
                    <td className="p-3"><Link href={employeeMonthHref(e.id)} className="font-semibold text-module hover:underline">{e.name}</Link></td>
                    <td className="p-3">{dept.get(e.departmentId ?? '') ?? ''}</td>
                    <td className="p-3">{e.title}</td>
                    <td className="p-3 tabular-nums" dir="ltr">{e.phone}</td>
                    <td className="p-3" title={e.trackId ? trackSummary(track.get(e.trackId)!) : ''}>{track.get(e.trackId ?? '')?.name ?? <span className="text-muted">לא נקבע</span>}</td>
                    <td className="p-3 tabular-nums">{dmy(e.createdAt)}</td>
                    <td className="p-3 tabular-nums">{e.lastActiveAt ? formatIL(e.lastActiveAt) : ''}</td>
                    <td className="p-3"><span className={cx('rounded-full px-2 py-0.5 text-xs font-bold', e.active ? 'bg-(--ok-soft) text-ok' : 'bg-surface-2 text-muted')}>{e.active ? 'פעיל' : 'לא פעיל'}</span>
                      {e.invitedAt && <span className="ms-1 text-xs text-muted">זומן</span>}</td>
                    <td className="p-3"><div className="flex gap-1">
                      <Link href={employeeMonthHref(e.id)}><Button size="sm" variant="soft">דוח</Button></Link>
                      {admin && e.active && <Button size="sm" variant="soft" aria-label={`זימון ${e.name} בוואטסאפ`} onClick={() => void invite(e)}><WhatsappLogo size={16} aria-hidden /></Button>}
                      {admin && <Button size="sm" variant="ghost" onClick={() => setEditing(e)}>עריכה</Button>}
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
      {editing && <EmployeeEditor value={editing === 'new' ? null : editing} onClose={close} onInvite={invite} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </>
  );
}

const emptyForm = (): EmployeeForm => ({ name: '', phone: '', code: '', departmentId: null, title: '', trackId: null, startDate: today(), endDate: null });

function EmployeeEditor({ value, onClose, onInvite }: { value: Employee | null; onClose: () => void; onInvite: (e: Employee) => void }) {
  const att = useAtt();
  const { setup, role } = att;
  const priv = value ? setup.privates.get(value.id) : undefined;
  const [f, setF] = useState<EmployeeForm>(value ? { name: value.name, phone: value.phone, code: value.code, departmentId: value.departmentId, title: value.title,
    trackId: value.trackId, startDate: value.startDate, endDate: value.endDate } : emptyForm());
  const [p, setP] = useState({ idNumber: priv?.idNumber ?? '', payKind: priv?.payKind ?? '', hourly: shekels(priv?.hourlyAgorot ?? null), monthly: shekels(priv?.monthlyAgorot ?? null) });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const showPrivate = seesPrivate(role);
  const idBad = p.idNumber.trim() !== '' && !validIsraeliId(p.idNumber);
  const hourly = agorotOf(p.hourly), monthly = agorotOf(p.monthly);
  const payBad = hourly === undefined || monthly === undefined;

  async function save() {
    setBusy(true); setErr(null);
    try {
      const id = value ? value.id : await addEmployee(att.userId, f);
      if (value) await saveEmployee(value.id, f);
      if (showPrivate && isAdmin(role) && (priv || p.idNumber || p.payKind || p.hourly || p.monthly)) {
        const row: PrivateDetails = { employeeId: id, idNumber: p.idNumber.replace(/\D/g, '') ? p.idNumber.replace(/\D/g, '').padStart(9, '0') : '',
          payKind: p.payKind as PrivateDetails['payKind'], hourlyAgorot: hourly ?? null, monthlyAgorot: monthly ?? null };
        await savePrivate(att.businessId, row);
      }
      await att.reload(); att.say(value ? 'נשמר' : 'העובד/ת נוסף/ה'); onClose();
    } catch (e) { setErr(attError(e)); } finally { setBusy(false); }
  }
  async function act(fn: () => Promise<unknown>, msg: string) {
    setBusy(true); setErr(null);
    try { await fn(); await att.reload(); att.say(msg); onClose(); } catch (e) { setErr(attError(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} wide>
      <h3 className="mb-4 font-display text-xl font-bold">{value ? `עריכה — ${value.name}` : 'עובד/ת חדש/ה'}</h3>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="שם מלא"><Input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="טלפון (לזימון בוואטסאפ)"><Input value={f.phone} inputMode="tel" dir="ltr" onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="מספר עובד"><Input value={f.code} maxLength={20} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="תואר / תפקיד"><Input value={f.title} maxLength={60} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="מחלקה">
          <Select value={f.departmentId ?? ''} onChange={(e) => setF({ ...f, departmentId: e.target.value || null })}>
            <option value="">בלי מחלקה</option>
            {setup.departments.filter((d) => d.active || d.id === f.departmentId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label="מסלול שעות תקן">
          <Select value={f.trackId ?? ''} onChange={(e) => setF({ ...f, trackId: e.target.value || null })}>
            <option value="">לא נקבע (בלי שעות תקן)</option>
            {setup.tracks.filter((t) => t.active || t.id === f.trackId).map((t) => <option key={t.id} value={t.id}>{t.name} — {trackSummary(t)}</option>)}
          </Select>
        </Field>
        <Field label="תאריך תחילת עבודה"><Input type="date" value={f.startDate ?? ''} onChange={(e) => setF({ ...f, startDate: e.target.value || null })} /></Field>
        {value && !value.active && <Field label="תאריך סיום"><Input type="date" value={f.endDate ?? ''} onChange={(e) => setF({ ...f, endDate: e.target.value || null })} /></Field>}
      </div>
      {showPrivate && (
        <fieldset className="mt-2 rounded-2xl border border-line p-4">
          <legend className="px-1 text-sm font-bold">פרטים אישיים ושכר — רק למנהל ולרואה החשבון</legend>
          <div className="grid gap-x-3 sm:grid-cols-2">
            <Field label="תעודת זהות (לא חובה)"><Input value={p.idNumber} inputMode="numeric" dir="ltr" maxLength={9} onChange={(e) => setP({ ...p, idNumber: e.target.value })} /></Field>
            <Field label="סוג שכר">
              <Select value={p.payKind} onChange={(e) => setP({ ...p, payKind: e.target.value as typeof p.payKind })}>
                <option value="">לא נקבע</option><option value="hourly">שעתי</option><option value="monthly">חודשי</option>
              </Select>
            </Field>
            {p.payKind === 'hourly' && <Field label="שכר לשעה (₪)"><Input value={p.hourly} inputMode="decimal" dir="ltr" onChange={(e) => setP({ ...p, hourly: e.target.value })} /></Field>}
            {p.payKind === 'monthly' && <Field label="שכר חודשי (₪)"><Input value={p.monthly} inputMode="decimal" dir="ltr" onChange={(e) => setP({ ...p, monthly: e.target.value })} /></Field>}
          </div>
          {idBad && <p className="text-sm text-warn">מספר תעודת הזהות לא תקין (ספרת ביקורת).</p>}
          {payBad && <p className="text-sm text-warn">סכום לא תקין — מספר, עד שתי ספרות אחרי הנקודה.</p>}
        </fieldset>
      )}
      {err && <p role="alert" className="mt-3 text-sm text-warn">{err}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || !f.name.trim() || idBad || payBad} onClick={() => void save()}>שמירה</Button>
        {value?.active && <Button variant="soft" disabled={busy} onClick={() => onInvite(value)}><WhatsappLogo size={16} aria-hidden />זימון בוואטסאפ</Button>}
        {value?.active && <Button variant="ghost" disabled={busy} onClick={() => { void navigator.clipboard?.writeText(clockLink(value)); att.say('הקישור הועתק'); }}>העתקת הקישור</Button>}
        {value?.active && <Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm('ליצור קישור חדש? הקישור הישן יפסיק לעבוד מיד.')) void act(() => newLink(value.id), 'נוצר קישור חדש'); }}>קישור חדש</Button>}
        {value?.active && <Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm(`להעביר את ${value.name} לארכיון? השעות נשמרות, והקישור האישי מפסיק להחתים.`)) void act(() => setEmployeeActive(value.id, false, today()), 'הועבר/ה לארכיון'); }}>העברה לארכיון</Button>}
        {value && !value.active && <Button variant="ghost" disabled={busy} onClick={() => void act(() => setEmployeeActive(value.id, true), 'הוחזר/ה לפעילים')}>החזרה לפעילים</Button>}
        <Button variant="ghost" onClick={onClose}>סגירה</Button>
      </div>
    </Modal>
  );
}

/** import from the previous system's export: read in the browser, shown before saving, only added */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const att = useAtt();
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  async function read(file: File) {
    setErr(null); setPlan(null);
    const r = await readSheet(file.name, new Uint8Array(await file.arrayBuffer()));
    if (!r.ok) { setErr(r.error); return; }
    const map = detectImportColumns(r.grid);
    if (!map) { setErr('לא מצאנו שורת כותרת עם "שם" (או "שם פרטי" ו"שם משפחה"). בודקים שהשורה הראשונה בקובץ היא הכותרות.'); return; }
    setPlan(planImport(r.grid, map, att.setup.employees.map((e) => ({ code: e.code, phone: e.phone }))));
  }
  async function run() {
    if (!plan) return;
    setBusy(true); setErr(null);
    try {
      // the departments of the file that the business does not have yet
      const known = new Map(att.setup.departments.filter((d) => d.active).map((d) => [d.name.trim().toLowerCase(), d.id]));
      for (const d of plan.departments) if (!known.has(d.trim().toLowerCase())) await addDepartment(att.businessId, d);
      await att.reload();
      const fresh = await loadSetup();
      const ids = new Map(fresh.departments.filter((d) => d.active).map((d) => [d.name.trim().toLowerCase(), d.id]));
      let n = 0;
      for (const a of plan.add) {
        const id = await addEmployee(att.userId, { name: a.name, phone: a.phone, code: a.code, title: a.title, departmentId: ids.get(a.department.trim().toLowerCase()) ?? null,
          trackId: null, startDate: a.startDate, endDate: null });
        if (a.idNumber && isAdmin(att.role)) await savePrivate(att.businessId, { employeeId: id, idNumber: a.idNumber, payKind: '', hourlyAgorot: null, monthlyAgorot: null });
        n += 1; setDone(n);
      }
      await att.reload(); att.say(`נוספו ${n} עובדים`); onClose();
    } catch (e) { setErr(`${attError(e)} (נוספו ${done} לפני העצירה — אפשר להעלות שוב: מי שכבר נוסף ידולג)`); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} wide>
      <h3 className="mb-2 font-display text-xl font-bold">ייבוא עובדים מקובץ</h3>
      <p className="mb-3 text-sm text-ink-2">קובץ Excel או CSV עם שורת כותרות (למשל הייצוא מ-OK2GO): שם, מספר עובד, טלפון, מחלקה, תואר, ת״ז, תאריך תחילת עבודה. רק מוסיפים — עובד שמספר העובד או הטלפון שלו כבר קיים מדולג, ושום דבר לא משתנה או נמחק.</p>
      <input type="file" accept=".xlsx,.csv,text/csv" aria-label="קובץ עובדים" onChange={(e) => e.target.files?.[0] && void read(e.target.files[0])} className="mb-3 block text-sm" />
      {err && <p role="alert" className="mb-3 text-sm text-warn">{err}</p>}
      {plan && (
        <>
          <p className="mb-2 text-sm font-semibold">{plan.add.length} יתווספו · {plan.skipped.length} ידולגו{plan.departments.length ? ` · מחלקות: ${plan.departments.join(', ')}` : ''}</p>
          <div className="mb-3 max-h-64 overflow-auto rounded-xl border border-line text-sm">
            <table className="w-full">
              <thead><tr className="text-muted"><th className="p-2 text-start">שורה</th><th className="p-2 text-start">שם</th><th className="p-2 text-start">מספר</th><th className="p-2 text-start">טלפון</th><th className="p-2 text-start">מחלקה</th></tr></thead>
              <tbody>
                {plan.add.map((a) => <tr key={a.row} className="border-t border-line"><td className="p-2">{a.row}</td><td className="p-2">{a.name}</td><td className="p-2">{a.code}</td><td className="p-2" dir="ltr">{a.phone}</td><td className="p-2">{a.department}</td></tr>)}
                {plan.skipped.map((s) => <tr key={`s${s.row}`} className="border-t border-line text-muted"><td className="p-2">{s.row}</td><td className="p-2" colSpan={4}>{s.name} — מדולג: {s.why}</td></tr>)}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy || !plan?.add.length} onClick={() => void run()}>{busy ? `מוסיף… ${done}/${plan?.add.length ?? 0}` : `הוספת ${plan?.add.length ?? 0} עובדים`}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}
