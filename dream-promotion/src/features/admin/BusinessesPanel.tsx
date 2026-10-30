'use client';
import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '@/lib/services/http';
import { Button, Card, Field, Input, Select } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { STATE_HE, passwordProblem, validSlug, type BizState } from './business-state';
import { MILESTONES, milestoneCount, type Milestones } from './milestones';

/**
 * Admin → "עסקים": the super admin's dashboard — one card per business with its state, payment date
 * (warning a week before it ends), assets (warning when one was disconnected) and this month's
 * activity; actions: extend a month, set a date, lock / unlock, add a business, assign assets, enter,
 * add a person (full access, the register only — "קופאי/ת" — or, 2.109, the calendar and the leads only — "יומן ולידים";
 * with a new sign-in the super admin opens for them: an email and a password) and remove one. 2.91 (T12א): a business with several locations
 * — which locations each person works in (all, or some: a cashier of one branch sees nothing of another).
 */
type Biz = {
  id: string; name: string; slug: string; status: string; paidUntil: string | null; graceDays: number; lockReason: string;
  state: BizState; lastDay: string | null; daysLeft: number | null; endingSoon: boolean;
  members: { role: string; access?: Access; attendanceRole?: string | null; email: string; name: string; locations?: string[] | null }[];
  /** 2.107 (migration 5800): what the business bought; null = before the migration (everything) */
  modules?: string[] | null;
  /** migration 4600: the business's locations, the main one first (one or none: nothing to choose) */
  locations?: { id: string; name: string; active: boolean }[];
  assets: number; missing: string[];
  month: { posts: number; leads: number; costUsd: number };
  milestones?: Milestones;
};
type Data = { businesses: Biz[]; current: string | null; unassignedAssets: number };
type Access = 'full' | 'register' | 'calendar';
const ACCESS_HE: Record<Access, string> = { full: 'גישה מלאה (בעלים)', register: 'קופה בלבד (קופאי/ת)', calendar: 'יומן ולידים בלבד' };
const limited = (m: { access?: Access }) => m.access === 'register' || m.access === 'calendar';
/** 2.109.2: a password typed here for another person — the phone may not fill, suggest, capitalise or correct it (an iPhone put
 *  its own "strong password" in the field, and the person could not sign in) */
const PASSWORD_FIELD = { dir: 'ltr', type: 'text', name: 'dp-person-password', autoComplete: 'off', autoCapitalize: 'none', autoCorrect: 'off',
  spellCheck: false, 'data-1p-ignore': true, 'data-lpignore': 'true' } as const;

const fmtDate = (d: string | null) => (d ? d.split('-').reverse().join('.') : '');
const TONE: Record<BizState, string> = {
  active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  locked: 'bg-red-500/15 text-red-700 dark:text-red-300',
  expired: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
};

export function BusinessesPanel({ onAssets }: { onAssets: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', slug: '', ownerEmail: '', paidUntil: '' });

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/businesses', { headers: await authHeaders() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.code);
      setData(j); setError(null);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function call(method: 'POST' | 'PATCH', body: object, key: string, done: string) {
    setBusy(key); setNotice(null);
    try {
      const r = await fetch('/api/admin/businesses', { method, headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.code);
      setNotice({ ok: true, text: done });
      await load();
      return true;
    } catch (e: any) { setNotice({ ok: false, text: e.message }); return false; }
    finally { setBusy(null); }
  }
  const act = (b: Biz, action: string, extra: object, done: string) => call('PATCH', { id: b.id, action, ...extra }, `${b.id}:${action}`, done);

  function lock(b: Biz) {
    const reason = window.prompt(`לנעול את "${b.name}"? הלקוח לא יוכל להשתמש באפליקציה, פוסטים מתוזמנים לא ייצאו ודף ההזמנות ייסגר. הנתונים נשמרים.\n\nסיבה (לא חובה):`, '');
    if (reason !== null) void act(b, 'lock', { reason }, `"${b.name}" נעול.`);
  }
  function setDate(b: Biz) {
    const v = window.prompt(`בתוקף עד (YYYY-MM-DD). ריק = בלי הגבלה.`, b.paidUntil ?? '');
    if (v !== null) void act(b, 'paid_until', { paidUntil: v.trim() }, v.trim() ? `"${b.name}" בתוקף עד ${fmtDate(v.trim())}.` : `ל"${b.name}" אין עכשיו תאריך תפוגה.`);
  }
  async function enter(b: Biz) {
    if (await act(b, 'enter', {}, `עברת לעבוד בעסק "${b.name}".`)) window.location.href = '/dashboard';
  }
  // 2.109: "+ אדם" — the person who signed up, or a new sign-in (an email and a password chosen here); and their access
  const [person, setPerson] = useState<{ biz: string; email: string; access: Access; create: boolean; password: string } | null>(null);
  const [pw, setPw] = useState<{ biz: string; email: string; password: string } | null>(null);
  async function savePassword(b: Biz) {
    if (!pw) return;
    if (await act(b, 'set_password', { email: pw.email, password: pw.password }, `${pw.email}: הסיסמה החדשה נשמרה — ${pw.password}`)) setPw(null);
  }
  async function addPerson(b: Biz) {
    if (!person) return;
    const email = person.email.trim().toLowerCase();
    const done = `${email} נוסף/ה ל"${b.name}" — ${ACCESS_HE[person.access]}.${person.create ? ` אפשר להיכנס עכשיו עם המייל והסיסמה: ${person.password}` : ''}`;
    const ok = person.create
      ? await act(b, 'create_user', { email, password: person.password, access: person.access }, done)
      : await act(b, 'add_member', { email, access: person.access }, done);
    if (ok) setPerson(null);
  }
  function removeMember(b: Biz, email: string) {
    if (window.confirm(`להסיר את ${email} מ"${b.name}"? הנתונים שלו/ה בעסק נשארים.`)) void act(b, 'remove_member', { email }, `${email} הוסר/ה מ"${b.name}".`);
  }
  async function add() {
    if (await call('POST', { ...form, slug: form.slug.trim().toLowerCase() }, 'add', `העסק "${form.name}" נוסף.`)) {
      setAdding(false); setForm({ name: '', slug: '', ownerEmail: '', paidUntil: '' });
    }
  }

  if (error) return <p className="rounded-2xl bg-warn/10 p-3 text-sm text-warn">{error}</p>;
  if (!data) return <div className="py-8 text-center"><Spinner /></div>;

  return (
    <div className="grid gap-4">
      {notice && <p className={cx('rounded-2xl p-3 text-sm', notice.ok ? 'bg-emerald-500/15' : 'bg-warn/10 text-warn')}>{notice.text}</p>}
      {data.unassignedAssets > 0 && (
        <p className="rounded-2xl bg-amber-500/10 p-3 text-sm">
          {data.unassignedAssets} נכסים (עמודים / חשבונות) מחכים לשיוך לעסק.{' '}
          <button type="button" className="font-semibold underline" onClick={onAssets}>לשיוך</button>
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {data.businesses.map((b) => (
          <Card key={b.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <strong className="text-[18px]">{b.name}</strong>
                {data.current === b.id && <span className="ms-2 text-xs text-muted">(את/ה עובד/ת בו עכשיו)</span>}
                <p className="text-xs text-muted">{b.members.filter((m) => !limited(m)).map((m) => m.email || m.name).join(' · ') || 'אין בעלים'}</p>
                {b.members.some((m) => m.access === 'calendar') && (
                  <p className="mt-0.5 text-xs text-muted">📅 יומן ולידים: {b.members.filter((m) => m.access === 'calendar').map((m) => (
                    <button key={m.email} type="button" className="me-1 underline decoration-dotted" title="הסרה" onClick={() => removeMember(b, m.email)}>{m.email || m.name}</button>
                  ))}</p>
                )}
                {b.members.some((m) => m.access === 'register') && (
                  <p className="mt-0.5 text-xs text-muted">🧾 קופה בלבד: {b.members.filter((m) => m.access === 'register').map((m) => (
                    <button key={m.email} type="button" className="me-1 underline decoration-dotted" title="הסרה" onClick={() => removeMember(b, m.email)}>{m.email || m.name}</button>
                  ))}</p>
                )}
              </div>
              <span className={cx('rounded-full px-3 py-1 text-sm font-bold', TONE[b.state])}>{STATE_HE[b.state]}</span>
            </div>

            <p className="mt-3 text-sm">
              {b.paidUntil ? <>בתוקף עד <strong>{fmtDate(b.paidUntil)}</strong>{b.graceDays ? ` (+${b.graceDays} ימי חסד)` : ''}</> : 'ללא הגבלת זמן'}
              {b.state === 'active' && b.daysLeft != null && ` · עוד ${b.daysLeft} ימים`}
            </p>
            {b.endingSoon && <p className="mt-1 rounded-xl bg-amber-500/15 p-2 text-sm font-semibold">⏳ התוקף מסתיים בעוד {b.daysLeft} ימים — כדאי להאריך.</p>}
            {b.state === 'expired' && <p className="mt-1 rounded-xl bg-amber-500/15 p-2 text-sm font-semibold">התוקף הסתיים ב-{fmtDate(b.lastDay)} — העסק סגור ללקוח עד הארכה.</p>}
            {b.state === 'locked' && b.lockReason && <p className="mt-1 text-sm text-muted">סיבת הנעילה: {b.lockReason}</p>}

            <p className="mt-2 text-sm">
              נכסים: <strong>{b.assets}</strong>
              {b.missing.length > 0 && <span className="text-red-600"> · ⚠️ {b.missing.length} מנותקים: {b.missing.join(', ')}</span>}
            </p>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <Mini label="פוסטים החודש" value={String(b.month.posts)} hint="מתוזמנים שפורסמו" />
              <Mini label="לידים החודש" value={String(b.month.leads)} />
              <Mini label="עלות AI החודש" value={`$${b.month.costUsd.toFixed(2)}`} />
            </div>
            {b.milestones && (
              <details className="mt-2 rounded-xl bg-surface-2 p-2 text-sm">
                <summary className="cursor-pointer font-semibold">פיילוט: {milestoneCount(b.milestones)}/{MILESTONES.length} שלבים</summary>
                <ul className="mt-1 grid gap-0.5 sm:grid-cols-2">
                  {MILESTONES.map((m) => {
                    const at = b.milestones?.[m.key];
                    return <li key={m.key} className={cx('flex justify-between gap-2', !at && 'text-muted')}><span>{at ? '✓' : '○'} {m.label}</span><span className="tabular-nums">{at ? fmtDate(at.slice(0, 10)) : '—'}</span></li>;
                  })}
                </ul>
              </details>
            )}

            {b.modules !== undefined && <AttendanceAccess b={b} busy={!!busy} act={act} />}

            {(b.locations?.length ?? 0) > 1 && (
              <MemberLocations b={b} busy={!!busy} onSave={(email, locations) => act(b, 'member_locations', { email, locations },
                locations ? `${email} עובד/ת עכשיו רק ב: ${locations.map((id) => b.locations?.find((l) => l.id === id)?.name ?? '').join(', ')}.` : `${email} עובד/ת עכשיו בכל הסניפים.`)} />
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              {b.paidUntil && <Button size="sm" variant="primary" disabled={!!busy} onClick={() => act(b, 'extend', {}, `"${b.name}" הוארך בחודש.`)}>
                {busy === `${b.id}:extend` ? <Spinner /> : null}הארך חודש</Button>}
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setDate(b)}>תאריך ידני</Button>
              {b.status === 'locked'
                ? <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act(b, 'unlock', {}, `"${b.name}" נפתח.`)}>פתיחה</Button>
                : <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => lock(b)}>נעילה</Button>}
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={onAssets}>שיוך נכסים</Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { setPw(null); setPerson({ biz: b.id, email: '', access: 'calendar', create: true, password: '' }); }}>+ אדם</Button>
              {b.members.some((m) => m.email) && <Button size="sm" variant="ghost" disabled={!!busy}
                onClick={() => { setPerson(null); setPw({ biz: b.id, email: b.members.find((m) => m.access === 'calendar')?.email || b.members.find((m) => m.email)!.email, password: '' }); }}>🔑 סיסמה חדשה</Button>}
              <Button size="sm" variant="ghost" disabled={!!busy || data.current === b.id} onClick={() => enter(b)}>כניסה לעסק</Button>
            </div>
            {pw?.biz === b.id && (() => {
              const weak = passwordProblem(pw.password);
              return (
                <div className="mt-3 rounded-2xl border border-line p-3" role="group" aria-label={`סיסמה חדשה ב${b.name}`}>
                  <Field label="למי">
                    <Select value={pw.email} onChange={(e) => setPw({ ...pw, email: e.target.value })}>
                      {b.members.filter((m) => m.email).map((m) => <option key={m.email} value={m.email}>{m.email}{m.access && m.access !== 'full' ? ` (${ACCESS_HE[m.access]})` : ''}</option>)}
                    </Select>
                  </Field>
                  <Field label="סיסמה חדשה (8 תווים לפחות, אותיות ומספרים)">
                    <Input {...PASSWORD_FIELD} value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} />
                  </Field>
                  {pw.password && weak && <p className="mb-2 text-xs text-warn">{weak}</p>}
                  <p className="mb-2 text-xs text-muted">הסיסמה הקודמת מפסיקה לעבוד מיד. שלחו את החדשה לאדם עצמו בלבד.</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" disabled={!!busy || Boolean(weak)} onClick={() => void savePassword(b)}>
                      {busy === `${b.id}:set_password` ? <Spinner /> : null}שמירת הסיסמה</Button>
                    <Button size="sm" variant="ghost" onClick={() => setPw(null)}>ביטול</Button>
                  </div>
                </div>
              );
            })()}
            {person?.biz === b.id && (() => {
              const weak = person.create ? passwordProblem(person.password) : null;
              const okEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email.trim());
              return (
                <div className="mt-3 rounded-2xl border border-line p-3" role="group" aria-label={`הוספת אדם ל${b.name}`}>
                  <Field label="מייל"><Input dir="ltr" type="email" autoComplete="off" value={person.email} onChange={(e) => setPerson({ ...person, email: e.target.value })} /></Field>
                  <Field label="הרשאה">
                    <Select value={person.access} onChange={(e) => setPerson({ ...person, access: e.target.value as Access })}>
                      {(['calendar', 'register', 'full'] as const).map((a) => <option key={a} value={a}>{ACCESS_HE[a]}</option>)}
                    </Select>
                  </Field>
                  {person.access === 'calendar' && <p className="mb-3 text-xs text-muted">רואה רק את התורים (של כל הצוות — מוסיף/ה, מזיז/ה ומבטל/ת, עם היסטוריה) ואת הלקוחות. לקוח חדש — רק עם טלפון. בלי כספים, תוכן, הגדרות או נוכחות.</p>}
                  <label className="mb-3 flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={person.create} onChange={(e) => setPerson({ ...person, create: e.target.checked, password: '' })} />
                    חשבון חדש — אני קובע/ת סיסמה (בלי הרשמה)
                  </label>
                  {person.create && (
                    <Field label="סיסמה (8 תווים לפחות, אותיות ומספרים)">
                      <Input {...PASSWORD_FIELD} value={person.password} onChange={(e) => setPerson({ ...person, password: e.target.value })} />
                    </Field>
                  )}
                  {person.create && person.password && weak && <p className="mb-2 text-xs text-warn">{weak}</p>}
                  {!person.create && <p className="mb-2 text-xs text-muted">בלי חשבון חדש — האדם צריך להיות רשום/ה כבר לאפליקציה עם המייל הזה.</p>}
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" disabled={!!busy || !okEmail || Boolean(weak)} onClick={() => void addPerson(b)}>
                      {busy === `${b.id}:${person.create ? 'create_user' : 'add_member'}` ? <Spinner /> : null}{person.create ? 'יצירה והוספה' : 'הוספה'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setPerson(null)}>ביטול</Button>
                  </div>
                </div>
              );
            })()}
          </Card>
        ))}
      </div>

      <Card>
        {!adding ? <Button variant="ghost" onClick={() => setAdding(true)}>+ הוספת עסק</Button> : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="שם העסק"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="למשל: מספרת רוני" /></Field>
            <Field label="מזהה באנגלית (לכתובות)"><Input dir="ltr" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="roni-hair" /></Field>
            <Field label="מייל הבעלים (לא חובה — חייב להיות רשום)"><Input dir="ltr" type="email" value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} /></Field>
            <Field label="בתוקף עד (ריק = בלי הגבלה)"><Input type="date" value={form.paidUntil} onChange={(e) => setForm({ ...form, paidUntil: e.target.value })} /></Field>
            <div className="flex gap-2 sm:col-span-2">
              <Button variant="primary" disabled={busy === 'add' || !form.name.trim() || !validSlug(form.slug.trim().toLowerCase())} onClick={add}>
                {busy === 'add' ? <Spinner /> : null}הוספה</Button>
              <Button variant="ghost" onClick={() => setAdding(false)}>ביטול</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * 2.107: what the business bought (Dream, "נוכחות ועובדים", or both — attendance only = the app shows that module only), and each
 * person's part in attendance: by their role (owner / editor = the attendance admin), or an approver / payroll (the accountant).
 */
const ATT_ROLE: Record<string, string> = { '': 'לפי התפקיד', admin: 'מנהל/ת נוכחות', approver: 'מאשר/ת', payroll: 'שכר / רואה חשבון' };
function AttendanceAccess({ b, busy, act }: { b: Biz; busy: boolean; act: (b: Biz, action: string, extra: Record<string, unknown>, ok: string) => Promise<boolean> }) {
  if (b.modules === null) return <p className="mt-2 text-xs text-muted">מודולים: הכול (מיגרציה 20261023005800 עוד לא במסד)</p>;
  const mods = b.modules ?? ['dream', 'attendance'];
  const toggle = (m: string) => {
    const next = mods.includes(m) ? mods.filter((x) => x !== m) : [...mods, m];
    if (!next.length) return;
    void act(b, 'modules', { modules: next }, `"${b.name}": ${next.map((x) => (x === 'dream' ? 'Dream' : 'נוכחות ועובדים')).join(' + ')}.`);
  };
  return (
    <details className="mt-2 rounded-xl bg-surface-2 p-2 text-sm">
      <summary className="cursor-pointer font-semibold">מודולים: {mods.map((x) => (x === 'dream' ? 'Dream' : 'נוכחות ועובדים')).join(' + ')}</summary>
      <div className="mt-2 flex flex-wrap gap-4">
        <label className="flex items-center gap-2"><input type="checkbox" disabled={busy || (mods.length === 1 && mods.includes('dream'))} checked={mods.includes('dream')} onChange={() => toggle('dream')} /> Dream (כל השאר)</label>
        <label className="flex items-center gap-2"><input type="checkbox" disabled={busy || (mods.length === 1 && mods.includes('attendance'))} checked={mods.includes('attendance')} onChange={() => toggle('attendance')} /> נוכחות ועובדים</label>
      </div>
      {mods.includes('attendance') && (
        <ul className="mt-2 grid gap-1">
          {b.members.filter((m) => !limited(m) && m.email).map((m) => (
            <li key={m.email} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words">{m.email}{m.role === 'viewer' ? ' (צפייה)' : ''}</span>
              <select aria-label={`התפקיד של ${m.email} בנוכחות`} disabled={busy} value={m.attendanceRole ?? ''} className="h-9 rounded-md border border-line bg-surface px-2"
                onChange={(e) => void act(b, 'member_attendance_role', { email: m.email, role: e.target.value || null }, `${m.email}: ${ATT_ROLE[e.target.value]}.`)}>
                {Object.entries(ATT_ROLE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/** which locations each person of the business works in: all of them, or some — the database shows them only those */
function MemberLocations({ b, busy, onSave }: { b: Biz; busy: boolean; onSave: (email: string, locations: string[] | null) => Promise<boolean> }) {
  const [edit, setEdit] = useState<{ email: string; picked: string[] | null } | null>(null);
  const places = b.locations ?? [];
  const nameOf = (id: string) => places.find((l) => l.id === id)?.name ?? '?';
  const toggle = (id: string) => setEdit((e) => {
    if (!e) return e;
    const now = e.picked ?? [];
    return { ...e, picked: now.includes(id) ? now.filter((x) => x !== id) : [...now, id] };
  });
  return (
    <details className="mt-2 rounded-xl bg-surface-2 p-2 text-sm">
      <summary className="cursor-pointer font-semibold">סניפים: {places.filter((l) => l.active).length} · מי עובד/ת איפה</summary>
      <ul className="mt-1 grid gap-1">
        {b.members.map((m) => (
          <li key={m.email || m.name} className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-words">{m.email || m.name}{m.access === 'register' ? ' (קופה)' : m.access === 'calendar' ? ' (יומן ולידים)' : ''}: <strong>{m.locations?.length ? m.locations.map(nameOf).join(', ') : 'כל הסניפים'}</strong></span>
            {m.email && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEdit({ email: m.email, picked: m.locations?.length ? [...m.locations] : null })}>שינוי</Button>}
          </li>
        ))}
      </ul>
      {edit && (
        <div className="mt-2 grid gap-1.5 rounded-xl border border-line p-2" role="group" aria-label={`הסניפים של ${edit.email}`}>
          <p className="font-semibold">הסניפים של {edit.email}</p>
          <label className="flex items-center gap-2"><input type="checkbox" checked={edit.picked === null} onChange={(e) => setEdit({ ...edit, picked: e.target.checked ? null : [] })} /> כל הסניפים</label>
          {edit.picked !== null && places.map((l) => (
            <label key={l.id} className="flex items-center gap-2"><input type="checkbox" checked={edit.picked!.includes(l.id)} onChange={() => toggle(l.id)} /> {l.name}{l.active ? '' : ' (סגור)'}</label>
          ))}
          <div className="mt-1 flex gap-2">
            <Button size="sm" variant="primary" disabled={busy || (edit.picked !== null && !edit.picked.length)}
              onClick={async () => { if (await onSave(edit.email, edit.picked)) setEdit(null); }}>שמירה</Button>
            <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>ביטול</Button>
          </div>
        </div>
      )}
    </details>
  );
}

function Mini({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-2" title={hint}>
      <p className="text-[11px] text-muted">{label}</p>
      <p className="text-[16px] font-bold">{value}</p>
    </div>
  );
}
