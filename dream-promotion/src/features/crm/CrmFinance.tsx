'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import { Spinner } from '@/components/ui/feedback';
import { DOC_LABEL } from '@/features/documents/documents';
import { ils } from '@/features/register/money';
import { QUOTE_STATUS_HE, type QuoteStatus } from '@/features/finance/quotes';

/**
 * The money of one contact, on their card: documents issued to them, what they still owe, open quotes — and
 * "הפקת מסמך" / "הצעת מחיר" straight into the money screens with the customer filled in. Loaded only when opened;
 * row-level security decides what is visible (a cashier never opens the CRM; a closed business shows nothing).
 */
interface Row { id: string; type: number; number: number; date: string; total: number }
export function CrmFinance({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ docs: Row[]; owed: number; overdue: number; quotes: { id: string; number: number; status: QuoteStatus; total: number }[]; paid: number } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open || data) return;
    const sb = supabase();
    void Promise.all([
      sb.from('documents').select('id, doc_type, doc_number, doc_date, total').eq('lead_id', leadId).order('issued_at', { ascending: false }).limit(20),
      sb.from('receivables').select('balance, due_date, cancelled').eq('lead_id', leadId),
      sb.from('quotes').select('id, quote_number, status, total').eq('lead_id', leadId).in('status', ['draft', 'sent', 'accepted']).order('created_at', { ascending: false }).limit(10),
    ]).then(([d, r, q]) => {
      if (d.error) { setError(true); return; }
      const today = new Date().toISOString().slice(0, 10);
      const rec = ((r.data ?? []) as any[]).filter((x) => !x.cancelled && Number(x.balance) > 0);
      const docs = ((d.data ?? []) as any[]).map((x) => ({ id: x.id, type: x.doc_type, number: Number(x.doc_number), date: x.doc_date, total: Number(x.total) }));
      setData({
        docs, owed: rec.reduce((a, x) => a + Number(x.balance), 0), overdue: rec.filter((x) => x.due_date && x.due_date < today).reduce((a, x) => a + Number(x.balance), 0),
        quotes: ((q.data ?? []) as any[]).map((x) => ({ id: x.id, number: Number(x.quote_number), status: x.status, total: Number(x.total) })),
        paid: docs.filter((x) => x.type === 320 || x.type === 400).reduce((a, x) => a + x.total, 0) - docs.filter((x) => x.type === 330).reduce((a, x) => a + x.total, 0),
      });
    });
  }, [open, data, leadId]);
  return (
    <div className="mb-4 rounded-2xl border border-line">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-2 p-3 text-start text-sm font-bold">
        <span>💰 כספים</span><span className="text-muted">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="grid gap-2 border-t border-line p-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <Link href={`/finance?tab=documents&new=1&lead=${leadId}`} className="rounded-full bg-primary px-3 py-1.5 font-semibold text-white">🧾 הפקת מסמך</Link>
            <Link href={`/finance?tab=quotes&new=1&lead=${leadId}`} className="rounded-full border border-line px-3 py-1.5 font-semibold hover:border-primary">הצעת מחיר</Link>
          </div>
          {error ? <p className="text-muted">אין גישה לנתונים הכספיים כאן.</p> : !data ? <Spinner /> : <>
            <p>{data.owed > 0 ? <>חייב/ת: <strong>{ils(data.owed)}</strong>{data.overdue > 0 ? <span className="text-red-600"> (באיחור {ils(data.overdue)})</span> : null}</> : 'אין חוב פתוח.'}{data.paid > 0 ? ` · שולם במסמכים: ${ils(data.paid)}` : ''}</p>
            {data.quotes.length > 0 && <ul className="grid gap-0.5">{data.quotes.map((q) => <li key={q.id}>הצעת מחיר {q.number} · {QUOTE_STATUS_HE[q.status]} · {ils(q.total)}</li>)}</ul>}
            {!data.docs.length ? <p className="text-muted">לא הופקו מסמכים ללקוח הזה.</p> : (
              <ul className="grid gap-0.5">{data.docs.map((d) => <li key={d.id} className="flex justify-between gap-2"><span>{DOC_LABEL[d.type]} {d.number} · {d.date.split('-').reverse().join('/')}</span><span className="tabular-nums">{ils(d.total)}</span></li>)}</ul>
            )}
            <Link href="/finance?tab=documents" className="text-xs font-semibold text-primary">לכל המסמכים ←</Link>
          </>}
        </div>
      )}
    </div>
  );
}
