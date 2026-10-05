'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { Button, Card } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { DOC_LABEL, docFromSale } from '@/features/documents/documents';
import { useFinance } from './FinanceScreen';
import { loadSummary, type Summary } from './Overview';
import { documentRow, financeError, issueDocumentRow, logEvent } from './api';
import { LEDGER_SOURCE_HE, ledgerTotals, payLabel, toLedgerRow, type LedgerRow } from './payments';
import { ledgerCsv } from './reports';
import { Note, PeriodPicker, Stat, ddmmyyyy, download, ils, periodNow, todayIL, type Period } from './ui';

/**
 * "הכנסות": income by its documents (the legal source) and the money that actually came in (the payments ledger), side by
 * side; and the register's paid sales that have no document yet — issued here with the same idempotency key as the
 * register uses ("sale:<id>"), so a sale never gets two documents.
 */
interface Paid { id: string; customer: string; total: number; at: string; raw: any }

export function Income() {
  const { userId, settings, business, vat, fail, say } = useFinance();
  const [period, setPeriod] = useState<Period>(() => periodNow('month'));
  const [s, setS] = useState<Summary | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [missing, setMissing] = useState<Paid[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setS(null);
    const sb = supabase();
    const [sum, led, sales] = await Promise.all([
      loadSummary(period),
      sb.from('payments').select('*').gte('paid_on', period.from).lte('paid_on', period.to).order('paid_on', { ascending: false }).limit(500),
      sb.from('sales').select('*').eq('status', 'paid').gte('paid_at', `${period.from}T00:00:00+03:00`).lte('paid_at', `${period.to}T23:59:59+03:00`).limit(1000),
    ]);
    if (!sum.ok) { fail(sum.error); return; }
    setS(sum.s);
    setLedger(led.error ? [] : ((led.data ?? []) as any[]).map(toLedgerRow));
    const ids = ((sales.data ?? []) as any[]).map((x) => x.id);
    const docs = ids.length ? await sb.from('documents').select('sale_id').in('sale_id', ids).in('doc_type', [305, 320, 400]) : { data: [] as any[] };
    const has = new Set(((docs.data ?? []) as any[]).map((d) => d.sale_id));
    setMissing(((sales.data ?? []) as any[]).filter((x) => !has.has(x.id)).map((x) => ({ id: x.id, customer: x.customer_name ?? '', total: Number(x.total), at: x.paid_at ?? x.created_at, raw: x })));
  }, [period, fail]);
  useEffect(() => { void load(); }, [load]);

  /** the documents the register would have issued, one per sale, never twice (same key as the register) */
  async function issueMissing() {
    if (!business.ready) { fail('חסרים פרטי העסק למסמכים — ממלאים בהגדרות.'); return; }
    if (!window.confirm(`להפיק ${missing.length} מסמכים למכירות ששולמו בלי מסמך? כל מסמך יקבל את תאריך היום.`)) return;
    setBusy(true);
    let ok = 0, failed = 0;
    for (const m of missing) {
      const r = m.raw;
      const sale = { items: r.items ?? [], discount: Number(r.discount), total: Number(r.total), vatAmount: Number(r.vat_amount), vatRate: Number(r.vat_rate), method: r.method,
        customerName: r.customer_name ?? '', customerPhone: r.customer_phone ?? '', payments: r.payments ?? [], billingName: r.billing_name, customerDealer: r.customer_dealer,
        customerStreet: r.customer_street, customerCity: r.customer_city };
      const d = docFromSale(sale, { licensed: vat, docDate: todayIL() });
      const out = await issueDocumentRow(documentRow(d, { userId, idempotencyKey: `sale:${m.id}`, vatRate: d.lines[0]?.vatRate ?? 0, saleId: m.id, leadId: r.lead_id ?? null, source: 'pos' }));
      if (out.ok) ok++; else failed++;
    }
    setBusy(false);
    say(`הופקו ${ok} מסמכים${failed ? ` · ${failed} נכשלו` : ''}`);
    void load();
  }

  const t = ledgerTotals(ledger ?? []);
  return (
    <div className="grid gap-3">
      <PeriodPicker value={period} onChange={setPeriod} />
      {!s ? <div className="py-8 text-center"><Spinner /></div> : <>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Stat label={vat ? 'הכנסות לפי מסמכים (לפני מע״מ)' : 'הכנסות לפי קבלות'} value={ils(s.revenue.net)} hint={vat ? `כולל מע״מ ${ils(s.revenue.gross)}` : undefined} />
          <Stat label="נכנס בפועל" value={ils(t.in)} hint="קבלות וחשבוניות מס/קבלה" />
          <Stat label="יצא בפועל" value={ils(t.out)} hint="החזרים, זיכויים, הוצאות, ביטולים" />
          <Stat label="נטו בתקופה" value={ils(t.net)} tone={t.net >= 0 ? 'ok' : 'bad'} />
        </div>
        {missing.length > 0 && (
          <Card className="p-4">
            <p className="mb-1 font-bold">מכירות ששולמו בלי מסמך ({missing.length})</p>
            <p className="mb-2 text-sm text-muted">כל מכירה ששולמה צריכה {vat ? 'חשבונית מס / קבלה' : 'קבלה'}. בדרך כלל זה קורה כשפרטי העסק עוד לא היו מלאים בזמן המכירה.</p>
            <ul className="mb-3 grid gap-1 text-sm">{missing.slice(0, 8).map((m) => <li key={m.id} className="flex justify-between gap-2"><span className="truncate">{m.customer || 'לקוח מזדמן'} · {ddmmyyyy(m.at.slice(0, 10))}</span><strong className="tabular-nums">{ils(m.total)}</strong></li>)}</ul>
            <Button variant="primary" disabled={busy} onClick={() => void issueMissing()}>{busy ? 'מפיק…' : `הפקת ${missing.length} המסמכים החסרים`}</Button>
          </Card>
        )}
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between gap-2"><p className="font-bold">יומן תשלומים</p>
            {ledger && ledger.length > 0 && <Button size="sm" variant="ghost" onClick={() => { download(`תשלומים-${period.from}-${period.to}.csv`, ledgerCsv(ledger)); void logEvent('export.csv', 'payments', '', { rows: ledger.length }); }}>ייצוא</Button>}</div>
          {!ledger?.length ? <p className="text-sm text-muted">אין תנועות בתקופה הזו.</p> : (
            <ul className="grid gap-1 text-sm">{ledger.slice(0, 100).map((r) => (
              <li key={r.id} className="flex min-w-0 items-center justify-between gap-2 border-b border-line py-1.5 last:border-0">
                <span className="min-w-0 truncate">{ddmmyyyy(r.paidOn)} · {LEDGER_SOURCE_HE[r.source]} · {payLabel(r.method)}{r.note ? ` · ${r.note}` : ''}</span>
                <strong className={r.direction === 'in' ? 'tabular-nums text-emerald-600 dark:text-emerald-400' : 'tabular-nums text-red-600 dark:text-red-400'}>{r.direction === 'in' ? '+' : '−'}{ils(r.amount)}</strong>
              </li>
            ))}</ul>
          )}
          <p className="mt-2 text-xs text-muted">היומן נכתב רק על ידי המערכת (מסמכים, החזרים, הוצאות, ביטולים) ולא משתנה — תיקון נרשם כתנועה הפוכה. רישום תשלום אינו סליקה.</p>
        </Card>
        {Object.keys(s.documents).length > 0 && (
          <Card className="p-4"><p className="mb-2 font-bold">לפי סוג מסמך</p>
            <ul className="grid gap-1 text-sm">{Object.entries(s.documents).map(([k, v]) => <li key={k} className="flex justify-between gap-2"><span>{DOC_LABEL[Number(k)] ?? k} · {v.count}</span><strong className="tabular-nums">{ils(Number(v.total))}</strong></li>)}</ul>
          </Card>
        )}
        {!settings.dealerNumber && <Note tone="warn">{financeError({ message: 'business_details_missing' })}</Note>}
      </>}
    </div>
  );
}
