'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { authHeaders } from '@/lib/services/http';
import { Button, Chip } from '@/components/ui/primitives';
import { Modal, Spinner } from '@/components/ui/feedback';
import { waLink } from '@/features/crm/crm';
import { DOC_LABEL } from '@/features/documents/documents';
import { useFinance } from './FinanceScreen';
import { DocView, loadDoc } from './DocView';
import { financeError, logEvent } from './api';
import { STATUS_HE, TONES, aging, agingByLines, aiDraftIsSafe, byLines, daysOverdue, fillReminder, reminderTemplate, toReceivable, type Receivable, type Tone } from './receivables';
import { lineLabel, nextOpen, type Line } from './plans';
import { loadLines, plansReady } from './plans-data';
import { reminderDoc } from './reminders';
import { ReminderQueue } from './Reminders';
import { receivablesCsv } from './reports';
import { Note, Pill, Stat, ddmmyyyy, download, ils, todayIL } from './ui';
import type { DocRow } from '@/features/documents/documents';

/**
 * "חייבים" — who owes what: every 305 / 300 with its credits and payments (the database view `receivables`), by how late.
 * Smart collection: a reminder built from the real values; "✨" asks the AI to reword the template only (it never sees
 * or writes amounts — they stay {{placeholders}}); WhatsApp opens with the text and the user sends it.
 * 2.89: an invoice with a payment plan is owed by its payments (receivable_lines) — each with its own date, in the aging, the
 * status and the reminder; the timer's reminders that wait for WhatsApp are on top ("📨 תזכורות לשליחה").
 */
export function Receivables() {
  const { fail, params, clearParams, business } = useFinance();
  const [list, setList] = useState<Receivable[] | null>(null);
  // ?receipt=1 — from the module's "+" → "קבלה": a receipt is issued on the invoice that was paid, from this list
  const [receiptHint, setReceiptHint] = useState(false);
  useEffect(() => { if (params.get('receipt')) { setReceiptHint(true); clearParams(); } }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<DocRow | null>(null);
  const [remind, setRemind] = useState<{ r: Receivable; line: Line | null } | null>(null);
  // 2.89 (migration 4400): the open lines by invoice — a plan's payments with their own dates (null: before the migration)
  const [lines, setLines] = useState<Map<string, Line[]> | null>(null);
  const [queueKey, setQueueKey] = useState(0);
  const [pending, setPending] = useState<{ id: string; customer: string; total: number; createdAt: string }[]>([]);
  const today = todayIL();

  const load = useCallback(async () => {
    const sb = supabase();
    let q = sb.from('receivables').select('*').eq('cancelled', false).order('due_date', { ascending: true, nullsFirst: false }).limit(500);
    if (!all) q = q.gt('balance', 0);
    const [r, p] = await Promise.all([q, sb.from('sales').select('id, customer_name, total, created_at').eq('status', 'pending').order('created_at').limit(100)]);
    if (r.error) { fail(financeError(r.error)); setList([]); return; }
    const ls = (await plansReady()) ? await loadLines({ openOnly: true }) : null;
    const m = ls ? new Map<string, Line[]>() : null;
    for (const l of ls ?? []) m!.set(l.documentId, [...(m!.get(l.documentId) ?? []), l]);
    setLines(m);
    const rows = ((r.data ?? []) as any[]).map(toReceivable);
    // by the next date that is owed (a plan's: its next payment)
    if (m) rows.sort((a, b) => (byLines(a, m.get(a.id), today).dueDate ?? '9999').localeCompare(byLines(b, m.get(b.id), today).dueDate ?? '9999'));
    setList(rows);
    setPending(((p.data ?? []) as any[]).map((x) => ({ id: x.id, customer: x.customer_name, total: Number(x.total), createdAt: x.created_at })));
  }, [all, fail, today]);
  useEffect(() => { void load(); }, [load]);
  const a = useMemo(() => (lines ? agingByLines([...lines.values()].flat(), today) : aging(list ?? [], today)), [list, lines, today]);

  if (list === null) return <div className="py-8 text-center"><Spinner /></div>;
  return (
    <div className="grid gap-3">
      {receiptHint && <Note>{list.some((r) => r.balance > 0)
        ? 'קבלה מופקת על החשבונית ששולמה: בוחרים אותה ברשימה, ואז "קבלה על תשלום".'
        : 'קבלה מופקת על חשבונית פתוחה, ואין כרגע חשבוניות פתוחות. על מכירה חדשה ששולמה — "חשבונית מס / קבלה".'}</Note>}
      <ReminderQueue key={queueKey} business={business.name} onChanged={() => void load()} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="סה״כ פתוח" value={ils(a.total)} />
        <Stat label="טרם הגיע מועד" value={ils(a.current)} />
        <Stat label="1–30 יום" value={ils(a.d30)} tone={a.d30 ? 'warn' : undefined} />
        <Stat label="31–60 יום" value={ils(a.d60)} tone={a.d60 ? 'warn' : undefined} />
        <Stat label="61–90 יום" value={ils(a.d90)} tone={a.d90 ? 'bad' : undefined} />
        <Stat label="מעל 90 יום" value={ils(a.over90)} tone={a.over90 ? 'bad' : undefined} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Chip on={!all} onClick={() => setAll(false)}>פתוחים</Chip>
        <Chip on={all} onClick={() => setAll(true)}>כולל ששולמו</Chip>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => { download(`חייבים-${today}.csv`, receivablesCsv(list, today, lines ?? undefined)); void logEvent('export.csv', 'receivables', '', { rows: list.length }); }}>ייצוא לאקסל</Button>
      </div>
      {!list.length ? <Note>אין חובות פתוחים. חשבונית מס (305) או חשבונית עסקה (300) שלא שולמו יופיעו כאן.</Note> : (
        <div className="grid gap-1.5">
          {list.map((r) => {
            const b = byLines(r, lines?.get(r.id), today), st = b.status, late = b.late;
            const next = b.planned ? nextOpen(lines?.get(r.id) ?? []) : null;
            return (
              <div key={r.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface p-3 text-sm">
                <button type="button" className="min-w-0 flex-1 text-start" onClick={async () => setOpen(await loadDoc(r.id))}>
                  <strong className="block truncate">{r.customerName || 'לקוח'} · {DOC_LABEL[r.docType]} {r.docNumber}</strong>
                  <span className="text-xs text-muted">{ddmmyyyy(r.docDate)}{!b.planned && r.dueDate ? ` · לתשלום עד ${ddmmyyyy(r.dueDate)}` : ''}{late ? ` · ${late} ימי איחור` : ''}</span>
                  {next && <span className="block text-xs text-muted">📅 {lineLabel(next)} עד {ddmmyyyy(next.dueDate)} · {ils(next.open)}</span>}
                </button>
                <Pill tone={st === 'overdue' ? 'bad' : st === 'paid' ? 'ok' : st === 'partial' ? 'warn' : 'default'}>{STATUS_HE[st]}{b.planned ? ' · פריסה' : ''}</Pill>
                <strong className="tabular-nums">{ils(r.balance)}</strong>
                {r.balance > 0 && <Button size="sm" variant="ghost" onClick={() => setRemind({ r, line: next })}>תזכורת</Button>}
              </div>
            );
          })}
        </div>
      )}
      {pending.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-sm font-bold">בקשות תשלום מהקופה ({pending.length})</p>
          {pending.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-2xl border border-dashed border-line p-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate">{p.customer || 'לקוח'} · {ddmmyyyy(p.createdAt.slice(0, 10))}</span>
              <strong className="tabular-nums">{ils(p.total)}</strong>
              <a href="/register" className="text-xs font-semibold text-primary">לקופה</a>
            </div>
          ))}
        </div>
      )}
      {open && <DocView doc={open} onClose={() => setOpen(null)} onChanged={() => { void load(); setQueueKey((k) => k + 1); }} />}
      {remind && <Reminder r={remind.r} line={remind.line} onClose={() => setRemind(null)} />}
    </div>
  );
}

/** a payment reminder: the template with the real values; an AI may reword the template only; the user sends it.
 *  2.89: an invoice with a plan — the next payment of it (its amount, its date: "תשלום 2 מתוך 3 של …") */
function Reminder({ r, line, onClose }: { r: Receivable; line: Line | null; onClose: () => void }) {
  const { business } = useFinance();
  const brand = useApp((s) => s.brand);
  const addActivity = useApp((s) => s.addActivity);
  const [tone, setTone] = useState<Tone>(daysOverdue(line ? { dueDate: line.dueDate, balance: line.open } : r, todayIL()) > 30 ? 'firm' : 'friendly');
  const [template, setTemplate] = useState(reminderTemplate(tone));
  const [ai, setAi] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });
  useEffect(() => { setTemplate(reminderTemplate(tone)); setAi({ busy: false, note: null }); }, [tone]);
  const text = fillReminder(template, {
    name: r.customerName.split(' ')[0] || '', doc: line ? reminderDoc(r.docType, r.docNumber, line.n, line.ofN) : `${DOC_LABEL[r.docType]} מס׳ ${r.docNumber}`,
    amount: ils(line ? line.open : r.balance), due: ddmmyyyy(line ? line.dueDate : r.dueDate) || 'מועד התשלום',
    business: business.name || brand.name, link: r.shareToken ? `${window.location.origin}/d/${r.shareToken}` : '',
  });
  async function reword() {
    setAi({ busy: true, note: null });
    try {
      const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ task: 'collection', payload: { tone, template: reminderTemplate(tone), business: business.name || brand.name } }) });
      const j = await res.json().catch(() => ({}));
      if (res.ok && aiDraftIsSafe(j.message)) { setTemplate(j.message); setAi({ busy: false, note: 'נוסח מחדש — הסכום, המסמך והתאריך נשארו מהמסמך עצמו.' }); }
      else setAi({ busy: false, note: res.ok ? 'הניסוח שהתקבל לא נשמר על הנתונים — נשארנו עם הנוסח הרגיל.' : 'ה-AI לא זמין כרגע — הנוסח הרגיל.' });
    } catch { setAi({ busy: false, note: 'אין חיבור — הנוסח הרגיל.' }); }
  }
  const url = waLink(r.customerPhone, text);
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">תזכורת תשלום · {r.customerName || 'לקוח'}</h3>
      <div className="mb-3 flex flex-wrap gap-1.5">{TONES.map((t) => <Chip key={t.id} on={tone === t.id} onClick={() => setTone(t.id)}>{t.label}</Chip>)}</div>
      <p className="whitespace-pre-wrap rounded-2xl bg-surface-2 p-3 text-sm" dir="rtl">{text}</p>
      {ai.note && <p className="mt-2 text-xs text-muted">{ai.note}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {url ? <a href={url} target="_blank" rel="noopener" onClick={() => { void logEvent('reminder.sent', 'documents', r.id, { tone, balance: r.balance }); if (r.leadId) addActivity(r.leadId, 'whatsapp', `תזכורת תשלום: ${DOC_LABEL[r.docType]} ${r.docNumber} · ${ils(r.balance)}`); onClose(); }}
          className="inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-semibold text-white">שליחה בוואטסאפ</a>
          : <Note tone="warn">אין טלפון ללקוח — אפשר להעתיק את הנוסח.</Note>}
        <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(text)}>העתקה</Button>
        <Button variant="ghost" disabled={ai.busy} onClick={() => void reword()}>{ai.busy ? <Spinner /> : '✨ ניסוח אחר'}</Button>
      </div>
      <p className="mt-2 text-xs text-muted">שום דבר לא נשלח מעצמו: וואטסאפ נפתח עם הנוסח, ואתם שולחים.</p>
    </Modal>
  );
}
