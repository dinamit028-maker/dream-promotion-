'use client';
import { useEffect, useState } from 'react';
import { Button, Card, Field, Input, PageHead, Pill } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/feedback';
import { supabase } from '@/lib/supabase/client';
import { QrTab, type QrSettings } from '@/features/timeclock/AttendanceScreen';
import { useAtt } from './AttendanceLayout';
import { addTrack, attError, saveTrack, type TrackForm } from './api';
import { DAY_NAMES } from './hours-engine';
import { OVERTIME_CONFIRMED, RULE_NOTES } from './overtime-rules';
import { isAdmin, trackDayMinutes, trackDayText, trackSummary, type WorkTrack } from './people';
import { Notice } from './ui';

/**
 * הגדרות (2.107): the hours tracks (the standard of each weekday — 8.6 / 9 hours, five or six days — the expected start for
 * "late", an unpaid break), the business's clock QR (the same screen as before), and the overtime rules as they are now —
 * read only: they are changed in overtime-rules.ts, with their tests, after the owner of the system confirms them.
 */
export function Settings() {
  const att = useAtt();
  const admin = isAdmin(att.role);
  const [editing, setEditing] = useState<WorkTrack | 'new' | null>(null);
  const [qr, setQr] = useState<QrSettings | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { supabase().from('timeclock_settings').select('*').maybeSingle().then(({ data }) => setQr((data as any) ?? null)); }, []);
  return (
    <>
      <PageHead title="הגדרות" />
      {err && <Notice tone="warn">{err}</Notice>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="font-bold">מסלולי שעות תקן</h3>
            {admin && <Button size="sm" variant="primary" onClick={() => setEditing('new')}>מסלול חדש</Button>}
          </div>
          <ul className="divide-y divide-line">
            {att.setup.tracks.map((t) => (
              <li key={t.id} className="flex min-h-12 items-center justify-between gap-2 py-2">
                <span><strong className={t.active ? '' : 'text-muted line-through'}>{t.name}</strong>
                  <span className="block text-xs text-muted">{trackSummary(t)}{t.startTime ? ` · התחלה ${t.startTime}` : ''}{t.autoBreakMin ? ` · הפסקה ${t.autoBreakMin} ד׳` : ''}</span></span>
                {admin && <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>עריכה</Button>}
              </li>
            ))}
            {!att.setup.tracks.length && <li className="py-2 text-sm text-muted">עוד אין מסלולים. בלי מסלול אין שעות תקן — וגם לא "חסר דיווח" ושעות נוספות לפי יום.</li>}
          </ul>
        </Card>

        <Card className="p-4">
          <h3 className="mb-1 font-bold">כללי שעות נוספות</h3>
          <p className="mb-3 text-sm text-ink-2">הכללים כתובים במקום אחד במערכת, עם בדיקות. שינוי — רק אחרי אישור של בעל המערכת.</p>
          {!OVERTIME_CONFIRMED && <Notice tone="warn">חלק מהכללים ממתינים לאישור — עד אז העמודות של 125% / 150% מסומנות "טיוטה", והקובץ לתוכנת השכר לא יוצא.</Notice>}
          <ul className="grid gap-2 text-sm">
            {RULE_NOTES.map((r) => (
              <li key={r.key} className="flex items-start justify-between gap-2">
                <span>{r.text}</span>
                <Pill tone={r.source === 'law' ? 'ok' : 'warn'}>{r.source === 'law' ? 'לפי החוק' : 'ממתין לאישור'}</Pill>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <h3 className="mb-2 mt-6 font-display text-lg font-bold">קוד QR לשעון</h3>
      {qr !== undefined && admin && <QrTab userId={att.userId} business={att.businessName} value={qr} onSaved={(v, m) => { setQr(v); att.say(m); }} onError={(e) => setErr(attError(e))} />}
      {!admin && <p className="text-sm text-muted">רק מנהל הנוכחות משנה את קוד ה-QR.</p>}
      {editing && <TrackEditor value={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function TrackEditor({ value, onClose }: { value: WorkTrack | null; onClose: () => void }) {
  const att = useAtt();
  const [f, setF] = useState({
    name: value?.name ?? '', days: (value?.dayMinutes ?? [516, 516, 516, 516, 516, 0, 0]).map(trackDayText),
    start: value?.startTime ?? '', grace: String(value?.lateGraceMin ?? 0), brk: String(value?.autoBreakMin ?? 0), after: String((value?.autoBreakAfterMin ?? 0) / 60 || ''),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mins = f.days.map(trackDayMinutes);
  const bad = !f.name.trim() || mins.some((m) => m === undefined);
  async function save(active = value?.active ?? true) {
    setBusy(true); setErr(null);
    const t: TrackForm = { name: f.name, dayMinutes: mins as number[], startTime: f.start || null, lateGraceMin: Math.max(0, Math.min(240, Number(f.grace) || 0)),
      autoBreakMin: Math.max(0, Math.min(180, Number(f.brk) || 0)), autoBreakAfterMin: Math.max(0, Math.min(1440, Math.round((Number(f.after.replace(',', '.')) || 0) * 60))) };
    try {
      if (value) { await saveTrack(value.id, t); if (active !== value.active) await supabase().from('work_tracks').update({ active }).eq('id', value.id); }
      else await addTrack(att.businessId, t);
      await att.reload(); att.say('המסלול נשמר'); onClose();
    } catch (e) { setErr(attError(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} wide>
      <h3 className="mb-3 font-display text-xl font-bold">{value ? `מסלול — ${value.name}` : 'מסלול שעות חדש'}</h3>
      <Field label="שם המסלול"><Input value={f.name} maxLength={60} placeholder="למשל: 8.6 שעות, 5 ימים" onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <p className="mb-2 text-sm font-semibold text-ink-2">שעות תקן לכל יום (ריק = לא יום עבודה; 8.6 או 8:36)</p>
      <div className="mb-4 grid grid-cols-4 gap-2 sm:grid-cols-7">
        {DAY_NAMES.map((d, i) => (
          <label key={d} className="text-sm"><span className="mb-1 block text-muted">{d}</span>
            <Input value={f.days[i]} inputMode="decimal" aria-label={`שעות תקן ביום ${d}`} onChange={(e) => setF({ ...f, days: f.days.map((x, j) => (j === i ? e.target.value : x)) })}
              className={mins[i] === undefined ? 'border-(--warn)' : ''} /></label>
        ))}
      </div>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="שעת התחלה (לסימון איחור, לא חובה)"><Input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
        <Field label="דקות חסד לאיחור"><Input value={f.grace} inputMode="numeric" onChange={(e) => setF({ ...f, grace: e.target.value })} /></Field>
        <Field label="הפסקה שלא משולמת (דקות; 0 = אין)"><Input value={f.brk} inputMode="numeric" onChange={(e) => setF({ ...f, brk: e.target.value })} /></Field>
        <Field label="ביום של לפחות (שעות)"><Input value={f.after} inputMode="decimal" placeholder="למשל 6" onChange={(e) => setF({ ...f, after: e.target.value })} /></Field>
      </div>
      <p className="mb-3 text-xs text-muted">הפסקה: יורדת רק מיום ארוך מספיק, ופחות ממה שהעובד/ת כבר יצא/ה להפסקה (יציאה וכניסה). איזה כלל נכון אצלכם — שאלה פתוחה לבעל המערכת.</p>
      {err && <p role="alert" className="mb-3 text-sm text-warn">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || bad} onClick={() => void save()}>שמירה</Button>
        {value && <Button variant="ghost" disabled={busy || bad} onClick={() => void save(!value.active)}>{value.active ? 'סגירת המסלול' : 'פתיחת המסלול'}</Button>}
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}
