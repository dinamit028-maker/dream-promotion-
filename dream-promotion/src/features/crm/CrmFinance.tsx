'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { DOC_LABEL } from '@/features/documents/documents';
import { ils } from '@/features/register/money';
import { israelParts } from '@/lib/il-time';
import { QUOTE_STATUS_HE, type QuoteStatus } from '@/features/finance/quotes';
import { orderLabel } from '@/features/store/checkout';
import { orderHref } from '@/features/store/routes';
import { packagesReady } from '@/features/finance/packages-data';
import { SellPackageDialog } from '@/features/finance/SellPackage';
import { PaylinkList, SendPaylinkDialog, heldBy, usePaylinks } from '@/features/finance/Paylinks';
import { loadLines, plansReady } from '@/features/finance/plans-data';
import { LeadReminderStop } from '@/features/finance/Reminders';
import { planLine, scheduleLabel, type RecurringPlan } from '@/features/finance/recurring';
import { loadRecurringPlans, recurringReady } from '@/features/finance/recurring-data';
import { useReportsReady } from '@/features/finance/reports-data';
import { toReceivable } from '@/features/finance/receivables';
import { LEDGER_SOURCE_HE, payLabel, toLedgerRow, type LedgerRow } from '@/features/finance/payments';
import { linkTargets, planRows, type LinkTarget, type PlanRow } from '@/features/finance/card-money';
import { ClientPackages } from './ClientPackages';

/**
 * The money of one contact, on their card — the card's "כספים" (docs/FINANCE_ADDITIONS_HE.md T7): what they still owe and what
 * is late, documents issued to them, open quotes, and "הפקת מסמך" / "הצעת מחיר" straight into the money screens with the
 * customer filled in; (2.57) their orders on the site — computed from orders by lead_id, never kept twice — and (2.88) the
 * payment links sent to them, with their statuses; (2.89) what is late by the payments of a plan, and "לא לשלוח" for the
 * automatic debt reminders; (2.90) their recurring charges. 2.97 (T7): their payments (the ledger), the open payments of their
 * plans, "💳 שליחת לינק לתשלום" on an open invoice or an accepted quote, and their packages in the same box — always shown, with
 * their warnings (ClientPackages), even while the rest is closed. Loaded only when opened; row-level security decides what is
 * visible (a cashier never opens the CRM; a closed business shows nothing).
 */
interface Row { id: string; type: number; number: number; date: string; total: number }
interface CardQuote { id: string; number: number; status: QuoteStatus; total: number; customerName: string; customerPhone: string; customerEmail: string }
export function CrmFinance({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ docs: Row[]; owed: number; overdue: number; quotes: CardQuote[]; paid: number;
    orders: { id: string; number: number; total: number; at: string; status: any; test: boolean }[];
    payments: LedgerRow[]; plan: PlanRow[]; targets: LinkTarget[] } | null>(null);
  const [error, setError] = useState(false);
  // "מכירת חבילה" (2.87): only once migration 20261010004200 is in the database
  const [pkReady, setPkReady] = useState(false);
  const [selling, setSelling] = useState(false);
  useEffect(() => { if (open) void packagesReady().then(setPkReady); }, [open]);
  const links = usePaylinks(open ? { leadId, recent: 10 } : null);
  // "💳 שליחת לינק לתשלום" (2.97): on what — chosen when there is more than one
  const [linkFor, setLinkFor] = useState<LinkTarget | 'pick' | null>(null);
  // "חיובים חוזרים" (2.90): only once migration 20261010004500 is in the database
  const [recurring, setRecurring] = useState<RecurringPlan[] | null>(null);
  const [rcReady, setRcReady] = useState(false);
  // "כרטסת" (2.94): the customer's card in the reports — once migration 20261011004900 is in the database
  const ledgerOk = useReportsReady();
  useEffect(() => {
    if (!open || recurring) return;
    void recurringReady().then(async (ok) => {
      setRcReady(ok);
      const r = ok ? await loadRecurringPlans({ leadId }) : null;
      setRecurring(r && r.ok ? r.data.filter((p) => p.status !== 'ended') : []);
    });
  }, [open, recurring, leadId]);
  useEffect(() => {
    if (!open || data) return;
    const sb = supabase();
    void Promise.all([
      sb.from('documents').select('id, doc_type, doc_number, doc_date, total').eq('lead_id', leadId).order('issued_at', { ascending: false }).limit(20),
      sb.from('receivables').select('*').eq('lead_id', leadId),
      sb.from('quotes').select('id, quote_number, status, total, customer_name, customer_phone, customer_email').eq('lead_id', leadId)
        .in('status', ['draft', 'sent', 'accepted']).order('created_at', { ascending: false }).limit(10),
      sb.from('orders').select('id, number, total, created_at, payment_status, is_test').eq('lead_id', leadId).order('created_at', { ascending: false }).limit(20),
      plansReady().then((ok) => (ok ? loadLines({ leadId, openOnly: true }) : null)),
      sb.from('payments').select('*').eq('lead_id', leadId).order('paid_on', { ascending: false }).order('created_at', { ascending: false }).limit(10),
    ]).then(([d, r, q, o, ls, p]) => {
      if (d.error) { setError(true); return; }
      const today = israelParts(Date.now()).date;
      const recv = ((r.data ?? []) as any[]).map(toReceivable);
      const rec = recv.filter((x) => !x.cancelled && x.balance > 0);
      const docs = ((d.data ?? []) as any[]).map((x) => ({ id: x.id, type: x.doc_type, number: Number(x.doc_number), date: x.doc_date, total: Number(x.total) }));
      const quotes = ((q.data ?? []) as any[]).map((x): CardQuote => ({ id: x.id, number: Number(x.quote_number), status: x.status, total: Number(x.total),
        customerName: x.customer_name ?? '', customerPhone: x.customer_phone ?? '', customerEmail: x.customer_email ?? '' }));
      setData({
        docs, owed: rec.reduce((a, x) => a + x.balance, 0),
        // late: by the payments of a plan (2.89, receivable_lines), else by each invoice's own date
        overdue: ls ? ls.filter((l) => l.dueDate && l.dueDate < today).reduce((a, l) => a + l.open, 0)
          : rec.filter((x) => x.dueDate && x.dueDate < today).reduce((a, x) => a + x.balance, 0),
        quotes,
        orders: o.error ? [] : ((o.data ?? []) as any[]).map((x) => ({ id: x.id, number: Number(x.number), total: Number(x.total), at: x.created_at, status: x.payment_status, test: Boolean(x.is_test) })),
        paid: docs.filter((x) => x.type === 320 || x.type === 400).reduce((a, x) => a + x.total, 0) - docs.filter((x) => x.type === 330).reduce((a, x) => a + x.total, 0),
        payments: p.error ? [] : ((p.data ?? []) as any[]).map(toLedgerRow),
        plan: ls ? planRows(ls, today) : [],
        targets: linkTargets(recv, quotes),
      });
    });
  }, [open, data, leadId]);
  const canLink = Boolean(links.ready && links.links && data && data.targets.length);
  return (
    <div className="mb-4 rounded-2xl border border-line">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-2 p-3 text-start text-sm font-bold">
        <span>💰 כספים</span><span className="text-muted">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="grid gap-2 border-t border-line p-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <Link href={`/finance/documents?new=1&lead=${leadId}`} className="rounded-full bg-primary px-3 py-1.5 font-semibold text-white">🧾 הפקת מסמך</Link>
            {canLink && <button type="button" onClick={() => setLinkFor(data!.targets.length === 1 ? data!.targets[0] : 'pick')}
              className="rounded-full border border-line px-3 py-1.5 font-semibold hover:border-primary">💳 שליחת לינק לתשלום</button>}
            {pkReady && !error && <button type="button" onClick={() => setSelling(true)} className="rounded-full border border-line px-3 py-1.5 font-semibold hover:border-primary">📦 מכירת חבילה</button>}
            <Link href={`/finance/quotes?new=1&lead=${leadId}`} className="rounded-full border border-line px-3 py-1.5 font-semibold hover:border-primary">הצעת מחיר</Link>
            {rcReady && !error && <Link href={`/finance/recurring?new=1&lead=${leadId}`} className="rounded-full border border-line px-3 py-1.5 font-semibold hover:border-primary">🔁 חיוב חוזר</Link>}
            {ledgerOk && !error && <Link href={`/finance/reports?view=cledger&key=l:${leadId}`} className="rounded-full border border-line px-3 py-1.5 font-semibold hover:border-primary">📒 כרטסת</Link>}
          </div>
          {error ? <p className="text-muted">אין גישה לנתונים הכספיים כאן.</p> : !data ? <Spinner /> : <>
            <p>{data.owed > 0 ? <>חייב/ת: <strong>{ils(data.owed)}</strong>{data.overdue > 0 ? <span className="text-red-600"> (באיחור {ils(data.overdue)})</span> : null}</> : 'אין חוב פתוח.'}{data.paid > 0 ? ` · שולם במסמכים: ${ils(data.paid)}` : ''}</p>
            {data.plan.length > 0 && (
              <section aria-label="פריסה לתשלומים" className="grid gap-0.5">
                <p className="mt-1 font-semibold">📅 פריסה לתשלומים</p>
                <ul className="grid gap-0.5">{data.plan.map((l) => (
                  <li key={l.key} className="flex justify-between gap-2">
                    <span className="min-w-0">{l.label}{l.dueDate ? ` · עד ${l.dueDate.split('-').reverse().join('/')}` : ''}{l.late ? <span className="font-semibold text-red-600"> · באיחור</span> : null}</span>
                    <span className="shrink-0 tabular-nums">{ils(l.open)}</span>
                  </li>
                ))}</ul>
              </section>
            )}
            {data.quotes.length > 0 && <ul className="grid gap-0.5">{data.quotes.map((q) => <li key={q.id}>הצעת מחיר {q.number} · {QUOTE_STATUS_HE[q.status]} · {ils(q.total)}</li>)}</ul>}
            {!data.docs.length ? <p className="text-muted">לא הופקו מסמכים ללקוח הזה.</p> : (
              <section aria-label="מסמכים" className="grid gap-0.5">
                <p className="mt-1 font-semibold">🧾 מסמכים</p>
                <ul className="grid gap-0.5">{data.docs.map((d) => <li key={d.id} className="flex justify-between gap-2"><span>{DOC_LABEL[d.type]} {d.number} · {d.date.split('-').reverse().join('/')}</span><span className="tabular-nums">{ils(d.total)}</span></li>)}</ul>
              </section>
            )}
            {data.payments.length > 0 && (
              <section aria-label="תשלומים" className="grid gap-0.5">
                <p className="mt-1 font-semibold">💳 תשלומים{data.payments.length === 10 ? ' (10 האחרונים)' : ''}</p>
                <ul className="grid gap-0.5">{data.payments.map((x) => (
                  <li key={x.id} className="flex justify-between gap-2">
                    <span className="min-w-0">{x.paidOn.split('-').reverse().join('/')} · {LEDGER_SOURCE_HE[x.source] ?? 'תשלום'} · {payLabel(x.method)}{x.method === 'withholding' && x.pct != null ? ` ${x.pct}%` : ''}</span>
                    <span className={x.direction === 'in' ? 'shrink-0 tabular-nums text-emerald-700 dark:text-emerald-400' : 'shrink-0 tabular-nums text-red-600 dark:text-red-400'}>
                      {x.direction === 'in' ? '+' : '−'}{ils(x.amount)}</span>
                  </li>
                ))}</ul>
              </section>
            )}
            {data.orders.length > 0 && <>
              <p className="mt-1 font-semibold">🛍️ הזמנות באתר: {data.orders.length} · {ils(data.orders.filter((x) => !x.test && x.status !== 'refunded').reduce((a, x) => a + x.total, 0))}</p>
              <ul className="grid gap-0.5">{data.orders.map((x) => (
                <li key={x.id}><Link href={orderHref(x.id)} className="flex justify-between gap-2 hover:text-primary">
                  <span>#{x.number} · {new Date(x.at).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' })} · {orderLabel({ paymentStatus: x.status, isTest: x.test }).text}</span>
                  <span className="tabular-nums">{ils(x.total)}</span></Link></li>
              ))}</ul>
            </>}
            {recurring && recurring.length > 0 && (
              <ul className="grid gap-0.5" aria-label="חיובים חוזרים">{recurring.map((p) => (
                <li key={p.id}><Link href={`/finance/recurring?open=${p.id}`} className="flex justify-between gap-2 hover:text-primary">
                  <span className="min-w-0">🔁 {p.name} · {scheduleLabel(p.every, p.day, p.nextDate)} · {planLine(p)}</span>
                  <span className="shrink-0 tabular-nums">{ils(p.amount)}</span></Link></li>
              ))}</ul>
            )}
            {links.links && <PaylinkList links={links.links} onChanged={() => { void links.reload(); setData(null); }} />}
            <LeadReminderStop leadId={leadId} />
            <Link href="/finance/documents" className="text-xs font-semibold text-primary">לכל המסמכים ←</Link>
          </>}
        </div>
      )}
      {/* the customer's packages (T1): in the money box, shown also while it is closed — what is left, and a warning near the end */}
      <ClientPackages leadId={leadId} embedded />
      {/* a package sold from the card: its document by the existing engine; the card's packages and documents refresh */}
      {selling && <SellPackageDialog leadId={leadId} onClose={() => setSelling(false)} onDone={() => { setSelling(false); setData(null); }} />}
      {linkFor === 'pick' && data && (
        <Modal open onClose={() => setLinkFor(null)}>
          <div className="mb-1 flex items-start justify-between gap-2">
            <h3 className="font-display text-lg font-extrabold">💳 לינק לתשלום — על מה?</h3>
            <CloseButton onClick={() => setLinkFor(null)} />
          </div>
          <p className="mb-3 text-sm text-muted">חשבונית פתוחה (מה שנשאר בה) או הצעת מחיר שאושרה.</p>
          <div className="grid gap-1.5" role="list">{data.targets.map((t) => (
            <button key={`${t.kind}:${t.id}`} type="button" role="listitem" onClick={() => setLinkFor(t)}
              className="flex min-w-0 items-center justify-between gap-2 rounded-2xl border border-line p-3 text-start text-sm hover:border-primary">
              <span className="min-w-0 font-semibold">{t.label}</span>
              <span className="shrink-0 tabular-nums">{t.kind === 'document' ? `נשאר ${ils(t.owed)}` : ils(t.owed)}</span>
            </button>
          ))}</div>
        </Modal>
      )}
      {linkFor && linkFor !== 'pick' && <CardPaylink target={linkFor} onClose={() => setLinkFor(null)} onSent={() => { void links.reload(); }} />}
    </div>
  );
}

/** the dialog of "שלח לינק לתשלום" on one invoice or quote: what may still be asked = what is owed less what its links hold */
function CardPaylink({ target, onClose, onSent }: { target: LinkTarget; onClose: () => void; onSent: () => void }) {
  const held = usePaylinks(target.kind === 'document' ? { documentId: target.id } : { quoteId: target.id });
  if (!held.links) return null;
  return (
    <SendPaylinkDialog kind={target.kind} target={target.id} what={`${target.label}${target.customer.name ? ` · ${target.customer.name}` : ''}`}
      left={Math.max(0, Math.round((target.owed - heldBy(held.links)) * 100) / 100)} customer={target.customer} onClose={onClose}
      onSent={() => { void held.reload(); onSent(); }} />
  );
}
