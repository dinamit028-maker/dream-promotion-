'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { authHeaders } from '@/lib/services/http';
import { Button, Chip, Field, Input } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { formatIL } from '@/lib/il-time';
import { waLink } from '@/features/crm/crm';
import { terminalInfo } from '@/features/store/data';
import { PaymentTerminal } from '@/features/store/PaymentTerminal';
import type { TerminalInfo } from '@/features/store/checkout';
import {
  LINK_DAYS, PAYLINK_COLUMNS, PAYLINK_MIGRATION, amountError, paylinkGate, paylinkOpen, paylinkPill, receiptLine, toPaylink,
  type Paylink, type PaylinkKind, type PaylinkVia,
} from './paylinks';
import { Note, Pill, ils } from './ui';

/**
 * "שלח לינק לתשלום" on the screens (docs/FINANCE_ADDITIONS_HE.md T2): the dialog, the links of a document / quote /
 * package / appointment / customer with their statuses, and the money settings of links. The server decides (the
 * terminal, what is left to ask for, the deposit) — this only asks and shows. Used outside the finance module too (the
 * CRM card, the appointments), so nothing here needs the finance screen's context.
 */
type Res<T> = { ok: true; data: T } | { ok: false; error: string };
async function post<T>(body: Record<string, unknown>): Promise<Res<T>> {
  try {
    const r = await fetch('/api/finance/paylinks', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, data: j as T } : { ok: false, error: j?.message || 'משהו השתבש. נסו שוב.' };
  } catch { return { ok: false, error: 'אין חיבור לשרת. בדקו את האינטרנט ונסו שוב.' }; }
}
type Sent = { url: string; text: string; emailed: boolean };
export const paylinkApi = {
  send: (b: { kind: PaylinkKind; target: string; amount: number; days: number; via: PaylinkVia; packageId?: string | null }) => post<Sent & { link: unknown }>({ action: 'send', ...b }),
  resend: (id: string, via: PaylinkVia) => post<Sent>({ action: 'resend', id, via }),
  cancel: (id: string, reason = '') => post<{ result: string }>({ action: 'cancel', id, reason }),
  receipt: (id: string) => post<{ receipt: string; error?: string }>({ action: 'receipt', id }),
};

/** a window opened on the owner's own tap (a phone's browser blocks one opened after an answer), then sent to WhatsApp */
function openWhatsApp(phone: string, text: string, w: Window | null) {
  const url = waLink(phone, text);
  if (!url) { w?.close(); return false; }
  if (w) w.location.href = url; else window.open(url, '_blank', 'noopener');
  return true;
}
const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => true, () => false) ?? Promise.resolve(false);

// ---- the links of something ------------------------------------------------------------------------------------------------
export interface PaylinkFilter { documentId?: string; quoteId?: string; packageId?: string; leadId?: string; appointmentIds?: string[]; recent?: number }
/** links, newest first; ready = false before migration 4300 (the screens then show no links and offer none) */
export function usePaylinks(f: PaylinkFilter | null) {
  const [links, setLinks] = useState<Paylink[] | null>(null);
  const [ready, setReady] = useState(true);
  const key = JSON.stringify(f);
  const reload = useCallback(async () => {
    if (!f) { setLinks([]); return; }
    let q = supabase().from('payment_requests').select(PAYLINK_COLUMNS).order('created_at', { ascending: false }).limit(f.recent ?? 50);
    if (f.documentId) q = q.eq('document_id', f.documentId);
    if (f.quoteId) q = q.eq('quote_id', f.quoteId);
    if (f.packageId) q = q.eq('package_id', f.packageId);
    if (f.leadId) q = q.eq('lead_id', f.leadId);
    if (f.appointmentIds) q = f.appointmentIds.length ? q.in('appointment_id', f.appointmentIds) : q.eq('appointment_id', '00000000-0000-0000-0000-000000000000');
    const { data, error } = await q;
    if (error) { setReady(false); setLinks([]); return; }
    setReady(true); setLinks(((data ?? []) as any[]).map(toPaylink));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [reload]);
  return { links, ready, reload };
}
/** what links still hold of a balance: open ones, and real payments whose receipt is not issued yet */
export const heldBy = (links: Paylink[] | null, now = Date.now()) => Math.round((links ?? []).reduce((a, l) =>
  a + (paylinkOpen(l, now) || (l.status === 'paid' && !l.isTest && ['pending', 'awaiting', 'blocked'].includes(l.receiptStatus)) ? l.amount : 0), 0) * 100) / 100;

export function useTerminal() {
  const [terminal, setTerminal] = useState<TerminalInfo | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => { const r = await terminalInfo(); if (r.ok) { setTerminal(r.data); setError(''); } else setError(r.error); }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { terminal, error, setTerminal, reload };
}

// ---- the dialog ----------------------------------------------------------------------------------------------------------------
export interface SendProps {
  kind: PaylinkKind; target: string; packageId?: string | null;
  /** what is paid, as the owner reads it ("חשבונית מס 12 · נועה") */
  what: string;
  /** the most that may be asked now; a deposit: its fixed amount */
  left: number;
  /** 2.89: what to start from (a payment of a plan: what is open of it) — never more than `left` */
  amount?: number;
  customer: { name: string; phone: string; email: string };
  /** a deposit's link lives until the appointment (days) */
  maxDays?: number;
  onClose: () => void;
  onSent?: () => void;
}
export function SendPaylinkDialog({ kind, target, packageId, what, left, amount: start, customer, maxDays, onClose, onSent }: SendProps) {
  const { terminal, error: termError } = useTerminal();
  const gate = termError ? { ok: false as const, reason: 'unknown' as const, message: termError } : paylinkGate(terminal);
  const fixed = kind === 'deposit';
  const [amount, setAmount] = useState(String(Math.max(0, start != null ? Math.min(start, left) : left)));
  const days0 = Math.min(maxDays ?? 7, 7);
  const [days, setDays] = useState(days0 >= 1 ? days0 : 1);
  const canWa = Boolean(waLink(customer.phone));
  const canMail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email);
  const [via, setVia] = useState<PaylinkVia>(canWa ? 'whatsapp' : canMail ? 'email' : 'link');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [copied, setCopied] = useState(false);
  const amountErr = fixed ? null : amountError(amount, left);
  const dayOptions = LINK_DAYS.filter((d) => !maxDays || d <= Math.max(1, maxDays));

  async function send() {
    if (amountErr) { setError(amountErr); return; }
    setBusy(true); setError(null);
    const w = via === 'whatsapp' ? window.open('', '_blank') : null;
    const r = await paylinkApi.send({ kind, target, amount: fixed ? left : Number(amount.replace(/,/g, '')), days, via, packageId: packageId ?? null });
    setBusy(false);
    if (!r.ok) { w?.close(); setError(r.error); return; }
    setSent(r.data);
    if (via === 'whatsapp') openWhatsApp(customer.phone, r.data.text, w);
    if (via === 'link') setCopied(await copy(r.data.url));
    onSent?.();
  }

  return (
    <Modal open onClose={onClose}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-extrabold">💳 לינק לתשלום</h3>
          <p className="truncate text-sm text-muted">{what}</p>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      {sent ? (
        <div className="grid gap-3">
          <Note tone="ok">{via === 'whatsapp' ? 'הלינק מוכן — וואטסאפ נפתח עם ההודעה.' : via === 'email' ? (sent.emailed ? 'הלינק נשלח במייל.' : 'הלינק נשמר — המייל ממתין לשליחה.') : copied ? 'הלינק הועתק.' : 'הלינק מוכן.'}</Note>
          <Field label="הלינק ללקוח/ה"><Input readOnly value={sent.url} dir="ltr" onFocus={(e) => e.currentTarget.select()} /></Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={async () => setCopied(await copy(sent.url))}>{copied ? '✓ הועתק' : 'העתקת הלינק'}</Button>
            {canWa && via !== 'whatsapp' && <Button variant="ghost" onClick={() => openWhatsApp(customer.phone, sent.text, null)}>💬 וואטסאפ</Button>}
            <Button variant="primary" onClick={onClose}>סיום</Button>
          </div>
          <p className="text-xs text-muted">הסטטוס מתעדכן כאן כשהלקוח/ה משלמים: נשלח ← שולם / נכשל. "שולם" רק אחרי אישור ישיר מחברת הסליקה.</p>
        </div>
      ) : !gate.ok ? (
        <div className="grid gap-3">
          {gate.reason === 'unknown' && !termError ? <p className="flex items-center gap-2 text-muted"><Spinner /> בודקים את ספק התשלום…</p> : <Note tone="warn">{gate.message}</Note>}
          {(gate.reason === 'connect' || gate.reason === 'verify') && (
            <Link href="/finance/settings#paylinks" className="inline-flex min-h-11 w-fit items-center rounded-full bg-primary px-5 font-bold text-white">
              {gate.reason === 'connect' ? 'חבר ספק תשלום' : 'לבדיקת החיבור'}
            </Link>
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          {gate.test && <Note tone="warn">מסוף בדיקה: הלקוח/ה משלמים בעמוד הבדיקה של PayPlus — לא יחויב כסף אמיתי, לא תופק קבלה והתשלום לא נרשם בהכנסות. מסומן "שולם (בדיקה)".</Note>}
          {fixed ? (
            <p className="text-sm">מקדמה: <strong className="text-lg">{ils(left)}</strong> <span className="text-muted">(כפי שהוגדר בשירות)</span></p>
          ) : (
            <Field label={`סכום (עד ${ils(left)})`}>
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr" aria-invalid={Boolean(amountErr)} />
            </Field>
          )}
          {!fixed && amountErr && amount.trim() !== '' && <p role="alert" className="-mt-2 text-xs font-semibold text-warn">{amountErr}</p>}
          {!fixed && left > 0 && <p className="-mt-2 text-xs text-muted">אפשר לבקש חלק מהסכום — היתרה נשארת פתוחה.</p>}
          <div>
            <p className="mb-1 text-sm font-semibold">בתוקף</p>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="תוקף הלינק">
              {dayOptions.map((d) => <Chip key={d} on={days === d} onClick={() => setDays(d)} role="radio" aria-checked={days === d}>{d === 1 ? 'יום' : `${d} ימים`}</Chip>)}
            </div>
          </div>
          <div>
            <p className="mb-1 text-sm font-semibold">איך שולחים</p>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="איך שולחים">
              <Chip on={via === 'whatsapp'} disabled={!canWa} onClick={() => setVia('whatsapp')} role="radio" aria-checked={via === 'whatsapp'}>💬 וואטסאפ</Chip>
              <Chip on={via === 'email'} disabled={!canMail} onClick={() => setVia('email')} role="radio" aria-checked={via === 'email'}>✉️ מייל</Chip>
              <Chip on={via === 'link'} onClick={() => setVia('link')} role="radio" aria-checked={via === 'link'}>🔗 העתקת לינק</Chip>
            </div>
            {!canWa && !canMail && <p className="mt-1 text-xs text-muted">אין טלפון או מייל ללקוח/ה — מעתיקים את הלינק ושולחים בעצמכם.</p>}
          </div>
          {error && <Note tone="warn">{error}</Note>}
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy || Boolean(amountErr) || left <= 0} onClick={() => void send()}>{busy ? <><Spinner /> יוצר לינק…</> : 'שליחת הלינק'}</Button>
            <Button variant="ghost" onClick={onClose}>ביטול</Button>
          </div>
          {left <= 0 && <p className="text-xs text-muted">אין יתרה לבקש — הכל שולם או כבר נשלח בלינק פתוח.</p>}
        </div>
      )}
    </Modal>
  );
}

/** "💳 שלח לינק לתשלום" — opens the dialog */
export function PaylinkButton(p: Omit<SendProps, 'onClose'> & { size?: 'sm' | 'md'; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size={p.size} onClick={() => setOpen(true)}>{p.label ?? '💳 שלח לינק לתשלום'}</Button>
      {open && <SendPaylinkDialog {...p} onClose={() => setOpen(false)} onSent={p.onSent} />}
    </>
  );
}

// ---- the list -----------------------------------------------------------------------------------------------------------------
/** links with their status; open ones are sent again or cancelled, a real payment's receipt is approved here */
export function PaylinkList({ links, onChanged, title = 'לינקים לתשלום', showLabel = true }: { links: Paylink[]; onChanged: () => void; title?: string; showLabel?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  if (!links.length) return null;
  async function run(id: string, job: () => Promise<Res<unknown>>, ok: string) {
    setBusy(id); setMsg(null);
    const r = await job();
    setBusy(null);
    setMsg(r.ok ? { tone: 'ok', text: ok } : { tone: 'warn', text: r.error });
    onChanged();
  }
  async function again(l: Paylink) {
    const wa = Boolean(waLink(l.customerPhone));
    const w = wa ? window.open('', '_blank') : null;
    setBusy(l.id); setMsg(null);
    const r = await paylinkApi.resend(l.id, wa ? 'whatsapp' : 'link');
    setBusy(null);
    if (!r.ok) { w?.close(); setMsg({ tone: 'warn', text: r.error }); return; }
    if (wa) openWhatsApp(l.customerPhone, r.data.text, w);
    else setMsg({ tone: 'ok', text: (await copy(r.data.url)) ? 'הלינק הועתק.' : r.data.url });
    onChanged();
  }
  return (
    <div className="mt-3 rounded-2xl border border-line p-3">
      <p className="mb-2 text-sm font-bold">{title}</p>
      {msg && <div className="mb-2"><Note tone={msg.tone}>{msg.text}</Note></div>}
      <ul className="grid gap-2">
        {links.map((l) => {
          const pill = paylinkPill(l);
          const open = paylinkOpen(l);
          const receipt = receiptLine(l);
          return (
            <li key={l.id} className="rounded-xl bg-surface-2 p-2.5 text-sm" data-paylink={l.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Pill tone={pill.tone}>{pill.text}</Pill>
                  <strong className="tabular-nums">{ils(l.paidAmount ?? l.amount)}</strong>
                  {showLabel && <span className="truncate text-muted">{l.label}</span>}
                </span>
                <span className="text-xs text-muted">{formatIL(l.createdAt)}</span>
              </div>
              <p className="mt-1 text-xs text-muted">
                {[l.customerName, open ? `בתוקף עד ${formatIL(l.expiresAt)}` : l.status === 'paid' && l.paidAt ? `שולם ${formatIL(l.paidAt)}`
                  : l.status === 'failed' ? `נכשל${l.failReason ? `: ${l.failReason}` : ''}` : '', l.sends > 1 ? `נשלח ${l.sends} פעמים` : ''].filter(Boolean).join(' · ')}
              </p>
              {l.status === 'failed' && <p className="mt-1 text-xs font-semibold text-red-700 dark:text-red-300">התשלום נכשל — הלקוח/ה יכולים לנסות שוב באותו לינק עד שפג תוקפו.</p>}
              {l.paidLate && <p className="mt-1 text-xs font-semibold text-amber-700 dark:text-amber-300">שולם אחרי שהלינק בוטל או פג — הכסף התקבל; לבדוק אם צריך להחזיר.</p>}
              {receipt && <p className={`mt-1 text-xs ${l.receiptStatus === 'blocked' ? 'font-semibold text-red-700 dark:text-red-300' : 'text-muted'}`}>{receipt}</p>}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {open && <Button size="sm" variant="ghost" disabled={busy === l.id} onClick={() => void again(l)}>{waLink(l.customerPhone) ? '💬 שליחה שוב' : '🔗 העתקה שוב'}</Button>}
                {open && <Button size="sm" variant="ghost" disabled={busy === l.id} onClick={() => {
                  if (!window.confirm('לבטל את הלינק? הלקוח/ה יראו שהבקשה בוטלה. תשלום שכבר בדרך עדיין יירשם.')) return;
                  void run(l.id, () => paylinkApi.cancel(l.id), 'הלינק בוטל.');
                }}>ביטול הלינק</Button>}
                {l.status === 'paid' && !l.isTest && (l.receiptStatus === 'awaiting' || l.receiptStatus === 'blocked') && (
                  <Button size="sm" variant="primary" disabled={busy === l.id} onClick={() => void run(l.id, () => paylinkApi.receipt(l.id), 'הקבלה הופקה.')}>
                    {busy === l.id ? <Spinner /> : l.receiptStatus === 'blocked' ? 'לנסות שוב להפיק קבלה' : 'הפקת הקבלה'}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- the money settings of links ------------------------------------------------------------------------------------------------
/** the terminal (the same one as the site's checkout) and when a real payment's receipt is issued */
export function PaylinkSettings({ userId }: { userId: string }) {
  const { terminal, error, setTerminal } = useTerminal();
  const [mode, setMode] = useState<'auto' | 'approve' | null>(null);
  const [missing, setMissing] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  useEffect(() => {
    void supabase().from('business_finance_profile').select('paylink_receipt').maybeSingle().then(({ data, error: e }) => {
      if (e) { setMissing(true); return; }
      setMode((data as any)?.paylink_receipt === 'approve' ? 'approve' : 'auto');
    });
  }, []);
  async function save(m: 'auto' | 'approve') {
    setMsg(null);
    const { error: e } = await supabase().from('business_finance_profile').upsert({ user_id: userId, paylink_receipt: m }, { onConflict: 'business_id' });
    if (e) { setMsg({ tone: 'warn', text: /paylink_receipt|schema cache|column/i.test(e.message) ? PAYLINK_MIGRATION : 'ההגדרה לא נשמרה. נסו שוב.' }); return; }
    setMode(m); setMsg({ tone: 'ok', text: 'נשמר.' });
  }
  return (
    <div id="paylinks" className="scroll-mt-24">
      <p className="mb-1 font-bold">לינק לתשלום</p>
      <p className="mb-3 text-sm text-muted">שולחים ללקוח/ה לינק לתשלום בכרטיס על חשבונית פתוחה, הצעה שאושרה, חבילה או מקדמה לתור. לינק נשלח רק ממסוף סליקה מחובר ומאומת.</p>
      <PaymentTerminal terminal={terminal} error={error} onChange={setTerminal} />
      {missing ? <Note tone="warn">{PAYLINK_MIGRATION}</Note> : (
        <div>
          <p className="mb-1 text-sm font-semibold">קבלה על תשלום בלינק</p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="קבלה על תשלום בלינק">
            <Chip on={mode === 'auto'} disabled={!mode} onClick={() => void save('auto')} role="radio" aria-checked={mode === 'auto'}>מופקת מיד</Chip>
            <Chip on={mode === 'approve'} disabled={!mode} onClick={() => void save('approve')} role="radio" aria-checked={mode === 'approve'}>אחרי אישור שלי</Chip>
          </div>
          <p className="mt-1 text-xs text-muted">"אחרי אישור שלי": התשלום נרשם כשולם, והקבלה ממתינה ל"הפקת הקבלה" ברשימת הלינקים. תשלום בדיקה — בלי קבלה בכלל.</p>
          {msg && <div className="mt-2"><Note tone={msg.tone}>{msg.text}</Note></div>}
        </div>
      )}
    </div>
  );
}
