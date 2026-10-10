'use client';
import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '@/lib/services/http';
import { Button, Card, Field, Input } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { STATE_HE, validSlug, type BizState } from './business-state';
import { MILESTONES, milestoneCount, type Milestones } from './milestones';

/**
 * Admin → "עסקים": the super admin's dashboard — one card per business with its state, payment date
 * (warning a week before it ends), assets (warning when one was disconnected) and this month's
 * activity; actions: extend a month, set a date, lock / unlock, add a business, assign assets, enter,
 * add a person (full access, or the register only — "קופאי/ת") and remove one. 2.91 (T12א): a business with several locations
 * — which locations each person works in (all, or some: a cashier of one branch sees nothing of another).
 */
type Biz = {
  id: string; name: string; slug: string; status: string; paidUntil: string | null; graceDays: number; lockReason: string;
  state: BizState; lastDay: string | null; daysLeft: number | null; endingSoon: boolean;
  members: { role: string; access?: 'full' | 'register'; email: string; name: string; locations?: string[] | null }[];
  /** migration 4600: the business's locations, the main one first (one or none: nothing to choose) */
  locations?: { id: string; name: string; active: boolean }[];
  assets: number; missing: string[];
  month: { posts: number; leads: number; costUsd: number };
  milestones?: Milestones;
};
type Data = { businesses: Biz[]; current: string | null; unassignedAssets: number };

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
  /** a person who signed up joins this business: full access, or the register only ("קופאי/ת") */
  async function addMember(b: Biz) {
    const email = window.prompt(`הוספת אדם ל"${b.name}" — מייל (חייב להיות רשום/ה לאפליקציה):`, '');
    if (!email?.trim()) return;
    const kind = window.prompt('הרשאה: 1 = קופה בלבד (קופאי/ת), 2 = גישה מלאה', '1');
    if (kind === null) return;
    const access = kind.trim() === '2' ? 'full' : 'register';
    await act(b, 'add_member', { email: email.trim(), access }, `${email.trim()} נוסף/ה ל"${b.name}" — ${access === 'register' ? 'קופה בלבד' : 'גישה מלאה'}.`);
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
                <p className="text-xs text-muted">{b.members.filter((m) => m.access !== 'register').map((m) => m.email || m.name).join(' · ') || 'אין בעלים'}</p>
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
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void addMember(b)}>+ אדם / קופאי/ת</Button>
              <Button size="sm" variant="ghost" disabled={!!busy || data.current === b.id} onClick={() => enter(b)}>כניסה לעסק</Button>
            </div>
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
            <span className="min-w-0 break-words">{m.email || m.name}{m.access === 'register' ? ' (קופה)' : ''}: <strong>{m.locations?.length ? m.locations.map(nameOf).join(', ') : 'כל הסניפים'}</strong></span>
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
