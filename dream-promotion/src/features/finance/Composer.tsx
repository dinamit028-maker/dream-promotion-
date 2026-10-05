'use client';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Button, Chip, Field, Input, Textarea } from '@/components/ui/primitives';
import { CloseButton, Modal } from '@/components/ui/feedback';
import { DOC_LABEL, type DocRow } from '@/features/documents/documents';
import { useFinance } from './FinanceScreen';
import { composeDocument, computeLines, type ComposeCustomer, type ComposeLine, type Discount } from './compose';
import { DOC_INFO, allowedDocTypes } from './rules';
import { TERMS, dueDateFor } from './receivables';
import { validUntilFor, type ComposerBody, type Quote } from './quotes';
import { documentRow, financeError, issueDocumentRow, newKey } from './api';
import { quoteKey } from './keys';
import type { PaymentEntry } from './payments';
import { CustomerFields, LinesEditor, Note, PaymentsEditor, ils, todayIL } from './ui';

/**
 * One composer for a new document, a draft and a quote: customer (from the contacts or typed), lines (free or from
 * the price list), prices with or without VAT, a discount, terms / due date, payments (receipts), notes.
 * Totals come from the accounting engine (compose.ts) as you type. "הפקה" asks once — an issued document never changes.
 * A retry of the same issue (a double tap, a lost answer) returns the same document (idempotency key).
 */
export type ComposerMode =
  | { kind: 'document'; docType: number; draftId?: string | null; quoteId?: string | null }
  | { kind: 'quote'; quote?: Quote | null };
export type ComposerDone = { kind: 'issued'; doc: DocRow } | { kind: 'draft'; id: string } | { kind: 'quote'; id: string; sent: boolean };

const EMPTY_LINE: ComposeLine = { name: '', qty: 1, unitPrice: 0 };

export function Composer({ mode, initial, onClose, onDone }: {
  mode: ComposerMode; initial?: Partial<ComposerBody> & { leadId?: string | null }; onClose: () => void; onDone: (r: ComposerDone) => void;
}) {
  const { userId, settings, profile, catalog, vat, business } = useFinance();
  const { leads, addActivity, updateLead } = useApp();
  const quote = mode.kind === 'quote' ? mode.quote ?? null : null;
  const types = allowedDocTypes(settings.entity).filter((t) => t !== 330 && (t !== 400 || !vat));
  const [docType, setDocType] = useState(mode.kind === 'document' ? (types.includes(mode.docType) ? mode.docType : types[0]) : 0);
  const [customer, setCustomer] = useState<ComposeCustomer>(initial?.customer ?? { name: '' });
  const [leadId, setLeadId] = useState<string | null>(initial?.leadId ?? quote?.leadId ?? null);
  const [lines, setLines] = useState<ComposeLine[]>(initial?.lines?.length ? initial.lines : [{ ...EMPTY_LINE }]);
  const [pricesIncludeVat, setPricesIncludeVat] = useState(initial?.pricesIncludeVat ?? true);
  const [discount, setDiscount] = useState<Discount>(initial?.discount ?? { kind: 'sum', value: 0 });
  const today = todayIL();
  const [docDate, setDocDate] = useState(today);
  const [terms, setTerms] = useState(initial?.terms ?? profile.paymentTerms);
  const [dueDate, setDueDate] = useState<string>(initial?.dueDate ?? dueDateFor(today, initial?.terms ?? profile.paymentTerms));
  const [payments, setPayments] = useState<PaymentEntry[]>((initial?.payments as PaymentEntry[] | undefined) ?? []);
  const [notes, setNotes] = useState(initial?.notes ?? quote?.notes ?? '');
  const [validUntil, setValidUntil] = useState(quote?.validUntil ?? validUntilFor(today, profile.quoteValidDays));
  const [key] = useState(() => newKey('direct'));
  const [draftId, setDraftId] = useState<string | null>(mode.kind === 'document' ? mode.draftId ?? null : null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => { setDueDate(dueDateFor(docDate, terms)); }, [docDate, terms]);
  const rate = vat && docType !== 400 ? settings.vatRate : 0;
  const preview = useMemo(() => computeLines(lines, { pricesIncludeVat, discount, rate }), [lines, pricesIncludeVat, discount, rate]);
  const receipt = docType === 320 || docType === 400;
  useEffect(() => { // a receipt starts with one payment of the whole amount
    if (receipt && !payments.length && preview.totals.total > 0) setPayments([{ method: 'cash', amount: preview.totals.total, date: today }]);
  }, [receipt, preview.totals.total]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = (): ComposerBody => ({ lines, pricesIncludeVat, discount, customer, notes, terms, dueDate, payments });
  const input = () => ({ docType, entity: settings.entity, vatRate: settings.vatRate, pricesIncludeVat, lines, discount, customer, payments: receipt ? payments : [],
    docDate, dueDate: docType === 305 || docType === 300 ? dueDate : null, notes, today });

  async function saveDraft() {
    setBusy(true); setErrors([]);
    const row = { doc_type: docType, customer_name: customer.name.trim().slice(0, 120), lead_id: leadId, total: preview.totals.total, body: body(),
      quote_id: mode.kind === 'document' ? mode.quoteId ?? null : null };
    const r = draftId ? await supabase().from('document_drafts').update(row).eq('id', draftId).select('id').single()
      : await supabase().from('document_drafts').insert({ ...row, user_id: userId }).select('id').single();
    setBusy(false);
    if (r.error || !r.data) { setErrors([financeError(r.error)]); return; }
    setDraftId(r.data.id); onDone({ kind: 'draft', id: r.data.id });
  }

  async function issue() {
    const res = composeDocument(input());
    if (!res.ok) { setErrors(res.errors); return; }
    if (!window.confirm(`להפיק ${DOC_LABEL[docType]} על ${ils(res.doc.total)}${customer.name ? ` ל${customer.name}` : ''}? מסמך שהופק לא ניתן לשינוי או למחיקה — תיקון רק בחשבונית זיכוי.`)) return;
    setBusy(true); setErrors([]);
    const quoteId = mode.kind === 'document' ? mode.quoteId ?? null : null;
    // a draft is one document, a quote is one document (whoever converts it, on any device), otherwise this form's own key
    const idempotencyKey = draftId ? `draft:${draftId}` : quoteId ? quoteKey(quoteId) : key;
    const out = await issueDocumentRow(documentRow(res.doc, { userId, idempotencyKey, vatRate: res.totals.vatRate, leadId, quoteId, draftId }));
    setBusy(false);
    if (!out.ok) { setErrors([out.error]); return; }
    if (out.again && quoteId) { setErrors([`ההצעה כבר הפכה ל${DOC_LABEL[out.doc.docType]} מס׳ ${out.doc.docNumber}.`]); return; }
    if (leadId && !out.again) {
      addActivity(leadId, 'purchase', `הופקה ${DOC_LABEL[docType]} מס׳ ${out.doc.docNumber} · ${ils(out.doc.total)}`);
      if (docType === 305 || docType === 320 || docType === 400) {
        const l = useApp.getState().leads.find((x) => x.id === leadId);
        if (l) updateLead(l.id, { value: Math.round(((l.value ?? 0) + out.doc.total) * 100) / 100 });
      }
    }
    onDone({ kind: 'issued', doc: out.doc });
  }

  async function saveQuote(send: boolean) {
    const t = preview.totals;
    if (!lines.some((l) => l.name.trim() && l.qty > 0) || t.total <= 0) { setErrors(['צריך לפחות שורה אחת עם סכום']); return; }
    setBusy(true); setErrors([]);
    const row = {
      customer_name: customer.name.trim().slice(0, 120), customer_phone: (customer.phone ?? '').trim().slice(0, 30), customer_email: (customer.email ?? '').trim().slice(0, 120),
      customer_dealer: (customer.dealer ?? '').replace(/\D/g, '').slice(0, 9), customer_street: (customer.street ?? '').slice(0, 120), customer_city: (customer.city ?? '').slice(0, 60),
      lead_id: leadId, body: body(), before_discount: t.beforeDiscount, discount: t.discountExVat, after_discount: t.afterDiscount, vat_rate: t.vatRate, vat_amount: t.vatAmount,
      total: t.total, valid_until: validUntil || null, notes: notes.trim().slice(0, 2000),
    };
    const r = quote ? await supabase().from('quotes').update({ ...row, ...(send && quote.status !== 'sent' ? { status: 'sent' } : {}) }).eq('id', quote.id).select('id').single()
      : await supabase().from('quotes').insert({ ...row, user_id: userId, status: send ? 'sent' : 'draft' }).select('id').single();
    setBusy(false);
    if (r.error || !r.data) { setErrors([financeError(r.error)]); return; }
    onDone({ kind: 'quote', id: r.data.id, sent: send });
  }

  const title = mode.kind === 'quote' ? (quote ? `הצעת מחיר מס׳ ${quote.number}` : 'הצעת מחיר חדשה') : draftId ? `טיוטה · ${DOC_LABEL[docType]}` : 'מסמך חדש';
  return (
    <Modal open onClose={onClose} wide>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="font-display text-xl font-extrabold">{title}</h3>
        <CloseButton onClick={onClose} />
      </div>
      {mode.kind === 'document' && (
        <div className="mb-3">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="סוג המסמך">
            {types.map((t) => <Chip key={t} on={docType === t} onClick={() => setDocType(t)} role="radio" aria-checked={docType === t}>{DOC_LABEL[t]}</Chip>)}
          </div>
          <p className="mt-1 text-xs text-muted">{DOC_INFO[docType]?.what}{vat ? '' : ' · עוסק פטור: ללא מע״מ'}</p>
        </div>
      )}

      <p className="mb-1 text-sm font-bold">לקוח</p>
      <CustomerFields value={customer} onChange={setCustomer} leads={leads} leadId={leadId} onLead={setLeadId} needName={docType === 305 || docType === 300} />

      <div className="mb-1 mt-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold">שורות</p>
        {rate > 0 && (
          <div className="flex gap-1.5 text-xs">
            <Chip on={pricesIncludeVat} onClick={() => setPricesIncludeVat(true)} className="min-h-9">מחירים כולל מע״מ</Chip>
            <Chip on={!pricesIncludeVat} onClick={() => setPricesIncludeVat(false)} className="min-h-9">לפני מע״מ</Chip>
          </div>
        )}
      </div>
      <LinesEditor lines={lines} onChange={setLines} catalog={catalog} />

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Field label="הנחה">
          <div className="flex gap-1.5">
            <Input type="number" inputMode="decimal" min={0} value={discount.value || ''} onChange={(e) => setDiscount({ ...discount, value: Number(e.target.value) })} className="w-28" aria-label="הנחה" />
            <Chip on={discount.kind === 'sum'} onClick={() => setDiscount({ ...discount, kind: 'sum' })}>₪</Chip>
            <Chip on={discount.kind === 'percent'} onClick={() => setDiscount({ ...discount, kind: 'percent' })}>%</Chip>
          </div>
        </Field>
        {mode.kind === 'document' ? (
          <Field label="תאריך המסמך"><Input type="date" value={docDate} max={today} onChange={(e) => setDocDate(e.target.value || today)} /></Field>
        ) : (
          <Field label="בתוקף עד"><Input type="date" value={validUntil} min={today} onChange={(e) => setValidUntil(e.target.value)} /></Field>
        )}
        {(docType === 305 || docType === 300 || mode.kind === 'quote') && (
          <Field label="תנאי תשלום">
            <div className="flex flex-wrap items-center gap-1.5">
              <select value={terms} onChange={(e) => setTerms(e.target.value)} className="h-11 rounded-md border-[1.5px] border-line bg-surface px-3 text-sm" aria-label="תנאי תשלום">
                {TERMS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              {mode.kind === 'document' && <Input type="date" value={dueDate} min={docDate} onChange={(e) => setDueDate(e.target.value)} className="w-40" aria-label="לתשלום עד" />}
            </div>
          </Field>
        )}
      </div>

      {receipt && mode.kind === 'document' && (
        <div className="mt-2"><p className="mb-1 text-sm font-bold">איך שולם</p><PaymentsEditor payments={payments} onChange={setPayments} total={preview.totals.total} today={today} /></div>
      )}
      <Field label="הערות על המסמך (לא חובה)"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={mode.kind === 'quote' ? 2000 : 1000} className="min-h-16" /></Field>

      <div className="rounded-2xl bg-surface-2 p-3 text-sm tabular-nums">
        {preview.totals.discount > 0 && <div className="flex justify-between"><span>הנחה</span><span>-{ils(preview.totals.discount)}</span></div>}
        {rate > 0 && <div className="flex justify-between"><span>לפני מע״מ</span><span>{ils(preview.totals.afterDiscount)}</span></div>}
        {rate > 0 && <div className="flex justify-between"><span>מע״מ {rate}%</span><span>{ils(preview.totals.vatAmount)}</span></div>}
        <div className="mt-1 flex justify-between text-base font-black"><span>סה״כ</span><span>{ils(preview.totals.total)}</span></div>
      </div>
      {errors.length > 0 && <div className="mt-3"><Note tone="warn">{errors.map((e) => <span key={e} className="block">{e}</span>)}</Note></div>}
      {!business.ready && mode.kind === 'document' && <div className="mt-3"><Note tone="warn">חסרים פרטי העסק (מספר עוסק) — אפשר לשמור טיוטה, להפיק אחרי שממלאים בהגדרות.</Note></div>}

      <div className="mt-4 flex flex-wrap gap-2">
        {mode.kind === 'document' ? <>
          <Button variant="primary" disabled={busy || !business.ready} onClick={() => void issue()}>{busy ? 'רגע…' : `הפקת ${DOC_LABEL[docType]}`}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => void saveDraft()}>שמירה כטיוטה</Button>
        </> : <>
          <Button variant="primary" disabled={busy} onClick={() => void saveQuote(true)}>{busy ? 'רגע…' : 'שמירה ושליחה ללקוח'}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => void saveQuote(false)}>שמירה</Button>
        </>}
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}
