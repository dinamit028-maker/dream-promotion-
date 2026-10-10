'use client';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Button, Chip } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { waLink } from '@/features/crm/crm';
import { DOC_LABEL } from '@/features/documents/documents';
import { useFinance } from './FinanceScreen';
import { Composer, type ComposerMode } from './Composer';
import { financeError, logEvent } from './api';
import { computeLines } from './compose';
import { invoiceDocType } from './rules';
import { QUOTE_STATUS_HE, canMove, editable, quoteMessage, quoteState, toQuote, type ComposerBody, type Quote, type QuoteStatus } from './quotes';
import { Note, Pill, ddmmyyyy, ils, todayIL } from './ui';
import { PaylinkButton, PaylinkList, heldBy, usePaylinks } from './Paylinks';

/**
 * "הצעות מחיר": numbered per business, sent to the customer as a private link (WhatsApp), accepted / rejected by the
 * business or by the customer on that link, and converted into a document draft (305 / 300) — the quote becomes
 * "converted" when that document is issued (the database marks it, in the same transaction).
 */
const STATUS_TONE: Record<QuoteStatus, 'default' | 'ok' | 'warn' | 'bad' | 'info'> = { draft: 'default', sent: 'info', accepted: 'ok', rejected: 'bad', expired: 'warn', converted: 'ok', cancelled: 'bad' };

export function Quotes() {
  const { params, clearParams, fail, say, settings } = useFinance();
  const leads = useApp((s) => s.leads);
  const [list, setList] = useState<Quote[] | null>(null);
  const [filter, setFilter] = useState<QuoteStatus | 'open' | 'all'>('open');
  const [open, setOpen] = useState<Quote | null>(null);
  const [composer, setComposer] = useState<{ mode: ComposerMode; initial?: Partial<ComposerBody> & { leadId?: string | null } } | null>(null);
  const today = todayIL();

  const load = useCallback(async () => {
    let q = supabase().from('quotes').select('*').order('created_at', { ascending: false }).limit(200);
    if (filter === 'open') q = q.in('status', ['draft', 'sent', 'accepted']);
    else if (filter !== 'all') q = q.eq('status', filter);
    const { data, error } = await q;
    if (error) { fail(financeError(error)); setList([]); return; }
    setList(((data ?? []) as any[]).map(toQuote));
  }, [filter, fail]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!params.get('new')) return;
    const lead = params.get('lead') ? leads.find((l) => l.id === params.get('lead')) : undefined;
    setComposer({ mode: { kind: 'quote' }, initial: lead ? { leadId: lead.id, customer: { name: lead.billingName || lead.name, phone: lead.phone, email: lead.email, dealer: lead.billingDealer, street: lead.billingStreet, city: lead.billingCity } } : undefined });
    clearParams();
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setComposer({ mode: { kind: 'quote' } })}>+ הצעת מחיר</Button>
      </div>
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        {(['open', 'all', 'converted', 'rejected', 'cancelled'] as const).map((f) => (
          <Chip key={f} on={filter === f} onClick={() => setFilter(f)} className="shrink-0">{f === 'open' ? 'פתוחות' : f === 'all' ? 'הכל' : QUOTE_STATUS_HE[f]}</Chip>
        ))}
      </div>
      {list === null ? <div className="py-8 text-center"><Spinner /></div> : !list.length ? <Note>אין הצעות מחיר כאן עדיין.</Note> : (
        <div className="grid gap-1.5">
          {list.map((q) => {
            const st = quoteState(q, today);
            return (
              <button key={q.id} type="button" onClick={() => setOpen(q)} className="flex min-w-0 items-center gap-2 rounded-2xl border border-line bg-surface p-3 text-start text-sm hover:border-primary">
                <span className="min-w-0 flex-1"><strong className="block truncate">הצעה {q.number} · {q.customerName || 'לקוח'}</strong>
                  <span className="text-xs text-muted">{ddmmyyyy(q.createdAt.slice(0, 10))}{q.validUntil ? ` · בתוקף עד ${ddmmyyyy(q.validUntil)}` : ''}</span></span>
                <Pill tone={STATUS_TONE[st]}>{QUOTE_STATUS_HE[st]}</Pill>
                <strong className="tabular-nums">{ils(q.total)}</strong>
              </button>
            );
          })}
        </div>
      )}
      {open && <QuoteView q={open} onClose={() => setOpen(null)} onChanged={async (msg) => { if (msg) say(msg); await load(); }}
        onEdit={() => { setComposer({ mode: { kind: 'quote', quote: open }, initial: { ...open.body, leadId: open.leadId } }); setOpen(null); }}
        onConvert={() => { setComposer({ mode: { kind: 'document', docType: invoiceDocType(settings.entity), quoteId: open.id }, initial: { ...open.body, leadId: open.leadId, notes: `על פי הצעת מחיר מס׳ ${open.number}` } }); setOpen(null); }} />}
      {composer && <Composer mode={composer.mode} initial={composer.initial} onClose={() => setComposer(null)}
        onDone={async (r) => {
          setComposer(null);
          if (r.kind === 'quote') {
            await load();
            const { data } = await supabase().from('quotes').select('*').eq('id', r.id).single();
            const q = data ? toQuote(data) : null;
            // WhatsApp goes into the window "save and send" opened on the tap (one opened here, after the save, is blocked by phones)
            say(r.sent ? 'ההצעה נשמרה — שולחים ללקוח' : 'ההצעה נשמרה');
            if (q) { setOpen(q); if (r.sent) sendQuote(q, '', r.sentWindow ?? null); } else r.sentWindow?.close();
          } else if (r.kind === 'issued') { say(`הופקה ${DOC_LABEL[r.doc.docType]} מס׳ ${r.doc.docNumber} מההצעה`); await load(); }
          else if (r.kind === 'draft') { say('נשמרה טיוטת מסמך מההצעה (בלשונית מסמכים)'); await load(); }
        }} />}
    </div>
  );
}

/** WhatsApp to the customer — into the window opened on the tap when there is one (w), else a new one; no phone: copy the link */
function sendQuote(q: Quote, business = '', w: Window | null = null) {
  const url = `${window.location.origin}/q/${q.shareToken}`;
  const link = waLink(q.customerPhone, quoteMessage({ name: q.customerName, number: q.number, business: business || String(q.issuer?.name ?? ''), total: ils(q.total), validUntil: q.validUntil, link: url }));
  if (!link) { w?.close(); void navigator.clipboard?.writeText(url); }
  else if (w) { w.opener = null; w.location.href = link; }
  else window.open(link, '_blank', 'noopener');
  void logEvent('quote.sent', 'quotes', q.id, { number: q.number });
}

function QuoteView({ q, onClose, onChanged, onEdit, onConvert }: { q: Quote; onClose: () => void; onChanged: (msg?: string) => Promise<void>; onEdit: () => void; onConvert: () => void }) {
  const { fail, business, vat } = useFinance();
  const st = quoteState(q, todayIL());
  // 2.88: an accepted quote is paid by link (a part too); its first payment makes it its document
  const links = usePaylinks({ quoteId: q.id });
  const lines = computeLines(q.body.lines ?? [], { pricesIncludeVat: q.body.pricesIncludeVat ?? true, discount: q.body.discount, rate: q.vatRate }).lines;
  async function move(to: QuoteStatus, label: string): Promise<boolean> {
    if (!canMove(q.status, to)) return false;
    const { error } = await supabase().from('quotes').update({ status: to, ...(to === 'accepted' || to === 'rejected' ? { decision_by: 'העסק' } : {}) }).eq('id', q.id);
    if (error) { fail(financeError(error)); return false; }
    await onChanged(label); onClose();
    return true;
  }
  async function duplicate() {
    const { userId } = useApp.getState();
    const { error } = await supabase().from('quotes').insert({ user_id: userId, customer_name: q.customerName, customer_phone: q.customerPhone, customer_email: q.customerEmail,
      customer_dealer: q.customerDealer, customer_street: q.customerStreet, customer_city: q.customerCity, lead_id: q.leadId, body: q.body, before_discount: q.beforeDiscount,
      discount: q.discount, after_discount: q.afterDiscount, vat_rate: q.vatRate, vat_amount: q.vatAmount, total: q.total, notes: q.notes, status: 'draft' });
    if (error) { fail(financeError(error)); return; }
    await onChanged('נוצרה הצעה חדשה (עותק)'); onClose();
  }
  return (
    <Modal open onClose={onClose} wide>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div><h3 className="font-display text-xl font-extrabold">הצעת מחיר {q.number}</h3>
          <div className="mt-1 flex flex-wrap gap-1.5"><Pill tone={STATUS_TONE[st]}>{QUOTE_STATUS_HE[st]}</Pill>
            {q.decidedAt && <Pill>{q.decisionBy ? `הוחלט ע״י ${q.decisionBy}` : 'הוחלט'} · {ddmmyyyy(q.decidedAt.slice(0, 10))}</Pill>}</div></div>
        <CloseButton onClick={onClose} />
      </div>
      <div className="rounded-xl border border-line p-3 text-sm">
        <p><strong>{q.customerName || 'לקוח'}</strong>{q.customerDealer ? ` · ע.מ ${q.customerDealer}` : ''}{q.customerPhone ? ` · ${q.customerPhone}` : ''}</p>
        <ul className="my-2 grid gap-1">{lines.map((l, i) => <li key={i} className="flex justify-between gap-2"><span>{l.name} × {l.qty}</span><span className="tabular-nums">{ils(l.totalExVat)}</span></li>)}</ul>
        <div className="border-t border-line pt-2 tabular-nums">
          {q.vatRate > 0 && <div className="flex justify-between"><span>לפני מע״מ</span><span>{ils(q.afterDiscount)}</span></div>}
          {q.vatRate > 0 && <div className="flex justify-between"><span>מע״מ {q.vatRate}%</span><span>{ils(q.vatAmount)}</span></div>}
          <div className="flex justify-between font-black"><span>סה״כ</span><span>{ils(q.total)}</span></div>
        </div>
        {q.validUntil && <p className="mt-2 text-xs text-muted">בתוקף עד {ddmmyyyy(q.validUntil)}</p>}
        {q.decisionNote && <p className="mt-1 text-xs">הערת הלקוח: {q.decisionNote}</p>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {editable(q.status) && <Button variant="ghost" onClick={onEdit}>עריכה</Button>}
        {(q.status === 'draft' || q.status === 'sent' || q.status === 'expired') && <Button variant="primary" onClick={async () => {
          // the window opens on the tap itself; it gets the WhatsApp address once the quote is marked as sent
          const w = q.status === 'sent' ? null : window.open('', '_blank');
          if (q.status !== 'sent' && !(await move('sent', 'ההצעה סומנה כנשלחה'))) { w?.close(); return; }
          sendQuote(q, business.name, w);
        }}>💬 שליחה ללקוח</Button>}
        {q.status === 'sent' && <Button variant="ghost" onClick={() => void move('accepted', 'ההצעה סומנה כמאושרת')}>✓ אושרה</Button>}
        {q.status === 'sent' && <Button variant="ghost" onClick={() => void move('rejected', 'ההצעה סומנה כנדחתה')}>נדחתה</Button>}
        {canMove(q.status, 'converted') && <Button variant="primary" onClick={onConvert}>הפיכה למסמך</Button>}
        {q.status === 'accepted' && links.ready && links.links && (
          <PaylinkButton kind="quote" target={q.id} what={`הצעת מחיר ${q.number}${q.customerName ? ` · ${q.customerName}` : ''}`}
            left={Math.max(0, Math.round((q.total - heldBy(links.links)) * 100) / 100)}
            customer={{ name: q.customerName, phone: q.customerPhone, email: q.customerEmail }} onSent={() => void links.reload()} />
        )}
        {canMove(q.status, 'cancelled') && <Button variant="ghost" onClick={() => window.confirm('לבטל את ההצעה?') && void move('cancelled', 'ההצעה בוטלה')}>ביטול</Button>}
        <Button variant="ghost" onClick={() => void duplicate()}>שכפול</Button>
        <a href={`/q/${q.shareToken}`} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm font-semibold hover:border-primary">כפי שהלקוח רואה</a>
      </div>
      {q.status === 'accepted' && links.ready && <p className="mt-2 text-xs text-muted">תשלום בלינק על הצעה שאושרה מפיק לה מסמך: תשלום מלא — {vat ? 'חשבונית מס / קבלה' : 'קבלה'}; תשלום חלקי — {vat ? 'חשבונית מס' : 'חשבונית עסקה'} וקבלה על החלק ששולם (את היתרה משלמים על החשבונית).</p>}
      {links.links && <PaylinkList links={links.links} showLabel={false} onChanged={() => { void links.reload(); void onChanged(); }} />}
    </Modal>
  );
}
