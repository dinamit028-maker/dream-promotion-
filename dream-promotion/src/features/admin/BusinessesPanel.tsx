'use client';
import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '@/lib/services/http';
import { Button, Card, Field, Input } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { STATE_HE, validSlug, type BizState } from './business-state';

/**
 * Admin → "עסקים": the super admin's dashboard — one card per business with its state, payment date
 * (warning a week before it ends), assets (warning when one was disconnected) and this month's
 * activity; actions: extend a month, set a date, lock / unlock, add a business, assign assets, enter.
 */
type Biz = {
  id: string; name: string; slug: string; status: string; paidUntil: string | null; graceDays: number; lockReason: string;
  state: BizState; lastDay: string | null; daysLeft: number | null; endingSoon: boolean;
  members: { role: string; email: string; name: string }[];
  assets: number; missing: string[];
  month: { posts: number; leads: number; costUsd: number };
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
                <p className="text-xs text-muted">{b.members.map((m) => m.email || m.name).join(' · ') || 'אין בעלים'}</p>
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

            <div className="mt-3 flex flex-wrap gap-2">
              {b.paidUntil && <Button size="sm" variant="primary" disabled={!!busy} onClick={() => act(b, 'extend', {}, `"${b.name}" הוארך בחודש.`)}>
                {busy === `${b.id}:extend` ? <Spinner /> : null}הארך חודש</Button>}
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setDate(b)}>תאריך ידני</Button>
              {b.status === 'locked'
                ? <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act(b, 'unlock', {}, `"${b.name}" נפתח.`)}>פתיחה</Button>
                : <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => lock(b)}>נעילה</Button>}
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={onAssets}>שיוך נכסים</Button>
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

function Mini({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-2" title={hint}>
      <p className="text-[11px] text-muted">{label}</p>
      <p className="text-[16px] font-bold">{value}</p>
    </div>
  );
}
