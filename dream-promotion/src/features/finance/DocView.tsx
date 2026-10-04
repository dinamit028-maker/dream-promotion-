'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { authHeaders } from '@/lib/services/http';
import { Button, Chip, Field, Input, Textarea } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { waLink } from '@/features/crm/crm';
import { DOC_LABEL, creditedTotals, toDoc, type DocRow } from '@/features/documents/documents';
import { docBody, printDocRow } from '@/features/documents/DocumentsTab';
import { useFinance } from './FinanceScreen';
import { composeCredit, composeReceipt, type CreditMode } from './compose';
import { SEED_RULES, allocationNeed, allocationPrintLine, allocationState, toAllocationRow, toRule, type AllocationRule, type AllocationRow, type AllocationState } from './allocation';
import { documentRow, financeError, issueDocumentRow, logEvent, newKey } from './api';
import { PAY_METHODS, type PaymentEntry, type PayMethod } from './payments';
import { toReceivable, type Receivable } from './receivables';
import { Note, PaymentsEditor, Pill, ils, todayIL } from './ui';

/**
 * One document: the document itself (as printed), and what can happen to it — print (original / true copy), PDF,
 * send on WhatsApp, a receipt for what is still owed, a credit invoice (whole / sum / lines, money back recorded),
 * cancelling a receipt or transaction invoice issued by mistake, its allocation number. The document never changes;
 * every action is a new document or a new record.
 */
let rulesCache: AllocationRule[] | null = null;
export async function allocationRules(): Promise<AllocationRule[]> {
  if (rulesCache) return rulesCache;
  const { data, error } = await supabase().from('tax_allocation_rules').select('*').order('effective_from');
  rulesCache = !error && data?.length ? data.map(toRule) : SEED_RULES;
  return rulesCache;
}

export function DocView({ doc: initial, onClose, onChanged }: { doc: DocRow; onClose: () => void; onChanged: () => void }) {
  const { userId, business, settings, vat, say, fail } = useFinance();
  const { addActivity, updateLead } = useApp();
  const [doc, setDoc] = useState(initial);
  const [cancelled, setCancelled] = useState<{ reason: string } | null>(null);
  const [credited, setCredited] = useState(0);
  const [recv, setRecv] = useState<Receivable | null>(null);
  const [alloc, setAlloc] = useState<{ rows: AllocationRow[]; state: AllocationState } | null>(null);
  const [dialog, setDialog] = useState<'credit' | 'receipt' | 'cancel' | 'manual' | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const sb = supabase();
    const [c, cr, rv, al, rules] = await Promise.all([
      sb.from('document_cancellations').select('reason').eq('document_id', doc.id).maybeSingle(),
      doc.docType === 305 || doc.docType === 320 ? sb.from('documents').select('doc_type, total, base_doc_type, base_doc_number').eq('doc_type', 330).eq('base_doc_type', doc.docType).eq('base_doc_number', doc.docNumber)
        : Promise.resolve({ data: [], error: null }),
      doc.docType === 305 || doc.docType === 300 ? sb.from('receivables').select('*').eq('id', doc.id).maybeSingle() : Promise.resolve({ data: null, error: null }),
      [305, 320, 330].includes(doc.docType) ? sb.from('tax_allocations').select('*').eq('document_id', doc.id).order('created_at', { ascending: false }) : Promise.resolve({ data: [], error: null }),
      allocationRules(),
    ]);
    setCancelled(c.data ? { reason: (c.data as any).reason } : null);
    setCredited(creditedTotals(((cr.data ?? []) as any[]).map((x) => ({ docType: x.doc_type, total: Number(x.total), baseDocType: x.base_doc_type, baseDocNumber: Number(x.base_doc_number) }))).get(`${doc.docType}:${doc.docNumber}`) ?? 0);
    setRecv(rv.data ? toReceivable(rv.data) : null);
    const rows = ((al.data ?? []) as any[]).map(toAllocationRow);
    setAlloc({ rows, state: allocationState(rows, allocationNeed(doc, { entityType: doc.issuer?.entityType ?? settings.entity }, rules)) });
  }, [doc, settings.entity]);
  useEffect(() => { void load(); }, [load]);

  const allocLine = alloc ? allocationPrintLine(alloc.state) : null;
  const html = useMemo(() => docBody({ ...doc, cancelled: Boolean(cancelled) } as DocRow, business, doc.printCount ? 'העתק נאמן למקור' : 'מקור (טרם הודפס)', { allocation: allocLine }), [doc, business, allocLine, cancelled]);
  const fullyCredited = credited > 0 && Math.round(credited * 100) >= Math.round(doc.total * 100);

  async function print() {
    const fresh = await printDocRow(doc, business);
    if (!fresh) { fail('ההדפסה לא נרשמה. נסו שוב.'); return; }
    setDoc(fresh); onChanged();
  }
  function share() {
    const url = `${window.location.origin}/d/${doc.shareToken}`;
    const link = waLink(doc.customerPhone ?? '', `שלום${doc.customerName ? ` ${doc.customerName.split(' ')[0]}` : ''}, מצורף ${DOC_LABEL[doc.docType]} מס׳ ${doc.docNumber} (${ils(doc.total)}): ${url}`);
    if (!link) { void navigator.clipboard?.writeText(url); say('הקישור הועתק'); return; }
    window.open(link, '_blank', 'noopener');
    void logEvent('document.sent', 'documents', doc.id, { type: doc.docType, number: doc.docNumber, channel: 'whatsapp' });
  }
  async function requestAllocation() {
    setBusy(true);
    try {
      const r = await fetch('/api/finance/allocations', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ documentId: doc.id }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) fail(j.message ?? 'הבקשה לא נשלחה.'); else say(j.message ?? 'הבקשה נרשמה');
    } catch { fail('אין חיבור כרגע. נסו שוב.'); }
    setBusy(false); await load();
  }
  const afterIssue = (d: DocRow, label: string) => {
    if (d.leadId) {
      addActivity(d.leadId, 'note', label);
      if (d.docType === 330) { const l = useApp.getState().leads.find((x) => x.id === d.leadId); if (l) updateLead(l.id, { value: Math.max(0, Math.round(((l.value ?? 0) - d.total) * 100) / 100) }); }
    }
    say(label); setDialog(null); onChanged(); void load();
  };

  return (
    <Modal open onClose={onClose} wide>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-display text-xl font-extrabold">{DOC_LABEL[doc.docType]} {doc.docNumber}</h3>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {cancelled && <Pill tone="bad">בוטל · {cancelled.reason}</Pill>}
            {credited > 0 && <Pill tone={fullyCredited ? 'bad' : 'warn'}>{fullyCredited ? 'זוכתה' : `זוכתה חלקית (${ils(credited)})`}</Pill>}
            {recv && !recv.cancelled && <Pill tone={recv.balance <= 0 ? 'ok' : 'warn'}>{recv.balance <= 0 ? 'שולם' : `יתרה ${ils(recv.balance)}`}</Pill>}
            {alloc?.state.kind === 'real' && <Pill tone="ok">מספר הקצאה {alloc.state.number}{alloc.state.manual ? ' (ידני)' : ''}</Pill>}
            {alloc?.state.kind === 'test' && <Pill tone="info">מספר בדיקה — לא אמיתי</Pill>}
            {alloc?.state.kind === 'missing' && <Pill tone="bad">חסר מספר הקצאה</Pill>}
          </div>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      <div className="max-h-[50vh] overflow-auto rounded-xl bg-white p-2 text-black" dangerouslySetInnerHTML={{ __html: html }} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => void print()}>{doc.printCount ? 'הדפסת העתק' : 'הדפסת מקור'}</Button>
        {doc.shareToken && <a href={`/api/doc/${doc.shareToken}/pdf`} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm font-semibold hover:border-primary">🔏 PDF</a>}
        {doc.shareToken && <Button variant="ghost" onClick={share}>💬 שליחה ללקוח</Button>}
        {recv && !recv.cancelled && recv.balance > 0 && <Button variant="ghost" onClick={() => setDialog('receipt')}>קבלה על תשלום</Button>}
        {vat && (doc.docType === 305 || doc.docType === 320) && !fullyCredited && <Button variant="ghost" onClick={() => setDialog('credit')}>חשבונית זיכוי</Button>}
        {(doc.docType === 300 || doc.docType === 400) && !cancelled && <Button variant="ghost" onClick={() => setDialog('cancel')}>ביטול מסמך</Button>}
      </div>
      {alloc && (alloc.state.kind === 'missing' || alloc.state.kind === 'error' || alloc.state.kind === 'test') && (
        <div className="mt-3 grid gap-2 rounded-2xl border border-line p-3 text-sm">
          <p><strong>מספר הקצאה:</strong> {alloc.state.kind === 'missing' ? alloc.state.reason : alloc.state.kind === 'error' ? `הבקשה האחרונה נכשלה — ${alloc.state.message}` : 'יש רק מספר בדיקה (סביבת בדיקות).'}
            {alloc.state.kind === 'missing' && !alloc.state.verified && <span className="block text-xs text-muted">הסף נלקח ממקורות משניים ולא אומת מול פרסום רשמי — לאשר עם רו״ח.</span>}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void requestAllocation()}>{busy ? <Spinner /> : 'בקשה מרשות המסים'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog('manual')}>הזנת מספר שהתקבל</Button>
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">מסמך שהופק לא ניתן לשינוי או למחיקה. תיקון — בחשבונית זיכוי (חשבונית מס) או בביטול (קבלה / חשבונית עסקה, נרשם עם סיבה).</p>

      {dialog === 'receipt' && recv && <ReceiptDialog doc={doc} balance={recv.balance} onClose={() => setDialog(null)} onIssued={(d) => afterIssue(d, `הופקה ${DOC_LABEL[d.docType]} מס׳ ${d.docNumber} · ${ils(d.total)}`)} />}
      {dialog === 'credit' && <CreditDialog doc={doc} credited={credited} onClose={() => setDialog(null)} onIssued={(d) => afterIssue(d, `הופקה חשבונית מס זיכוי מס׳ ${d.docNumber} · ${ils(d.total)}`)} />}
      {dialog === 'cancel' && <CancelDialog doc={doc} userId={userId} onClose={() => setDialog(null)} onDone={() => afterIssue(doc, `${DOC_LABEL[doc.docType]} מס׳ ${doc.docNumber} בוטל/ה`)} />}
      {dialog === 'manual' && <ManualAllocation doc={doc} onClose={() => setDialog(null)} onDone={() => { setDialog(null); say('מספר ההקצאה נשמר'); void load(); }} />}
    </Modal>
  );
}

/** payment of an open 305 / 300: a receipt (400), or a 320 for a VAT business's transaction invoice */
export function ReceiptDialog({ doc, balance, onClose, onIssued }: { doc: DocRow; balance: number; onClose: () => void; onIssued: (d: DocRow) => void }) {
  const { userId, settings } = useFinance();
  const today = todayIL();
  const [payments, setPayments] = useState<PaymentEntry[]>([{ method: 'transfer', amount: balance, date: today }]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => newKey('receipt'));
  async function go() {
    const r = composeReceipt({ ...doc, balance }, { entity: settings.entity, vatRate: settings.vatRate, payments, docDate: today, today });
    if (!r.ok) { setErrors(r.errors); return; }
    setBusy(true);
    const out = await issueDocumentRow(documentRow(r.doc, { userId, idempotencyKey: key, vatRate: r.totals.vatRate, leadId: doc.leadId ?? null, paidDocumentId: doc.id }));
    setBusy(false);
    if (!out.ok) { setErrors([out.error]); return; }
    onIssued(out.doc);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">תשלום על {DOC_LABEL[doc.docType]} {doc.docNumber}</h3>
      <p className="mb-3 text-sm text-muted">יתרה לתשלום: {ils(balance)}. רישום תשלום שהתקבל — לא סליקה; שום כרטיס לא מחויב כאן.</p>
      <PaymentsEditor payments={payments} onChange={setPayments} total={payments.reduce((a, p) => a + (p.amount || 0), 0)} today={today} />
      {errors.length > 0 && <div className="mt-3"><Note tone="warn">{errors.map((e) => <span key={e} className="block">{e}</span>)}</Note></div>}
      <div className="mt-4 flex gap-2"><Button variant="primary" disabled={busy} onClick={() => void go()}>{busy ? 'מפיק…' : 'הפקת קבלה'}</Button><Button variant="ghost" onClick={onClose}>ביטול</Button></div>
    </Modal>
  );
}

function CreditDialog({ doc, credited, onClose, onIssued }: { doc: DocRow; credited: number; onClose: () => void; onIssued: (d: DocRow) => void }) {
  const { userId, fail } = useFinance();
  const today = todayIL();
  const left = Math.round((doc.total - credited) * 100) / 100;
  const [kind, setKind] = useState<CreditMode['kind']>('full');
  const [amount, setAmount] = useState(left);
  const [qty, setQty] = useState<number[]>(doc.lines.map(() => 0));
  const [restock, setRestock] = useState(true);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<{ on: boolean; method: PayMethod }>({ on: doc.docType === 320, method: 'cash' });
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => newKey('credit'));
  const mode: CreditMode = kind === 'full' ? { kind } : kind === 'amount' ? { kind, amount } : { kind, qty, restock };
  const preview = composeCredit(doc, mode, credited, today, { reason, today });
  async function go() {
    if (!preview.ok) { setErrors(preview.errors); return; }
    if (!window.confirm(`להפיק חשבונית מס זיכוי על ${ils(preview.doc.total)}? החשבונית המקורית נשארת כמו שהיא.`)) return;
    setBusy(true);
    const out = await issueDocumentRow(documentRow(preview.doc, { userId, idempotencyKey: key, vatRate: preview.totals.vatRate, leadId: doc.leadId ?? null, saleId: doc.saleId }));
    if (!out.ok) { setBusy(false); setErrors([out.error]); return; }
    if (refund.on) {
      const { error } = await supabase().rpc('record_credit_refund', { p_document: out.doc.id, p_method: refund.method, p_amount: out.doc.total, p_paid_on: today, p_note: reason.slice(0, 300) });
      if (error) fail(`חשבונית הזיכוי הופקה, אבל ההחזר לא נרשם: ${financeError(error)}`);
    }
    setBusy(false); onIssued(out.doc);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">חשבונית זיכוי על {DOC_LABEL[doc.docType]} {doc.docNumber}</h3>
      <p className="mb-3 text-sm text-muted">אפשר לזכות עד {ils(left)}{credited ? ` (כבר זוכו ${ils(credited)})` : ''}.</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        <Chip on={kind === 'full'} onClick={() => setKind('full')}>{credited ? 'כל היתרה' : 'כל החשבונית'}</Chip>
        <Chip on={kind === 'amount'} onClick={() => setKind('amount')}>סכום</Chip>
        {doc.lines.length > 0 && <Chip on={kind === 'lines'} onClick={() => setKind('lines')}>לפי שורות</Chip>}
      </div>
      {kind === 'amount' && <Field label="סכום הזיכוי (כולל מע״מ)"><Input type="number" inputMode="decimal" min={0} max={left} step="0.01" value={amount || ''} onChange={(e) => setAmount(Number(e.target.value))} /></Field>}
      {kind === 'lines' && (
        <div className="mb-3 grid gap-1.5">
          {doc.lines.map((l, i) => (
            <label key={i} className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-2 text-sm">
              <span className="truncate">{l.name} <span className="text-muted">(מתוך {l.qty})</span></span>
              <Input type="number" min={0} max={l.qty} value={qty[i] || ''} onChange={(e) => setQty(qty.map((q, k) => (k === i ? Math.max(0, Math.min(l.qty, Number(e.target.value))) : q)))} aria-label={`כמות לזיכוי: ${l.name}`} className="px-2 py-2 text-center" />
            </label>
          ))}
          {doc.lines.some((l) => l.itemId) && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> המוצרים חזרו למלאי</label>}
        </div>
      )}
      <Field label="סיבה (מופיעה על המסמך)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-14" /></Field>
      <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={refund.on} onChange={(e) => setRefund({ ...refund, on: e.target.checked })} /> הכסף הוחזר ללקוח</label>
      {refund.on && <div className="mb-3 flex flex-wrap gap-1.5">{PAY_METHODS.map((m) => <Chip key={m.id} on={refund.method === m.id} onClick={() => setRefund({ ...refund, method: m.id })} className="min-h-9">{m.icon} {m.label}</Chip>)}</div>}
      {preview.ok && <p className="mb-2 text-sm">חשבונית הזיכוי: <strong>{ils(preview.doc.total)}</strong>{preview.doc.vatAmount ? ` (מתוכו מע״מ ${ils(preview.doc.vatAmount)})` : ''}</p>}
      {errors.length > 0 && <Note tone="warn">{errors.join(' · ')}</Note>}
      <div className="mt-3 flex gap-2"><Button variant="primary" disabled={busy || !preview.ok} onClick={() => void go()}>{busy ? 'מפיק…' : 'הפקת חשבונית זיכוי'}</Button><Button variant="ghost" onClick={onClose}>ביטול</Button></div>
    </Modal>
  );
}

function CancelDialog({ doc, userId, onClose, onDone }: { doc: DocRow; userId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    const { error: e } = await supabase().from('document_cancellations').insert({ document_id: doc.id, user_id: userId, reason: reason.trim() });
    setBusy(false);
    if (e) { setError(financeError(e)); return; }
    onDone();
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">ביטול {DOC_LABEL[doc.docType]} {doc.docNumber}</h3>
      <p className="mb-3 text-sm text-muted">המסמך נשאר כמו שהוא ומסומן "בוטל" (גם בממשק הפתוח). {doc.docType === 400 ? 'הכסף שלו יוצא מיומן התשלומים.' : ''} {!doc.saleId && doc.lines.some((l) => l.itemId) ? 'המוצרים שבו חוזרים למלאי.' : ''} רק אם הופק בטעות.</p>
      <Field label="סיבה"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
      {error && <Note tone="warn">{error}</Note>}
      <div className="mt-3 flex gap-2"><Button variant="primary" disabled={busy || reason.trim().length < 2} onClick={() => void go()}>ביטול המסמך</Button><Button variant="ghost" onClick={onClose}>חזרה</Button></div>
    </Modal>
  );
}

function ManualAllocation({ doc, onClose, onDone }: { doc: DocRow; onClose: () => void; onDone: () => void }) {
  const [num, setNum] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function go() {
    const { error: e } = await supabase().rpc('record_manual_allocation', { p_document: doc.id, p_number: num });
    if (e) { setError(financeError(e)); return; }
    onDone();
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">מספר הקצאה שהתקבל מרשות המסים</h3>
      <p className="mb-3 text-sm text-muted">רק מספר שקיבלתם בפועל מרשות המסים (למשל באזור האישי). הוא יסומן "הוזן ידנית" על המסמך ובייצוא.</p>
      <Input value={num} onChange={(e) => setNum(e.target.value.replace(/\D/g, '').slice(0, 20))} inputMode="numeric" dir="ltr" aria-label="מספר הקצאה" />
      {error && <div className="mt-2"><Note tone="warn">{error}</Note></div>}
      <div className="mt-3 flex gap-2"><Button variant="primary" disabled={num.length < 6} onClick={() => void go()}>שמירה</Button><Button variant="ghost" onClick={onClose}>ביטול</Button></div>
    </Modal>
  );
}

/** a document by id (the CRM card and the receivables open documents this way) */
export async function loadDoc(id: string): Promise<DocRow | null> {
  const { data } = await supabase().from('documents').select('*').eq('id', id).maybeSingle();
  return data ? toDoc(data) : null;
}
