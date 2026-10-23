'use client';
import { useEffect, useState } from 'react';
import { Button, Card, Chip, Field, Input, PageHead, Pill, Select } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/feedback';
import { supabase } from '@/lib/supabase/client';
import { QrTab, type QrSettings } from '@/features/timeclock/AttendanceScreen';
import { useAtt } from './AttendanceLayout';
import { addTrack, attError, saveTrack, setExportsPdfOnly, setTrackActive } from './api';
import { DAY_NAMES, hm } from './hours-engine';
import { AUTO_BREAK, DEFAULT_RULES, RULE_NOTES, ratesValid, rulesOf, type ContractRules } from './overtime-rules';
import { isAdmin, trackDayMinutes, trackDayText, trackSummary, type WorkTrack } from './people';
import { Notice } from './ui';

/**
 * הגדרות (2.107): the hours tracks — each one a contract ("מסלול הסכם"): the standard of each weekday, the overtime threshold (by
 * day — 8:00 / 8:36 / 8:40 / anything — or by month, e.g. 186 hours), the rates of the recommended split (125% for two hours,
 * then 150%), the weekly rest day, a festival, Independence Day, the eve of a festival, an automatic 30-minute break. The system
 * calculates hours only; the split is a recommendation for the accountant (the owner of the system, 23.10.2026) — nothing waits
 * for a confirmation of it. Then the business's clock QR (as before), and hours as PDF only.
 */
const SOURCE: Record<string, { label: string; tone: 'ok' | 'ai' | 'default' }> = {
  common: { label: 'נהוג במשק', tone: 'ok' }, owner: { label: 'ברירת מחדל', tone: 'default' }, employer: { label: 'לפי המעסיק', tone: 'ai' },
};

export function Settings() {
  const att = useAtt();
  const admin = isAdmin(att.role);
  const [editing, setEditing] = useState<WorkTrack | 'new' | null>(null);
  const [qr, setQr] = useState<QrSettings | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { supabase().from('timeclock_settings').select('*').maybeSingle().then(({ data }) => setQr((data as any) ?? null)); }, []);
  async function run(fn: () => Promise<unknown>, msg: string) {
    setBusy(true); setErr(null);
    try { await fn(); await att.reload(); att.say(msg); } catch (e) { setErr(attError(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHead title="הגדרות" />
      {err && <Notice tone="warn">{err}</Notice>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="font-bold">מסלולי הסכם (שעות תקן, והמלצה לחלוקה)</h3>
            {admin && <Button size="sm" variant="primary" onClick={() => setEditing('new')}>מסלול חדש</Button>}
          </div>
          <ul className="divide-y divide-line">
            {att.setup.tracks.map((t) => {
              const r = rulesOf(t.rules);
              return (
                <li key={t.id} className="py-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0"><strong className={t.active ? '' : 'text-muted line-through'}>{t.name}</strong>
                      <span className="block text-xs text-muted">{trackSummary(t)}{t.startTime ? ` · התחלה ${t.startTime}` : ''}</span>
                      <span className="block text-xs text-muted">{r.mode === 'monthly' ? `נוספות אחרי ${hm(r.monthlyMinutes ?? 0)} בחודש` : 'נוספות אחרי שעות התקן של היום'}
                        {` · ${r.tier1Pct}% ל-${hm(r.tier1Minutes)}, ואז ${r.tier2Pct}% · מנוחה ${r.restPct}%${r.autoBreakMin ? ` · הפסקה ${r.autoBreakMin} ד׳` : ''}`}</span></span>
                    {admin && <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>עריכה</Button>}
                  </div>
                </li>
              );
            })}
            {!att.setup.tracks.length && <li className="py-2 text-sm text-muted">עוד אין מסלולים. בלי מסלול אין שעות תקן, חוסרים או סגירת חודש.</li>}
          </ul>
        </Card>

        <div className="grid gap-4">
          <Card className="p-4">
            <h3 className="mb-1 font-bold">ייצוא שעות</h3>
            <label className="flex items-start justify-between gap-3">
              <span><strong className="block text-sm">PDF בלבד</strong>
                <span className="text-xs text-muted">השעות יוצאות רק כ-PDF, כדי שאף אחד לא ישנה אותן מחוץ למערכת. שינוי שעות — רק בתיקון מתועד (מי, מתי ולמה).</span></span>
              <input type="checkbox" className="mt-1 h-5 w-5" disabled={!admin || busy} checked={att.pdfOnly} aria-label="ייצוא שעות ב-PDF בלבד"
                onChange={(e) => void run(() => setExportsPdfOnly(att.userId, e.target.checked), e.target.checked ? 'השעות יוצאות ב-PDF בלבד' : 'מותר גם אקסל וקובץ שכר')} />
            </label>
          </Card>
          <Card className="p-4">
            <h3 className="mb-1 font-bold">איך מחושבות השעות</h3>
            <p className="mb-3 text-sm text-ink-2">המערכת מחשבת שעות: יומי, מצטבר, מעבר לתקן, ימי מנוחה וחוסרים. החלוקה לאחוזים היא המלצה בלבד לרואה החשבון — הוא והמעסיק מחליטים מה משולם. כל מעסיק קובע את ההגדרות לכל מסלול; ברירות המחדל:</p>
            <ul className="grid gap-2 text-sm">
              {RULE_NOTES.map((r) => (
                <li key={r.key} className="flex items-start justify-between gap-2"><span>{r.text}</span><Pill tone={SOURCE[r.source].tone}>{SOURCE[r.source].label}</Pill></li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <h3 className="mb-2 mt-6 font-display text-lg font-bold">קוד QR לשעון</h3>
      {qr !== undefined && admin && <QrTab userId={att.userId} business={att.businessName} value={qr} onSaved={(v, m) => { setQr(v); att.say(m); }} onError={(e) => setErr(attError(e))} />}
      {!admin && <p className="text-sm text-muted">רק מנהל הנוכחות משנה את קוד ה-QR.</p>}
      {editing && <TrackEditor value={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onActive={(t) => void run(() => setTrackActive(t.id, !t.active), t.active ? 'המסלול נסגר' : 'המסלול נפתח')} />}
    </>
  );
}

const SIX_DAYS = [480, 480, 480, 480, 480, 480, 0];
const FIVE_DAYS = [516, 516, 516, 516, 516, 0, 0];
const num = (v: string) => (v.trim() === '' ? NaN : Number(v.replace(',', '.')));
const hoursOf = (min: number | null) => (min == null ? '' : String(Math.round((min / 60) * 100) / 100));

function TrackEditor({ value, onClose, onActive }: { value: WorkTrack | null; onClose: () => void; onActive: (t: WorkTrack) => void }) {
  const att = useAtt();
  const start = rulesOf(value?.rules ?? DEFAULT_RULES);
  const [f, setF] = useState({
    name: value?.name ?? '', days: (value?.dayMinutes ?? SIX_DAYS).map(trackDayText),
    start: value?.startTime ?? '', grace: String(value?.lateGraceMin ?? 0),
  });
  const [r, setR] = useState<ContractRules>(start);
  const [text, setText] = useState({ monthly: hoursOf(start.monthlyMinutes), monthlyT1: hoursOf(start.monthlyTier1Minutes), tier1: hoursOf(start.tier1Minutes),
    eve: hoursOf(start.eveMinutes), breakAfter: hoursOf(start.autoBreakAfterMin || AUTO_BREAK.afterMinutes) });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mins = f.days.map(trackDayMinutes);
  const workdays = mins.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
  const setAll = (min: number) => setF({ ...f, days: f.days.map((d, i) => (mins[i] ? trackDayText(min) : d)) });
  const rules: ContractRules = {
    ...r,
    monthlyMinutes: r.mode === 'monthly' ? Math.round(num(text.monthly) * 60) : null,
    monthlyTier1Minutes: r.mode === 'monthly' ? Math.round(num(text.monthlyT1) * 60) : null,
    tier1Minutes: Math.round(num(text.tier1) * 60),
    eveMinutes: text.eve.trim() === '' ? null : Math.round(num(text.eve) * 60),
    autoBreakAfterMin: r.autoBreakMin ? Math.round(num(text.breakAfter) * 60) : 0,
  };
  const bad = !f.name.trim() || mins.some((m) => m === undefined) || !ratesValid(rules) || !Number.isFinite(rules.tier1Minutes)
    || (rules.eveMinutes != null && !Number.isFinite(rules.eveMinutes)) || (r.autoBreakMin > 0 && !Number.isFinite(rules.autoBreakAfterMin));
  const pct = (k: keyof ContractRules, label: string) => (
    <label className="text-sm"><span className="mb-1 block text-muted">{label}</span>
      <Input value={String(r[k])} inputMode="numeric" aria-label={label} onChange={(e) => setR({ ...r, [k]: Number(e.target.value.replace(/\D/g, '') || 0) })} /></label>
  );
  async function save() {
    setBusy(true); setErr(null);
    const t = { name: f.name, dayMinutes: mins as number[], startTime: f.start || null, lateGraceMin: Math.max(0, Math.min(240, Number(f.grace) || 0)), rules };
    try {
      if (value) await saveTrack(value.id, t); else await addTrack(att.businessId, t);
      await att.reload(); att.say('המסלול נשמר'); onClose();
    } catch (e) { setErr(attError(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} wide>
      <h3 className="mb-3 font-display text-xl font-bold">{value ? `מסלול — ${value.name}` : 'מסלול הסכם חדש'}</h3>
      {value && <Notice>חודש שכבר נסגר נשאר לפי ההגדרות שהיו בו.</Notice>}
      <Field label="שם המסלול"><Input value={f.name} maxLength={60} placeholder="למשל: 6 ימים, 8 שעות" onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>

      <p className="mb-2 text-sm font-semibold text-ink-2">ימי עבודה ושעות תקן (ריק = לא יום עבודה; 8, 8.6 או 8:40)</p>
      <div className="mb-2 flex flex-wrap gap-1.5">
        <Chip className="min-h-10" onClick={() => setF({ ...f, days: SIX_DAYS.map(trackDayText) })}>6 ימים (א׳–ו׳)</Chip>
        <Chip className="min-h-10" onClick={() => setF({ ...f, days: FIVE_DAYS.map(trackDayText) })}>5 ימים (א׳–ה׳)</Chip>
        <span className="mx-1 self-center text-sm text-muted">שעות נוספות אחרי:</span>
        {[480, 516, 520].map((m) => <Chip key={m} className="min-h-10" onClick={() => setAll(m)}>{hm(m)}</Chip>)}
      </div>
      <div className="mb-4 grid grid-cols-4 gap-2 sm:grid-cols-7">
        {DAY_NAMES.map((d, i) => (
          <label key={d} className="text-sm"><span className="mb-1 block text-muted">{d}</span>
            <Input value={f.days[i]} inputMode="decimal" aria-label={`שעות תקן ביום ${d}`} onChange={(e) => setF({ ...f, days: f.days.map((x, j) => (j === i ? e.target.value : x)) })}
              className={mins[i] === undefined ? 'border-(--warn)' : ''} /></label>
        ))}
      </div>

      <fieldset className="mb-4 rounded-2xl border border-line p-3">
        <legend className="px-1 text-sm font-bold">שעות נוספות — המלצה לחלוקה</legend>
        <div className="mb-3 flex flex-wrap gap-1.5">
          <Chip className="min-h-10" on={r.mode === 'daily'} onClick={() => setR({ ...r, mode: 'daily' })}>אחרי שעות התקן של כל יום</Chip>
          <Chip className="min-h-10" on={r.mode === 'monthly'} onClick={() => setR({ ...r, mode: 'monthly' })}>אחרי סף חודשי (לפי חוזה)</Chip>
        </div>
        {r.mode === 'monthly' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="שעות בחודש לפני שעות נוספות"><Input value={text.monthly} inputMode="decimal" placeholder="למשל 186" onChange={(e) => setText({ ...text, monthly: e.target.value })} /></Field>
            <Field label={`מתוך הנוספות — כמה שעות ב-${r.tier1Pct}%`}><Input value={text.monthlyT1} inputMode="decimal" placeholder="לפי החוזה" onChange={(e) => setText({ ...text, monthlyT1: e.target.value })} /></Field>
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          {r.mode === 'daily' && <label className="text-sm"><span className="mb-1 block text-muted">שעות בדרגה הראשונה</span>
            <Input value={text.tier1} inputMode="decimal" aria-label="שעות בדרגה הראשונה" onChange={(e) => setText({ ...text, tier1: e.target.value })} /></label>}
          {pct('tier1Pct', 'דרגה ראשונה (%)')}
          {pct('tier2Pct', 'אחריה (%)')}
        </div>
      </fieldset>

      <fieldset className="mb-4 rounded-2xl border border-line p-3">
        <legend className="px-1 text-sm font-bold">ימי מנוחה וחגים</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <label className="text-sm"><span className="mb-1 block text-muted">יום המנוחה השבועי</span>
            <Select value={r.restWeekday} aria-label="יום המנוחה השבועי" onChange={(e) => setR({ ...r, restWeekday: Number(e.target.value) })}>
              {DAY_NAMES.map((d, i) => <option key={d} value={i} disabled={workdays.includes(i) && i !== r.restWeekday}>{d}</option>)}
            </Select></label>
          {pct('restPct', 'עבודה ביום המנוחה (%)')}
          {pct('restTier1Pct', 'נוספות ביום מנוחה — שעתיים (%)')}
          {pct('restTier2Pct', 'נוספות ביום מנוחה — אחר כך (%)')}
          {pct('festivalPct', 'עבודה בחג (%)')}
          {pct('independencePct', 'עבודה ביום העצמאות (%)')}
        </div>
        <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={r.independenceRest} onChange={(e) => setR({ ...r, independenceRest: e.target.checked })} /> יום העצמאות — יום מנוחה</label>
        <div className="mt-2 max-w-xs"><Field label="ערב חג — שעות תקן (ריק = כמו יום רגיל)"><Input value={text.eve} inputMode="decimal" onChange={(e) => setText({ ...text, eve: e.target.value })} /></Field></div>
      </fieldset>

      <fieldset className="mb-4 rounded-2xl border border-line p-3">
        <legend className="px-1 text-sm font-bold">הפסקה</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={r.autoBreakMin > 0} aria-label="הפסקה אוטומטית של 30 דקות"
            onChange={(e) => setR({ ...r, autoBreakMin: e.target.checked ? AUTO_BREAK.minutes : 0 })} />
          <span><strong>הפסקה אוטומטית של 30 דקות</strong> — בלחיצת כפתור: יורדת מכל יום עבודה של יותר מ-8 שעות, בלי שהעובד/ת מחתים/ה יציאה וכניסה להפסקה.
            <span className="block text-xs text-muted">הדרך הרגילה — העובד/ת מחתים/ה יציאה וכניסה, וכך ההפסקה מתועדת. אם ביום עם הכפתור העובד/ת גם הוחתם/ה להפסקה, ההפסקה שהוחתמה נספרת בתוך ה-30 — כדי שלא ירד פעמיים.</span></span>
        </label>
        {r.autoBreakMin > 0 && <div className="mt-2 max-w-xs"><Field label="ביום עבודה של יותר מ- (שעות)"><Input value={text.breakAfter} inputMode="decimal" onChange={(e) => setText({ ...text, breakAfter: e.target.value })} /></Field></div>}
      </fieldset>

      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="שעת התחלה (לסימון איחור, לא חובה)"><Input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
        <Field label="דקות חסד לאיחור"><Input value={f.grace} inputMode="numeric" onChange={(e) => setF({ ...f, grace: e.target.value })} /></Field>
      </div>
      {!ratesValid(rules) && <p className="mb-3 text-sm text-warn">אחוזים — בין 100 ל-400. בסף חודשי — גם השעות בחודש וגם כמה מהן בדרגה הראשונה.</p>}
      {err && <p role="alert" className="mb-3 text-sm text-warn">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || bad} onClick={() => void save()}>שמירה</Button>
        {value && <Button variant="ghost" disabled={busy} onClick={() => { onActive(value); onClose(); }}>{value.active ? 'סגירת המסלול' : 'פתיחת המסלול'}</Button>}
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}
