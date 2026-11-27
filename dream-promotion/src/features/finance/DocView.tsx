'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Button, Chip, Field, Input, Textarea } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { waLink } from '@/features/crm/crm';
import { DEPOSIT_DOC_NOTE, DOC_LABEL, creditedTotals, isDepositDoc, isRefundReceipt, refundLeft, toDoc, type DocRow, docNumberLabel } from '@/features/documents/documents';
import { cancelReceiptDoc, missingSaleReceipts, refundReceiptDoc } from './sale-receipts';
import { toRefund } from '@/features/register/refunds';
import { saleFromRow } from '@/features/store/commerce';
import { israelParts } from '@/lib/il-time';
import { docBody, previewMark, printDocRow, wasDelivered } from '@/features/documents/DocumentsTab';
import { deliveryState, linkMayGo, sendDocLink, staffPdf } from '@/features/documents/deliver';
import { AWAITING_SHORT, AWAITING_STAFF, WRONG_NUMBER_NOTE, needFromState, type DeliveryState } from './delivery';
import { useFinance } from './FinanceScreen';
import { composeCredit, composeReceipt, composeRefundReceipt, type CreditMode } from './compose';
import { SEED_RULES, allocationNeed, allocationPrintLine, allocationState, toAllocationRow, toRule, type AllocationRule, type AllocationRow, type AllocationState } from './allocation';
import { documentRow, financeError, issueDocumentRow, logEvent, refundReceiptError } from './api';
import { followKey } from './keys';
import { TAX_FROM_300_LINK, composeTaxFrom300, taxFrom300Extra, taxFrom300Key, type TaxFrom300Link } from './tax-from-300';
import { PAY_METHODS, type PaymentEntry, type PayMethod } from './payments';
import { toReceivable, type Receivable } from './receivables';
import { Note, PaymentsEditor, Pill, ils, todayIL } from './ui';
import { useReportsReady } from './reports-data';
import { PaylinkButton, PaylinkList, heldBy, usePaylinks } from './Paylinks';
import { PlanSection } from './Plans';
import { DocReminders } from './Reminders';
import { FromBaseDialog, goodsActions, useFollowers } from './Goods';
import { isGoods } from './goods';

/**
 * One document: the document itself (as printed), and what can happen to it — print (original / true copy), PDF,
 * send on WhatsApp, a receipt for what is still owed, a payment link for it (2.88: a part of the balance too; its
 * statuses below), a payment plan of what is owed and its reminders (2.89), a credit invoice (whole / sum / lines, money back recorded), cancelling a receipt or transaction
 * invoice issued by mistake, its allocation number. The document never changes; every action is a new document or a new
 * record.
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
  // 2.119: the database's answer (document_delivery_state — the allocation rule, the deliveries so far); null before migration 6900
  const [delivery, setDelivery] = useState<DeliveryState | null>(null);
  const [dialog, setDialog] = useState<'credit' | 'receipt' | 'cancel' | 'manual' | 'deliver' | 'invoice' | 'return' | 'refund' | 'tax300' | null>(null);
  // 2.118: what was refunded on a receipt (its refund receipts — an exempt dealer's money back, the accountant's answer 15)
  const [refunded, setRefunded] = useState<{ left: number; count: number } | null>(null);
  const links = usePaylinks(doc.docType === 305 || doc.docType === 300 ? { documentId: doc.id } : null);
  // 2.95 (T10): an order / a delivery note — what was made from it, what is left
  const goods = useFollowers(doc);
  // 2.121 (answer 19): a 300 of a VAT business — has a tax invoice been issued on it (a 305 linked to it, or a 320 that paid it)?
  const [taxed, setTaxed] = useState<boolean | null>(null);
  useEffect(() => {
    if (!TAX_FROM_300_LINK || doc.docType !== 300) return;
    let alive = true;
    void taxedAlready(doc, TAX_FROM_300_LINK).then((v) => { if (alive) setTaxed(v); });
    return () => { alive = false; };
  }, [doc]);

  const load = useCallback(async () => {
    const sb = supabase();
    const [c, cr, rv, al, rules, rr, ds] = await Promise.all([
      sb.from('document_cancellations').select('reason').eq('document_id', doc.id).maybeSingle(),
      doc.docType === 305 || doc.docType === 320 ? sb.from('documents').select('doc_type, total, base_doc_type, base_doc_number').eq('doc_type', 330).eq('base_doc_type', doc.docType).eq('base_doc_number', doc.docNumber)
        : Promise.resolve({ data: [], error: null }),
      doc.docType === 305 || doc.docType === 300 ? sb.from('receivables').select('*').eq('id', doc.id).maybeSingle() : Promise.resolve({ data: null, error: null }),
      [305, 320, 330].includes(doc.docType) ? sb.from('tax_allocations').select('*').eq('document_id', doc.id).order('created_at', { ascending: false }) : Promise.resolve({ data: [], error: null }),
      allocationRules(),
      doc.docType === 400 && !isRefundReceipt(doc)
        ? sb.from('documents').select('doc_type, total, base_doc_type, base_doc_number').eq('doc_type', 400).eq('base_doc_type', 400).eq('base_doc_number', doc.docNumber).lt('total', 0)
        : Promise.resolve({ data: null, error: null }),
      deliveryState(doc.id),
    ]);
    const back = ((rr.data ?? []) as any[]).map((x) => ({ docType: x.doc_type, total: Number(x.total), baseDocType: x.base_doc_type, baseDocNumber: Number(x.base_doc_number) }));
    setRefunded(rr.data ? { left: refundLeft(doc, back), count: back.length } : null);
    setCancelled(c.data ? { reason: (c.data as any).reason } : null);
    setCredited(creditedTotals(((cr.data ?? []) as any[]).map((x) => ({ docType: x.doc_type, total: Number(x.total), baseDocType: x.base_doc_type, baseDocNumber: Number(x.base_doc_number) }))).get(`${doc.docType}:${doc.docNumber}`) ?? 0);
    setRecv(rv.data ? toReceivable(rv.data) : null);
    const rows = ((al.data ?? []) as any[]).map(toAllocationRow);
    // the rule is the database's (allocation_required, 2.119); before migration 6900 — the rule rows, read here as before
    const st = ds.ok ? ds.state : null;
    setDelivery(st);
    setAlloc({ rows, state: allocationState(rows, st ? needFromState(st) : allocationNeed(doc, { entityType: doc.issuer?.entityType ?? settings.entity }, rules)) });
  }, [doc, settings.entity]);
  useEffect(() => { void load(); }, [load]);

  const allocLine = alloc ? allocationPrintLine(alloc.state) : null;
  // the screen's preview: what the next delivery will be (2.119: any delivery — a print, the link, a PDF — not only a print)
  const delivered = wasDelivered(doc, delivery);
  const html = useMemo(() => docBody({ ...doc, cancelled: Boolean(cancelled) } as DocRow, business, previewMark(doc, delivery), { allocation: allocLine }),
    [doc, business, allocLine, cancelled, delivered, delivery]);
  const awaiting = Boolean(delivery?.allocation.awaiting);
  const deposit = isDepositDoc(doc);
  const fullyCredited = credited > 0 && Math.round(credited * 100) >= Math.round(doc.total * 100);

  async function print() {
    const r = await printDocRow(doc, business);
    if (!r.ok) { fail(r.message); void load(); return; }
    setDoc(r.doc); onChanged(); void load();
  }
  async function pdf() {
    const e = await staffPdf(doc);
    if (e) fail(e);
    void load();
  }
  // 2.119: a WhatsApp message with the link is not a delivery (opening the link is — recorded by the server); a document waiting
  // for its allocation number is not sent at all
  async function share() {
    const url = `${window.location.origin}/d/${doc.shareToken}`;
    const link = waLink(doc.customerPhone ?? '', `שלום${doc.customerName ? ` ${doc.customerName.split(' ')[0]}` : ''}, מצורף ${DOC_LABEL[doc.docType]} מס׳ ${docNumberLabel(doc)} (${ils(doc.total)}): ${url}`);
    if (!link) {
      const e = await linkMayGo(doc.id);
      if (e) { fail(e); return; }
      void navigator.clipboard?.writeText(url); say('הקישור הועתק'); return;
    }
    const e = await sendDocLink(doc.id, link);
    if (e) { fail(e); return; }
    void logEvent('document.sent', 'documents', doc.id, { type: doc.docType, number: doc.docNumber, channel: 'whatsapp' });
  }
  const afterIssue = (d: DocRow, label: string) => {
    if (d.leadId) {
      addActivity(d.leadId, 'note', label);
      if (d.docType === 330) { const l = useApp.getState().leads.find((x) => x.id === d.leadId); if (l) updateLead(l.id, { value: Math.max(0, Math.round(((l.value ?? 0) - d.total) * 100) / 100) }); }
    }
    say(label); setDialog(null); onChanged(); void load(); void goods.reload();
  };
  const ga = goodsActions(doc, goods.state, Boolean(cancelled), settings.entity);

  return (
    <Modal open onClose={onClose} wide>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-display text-xl font-extrabold">{DOC_LABEL[doc.docType]} {docNumberLabel(doc)}</h3>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {cancelled && <Pill tone="bad">בוטל · {cancelled.reason}</Pill>}
            {credited > 0 && <Pill tone={fullyCredited ? 'bad' : 'warn'}>{fullyCredited ? 'זוכתה' : `זוכתה חלקית (${ils(credited)})`}</Pill>}
            {isRefundReceipt(doc) && <Pill tone="warn">החזר כספי{doc.baseDocNumber ? ` על קבלה ${docNumberLabel(doc.baseDocNumber)}` : ''}</Pill>}
            {refunded && refunded.count > 0 && <Pill tone={refunded.left <= 0 ? 'bad' : 'warn'}>{refunded.left <= 0 ? 'הוחזרה במלואה' : `הוחזר חלק (נשארו ${ils(refunded.left)})`}</Pill>}
            {recv && !recv.cancelled && <Pill tone={recv.balance <= 0 ? 'ok' : 'warn'}>{recv.balance <= 0 ? 'שולם' : `יתרה ${ils(recv.balance)}`}</Pill>}
            {alloc?.state.kind === 'real' && <Pill tone="ok">מספר הקצאה {alloc.state.number}{alloc.state.manual ? ' (ידני)' : ''}</Pill>}
            {alloc?.state.kind === 'test' && <Pill tone="info">מספר בדיקה — לא אמיתי</Pill>}
            {alloc?.state.kind === 'missing' && <Pill tone="bad">{awaiting ? 'ממתין למספר הקצאה' : 'חסר מספר הקצאה'}</Pill>}
            {goods.state?.invoices.map((x) => <Pill key={`i${x.docNumber}`} tone="ok">חויבה: {DOC_LABEL[x.docType]} {docNumberLabel(x)}</Pill>)}
            {goods.state?.deliveries.map((x) => <Pill key={`d${x.docNumber}`} tone="info">תעודת משלוח {docNumberLabel(x)}</Pill>)}
            {goods.state?.returns.map((x) => <Pill key={`r${x.docNumber}`} tone="warn">תעודת החזרה {docNumberLabel(x)}</Pill>)}
          </div>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      <div className="max-h-[50vh] overflow-auto rounded-xl bg-white p-2 text-black" dangerouslySetInnerHTML={{ __html: html }} />
      <div className="mt-3 flex flex-wrap gap-2">
        {/* 2.120 (migration 7000): a bank deposit's document (420) is the business's own — never delivered (no original, no link,
            no PDF to a customer) and cancelled only with its deposit (קופות ← הפקדות) */}
        {!deposit && <Button variant="primary" disabled={awaiting} onClick={() => void print()}>{delivered ? 'הדפסת העתק' : 'הדפסת מקור'}</Button>}
        {!deposit && (doc.shareToken || delivery) && <Button variant="ghost" disabled={awaiting} title="קובץ PDF למסירה ללקוח — נרשם כמסירה (הראשונה: מקור)" onClick={() => void pdf()}>📄 PDF</Button>}
        {!deposit && doc.shareToken && <Button variant="ghost" disabled={awaiting} onClick={() => void share()}>💬 שליחה ללקוח</Button>}
        {recv && !recv.cancelled && recv.balance > 0 && <Button variant="ghost" onClick={() => setDialog('receipt')}>קבלה על תשלום</Button>}
        {recv && !recv.cancelled && !cancelled && recv.balance > 0 && links.ready && links.links && (
          <PaylinkButton kind="document" target={doc.id} what={`${DOC_LABEL[doc.docType]} ${docNumberLabel(doc)}${doc.customerName ? ` · ${doc.customerName}` : ''}`}
            left={Math.max(0, Math.round((recv.balance - heldBy(links.links)) * 100) / 100)}
            customer={{ name: doc.customerName ?? '', phone: doc.customerPhone ?? '', email: doc.customerEmail ?? '' }} onSent={() => void links.reload()}
            blocked={awaiting ? AWAITING_STAFF : null} blockedNote={AWAITING_SHORT} />
        )}
        {vat && (doc.docType === 305 || doc.docType === 320) && !fullyCredited && <Button variant="ghost" onClick={() => setDialog('credit')}>חשבונית זיכוי</Button>}
        {/* 2.121 (answer 19): a tax invoice from a transaction invoice — once the database's link is known (TAX_FROM_300_LINK) */}
        {TAX_FROM_300_LINK && vat && doc.docType === 300 && !cancelled && taxed === false && <Button variant="ghost" onClick={() => setDialog('tax300')}>הפקת חשבונית מס</Button>}
        {ga.canDeliver && <Button variant="ghost" onClick={() => setDialog('deliver')}>תעודת משלוח מההזמנה</Button>}
        {ga.canInvoice && <Button variant={doc.docType === 200 ? 'primary' : 'ghost'} onClick={() => setDialog('invoice')}>{doc.docType === 200 ? 'הפקת חשבונית' : 'חשבונית מההזמנה'}</Button>}
        {ga.canReturn && <Button variant="ghost" onClick={() => setDialog('return')}>תעודת החזרה</Button>}
        {/* 2.118 (the accountant's answer 8): a receipt (400) is never cancelled by marking — only 300 and the goods documents */}
        {(doc.docType === 300 || isGoods(doc.docType)) && !cancelled && !doc.saleId
          && !(goods.state && (goods.state.invoices.length || goods.state.deliveries.length || goods.state.returns.length))
          && <Button variant="ghost" onClick={() => setDialog('cancel')}>ביטול מסמך</Button>}
        {/* 2.118 (answer 15): an exempt dealer gives money back on a receipt with a refund receipt (a receipt below zero) */}
        {doc.docType === 400 && !isRefundReceipt(doc) && settings.entity === 'exempt_dealer' && !cancelled && !doc.saleId && refunded && refunded.left > 0
          && <Button variant="ghost" onClick={() => setDialog('refund')}>החזר כספי</Button>}
      </div>
      {/* a register sale's document is cancelled / refunded with its sale (money and stock come back with it) */}
      {doc.docType === 300 && !cancelled && doc.saleId && <p className="mt-2 text-xs text-muted">המסמך הופק ממכירה בקופה — מבטלים אותו מהעסקה עצמה (קופה ← מכירות ודוחות), כדי שגם הכסף והמלאי יחזרו.</p>}
      {doc.docType === 400 && !isRefundReceipt(doc) && !cancelled && doc.saleId && <p className="mt-2 text-xs text-muted">הקבלה הופקה ממכירה (בקופה או באתר) — החזר כספי עושים מהעסקה עצמה (קופה ← מכירות ודוחות, או דף ההזמנה), כדי שגם המלאי יחזור. שם תופק הקבלה במינוס.</p>}
      {doc.docType === 400 && !isRefundReceipt(doc) && !cancelled && doc.saleId && settings.entity === 'exempt_dealer' && (
        <SaleReceiptsDue key={`${doc.id}:${refunded?.count ?? 0}`} doc={doc} onIssued={(d) => afterIssue(d, `הופקה קבלה במינוס (החזר כספי) מס׳ ${docNumberLabel(d)} · ${ils(-d.total)}`)} />
      )}
      {alloc && (alloc.state.kind === 'missing' || alloc.state.kind === 'error' || alloc.state.kind === 'test') && (
        <section aria-label="מספר הקצאה" className={`mt-3 grid gap-2 rounded-2xl border p-3 text-sm ${awaiting ? 'border-red-500/50' : 'border-line'}`}>
          {awaiting && <p role="status" className="font-bold">{AWAITING_STAFF}</p>}
          <p><strong>מספר הקצאה:</strong> {alloc.state.kind === 'missing' ? alloc.state.reason : alloc.state.kind === 'error' ? `הבקשה האחרונה נכשלה — ${alloc.state.message}` : 'יש רק מספר בדיקה (סביבת בדיקות).'}
            {alloc.state.kind === 'missing' && !alloc.state.verified && <span className="block text-xs text-muted">הסף נלקח ממקורות משניים ולא אומת מול פרסום רשמי — לאשר עם רו״ח.</span>}</p>
          {/* the owner, 26.11.2026: no connection to the Tax Authority yet — the number is asked for in the Tax Authority's own system
              and typed in here (the request from here, /api/finance/allocations, waits for the connection) */}
          <p className="text-xs text-muted">מבקשים את המספר במערכת של רשות המסים (באזור האישי) ומזינים אותו כאן. {WRONG_NUMBER_NOTE}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={awaiting ? 'primary' : 'ghost'} onClick={() => setDialog('manual')}>הזנת מספר שהתקבל</Button>
          </div>
        </section>
      )}
      {alloc?.state.kind === 'real' && <p className="mt-2 text-xs text-muted">{WRONG_NUMBER_NOTE}</p>}
      {links.links && <PaylinkList links={links.links} showLabel={false} onChanged={() => { void links.reload(); void load(); onChanged(); }} />}
      {/* 2.89: a payment plan of what is owed (its payments: each with its own date, in "חייבים" and in the reminders) */}
      {recv && !recv.cancelled && !cancelled && (
        <PlanSection key={`${doc.id}:${recv.balance}`} documentId={doc.id} balance={recv.balance} what={`${DOC_LABEL[doc.docType]} ${docNumberLabel(doc)}${doc.customerName ? ` · ${doc.customerName}` : ''}`}
          canPlan say={say} onChanged={() => { void load(); onChanged(); }}
          linkProps={recv.balance > 0 && links.ready && links.links ? {
            kind: 'document', target: doc.id, what: `${DOC_LABEL[doc.docType]} ${docNumberLabel(doc)}${doc.customerName ? ` · ${doc.customerName}` : ''}`,
            left: Math.max(0, Math.round((recv.balance - heldBy(links.links)) * 100) / 100),
            customer: { name: doc.customerName ?? '', phone: doc.customerPhone ?? '', email: doc.customerEmail ?? '' }, onSent: () => void links.reload(),
            blocked: awaiting ? AWAITING_STAFF : null, blockedNote: AWAITING_SHORT,
          } : null} />
      )}
      {(doc.docType === 305 || doc.docType === 300) && <DocReminders documentId={doc.id} />}
      {deposit && <p className="mt-2 text-xs text-muted">{DEPOSIT_DOC_NOTE}</p>}
      {!deposit && <p className="mt-2 text-xs text-muted">{isGoods(doc.docType)
        ? 'המערכת לא מאפשרת לשנות או למחוק מסמך שהופק. אם הופק בטעות — מבטלים אותו (עם סיבה), כל עוד לא הופק ממנו מסמך אחר.'
        : doc.docType === 400
          ? 'המערכת לא מאפשרת לשנות, למחוק או לבטל קבלה שהופקה. כסף שהוחזר — בקבלה במינוס ("החזר כספי", עוסק פטור) או בחשבונית זיכוי (עסק שגובה מע״מ).'
          : 'המערכת לא מאפשרת לשנות או למחוק מסמך שהופק. תיקון — בחשבונית זיכוי (חשבונית מס) או בביטול (חשבונית עסקה, נרשם עם סיבה).'}</p>}

      {dialog === 'receipt' && recv && <ReceiptDialog doc={doc} balance={recv.balance} onClose={() => setDialog(null)} onIssued={(d) => afterIssue(d, `הופקה ${DOC_LABEL[d.docType]} מס׳ ${docNumberLabel(d)} · ${ils(d.total)}`)} />}
      {dialog === 'tax300' && TAX_FROM_300_LINK && <TaxFrom300Dialog doc={doc} link={TAX_FROM_300_LINK} onClose={() => setDialog(null)}
        onIssued={(d) => { setTaxed(true); afterIssue(d, `הופקה חשבונית מס מס׳ ${docNumberLabel(d)} · ${ils(d.total)} — על ${DOC_LABEL[300]} ${docNumberLabel(doc)}`); }} />}
      {dialog === 'credit' && <CreditDialog doc={doc} credited={credited} onClose={() => setDialog(null)} onIssued={(d) => afterIssue(d, `הופקה חשבונית מס זיכוי מס׳ ${docNumberLabel(d)} · ${ils(d.total)}`)} />}
      {dialog === 'refund' && refunded && <RefundReceiptDialog doc={doc} left={refunded.left} count={refunded.count} onClose={() => setDialog(null)}
        onIssued={(d) => afterIssue(d, `הופקה קבלה במינוס (החזר כספי) מס׳ ${docNumberLabel(d)} · ${ils(-d.total)}`)} />}
      {dialog === 'cancel' && <CancelDialog doc={doc} userId={userId} onClose={() => setDialog(null)} onDone={() => afterIssue(doc, `${DOC_LABEL[doc.docType]} מס׳ ${docNumberLabel(doc)} בוטל/ה`)} />}
      {dialog === 'manual' && <ManualAllocation doc={doc} onClose={() => setDialog(null)} onDone={() => { setDialog(null); say('מספר ההקצאה נשמר'); void load(); }} />}
      {goods.state && dialog === 'deliver' && <FromBaseDialog base={doc} targets={[200]} left={goods.state.left} title="תעודת משלוח מההזמנה" onClose={() => setDialog(null)}
        onIssued={(d) => afterIssue(d, `הופקה תעודת משלוח מס׳ ${docNumberLabel(d)}`)} />}
      {goods.state && dialog === 'invoice' && <FromBaseDialog base={doc} targets={ga.invoiceTargets} left={goods.state.left} fixedQty={doc.docType === 200}
        title={doc.docType === 200 ? 'חשבונית מתעודת המשלוח' : 'חשבונית מההזמנה'} onClose={() => setDialog(null)}
        onIssued={(d) => afterIssue(d, `הופקה ${DOC_LABEL[d.docType]} מס׳ ${docNumberLabel(d)} · ${ils(d.total)}`)} />}
      {goods.state && dialog === 'return' && <FromBaseDialog base={doc} targets={[210]} left={goods.state.left} title="תעודת החזרה" onClose={() => setDialog(null)}
        onIssued={(d) => afterIssue(d, `הופקה תעודת החזרה מס׳ ${docNumberLabel(d)}`)} />}
    </Modal>
  );
}

/** 2.121 (answer 19): was a tax invoice issued on this 300 — a 305 linked to it (by the database's link) or a 320 that paid it */
async function taxedAlready(doc: DocRow, link: TaxFrom300Link): Promise<boolean | null> {
  const sb = supabase();
  const [t, p] = await Promise.all([
    link === 'base'
      ? sb.from('documents').select('id', { count: 'exact', head: true }).eq('doc_type', 305).eq('base_doc_type', 300).eq('base_doc_number', doc.docNumber)
      : sb.from('documents').select('id', { count: 'exact', head: true }).eq('doc_type', 305).eq('paid_document_id', doc.id),
    sb.from('documents').select('id', { count: 'exact', head: true }).eq('doc_type', 320).eq('paid_document_id', doc.id),
  ]);
  if (t.error || p.error) return null;           // not known — the button is not offered
  return (t.count ?? 0) + (p.count ?? 0) > 0;
}

/** 2.121 (answer 19): the tax invoice (305) of a transaction invoice (300) — its lines and amounts as they are, linked to it */
function TaxFrom300Dialog({ doc, link, onClose, onIssued }: { doc: DocRow; link: TaxFrom300Link; onClose: () => void; onIssued: (d: DocRow) => void }) {
  const { userId, settings } = useFinance();
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const preview = composeTaxFrom300(doc, { entity: settings.entity, vatRate: settings.vatRate, docDate: todayIL(), link });
  async function go() {
    const now = todayIL();   // the document's day — taken at issue
    const r = composeTaxFrom300(doc, { entity: settings.entity, vatRate: settings.vatRate, docDate: now, link });
    if (!r.ok) { setErrors(r.errors); return; }
    setBusy(true);
    const out = await issueDocumentRow(documentRow(r.doc, { userId, idempotencyKey: taxFrom300Key(doc.id), vatRate: r.totals.vatRate, leadId: doc.leadId ?? null,
      ...taxFrom300Extra(link, doc.id) }));
    setBusy(false);
    if (!out.ok) { setErrors([out.error]); return; }
    onIssued(out.doc);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">חשבונית מס על {DOC_LABEL[300]} {docNumberLabel(doc)}</h3>
      <p className="mb-3 text-sm text-muted">תופק חשבונית מס עם אותן שורות ואותם סכומים, ללקוח של חשבון העסקה, בתאריך של היום. היא סוגרת את חשבון העסקה — הלקוח מחויב פעם אחת.</p>
      {preview.ok && <p className="mb-2 text-sm">סה״כ: <strong>{ils(preview.doc.total)}</strong>{preview.doc.vatAmount ? ` (מתוכו מע״מ ${ils(preview.doc.vatAmount)})` : ''} · {preview.doc.lines.length} שורות</p>}
      {(!preview.ok || errors.length > 0) && <Note tone="warn">{(errors.length ? errors : !preview.ok ? preview.errors : []).map((e) => <span key={e} className="block">{e}</span>)}</Note>}
      <div className="mt-4 flex gap-2"><Button variant="primary" disabled={busy || !preview.ok} onClick={() => void go()}>{busy ? 'מפיק…' : 'הפקת חשבונית מס'}</Button><Button variant="ghost" onClick={onClose}>ביטול</Button></div>
    </Modal>
  );
}

/** payment of an open 305 / 300: a receipt (400), or a 320 for a VAT business's transaction invoice */
export function ReceiptDialog({ doc, balance, onClose, onIssued }: { doc: DocRow; balance: number; onClose: () => void; onIssued: (d: DocRow) => void }) {
  const { userId, settings } = useFinance();
  const today = todayIL();
  const [payments, setPayments] = useState<PaymentEntry[]>([{ method: 'transfer', amount: balance, date: today }]);
  // 2.94: tax withheld at source — once migration 20261011004900 is in the database
  const withholdingOk = useReportsReady();
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // the key of this payment is the invoice's next receipt: two devices paying it at once share it — one receipt only
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void supabase().from('documents').select('id', { count: 'exact', head: true }).eq('paid_document_id', doc.id)
      .then(({ count, error }) => { if (alive) { if (error) setErrors([financeError(error)]); else setKey(followKey('receipt', doc.id, count ?? 0)); } });
    return () => { alive = false; };
  }, [doc.id]);
  async function go() {
    if (!key) return;
    const now = todayIL();   // the document's day — taken at issue, not when the dialog opened
    const r = composeReceipt({ ...doc, balance }, { entity: settings.entity, vatRate: settings.vatRate, payments, docDate: now, today: now });
    if (!r.ok) { setErrors(r.errors); return; }
    setBusy(true);
    const out = await issueDocumentRow(documentRow(r.doc, { userId, idempotencyKey: key, vatRate: r.totals.vatRate, leadId: doc.leadId ?? null, paidDocumentId: doc.id }));
    setBusy(false);
    if (!out.ok) { setErrors([out.error]); return; }
    if (out.again && Math.round(out.doc.total * 100) !== Math.round(r.doc.total * 100)) {
      setErrors(['כבר הופקה קבלה על החשבונית הזו, כנראה ממכשיר אחר. סגרו ופתחו שוב כדי לראות את היתרה המעודכנת.']); return;
    }
    onIssued(out.doc);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">תשלום על {DOC_LABEL[doc.docType]} {docNumberLabel(doc)}</h3>
      <p className="mb-3 text-sm text-muted">יתרה לתשלום: {ils(balance)}. רישום תשלום שהתקבל — לא סליקה; שום כרטיס לא מחויב כאן.</p>
      <PaymentsEditor payments={payments} onChange={setPayments} total={payments.reduce((a, p) => a + (p.amount || 0), 0)} today={today} withholding={withholdingOk} />
      {errors.length > 0 && <div className="mt-3"><Note tone="warn">{errors.map((e) => <span key={e} className="block">{e}</span>)}</Note></div>}
      <div className="mt-4 flex gap-2"><Button variant="primary" disabled={busy || !key} onClick={() => void go()}>{busy ? 'מפיק…' : 'הפקת קבלה'}</Button><Button variant="ghost" onClick={onClose}>ביטול</Button></div>
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
  // the key is the invoice's next credit: two devices crediting it at once share it — one credit invoice only
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void supabase().from('documents').select('id', { count: 'exact', head: true }).eq('doc_type', 330).eq('base_doc_type', doc.docType).eq('base_doc_number', doc.docNumber)
      .then(({ count, error }) => { if (alive) { if (error) setErrors([financeError(error)]); else setKey(followKey('credit', doc.id, count ?? 0)); } });
    return () => { alive = false; };
  }, [doc.id, doc.docType, doc.docNumber]);
  const mode: CreditMode = kind === 'full' ? { kind } : kind === 'amount' ? { kind, amount } : { kind, qty, restock };
  const preview = composeCredit(doc, mode, credited, today, { reason, today });
  async function go() {
    if (!key) return;
    // the document's day — taken at issue, not when the dialog opened
    const now = todayIL();
    const fresh = composeCredit(doc, mode, credited, now, { reason, today: now });
    if (!fresh.ok) { setErrors(fresh.errors); return; }
    if (!window.confirm(`להפיק חשבונית מס זיכוי על ${ils(fresh.doc.total)}? החשבונית המקורית נשארת כמו שהיא.`)) return;
    setBusy(true);
    const out = await issueDocumentRow(documentRow(fresh.doc, { userId, idempotencyKey: key, vatRate: fresh.totals.vatRate, leadId: doc.leadId ?? null, saleId: doc.saleId }));
    if (!out.ok) { setBusy(false); setErrors([out.error]); return; }
    if (out.again && Math.round(out.doc.total * 100) !== Math.round(fresh.doc.total * 100)) {
      setBusy(false); setErrors(['כבר הופקה חשבונית זיכוי על החשבונית הזו, כנראה ממכשיר אחר. סגרו ופתחו שוב כדי לראות כמה נשאר לזכות.']); return;
    }
    if (refund.on && !out.again) {
      const { error } = await supabase().rpc('record_credit_refund', { p_document: out.doc.id, p_method: refund.method, p_amount: out.doc.total, p_paid_on: now, p_note: reason.slice(0, 300) });
      if (error) fail(`חשבונית הזיכוי הופקה, אבל ההחזר לא נרשם: ${financeError(error)}`);
    }
    setBusy(false); onIssued(out.doc);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">חשבונית זיכוי על {DOC_LABEL[doc.docType]} {docNumberLabel(doc)}</h3>
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
      <div className="mt-3 flex gap-2"><Button variant="primary" disabled={busy || !preview.ok || !key} onClick={() => void go()}>{busy ? 'מפיק…' : 'הפקת חשבונית זיכוי'}</Button><Button variant="ghost" onClick={onClose}>ביטול</Button></div>
    </Modal>
  );
}

/**
 * 2.118 — an exempt dealer's money back on a receipt (the accountant's answer 15): a refund receipt (a 400 below zero) on it,
 * never beyond what is left (the database checks again, in a lock). Its key is the receipt's next refund (followKey 'refund' —
 * two devices at once share it: one refund receipt). How the money went back is asked as any payment (a card — with its kind).
 * The money out is the refund receipt's own (the database writes it); nothing goes back to stock from here (a count does that).
 */
function RefundReceiptDialog({ doc, left, count, onClose, onIssued }: { doc: DocRow; left: number; count: number; onClose: () => void; onIssued: (d: DocRow) => void }) {
  const { userId, settings } = useFinance();
  const today = todayIL();
  const first = doc.payments.find((p) => p.m !== 'withholding');
  const [payments, setPayments] = useState<PaymentEntry[]>([{ method: (first?.m && PAY_METHODS.some((m) => m.id === first.m) ? first.m : 'cash') as PayMethod, amount: left, date: today }]);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const key = followKey('refund', doc.id, count);
  async function go() {
    const r = composeRefundReceipt(doc, { entity: settings.entity, left, payments: payments.map((p) => ({ ...p, date: todayIL() })), docDate: todayIL(), today: todayIL(), notes: reason });
    if (!r.ok) { setErrors(r.errors); return; }
    if (!window.confirm(`להפיק קבלה במינוס (החזר כספי) על ${ils(-r.doc.total)}? הקבלה המקורית נשארת כמו שהיא.`)) return;
    setBusy(true);
    const out = await issueDocumentRow(documentRow(r.doc, { userId, idempotencyKey: key, vatRate: 0, leadId: doc.leadId ?? null, source: 'refund' }));
    setBusy(false);
    if (!out.ok) { setErrors([refundReceiptError(out.raw ?? out.error)]); return; }
    if (out.again && Math.round(out.doc.total * 100) !== Math.round(r.doc.total * 100)) {
      setErrors(['כבר הופקה קבלה במינוס על הקבלה הזו, כנראה ממכשיר אחר. סגרו ופתחו שוב כדי לראות כמה נשאר להחזיר.']); return;
    }
    onIssued(out.doc);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">החזר כספי על קבלה {docNumberLabel(doc)}</h3>
      <p className="mb-3 text-sm text-muted">תופק קבלה במינוס על הכסף שהוחזר ללקוח (עוסק פטור). אפשר להחזיר עד {ils(left)}. רישום החזר שנעשה — לא העברת כסף; שום כרטיס לא מזוכה כאן.</p>
      <PaymentsEditor payments={payments} onChange={setPayments} total={payments.reduce((a, p) => a + (p.amount || 0), 0)} today={today} installments={false} />
      <Field label="סיבה (מופיעה על המסמך, לא חובה)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-14" /></Field>
      {errors.length > 0 && <div className="mt-3"><Note tone="warn">{errors.map((e) => <span key={e} className="block">{e}</span>)}</Note></div>}
      <div className="mt-4 flex gap-2"><Button variant="primary" disabled={busy} onClick={() => void go()}>{busy ? 'מפיק…' : 'הפקת קבלה במינוס'}</Button><Button variant="ghost" onClick={onClose}>ביטול</Button></div>
    </Modal>
  );
}

/**
 * 2.118: a sale's receipt whose refund receipt did not go out when the sale was cancelled or refunded (the database refused it before
 * migration 6800, or the answer was lost) — completed here, on the same key the register used (cancel:<sale> / refund:<refund id>),
 * so it can never be issued twice. The builders are the register's own (sale-receipts.ts).
 */
function SaleReceiptsDue({ doc, onIssued }: { doc: DocRow; onIssued: (d: DocRow) => void }) {
  const { userId } = useFinance();
  const [due, setDue] = useState<{ sale: any; refunds: any[]; allRefunds: any[]; cancel: boolean; docs: DocRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const sb = supabase();
    const [sl, rf, ds] = await Promise.all([
      sb.from('sales').select('*').eq('id', doc.saleId!).maybeSingle(),
      sb.from('sale_refunds').select('*').eq('sale_id', doc.saleId!),
      sb.from('documents').select('*').eq('sale_id', doc.saleId!).order('issued_at'),
    ]);
    if (sl.error || rf.error || ds.error || !sl.data) { setDue(null); return; }
    const docs = ((ds.data ?? []) as any[]).map(toDoc);
    const m = missingSaleReceipts({ saleStatus: sl.data.status, refunds: (rf.data ?? []) as any[], docs, receiptCancelled: false });
    setDue({ sale: sl.data, refunds: m.refunds, allRefunds: (rf.data ?? []) as any[], cancel: m.cancel, docs });
  }, [doc.saleId]);
  useEffect(() => { void load(); }, [load]);
  if (!due || (!due.refunds.length && !due.cancel)) return null;
  async function go() {
    if (!due) return;
    setBusy(true); setError(null);
    const today = todayIL();
    const sale = saleFromRow(due.sale);
    const allRefunds = (due.allRefunds ?? []) as any[];
    let docs = due.docs;
    let last: DocRow | null = null;
    let stop: string | null = null;
    // the refunds first, in order; the cancellation only once every refund before it has its refund receipt — never the same money twice
    for (const r of due.refunds.map(toRefund)) {
      const back = refundReceiptDoc(doc, docs, r, sale, today);
      if (!back) { stop = `ההחזר של ${ils(r.amount)} גדול ממה שנשאר על הקבלה — לא הופקה קבלה במינוס. לבירור עם רואה החשבון.`; break; }
      const out = await issueDocumentRow(documentRow(back, { userId, idempotencyKey: `refund:${r.id}`, vatRate: 0, saleId: sale.id, leadId: sale.leadId, refundId: r.id, source: 'refund' }));
      if (!out.ok) { stop = refundReceiptError(out.raw ?? out.error); break; }
      docs = [...docs, out.doc]; last = out.doc;
    }
    if (!stop && due.cancel) {
      const back = cancelReceiptDoc(doc, docs, today, allRefunds.map((r) => ({ amount: Number(r.amount) })));
      if (back) {
        const out = await issueDocumentRow(documentRow(back, { userId, idempotencyKey: `cancel:${sale.id}`, vatRate: 0, saleId: sale.id, leadId: sale.leadId, source: 'refund' }));
        if (!out.ok) stop = refundReceiptError(out.raw ?? out.error); else last = out.doc;
      } else if (!last) stop = 'אין מה להשלים: על הקבלה לא נשאר כסף להחזיר.';
    }
    setBusy(false);
    // stopped: the reason stays on screen (what was issued before it is kept — the box shows what is still missing)
    if (stop) { setError(stop); if (last) void load(); return; }
    if (last) onIssued(last); else setError('אין מה להשלים.');
  }
  // each refund with its day: the refund receipt is dated today (answer 16) — the owner sees what it is for before issuing it
  const what = [...(due.cancel ? ['המכירה בוטלה בקופה'] : []),
    ...due.refunds.map((r) => `החזר של ${ils(Number(r.amount))} מתאריך \u200e${r.created_at ? israelParts(Date.parse(r.created_at)).date.split('-').reverse().join('/') : ''}`)];
  return (
    <div className="mt-3 grid gap-2 rounded-2xl border border-line p-3 text-sm">
      <p><strong>חסרה קבלה במינוס:</strong> {what.join(' · ')} — והקבלה במינוס לא הופקה אז. היא תופק בתאריך של היום.</p>
      {error && <Note tone="warn">{error}</Note>}
      <div><Button size="sm" variant="primary" disabled={busy} onClick={() => void go()}>{busy ? <Spinner /> : 'הפקת הקבלה במינוס'}</Button></div>
    </div>
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
      <h3 className="mb-1 font-display text-lg font-extrabold">ביטול {DOC_LABEL[doc.docType]} {docNumberLabel(doc)}</h3>
      <p className="mb-3 text-sm text-muted">המסמך נשאר כמו שהוא ומסומן "בוטל" (גם בממשק הפתוח). {!doc.saleId && doc.docType !== 100 && doc.lines.some((l) => l.itemId) ? (doc.docType === 210 ? 'הפריטים שחזרו בה יוצאים שוב מהמלאי.' : 'המוצרים שבו חוזרים למלאי.') : ''} רק אם הופק בטעות.</p>
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
      {/* the accountant's answer 4 (as decided 25.11.2026): a recorded number never changes — tax_allocations is append-only */}
      <div className="mb-3"><Note>בדקו את המספר לפני השמירה: אחרי השמירה אי אפשר לשנות או למחוק אותו. {WRONG_NUMBER_NOTE}</Note></div>
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
