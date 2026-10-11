'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { Button, Chip, Field, Input, Textarea } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/feedback';
import { DOC_LABEL, type DocRow } from '@/features/documents/documents';
import { useFinance } from './FinanceScreen';
import { documentRow, financeError, issueDocumentRow } from './api';
import { followKey } from './keys';
import { docFromBase, goodsState, madeFrom, type GoodsState } from './goods';
import { dueDateFor } from './receivables';
import type { PaymentEntry } from './payments';
import { Note, PaymentsEditor, ils, todayIL } from './ui';
import { useReportsReady } from './reports-data';

/**
 * The goods documents' actions (2.95, T10): what was made from an order or a delivery note, and a new document made from it — a
 * delivery note or an invoice from an order, the invoice in one click or a return note from a delivery note. The quantities are of
 * what is left; the database checks the same (d_documents_goods) and numbers each in its own series.
 */
export interface Follower { id: string; docType: number; docNumber: number; lines: DocRow['lines']; cancelled: boolean }
export function useFollowers(doc: DocRow | null): { list: Follower[] | null; state: GoodsState | null; reload: () => Promise<void> } {
  const [list, setList] = useState<Follower[] | null>(null);
  const reload = useCallback(async () => {
    if (!doc || (doc.docType !== 100 && doc.docType !== 200)) { setList([]); return; }
    const sb = supabase();
    const { data } = await sb.from('documents').select('id, doc_type, doc_number, lines').eq('base_doc_type', doc.docType).eq('base_doc_number', doc.docNumber)
      .order('issued_at');
    const rows = (data ?? []) as any[];
    const ids = rows.map((r) => r.id);
    const c = ids.length ? await sb.from('document_cancellations').select('document_id').in('document_id', ids) : { data: [] as any[] };
    const gone = new Set(((c.data ?? []) as any[]).map((x) => x.document_id));
    setList(rows.map((r) => ({ id: r.id, docType: r.doc_type, docNumber: Number(r.doc_number), lines: r.lines ?? [], cancelled: gone.has(r.id) })));
  }, [doc]);
  useEffect(() => { void reload(); }, [reload]);
  const state = useMemo(() => (doc && list ? goodsState(doc, list) : null), [doc, list]);
  return { list, state, reload };
}

/** a new document made from an order or a delivery note: its type, the quantity of each line (of what is left), and its terms */
export function FromBaseDialog({ base, targets, left, fixedQty, title, onClose, onIssued }: {
  base: DocRow; targets: number[]; left: number[]; fixedQty?: boolean; title: string; onClose: () => void; onIssued: (d: DocRow) => void;
}) {
  const { userId, settings, profile } = useFinance();
  const today = todayIL();
  const [type, setType] = useState(targets[0]);
  const [take, setTake] = useState<number[]>(left);
  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [dueDate, setDueDate] = useState(dueDateFor(today, profile.paymentTerms));
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const withholdingOk = useReportsReady();
  // the key of the next document made from it: two devices making it at once share it — one document only
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void supabase().from('documents').select('id', { count: 'exact', head: true }).eq('base_doc_type', base.docType).eq('base_doc_number', base.docNumber)
      .then(({ count, error }) => { if (alive) { if (error) setErrors([financeError(error)]); else setKey(followKey('from', base.id, count ?? 0)); } });
    return () => { alive = false; };
  }, [base.id, base.docType, base.docNumber]);
  const opts = { docType: type, entity: settings.entity, vatRate: settings.vatRate, docDate: today, today, left, dueDate, payments, notes };
  const preview = docFromBase(base, take, opts);
  const total = preview.ok ? preview.doc.total : 0;
  const receipt = type === 320;
  useEffect(() => { // an invoice-receipt starts with one payment of the whole amount
    if (receipt && total > 0 && (payments.length === 0 || (payments.length === 1 && payments[0].amount !== total))) setPayments([{ method: 'transfer', amount: total, date: today }]);
  }, [receipt, total]); // eslint-disable-line react-hooks/exhaustive-deps

  async function go() {
    if (!key) return;
    const res = docFromBase(base, take, opts);
    if (!res.ok) { setErrors(res.errors); return; }
    if (!window.confirm(`להפיק ${DOC_LABEL[type]} על ${ils(res.doc.total)} מתוך ${DOC_LABEL[base.docType]} ${base.docNumber}?`)) return;
    setBusy(true); setErrors([]);
    const out = await issueDocumentRow(documentRow(res.doc, { userId, idempotencyKey: key, vatRate: res.totals.vatRate, leadId: base.leadId ?? null }));
    setBusy(false);
    if (!out.ok) { setErrors([out.error]); return; }
    if (out.again && (out.doc.docType !== type || Math.round(out.doc.total * 100) !== Math.round(res.doc.total * 100))) {
      setErrors([`כבר הופק מסמך מ${DOC_LABEL[base.docType]} הזה (${DOC_LABEL[out.doc.docType]} ${out.doc.docNumber}), כנראה ממכשיר אחר. סגרו ופתחו שוב.`]); return;
    }
    onIssued(out.doc);
  }
  return (
    <Modal open onClose={onClose} wide>
      <h3 className="mb-1 font-display text-lg font-extrabold">{title}</h3>
      <p className="mb-3 text-sm text-muted">מתוך {DOC_LABEL[base.docType]} {base.docNumber}{base.customerName ? ` · ${base.customerName}` : ''}. המחירים כמו במסמך המקורי.</p>
      {targets.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="סוג המסמך">
          {targets.map((t) => <Chip key={t} on={type === t} onClick={() => setType(t)} role="radio" aria-checked={type === t}>{DOC_LABEL[t]}</Chip>)}
        </div>
      )}
      <div className="mb-3 grid gap-1.5">
        {base.lines.map((l, i) => (
          <label key={i} className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-2 text-sm">
            <span className="min-w-0 truncate">{l.name} <span className="text-muted">(נשאר {left[i]}{left[i] !== l.qty ? ` מתוך ${l.qty}` : ''})</span></span>
            {fixedQty ? <span className="text-center tabular-nums">{take[i]}</span> : (
              <Input type="number" min={0} max={left[i]} value={take[i] || ''} onChange={(e) => setTake(take.map((q, k) => (k === i ? Math.max(0, Math.min(left[i], Number(e.target.value) || 0)) : q)))}
                aria-label={`כמות: ${l.name}`} className="px-2 py-2 text-center" />
            )}
          </label>
        ))}
      </div>
      {(type === 305 || type === 300) && <Field label="לתשלום עד"><Input type="date" value={dueDate} min={today} onChange={(e) => setDueDate(e.target.value)} className="w-44" /></Field>}
      {receipt && total > 0 && <div className="mb-2"><p className="mb-1 text-sm font-bold">איך שולם</p><PaymentsEditor payments={payments} onChange={setPayments} total={total} today={today} withholding={withholdingOk} /></div>}
      <Field label="הערות על המסמך (לא חובה)"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} className="min-h-14" /></Field>
      {preview.ok && (
        <p className="mb-2 text-sm">{DOC_LABEL[type]}: <strong>{ils(preview.doc.total)}</strong>{preview.doc.vatAmount ? ` (מתוכו מע״מ ${ils(preview.doc.vatAmount)})` : ''}
          {type === 210 ? ' · הפריטים חוזרים למלאי' : type === 200 ? ' · הפריטים יורדים מהמלאי' : base.docType === 200 ? ' · המלאי כבר ירד בתעודת המשלוח' : ''}</p>
      )}
      {errors.length > 0 && <Note tone="warn">{errors.map((e) => <span key={e} className="block">{e}</span>)}</Note>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={busy || !key || !preview.ok} onClick={() => void go()}>{busy ? 'מפיק…' : `הפקת ${DOC_LABEL[type]}`}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}

/** what a goods document's view offers: the documents made from it, and the new one to make */
export function goodsActions(doc: DocRow, s: GoodsState | null, cancelled: boolean, entity: Parameters<typeof madeFrom>[1]) {
  if (!s || cancelled || (doc.docType !== 100 && doc.docType !== 200)) return { canDeliver: false, canInvoice: false, canReturn: false, invoiceTargets: [] as number[] };
  const anyLeft = s.left.some((q) => q > 0);
  const invoiceTargets = madeFrom(doc.docType, entity).filter((t) => t !== 200 && t !== 210);
  if (doc.docType === 100) return { canDeliver: anyLeft, canInvoice: anyLeft, canReturn: false, invoiceTargets };
  const invoiced = s.invoices.length > 0;
  return { canDeliver: false, canInvoice: !invoiced && anyLeft, canReturn: !invoiced && anyLeft, invoiceTargets };
}
