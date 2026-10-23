'use client';
import { useEffect, useState } from 'react';
import { Button, Card, Field, Input, PageHead, Select } from '@/components/ui/primitives';
import { authHeaders } from '@/lib/services/http';
import { useAtt } from './AttendanceLayout';
import { addApprover, addDepartment, attError, removeApprover, setDepartment } from './api';
import { isAdmin } from './people';
import { Notice } from './ui';

/**
 * מחלקות ומאשרים (2.107): the departments, and who approves whose reports — a department or one employee → a member of the
 * business marked "מאשר/ת" by the system's admin (business_members.attendance_role). A department is closed, never deleted.
 */
interface Member { userId: string; name: string; email: string; role: string; attendanceRole: string | null }
const ROLE_LABEL: Record<string, string> = { admin: 'מנהל/ת נוכחות', approver: 'מאשר/ת', payroll: 'שכר / רואה חשבון', viewer: 'צפייה' };

export function Departments() {
  const att = useAtt();
  const { setup, role } = att;
  const admin = isAdmin(role);
  const [name, setName] = useState('');
  const [members, setMembers] = useState<Member[] | null>(null);
  const [pick, setPick] = useState({ user: '', target: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!admin) return;
    (async () => {
      try {
        const r = await fetch('/api/attendance/members', { headers: await authHeaders() });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message);
        setMembers(j.members);
      } catch (e: any) { setErr(e?.message || 'לא הצלחנו לטעון את המשתמשים של העסק.'); }
    })();
  }, [admin]);
  async function run(fn: () => Promise<unknown>, msg: string) {
    setBusy(true); setErr(null);
    try { await fn(); await att.reload(); att.say(msg); } catch (e) { setErr(attError(e)); } finally { setBusy(false); }
  }
  const approvers = (members ?? []).filter((m) => m.attendanceRole === 'approver');
  const who = (uid: string) => members?.find((m) => m.userId === uid)?.name || members?.find((m) => m.userId === uid)?.email || 'משתמש/ת';
  const targetName = (a: { departmentId: string | null; employeeId: string | null }) =>
    a.departmentId ? `מחלקת ${setup.departments.find((d) => d.id === a.departmentId)?.name ?? ''}` : setup.employees.find((e) => e.id === a.employeeId)?.name ?? '';

  return (
    <>
      <PageHead title="מחלקות ומאשרים" />
      {err && <Notice tone="warn">{err}</Notice>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-3 font-bold">מחלקות</h3>
          {admin && (
            <div className="mb-3 flex gap-2">
              <Input value={name} maxLength={60} placeholder="שם מחלקה חדשה" aria-label="שם מחלקה" onChange={(e) => setName(e.target.value)} />
              <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void run(() => addDepartment(att.businessId, name), 'המחלקה נוספה').then(() => setName(''))}>הוספה</Button>
            </div>
          )}
          <ul className="divide-y divide-line">
            {setup.departments.map((d) => (
              <li key={d.id} className="flex min-h-12 items-center justify-between gap-2">
                <span className={d.active ? 'font-semibold' : 'text-muted line-through'}>{d.name}
                  <span className="ms-2 text-xs font-normal text-muted">{setup.employees.filter((e) => e.active && e.departmentId === d.id).length} עובדים</span></span>
                {admin && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { const n = window.prompt('שם המחלקה', d.name); if (n?.trim()) void run(() => setDepartment(d.id, { name: n.trim() }), 'נשמר'); }}>שינוי שם</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => setDepartment(d.id, { active: !d.active }), d.active ? 'המחלקה נסגרה' : 'המחלקה נפתחה')}>{d.active ? 'סגירה' : 'פתיחה'}</Button>
                  </div>
                )}
              </li>
            ))}
            {!setup.departments.length && <li className="py-2 text-sm text-muted">עוד אין מחלקות.</li>}
          </ul>
        </Card>

        <Card className="p-4">
          <h3 className="mb-1 font-bold">מאשרים — מי מאשר דיווחים של מי</h3>
          <p className="mb-3 text-sm text-ink-2">מאשר/ת רואה ומאשר/ת רק את העובדים שהוגדרו לו/ה. את התפקיד "מאשר/ת" למשתמש/ת קובע מנהל המערכת.</p>
          {admin && members && (approvers.length ? (
            <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Field label="מאשר/ת"><Select value={pick.user} onChange={(e) => setPick({ ...pick, user: e.target.value })}>
                <option value="">בחרו…</option>{approvers.map((m) => <option key={m.userId} value={m.userId}>{m.name || m.email}</option>)}</Select></Field>
              <Field label="מאשר/ת את"><Select value={pick.target} onChange={(e) => setPick({ ...pick, target: e.target.value })}>
                <option value="">בחרו…</option>
                <optgroup label="מחלקה">{setup.departments.filter((d) => d.active).map((d) => <option key={d.id} value={`d:${d.id}`}>{d.name}</option>)}</optgroup>
                <optgroup label="עובד/ת">{setup.employees.filter((e) => e.active).map((e) => <option key={e.id} value={`e:${e.id}`}>{e.name}</option>)}</optgroup>
              </Select></Field>
              <div className="flex items-end pb-4"><Button variant="primary" disabled={busy || !pick.user || !pick.target}
                onClick={() => void run(() => addApprover(att.businessId, pick.user, pick.target.startsWith('d:') ? { departmentId: pick.target.slice(2) } : { employeeId: pick.target.slice(2) }), 'נשמר').then(() => setPick({ user: '', target: '' }))}>הוספה</Button></div>
            </div>
          ) : <Notice>אין עדיין משתמשים בתפקיד "מאשר/ת". מנהל המערכת מוסיף אותם (ניהול ← העסק ← משתמשים).</Notice>)}
          <ul className="divide-y divide-line">
            {setup.approvers.map((a) => (
              <li key={a.id} className="flex min-h-12 items-center justify-between gap-2 text-sm">
                <span><strong>{members ? who(a.userId) : 'מאשר/ת'}</strong> ← {targetName(a)}</span>
                {admin && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => removeApprover(a.id), 'הוסר')}>הסרה</Button>}
              </li>
            ))}
            {!setup.approvers.length && <li className="py-2 text-sm text-muted">אין מאשרים — מנהל הנוכחות מאשר את כולם.</li>}
          </ul>
          {admin && members && (
            <details className="mt-4 text-sm"><summary className="cursor-pointer font-semibold">המשתמשים של העסק ותפקידם בנוכחות</summary>
              <ul className="mt-2">{members.map((m) => <li key={m.userId}>{m.name || m.email} — {ROLE_LABEL[m.attendanceRole ?? (m.role === 'viewer' ? 'viewer' : 'admin')]}</li>)}</ul>
            </details>
          )}
        </Card>
      </div>
    </>
  );
}
