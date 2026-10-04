'use client';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { Button, Chip, Field, Input, Textarea } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL, israelParts, israelToIso } from '@/lib/il-time';
import type { Lead, LeadActivityKind, LeadStatus } from '@/types';
import { ACTIVITY_HE, STAGES, followupState, parseTags, stageOf, telLink, waLink } from './crm';
import { channelOfSource } from './meta-inbox';
import { authHeaders } from '@/lib/services/http';

/** what the reply box says it answers in, per inbox channel */
const REPLY_IN = { messenger: 'תשובה במסנג׳ר', fb: 'תשובה לתגובה בפייסבוק', ig: 'תשובה לתגובה באינסטגרם' } as const;

const LOG_KINDS: LeadActivityKind[] = ['note', 'call', 'whatsapp', 'meeting', 'purchase'];

/** One contact: details, stage, next follow-up, timeline, quick actions and an AI follow-up message. */
export function ContactSheet({ leadId, onClose }: { leadId: string | null; onClose: () => void }) {
  const { leads, activities, brand, updateLead, deleteLead, addActivity, deleteActivity } = useApp();
  const lead = leads.find((l) => l.id === leadId) ?? null;
  const history = useMemo(() => activities.filter((a) => a.leadId === leadId), [activities, leadId]);

  const [draft, setDraft] = useState<Lead | null>(lead);
  const [tagsText, setTagsText] = useState('');
  const [logKind, setLogKind] = useState<LeadActivityKind>('note');
  const [logText, setLogText] = useState('');
  const [amount, setAmount] = useState('');
  const [fu, setFu] = useState({ date: '', time: '10:00' });
  const [ai, setAi] = useState<{ busy: boolean; text: string; error: string | null }>({ busy: false, text: '', error: null });
  const [reply, setReply] = useState<{ text: string; busy: boolean; error: string | null; sent: boolean }>({ text: '', busy: false, error: null, sent: false });

  useEffect(() => {
    setDraft(lead);
    setTagsText((lead?.tags ?? []).join(', '));
    const p = lead?.nextFollowup ? israelParts(new Date(lead.nextFollowup)) : null;
    setFu(p ? { date: p.date, time: p.time } : { date: '', time: '10:00' });
    setAi({ busy: false, text: '', error: null }); setLogText(''); setAmount('');
    setReply({ text: '', busy: false, error: null, sent: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  if (!lead || !draft) return null;
  const dirty = JSON.stringify({ ...draft, tags: parseTags(tagsText) }) !== JSON.stringify({ ...lead, tags: lead.tags ?? [] });

  function save() {
    if (!draft || !draft.name.trim()) return;
    updateLead(lead!.id, { name: draft.name.trim(), phone: draft.phone, email: draft.email, source: draft.source, notes: draft.notes, value: Number(draft.value) || 0, tags: parseTags(tagsText) });
  }
  function setStage(s: LeadStatus) {
    if (s === lead!.status) return;
    addActivity(lead!.id, 'status', `${stageOf(lead!.status).label} ← ${stageOf(s).label}`);
    updateLead(lead!.id, { status: s });
  }
  function setFollowup(date: string, time: string) {
    setFu({ date, time });
    updateLead(lead!.id, { nextFollowup: date ? israelToIso(date, time || '10:00') : null });
  }
  const quick = (days: number, time = '10:00') => { const d = israelParts(Date.now() + days * 864e5).date; setFollowup(d, time); };
  function log() {
    if (!logText.trim() && logKind !== 'purchase') return;
    const sum = Number(amount);
    const body = logKind === 'purchase' && sum ? `${logText.trim() || 'רכישה'} · ₪${sum.toLocaleString('he-IL')}` : logText.trim();
    addActivity(lead!.id, logKind, body);
    if (logKind === 'purchase' && sum) updateLead(lead!.id, { value: (lead!.value ?? 0) + sum, status: 'נסגר' });
    setLogText(''); setAmount('');
  }
  async function suggest() {
    setAi({ busy: true, text: '', error: null });
    try {
      const r = await AIService.followup(brand, {
        name: lead!.name, stage: stageOf(lead!.status).label, source: lead!.source, notes: lead!.notes,
        history: history.slice(0, 10).map((a) => `${ACTIVITY_HE[a.kind].label} (${formatIL(a.at, { dateStyle: 'short' })}): ${a.body}`),
      });
      setAi({ busy: false, text: r.message ?? '', error: null });
    } catch { setAi({ busy: false, text: '', error: 'לא הצלחנו לנסח הודעה כרגע. נסו שוב.' }); }
  }
  function sendWhatsApp(text: string) {
    const url = waLink(lead!.phone, text);
    if (!url) return;
    window.open(url, '_blank', 'noopener');
    addActivity(lead!.id, 'whatsapp', text.slice(0, 300));
  }
  const fuState = followupState(lead);
  const inbox = channelOfSource(lead.source);
  /** answers on Messenger / under the comment, through Meta — the server writes it into the history */
  async function sendReply() {
    const text = reply.text.trim();
    if (!text || reply.busy) return;
    setReply({ ...reply, busy: true, error: null, sent: false });
    try {
      const r = await fetch('/api/meta/inbox/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ leadId: lead!.id, text }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) { setReply((x) => ({ ...x, busy: false, error: j?.message ?? 'השליחה לא הצליחה. נסו שוב בעוד רגע.' })); return; }
      setReply({ text: '', busy: false, error: null, sent: true });
      const { userId, businessId, hydrate } = useApp.getState();
      if (userId) await hydrate(userId, businessId);
    } catch { setReply((x) => ({ ...x, busy: false, error: 'אין חיבור כרגע. נסו שוב.' })); }
  }

  return (
    <Modal open={Boolean(leadId)} onClose={onClose} wide>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-display text-xl font-extrabold">{lead.name}</h3>
          <p className="text-xs text-muted">
            {lead.source || 'ידני'} · נוסף {lead.date}{lead.lastContact ? ` · קשר אחרון ${formatIL(lead.lastContact, { dateStyle: 'short' })}` : ''}
            {lead.value ? ` · ₪${Number(lead.value).toLocaleString('he-IL')}` : ''}
          </p>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      {/* quick actions */}
      <div className="mb-4 flex flex-wrap gap-2">
        {lead.phone && <a href={telLink(lead.phone)} onClick={() => addActivity(lead.id, 'call', 'התקשרתי')} className="rounded-full border border-line px-3 py-1.5 text-sm font-semibold hover:border-primary">📞 התקשרות</a>}
        {waLink(lead.phone) && <a href={waLink(lead.phone)} target="_blank" rel="noopener" onClick={() => addActivity(lead.id, 'whatsapp', 'פתחתי שיחת וואטסאפ')} className="rounded-full border border-line px-3 py-1.5 text-sm font-semibold hover:border-primary">💬 וואטסאפ</a>}
        {lead.email && <a href={`mailto:${lead.email}`} onClick={() => addActivity(lead.id, 'email', 'שלחתי מייל')} className="rounded-full border border-line px-3 py-1.5 text-sm font-semibold hover:border-primary">✉️ מייל</a>}
        <Button size="sm" variant="ghost" onClick={suggest} disabled={ai.busy}>{ai.busy ? <><Spinner />מנסח…</> : '✨ הצעת הודעת המשך'}</Button>
      </div>

      {inbox && (
        <div className="mb-4 rounded-2xl border border-line p-3">
          <p className="mb-1.5 text-sm font-semibold">↩️ {REPLY_IN[inbox]}</p>
          <Textarea value={reply.text} onChange={(e) => setReply({ ...reply, text: e.target.value, sent: false })} className="min-h-[70px]"
            placeholder="כתבו כאן את התשובה — היא תישלח ישירות אליו/ה" aria-label={REPLY_IN[inbox]} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" onClick={sendReply} disabled={reply.busy || !reply.text.trim()}>{reply.busy ? <><Spinner />שולח…</> : 'שליחה'}</Button>
            {reply.sent && <span className="text-xs font-semibold text-[var(--ok,#16a34a)]">נשלח ✓ ונשמר בהיסטוריה</span>}
          </div>
          {reply.error && <p className="mt-2 text-sm text-warn">{reply.error}</p>}
          {inbox === 'messenger' && <p className="mt-1.5 text-xs text-muted">במסנג׳ר אפשר לענות עד 24 שעות מההודעה האחרונה של הלקוח/ה.</p>}
        </div>
      )}

      {(ai.text || ai.error) && (
        <div className="mb-4 rounded-2xl bg-primary-soft p-3">
          {ai.error ? <p className="text-sm text-warn">{ai.error}</p> : (
            <>
              <Textarea value={ai.text} onChange={(e) => setAi({ ...ai, text: e.target.value })} className="min-h-[90px] bg-surface" aria-label="הודעת המשך" />
              <div className="mt-2 flex flex-wrap gap-2">
                {waLink(lead.phone) && <Button size="sm" variant="primary" onClick={() => sendWhatsApp(ai.text)}>שליחה בוואטסאפ</Button>}
                <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(ai.text)}>העתקה</Button>
                <Button size="sm" variant="ghost" onClick={suggest}>נוסח אחר</Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* stage */}
      <p className="mb-1.5 text-sm font-semibold">שלב</p>
      <div className="mb-4 flex flex-wrap gap-2">
        {STAGES.map((s) => <Chip key={s.id} on={lead.status === s.id} onClick={() => setStage(s.id)}>{s.label}</Chip>)}
      </div>

      {/* follow-up */}
      <p className="mb-1.5 text-sm font-semibold">
        תזכורת לחזור אליו/ה
        {fuState === 'overdue' && <span className="ms-2 text-xs font-bold text-[var(--danger)]">עבר הזמן</span>}
        {fuState === 'today' && <span className="ms-2 text-xs font-bold text-warn">היום</span>}
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input type="date" value={fu.date} onChange={(e) => setFollowup(e.target.value, fu.time)} className="h-9 w-auto py-1" aria-label="תאריך" />
        <Input type="time" value={fu.time} onChange={(e) => fu.date && setFollowup(fu.date, e.target.value)} className="h-9 w-auto py-1" aria-label="שעה" />
        <Chip on={false} onClick={() => quick(1)}>מחר</Chip>
        <Chip on={false} onClick={() => quick(3)}>בעוד 3 ימים</Chip>
        <Chip on={false} onClick={() => quick(7)}>בעוד שבוע</Chip>
        {lead.nextFollowup && <button type="button" className="text-xs text-muted underline" onClick={() => setFollowup('', fu.time)}>ביטול</button>}
      </div>

      {/* log something */}
      <div className="mb-4 rounded-2xl border border-line p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {LOG_KINDS.map((k) => <Chip key={k} on={logKind === k} onClick={() => setLogKind(k)}>{ACTIVITY_HE[k].icon} {ACTIVITY_HE[k].label}</Chip>)}
        </div>
        <Textarea value={logText} onChange={(e) => setLogText(e.target.value)} className="min-h-[64px]"
          placeholder={logKind === 'purchase' ? 'מה נקנה (לא חובה)' : 'מה קרה? למשל: מתעניינת בטיפול לייזר, ביקשה מחיר'} aria-label="תיעוד" />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {logKind === 'purchase' && <Input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="סכום ₪" className="h-9 w-32 py-1" aria-label="סכום" />}
          <Button size="sm" variant="primary" onClick={log}>הוספה לתיעוד</Button>
        </div>
      </div>

      {/* timeline */}
      {history.length > 0 && (
        <div className="mb-5">
          <p className="mb-2 text-sm font-semibold">היסטוריה</p>
          <ol className="grid max-h-60 gap-2 overflow-y-auto pe-1">
            {history.map((a) => (
              <li key={a.id} className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm">
                <span aria-hidden>{ACTIVITY_HE[a.kind].icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="text-xs text-muted">{ACTIVITY_HE[a.kind].label} · {formatIL(a.at)}</span>
                  {a.body && <span className="block whitespace-pre-wrap" dir="auto">{a.body}</span>}
                </span>
                <button type="button" onClick={() => deleteActivity(a.id)} className="text-xs text-muted hover:text-[var(--danger)]" aria-label="מחיקה">✕</button>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* details */}
      <details className="mb-4 rounded-2xl border border-line p-3" open={!lead.phone}>
        <summary className="cursor-pointer text-sm font-semibold">פרטים</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="שם"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
          <Field label="טלפון"><Input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} inputMode="tel" dir="ltr" /></Field>
          <Field label="אימייל"><Input value={draft.email ?? ''} onChange={(e) => setDraft({ ...draft, email: e.target.value })} inputMode="email" dir="ltr" /></Field>
          <Field label="מקור"><Input value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} placeholder="אינסטגרם, המלצה, אתר…" /></Field>
          <Field label="תגיות (מופרדות בפסיק)"><Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="VIP, לייזר" /></Field>
          <Field label="ערך לקוח ₪"><Input type="number" inputMode="decimal" value={draft.value ?? 0} onChange={(e) => setDraft({ ...draft, value: Number(e.target.value) })} /></Field>
        </div>
        <Field label="הערות"><Textarea value={draft.notes ?? ''} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className="min-h-[70px]" /></Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button size="sm" variant="primary" onClick={save} disabled={!dirty}>{dirty ? 'שמירת פרטים' : 'נשמר'}</Button>
          <button type="button" className="text-xs text-[var(--danger)] hover:underline"
            onClick={() => { if (window.confirm(`למחוק את ${lead.name} וכל ההיסטוריה שלו/ה?`)) { deleteLead(lead.id); onClose(); } }}>
            מחיקת איש הקשר
          </button>
        </div>
      </details>
      <p className={cx('text-xs text-muted')}>כל מה שנרשם כאן גלוי רק לכם.</p>
    </Modal>
  );
}
