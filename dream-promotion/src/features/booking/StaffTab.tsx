'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Field, Input, Select } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { authHeaders } from '@/lib/services/http';
import type { RoutingView, StaffView } from '@/features/crm/lead-routing';
import { CALENDAR_COLORS, staffColor, type CalStaff } from './calendar';

/**
 * "מטפלות" (2.105): who of the team is a column of the calendar, and her colour. The team is the same list the leads go to
 * (lead_staff, through /api/leads/departments — the owner changes it; anyone of the business sees it). A practitioner needs no
 * WhatsApp number: only one who gets messages has one.
 */
type Setup = RoutingView & { members?: { userId: string; name: string; role: string }[] };
const asCal = (s: StaffView): CalStaff => ({ id: s.id, name: s.name, color: s.color ?? '', practitioner: Boolean(s.practitioner), memberUserId: s.memberUserId, active: s.active });

function Swatches({ value, onPick, disabled, label }: { value: string; onPick: (c: string) => void; disabled?: boolean; label: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
      {CALENDAR_COLORS.map((c) => (
        <button key={c.key} type="button" role="radio" aria-checked={value === c.key} aria-label={c.label} title={c.label} disabled={disabled}
          onClick={() => onPick(c.key)}
          className={cx('cal-dot h-7 w-7 rounded-full border-2', `cal-${c.key}`, value === c.key ? 'border-ink' : 'border-transparent', disabled && 'opacity-50')} />
      ))}
    </div>
  );
}

export function StaffTab({ ready, onChanged }: { ready: boolean; onChanged: () => void }) {
  const [view, setView] = useState<Setup | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', color: '', phone: '', memberUserId: '' });

  /** the team from the server; keepErr: after a refusal — the list as it is, and the refusal's message stays on the screen */
  const load = useCallback(async (keepErr = false) => {
    try {
      const head = await authHeaders();
      let r = await fetch('/api/leads/departments?view=setup', { headers: head });
      let j = await r.json().catch(() => null);
      if (r.ok && j && !j.owner) { r = await fetch('/api/leads/departments', { headers: head }); j = await r.json().catch(() => null); }
      if (!r.ok) { setErr(j?.message ?? 'לא הצלחנו לטעון את הצוות.'); return; }
      setView(j);
      if (!keepErr) setErr(null);
    } catch { setErr('לא הצלחנו לטעון את הצוות.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function post(key: string, body: Record<string, unknown>, after?: () => void, failed?: () => void) {
    setBusy(key); setErr(null);
    try {
      const r = await fetch('/api/leads/departments', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (!r.ok) { setErr(j?.message ?? 'השמירה לא הצליחה.'); failed?.(); return; }
      setView((v) => (v ? { ...v, ...j } : j));
      after?.();
      onChanged();
    } catch { setErr('השמירה לא הצליחה.'); failed?.(); }
    finally { setBusy(null); }
  }
  /** "מטפל/ת ביומן" and the colour: shown at once; a refusal puts back what the server has, and says why */
  function calendar(id: string, patch: { practitioner?: boolean; color?: string }) {
    setView((v) => (v ? { ...v, staff: v.staff.map((x) => (x.id === id ? { ...x, ...patch } : x)) } : v));
    void post(id, { action: 'staff.calendar', id, ...patch }, undefined, () => void load(true));
  }

  if (!view && !err) return <div className="py-8 text-center"><Spinner /></div>;
  if (!view) return <p className="rounded-2xl bg-warn/10 p-3 text-sm text-warn">{err}</p>;
  if (!view.ready) return <p className="rounded-2xl bg-warn/10 p-3 text-sm text-warn">רשימת הצוות עוד לא זמינה: חסר עדכון במסד הנתונים (מיגרציה 20261012005300).</p>;

  const team = view.staff.filter((s) => s.active);
  const cal = team.map(asCal);
  const owner = view.owner && ready;
  return (
    <div className="grid gap-3">
      {err && <p className="rounded-2xl bg-warn/10 p-3 text-sm text-warn">{err}</p>}
      {!ready && (
        <p className="rounded-2xl bg-warn/10 p-3 text-sm text-warn">
          כדי לשבץ מטפלות ביומן צריך קודם להריץ את מיגרציה 20261018005700 (יומן התורים). עד אז היומן מציג את כל התורים בלי מטפלות.
        </p>
      )}
      <Card className="p-4">
        <h3 className="font-bold">המטפלות ביומן</h3>
        <p className="mb-3 text-sm text-muted">מי שמסומן/ת כאן מופיע/ה ביומן כעמודה, בצבע שלו/ה. זו אותה רשימת צוות שהלידים מגיעים אליה.</p>
        {!team.length && <p className="text-sm text-muted">עוד אין אף אחד ברשימת הצוות.</p>}
        <ul className="grid gap-2">
          {team.map((s) => {
            const c = asCal(s);
            return (
              <li key={s.id} className="rounded-2xl border border-line bg-surface p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className={cx('cal-dot h-3 w-3 rounded-full', `cal-${c.practitioner ? staffColor(cal, s.id) : 'none'}`)} aria-hidden="true" />
                  <strong>{s.name}</strong>
                  {view.owner && (s.phoneShown ? <bdi dir="ltr" className="text-sm tabular-nums text-ink-2">{s.phoneShown}</bdi> : <span className="text-xs text-muted">בלי וואטסאפ</span>)}
                  <label className="ms-auto flex items-center gap-2 text-sm font-semibold">
                    <input type="checkbox" className="h-5 w-5" checked={c.practitioner} disabled={!owner || busy === s.id}
                      onChange={(e) => calendar(s.id, { practitioner: e.target.checked })} />
                    מטפל/ת ביומן
                  </label>
                </div>
                {c.practitioner && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted">צבע:</span>
                    <Swatches value={c.color} disabled={!owner || busy === s.id} label={`הצבע של ${s.name}`}
                      onPick={(color) => calendar(s.id, { color })} />
                    {!c.color && <span className="text-xs text-muted">(בינתיים צבע אוטומטי)</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {owner && (
        <Card className="p-4">
          <h3 className="mb-3 font-bold">מטפל/ת חדש/ה</h3>
          <Field label="שם"><Input value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="למשל: נועה לוי" /></Field>
          <p className="mb-1.5 text-sm font-semibold">צבע ביומן</p>
          <div className="mb-4"><Swatches value={draft.color} onPick={(color) => setDraft({ ...draft, color })} label="צבע ביומן" /></div>
          <Field label="מספר וואטסאפ (לא חובה — רק למי שמקבל/ת הודעות)">
            <Input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} inputMode="tel" dir="ltr" placeholder="050-1234567" />
          </Field>
          <Field label="החשבון שלה/ו ב-Dream (לא חובה — בשביל &quot;רק שלי&quot; וההיסטוריה)">
            <Select value={draft.memberUserId} onChange={(e) => setDraft({ ...draft, memberUserId: e.target.value })}>
              <option value="">בלי חשבון</option>
              {(view.members ?? []).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
            </Select>
          </Field>
          <Button variant="primary" disabled={busy === 'new' || !draft.name.trim()}
            onClick={() => void post('new', { action: 'staff.save', name: draft.name, phone: draft.phone, memberUserId: draft.memberUserId || null, practitioner: true, color: draft.color },
              () => setDraft({ name: '', color: '', phone: '', memberUserId: '' }))}>
            {busy === 'new' ? 'שומר…' : 'הוספה ליומן'}
          </Button>
        </Card>
      )}
      {!view.owner && <p className="text-xs text-muted">רק בעלי העסק משנים את רשימת המטפלות.</p>}
    </div>
  );
}
