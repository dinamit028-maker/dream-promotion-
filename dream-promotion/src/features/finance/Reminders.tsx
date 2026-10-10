'use client';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import { Button, Chip, Input } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { waLink } from '@/features/crm/crm';
import { ils } from '@/features/register/money';
import { daysText, normalizeDays, reminderDoc, reminderLine, reminderText, WHATSAPP_RESULT_HE, type Channel, type Reminder, type ReminderSettings } from './reminders';
import {
  configureReminders, documentReminders, isBusinessOwner, loadQueue, loadReminderSettings, previewReminders, remindersReady, remindersStopped, sendQueued,
  skipQueued, stopReminders, type QueuedReminder,
} from './plans-data';
import { Note, Pill, ddmmyyyy, todayIL } from './ui';
import { formatIL } from '@/lib/il-time';

/**
 * Scheduled debt reminders (T5, 2.89). Off until the business's owner turns them on — the approval (who, when, these rules) is
 * kept and logged; anyone who may write the money turns them off. The dashboard's timer queues them: an email (sent by the
 * server, through the one outbox) or the WhatsApp queue below, where the owner presses "שליחה" and WhatsApp opens with the text.
 * A payment stops them: the database asks again before every send. Nothing is sent without that approval.
 */
export function ReminderSettingsCard({ userId, businessId }: { userId: string; businessId: string | null }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [s, setS] = useState<ReminderSettings | null>(null);
  const [owner, setOwner] = useState(false);
  const [days, setDays] = useState<string[]>(['3', '7', '14']);
  const [channel, setChannel] = useState<Channel>('whatsapp');
  const [approve, setApprove] = useState(false);
  const [preview, setPreview] = useState<{ email: number; whatsapp: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const load = useCallback(async () => {
    if (!(await remindersReady())) { setReady(false); return; }
    const [st, o] = await Promise.all([loadReminderSettings(), isBusinessOwner(userId, businessId)]);
    setReady(true); setS(st); setOwner(o); setDays(st.days.map(String)); setChannel(st.channel);
  }, [userId, businessId]);
  useEffect(() => { void load(); }, [load]);
  const norm = normalizeDays(days.filter((d) => d.trim() !== ''));
  useEffect(() => {
    if (!ready || norm.error || s?.enabled) { setPreview(null); return; }
    let alive = true;
    void previewReminders(norm.days, channel).then((p) => { if (alive) setPreview(p); });
    return () => { alive = false; };
  }, [ready, norm.days.join(','), norm.error, channel, s?.enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  if (ready === null) return <Spinner />;
  if (!ready || !s) return null;
  async function save(enabled: boolean) {
    if (norm.error) { setMsg({ tone: 'warn', text: norm.error }); return; }
    setBusy(true); setMsg(null);
    const r = await configureReminders(enabled, norm.days, channel);
    setBusy(false);
    if (!r.ok) { setMsg({ tone: 'warn', text: r.error }); return; }
    setS(r.data); setApprove(false);
    setMsg({ tone: 'ok', text: enabled ? 'התזכורות האוטומטיות פועלות.' : 'התזכורות האוטומטיות כבויות. מה שחיכה בתור בוטל.' });
  }
  const changed = s.enabled && (norm.days.join(',') !== s.days.join(',') || channel !== s.channel);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-bold">תזכורות חוב אוטומטיות</p>
        <Pill tone={s.enabled ? 'ok' : 'default'}>{s.enabled ? 'פועלות' : 'כבויות'}</Pill>
      </div>
      {s.enabled && s.approvedAt && <p className="text-sm text-muted">הופעלו באישור הבעלים ב-{formatIL(s.approvedAt, { timeStyle: 'short' })}: {daysText(s.days)}, {s.channel === 'email' ? 'במייל' : 'בתור לשליחה בוואטסאפ'}.</p>}
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="font-semibold">ימים אחרי מועד התשלום:</span>
        {days.map((d, i) => (
          <div key={i} className="w-16"><Input type="number" min={1} max={120} value={d} className="px-1 py-1.5 text-center" aria-label={`תזכורת ${i + 1} — ימים`}
            onChange={(e) => setDays(days.map((x, k) => (k === i ? e.target.value : x)))} /></div>
        ))}
        {days.length < 5 && <Button size="sm" variant="ghost" onClick={() => setDays([...days, String(Math.min(120, (Number(days[days.length - 1]) || 0) + 7))])}>+ יום</Button>}
        {days.length > 1 && <Button size="sm" variant="ghost" onClick={() => setDays(days.slice(0, -1))}>− יום</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="font-semibold">ערוץ:</span>
        <Chip on={channel === 'whatsapp'} onClick={() => setChannel('whatsapp')}>תור לשליחה בוואטסאפ</Chip>
        <Chip on={channel === 'email'} onClick={() => setChannel('email')}>מייל</Chip>
      </div>
      <p className="text-xs text-muted">
        {channel === 'email' ? 'מייל נשלח מעצמו ללקוח שיש לו כתובת מייל; ללקוח בלי מייל — התזכורת נכנסת לתור הוואטסאפ.' : 'התזכורות מחכות ב"חייבים" — לוחצים "שליחה" וואטסאפ נפתח עם הנוסח.'}
        {' '}רק ללקוחות עם כרטיס, בימים א׳–ו׳ בין 09:00 ל-19:00. תשלום עוצר את התזכורות, וגם "לא לשלוח" בכרטיס הלקוח. חוב שעבר יותר מ-30 יום מהתזכורת האחרונה — רק ידנית.
      </p>
      {norm.error && <Note tone="warn">{norm.error}</Note>}
      {!s.enabled && preview && <p className="text-sm">אם יופעלו עכשיו: {preview.email + preview.whatsapp ? `${preview.email ? `${preview.email} במייל` : ''}${preview.email && preview.whatsapp ? ' ו-' : ''}${preview.whatsapp ? `${preview.whatsapp} לתור הוואטסאפ` : ''}` : 'אין כרגע חוב שמגיעה לו תזכורת'}.</p>}
      {owner ? (
        (!s.enabled || changed) && <>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} className="mt-1" />
            <span>אני מאשר/ת לשלוח ללקוחות תזכורות חוב לפי הכללים האלה ({norm.error ? '…' : daysText(norm.days)}).</span></label>
          <div><Button variant="primary" disabled={busy || !approve || Boolean(norm.error)} onClick={() => void save(true)}>{busy ? <Spinner /> : s.enabled ? 'שמירת הכללים החדשים' : 'הפעלת התזכורות'}</Button></div>
        </>
      ) : !s.enabled && <Note>רק הבעלים של העסק מפעילים תזכורות אוטומטיות.</Note>}
      {s.enabled && <div><Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(false)}>כיבוי התזכורות</Button></div>}
      {msg && <div role="status"><Note tone={msg.tone}>{msg.text}</Note></div>}
    </div>
  );
}

/** the WhatsApp queue: what the timer queued, with the debt as it is now; "שליחה" asks the database again first */
export function ReminderQueue({ business, onChanged }: { business: string; onChanged?: () => void }) {
  const brand = useApp((s) => s.brand);
  const [list, setList] = useState<QueuedReminder[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const load = useCallback(async () => { setList((await remindersReady()) ? await loadQueue() : []); }, []);
  useEffect(() => { void load(); }, [load]);
  if (!list?.length) return msg ? <Note tone={msg.tone}>{msg.text}</Note> : null;
  const today = todayIL();
  async function send(q: QueuedReminder, paid: boolean) {
    // the window opens on the press itself (phones block one opened after a request), then gets WhatsApp's address;
    // a debt paid meanwhile opens nothing (the database cancels its reminder)
    const w = paid ? null : window.open('', '_blank');
    setBusy(q.reminder.id); setMsg(null);
    const r = await sendQueued(q.reminder.id);
    setBusy(null);
    if (!r.ok || r.data.result !== 'ok') {
      w?.close();
      setMsg({ tone: 'warn', text: r.ok ? WHATSAPP_RESULT_HE[r.data.result] ?? 'התזכורת לא נשלחה.' : r.error });
    } else {
      const s = r.data.state;
      const text = reminderText({ tone: s.tone, customerName: String(s.customer ?? ''), docType: Number(s.docType), docNumber: s.docNumber, n: s.n ?? null, of: s.of ?? null,
        open: Number(s.open), due: s.due ?? null, business: business || brand.name, link: s.shareToken ? `${window.location.origin}/d/${s.shareToken}` : '' });
      const url = waLink(q.reminder.toAddress, text);
      if (w && url) { w.opener = null; w.location.href = url; } else { w?.close(); if (url) window.open(url, '_blank', 'noopener'); }
      setMsg({ tone: 'ok', text: 'התזכורת נרשמה כנשלחה — בכרטיס הלקוח וביומן.' });
    }
    await load(); onChanged?.();
  }
  async function skip(q: QueuedReminder) {
    setBusy(q.reminder.id);
    const r = await skipQueued(q.reminder.id);
    setBusy(null);
    if (!r.ok) setMsg({ tone: 'warn', text: r.error });
    await load();
  }
  return (
    <div className="grid gap-1.5 rounded-2xl border border-primary/40 bg-primary-soft/40 p-3 text-sm">
      <p className="font-bold">📨 תזכורות לשליחה בוואטסאפ ({list.length})</p>
      {list.map((q) => {
        const l = q.line, paid = !l || l.open <= 0;
        const late = Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${q.reminder.dueDate}T12:00:00Z`)) / 864e5));
        return (
          <div key={q.reminder.id} className="grid min-w-0 gap-1.5 rounded-xl bg-surface p-2.5">
            <span className="min-w-0">
              <strong className="block">{l?.customerName || 'לקוח'} · {l ? reminderDoc(l.docType, l.docNumber, l.n, l.ofN) : 'המסמך'}</strong>
              <span className="text-xs text-muted">{late} ימי איחור · תזכורת {q.reminder.step}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
            {paid ? <Pill tone="ok">שולם בינתיים</Pill> : <strong className="tabular-nums">{ils(l!.open)}</strong>}
            <span className="flex-1" />
            <Button size="sm" variant={paid ? 'ghost' : 'primary'} disabled={busy === q.reminder.id} onClick={() => void send(q, paid)}>{busy === q.reminder.id ? <Spinner /> : paid ? 'הסרה' : 'שליחה בוואטסאפ'}</Button>
            {!paid && <Button size="sm" variant="ghost" disabled={busy === q.reminder.id} onClick={() => void skip(q)}>לא עכשיו</Button>}
            </span>
          </div>
        );
      })}
      {msg && <div role="status"><Note tone={msg.tone}>{msg.text}</Note></div>}
    </div>
  );
}

/** the reminders of one invoice (DocView) */
export function DocReminders({ documentId }: { documentId: string }) {
  const [list, setList] = useState<Reminder[] | null>(null);
  useEffect(() => { let alive = true; void remindersReady().then(async (ok) => { const l = ok ? await documentReminders(documentId) : []; if (alive) setList(l); }); return () => { alive = false; }; }, [documentId]);
  if (!list?.length) return null;
  return (
    <div className="mt-3 grid gap-1 rounded-2xl border border-line p-3 text-sm">
      <p className="font-bold">תזכורות חוב</p>
      {list.map((q) => {
        const r = reminderLine(q);
        return (
          <div key={q.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">{r.text}</span>
            <span className="text-xs text-muted">{ddmmyyyy((q.sentAt ?? q.createdAt).slice(0, 10))} · {ils(q.amount)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** "לא לשלוח" on a customer's card: no automatic reminder for them (what waits is cancelled at once) */
export function LeadReminderStop({ leadId }: { leadId: string }) {
  const [stopped, setStopped] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let alive = true; void remindersReady().then(async (ok) => { const v = ok ? await remindersStopped(leadId) : null; if (alive) setStopped(v); }); return () => { alive = false; }; }, [leadId]);
  if (stopped === null) return null;
  async function toggle() {
    setBusy(true); setError(null);
    const r = await stopReminders(leadId, !stopped);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setStopped(r.data);
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={stopped} disabled={busy} onChange={() => void toggle()} />
        🔕 לא לשלוח תזכורות חוב אוטומטיות
      </label>
      {error && <span className="text-warn">{error}</span>}
    </div>
  );
}
