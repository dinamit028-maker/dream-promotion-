'use client';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Chip, Field, Input, Textarea } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { ils } from '@/features/register/money';
import { LINE_STATUS_HE, PLAN_MAX, PLAN_MIN, draftPlan, lineLabel, lineStatus, planError, rebalance, type Line, type Plan, type PlanItem } from './plans';
import { cancelPlan, createPlan, loadLines, loadPlan, plansReady } from './plans-data';
import { ag, sh } from './vat';
import { Note, Pill, ddmmyyyy, todayIL } from './ui';
import { PaylinkButton } from './Paylinks';

/**
 * "📅 פריסה לתשלומים" (T3, 2.89): the balance of an open invoice — also a package's — split into dated payments that add up to
 * it to the agora; each payment is owed (and reminded, T5) on its own date. Not card installments: dates the business collects
 * on; the money still comes as receipts on the invoice (or a link for one payment). The plan is made, replaced and cancelled
 * only by the database's functions (payment_plan_create / _cancel); nothing here changes a document.
 */
export function usePlan(documentId: string | null) {
  const [ready, setReady] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const reload = useCallback(async () => {
    if (!documentId || !(await plansReady())) { setReady(false); setPlan(null); setLines([]); return; }
    const [p, l] = await Promise.all([loadPlan(documentId), loadLines({ documentId })]);
    setReady(true); setPlan(p); setLines(l ?? []);
  }, [documentId]);
  useEffect(() => { void reload(); }, [reload]);
  return { ready, plan, lines, reload };
}

const COUNTS = [2, 3, 4, 6, 10, 12];

/** making a plan (or making it again: it replaces the one in force) */
export function PlanDialog({ documentId, balance, what, replacing, onClose, onSaved }: {
  documentId: string; balance: number; what: string; replacing: boolean; onClose: () => void; onSaved: (message: string) => void;
}) {
  const today = todayIL();
  // the id of this plan is fixed when the dialog opens: pressing again after a lost answer is the same plan
  const [id] = useState(() => crypto.randomUUID());
  const [count, setCount] = useState(3);
  const [first, setFirst] = useState(today);
  const [items, setItems] = useState<PlanItem[]>(() => draftPlan(balance, 3, today));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restart = (n: number, f: string) => { setCount(n); setFirst(f); setItems(draftPlan(balance, n, f)); setError(null); };
  const sum = useMemo(() => sh(items.reduce((a, i) => a + ag(i.amount), 0)), [items]);
  const problem = planError(items, balance, today);

  function setAmount(i: number, v: string) {
    const amount = Math.round(Number(v || 0) * 100) / 100;
    setItems((all) => rebalance(all.map((it, k) => (k === i ? { ...it, amount } : it)), balance, i));
  }
  function setDate(i: number, v: string) { setItems((all) => all.map((it, k) => (k === i ? { ...it, dueDate: v } : it))); }
  async function save() {
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    const r = await createPlan(id, documentId, items, note, replacing);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onSaved(`נשמרה פריסה ל-${items.length} תשלומים · ${ils(balance)}`);
  }
  return (
    <Modal open onClose={onClose}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-extrabold">{replacing ? 'פריסה מחדש' : 'פריסה לתשלומים'}</h3>
          <p className="truncate text-sm text-muted">{what} · יתרה {ils(balance)}</p>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      <p className="mb-2 text-xs text-muted">מועדי גבייה שהעסק מנהל — לא תשלומים בכרטיס אשראי. כל תשלום מופיע ב"חייבים" עם התאריך שלו{replacing ? '. הפריסה הקודמת תבוטל.' : '.'}</p>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-semibold">מספר תשלומים</span>
        {COUNTS.map((n) => <Chip key={n} on={count === n} onClick={() => restart(n, first)}>{n}</Chip>)}
        <div className="w-20"><Input type="number" min={PLAN_MIN} max={PLAN_MAX} value={count} className="py-1.5 text-center" aria-label="מספר תשלומים"
          onChange={(e) => { const n = Math.max(PLAN_MIN, Math.min(PLAN_MAX, Math.floor(Number(e.target.value) || PLAN_MIN))); restart(n, first); }} /></div>
      </div>
      <Field label="תשלום ראשון בתאריך (אחריו — פעם בחודש)">
        <div className="w-48"><Input type="date" value={first} min={today} onChange={(e) => e.target.value && restart(count, e.target.value)} /></div>
      </Field>
      <div className="mt-2 grid max-h-[40vh] gap-1.5 overflow-auto">
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-1.5 text-sm">
            <span className="text-muted">תשלום {i + 1}</span>
            <Input type="date" value={it.dueDate} min={today} onChange={(e) => setDate(i, e.target.value)} aria-label={`תאריך תשלום ${i + 1}`} className="py-1.5" />
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={it.amount || ''} onChange={(e) => setAmount(i, e.target.value)}
              aria-label={`סכום תשלום ${i + 1}`} className="py-1.5" />
          </div>
        ))}
      </div>
      <p className={`mt-2 text-sm font-semibold ${ag(sum) === ag(balance) ? 'text-emerald-700 dark:text-emerald-300' : 'text-warn'}`} role="status">
        סה״כ {ils(sum)} מתוך יתרה של {ils(balance)}{ag(sum) === ag(balance) ? ' ✓' : ''}
      </p>
      <Field label="הערה (לא חובה)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className="min-h-12" /></Field>
      {(error ?? (problem && ag(sum) === ag(balance) ? problem : null)) && <div className="mt-2" role="alert"><Note tone="warn">{error ?? problem}</Note></div>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || Boolean(problem)} onClick={() => void save()}>{busy ? <Spinner /> : replacing ? 'שמירת הפריסה החדשה' : 'שמירת הפריסה'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}

/** a plan's payments with their statuses (paid in order, by what the invoice went down since the plan was made) */
export function PlanLines({ lines, today = todayIL(), link }: { lines: Line[]; today?: string; link?: (l: Line) => ReactNode }) {
  const planned = lines.filter((l) => l.planId);
  if (!planned.length) return null;
  return (
    <ul className="grid gap-1 text-sm">
      {planned.map((l) => {
        const st = lineStatus(l, today);
        return (
          <li key={`${l.itemId ?? 'extra'}`} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">{lineLabel(l)} · {l.dueDate ? ddmmyyyy(l.dueDate) : ''}</span>
            <Pill tone={st === 'paid' ? 'ok' : st === 'overdue' ? 'bad' : st === 'partial' ? 'warn' : 'default'}>{LINE_STATUS_HE[st]}</Pill>
            <strong className="tabular-nums">{st === 'partial' ? `${ils(l.open)} מתוך ${ils(l.amount)}` : ils(st === 'paid' ? l.amount : l.open)}</strong>
            {st !== 'paid' && link?.(l)}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * On an invoice (DocView) and on a package (its invoice): the plan in force and its payments — or "📅 פריסה לתשלומים" when
 * something is owed. A payment of the plan may be asked for with a link (T2) for what is open of it.
 */
export function PlanSection({ documentId, balance, what, canPlan, linkProps, onChanged, say }: {
  documentId: string; balance: number; what: string; canPlan: boolean;
  /** a link for one payment (when links may be sent on this invoice): everything but the amount */
  linkProps?: { kind: 'document'; target: string; packageId?: string | null; what: string; left: number; customer: { name: string; phone: string; email: string }; onSent: () => void } | null;
  onChanged?: () => void; say?: (m: string) => void;
}) {
  const { ready, plan, lines, reload } = usePlan(documentId);
  const [dialog, setDialog] = useState<'new' | 'replace' | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!ready) return null;
  const owed = ag(balance) > 0;
  if (!plan && !(owed && canPlan)) return null;
  async function doCancel() {
    if (!plan) return;
    const r = await cancelPlan(plan.id, reason);
    if (!r.ok) { setError(r.error); return; }
    setCancelling(false); setReason(''); say?.('הפריסה בוטלה — המסמך חוזר למועד התשלום שלו'); await reload(); onChanged?.();
  }
  return (
    <div className="mt-3 grid gap-2 rounded-2xl border border-line p-3 text-sm">
      {plan ? <>
        <p className="font-bold">📅 פריסה ל-{plan.payments} תשלומים · {ils(plan.total)}{plan.note ? <span className="font-normal text-muted"> · {plan.note}</span> : null}</p>
        <PlanLines lines={lines} link={linkProps ? (l) => (
          <PaylinkButton size="sm" label="💳 לינק" {...linkProps} amount={Math.min(l.open, linkProps.left)} what={`${linkProps.what} · ${lineLabel(l)}`} />
        ) : undefined} />
        {canPlan && (
          <div className="flex flex-wrap gap-2">
            {owed && <Button size="sm" variant="ghost" onClick={() => setDialog('replace')}>פריסה מחדש</Button>}
            <Button size="sm" variant="ghost" onClick={() => setCancelling((c) => !c)}>ביטול הפריסה</Button>
          </div>
        )}
        {cancelling && (
          <div className="flex flex-wrap items-center gap-2">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="סיבה (לא חובה)" className="max-w-xs py-2" aria-label="סיבת ביטול הפריסה" />
            <Button size="sm" variant="primary" onClick={() => void doCancel()}>אישור ביטול</Button>
          </div>
        )}
        <p className="text-xs text-muted">תשלום שמתקבל נרשם כרגיל ("קבלה על תשלום" או לינק) — וסוגר את התשלומים לפי הסדר.</p>
      </> : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDialog('new')}>📅 פריסה לתשלומים</Button>
          <span className="text-xs text-muted">חלוקת היתרה ({ils(balance)}) למועדים — כל תשלום עם התאריך שלו בחייבים ובתזכורות.</span>
        </div>
      )}
      {error && <Note tone="warn">{error}</Note>}
      {dialog && <PlanDialog documentId={documentId} balance={balance} what={what} replacing={dialog === 'replace'} onClose={() => setDialog(null)}
        onSaved={(m) => { setDialog(null); say?.(m); void reload(); onChanged?.(); }} />}
    </div>
  );
}
