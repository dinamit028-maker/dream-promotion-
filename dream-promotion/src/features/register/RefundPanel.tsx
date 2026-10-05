'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL } from '@/lib/il-time';
import { ils, methodLabel, type Refund, type RefundMethod, type Sale } from './money';
import { REFUND_ERROR_HE, defaultRefundMethod, planRefund, refundLeft, returnedQty, type RefundPlan, type RefundRequest } from './refunds';

/**
 * "↩️ החזר כספי" on a paid sale: the whole sale, chosen items, or a sum — by the way the money goes back.
 * Shows what was already given back; the database refuses anything beyond what was paid.
 */
const METHODS: { id: RefundMethod; label: string; icon: string }[] = [
  { id: 'cash', label: 'מזומן', icon: '💵' }, { id: 'card', label: 'אשראי', icon: '💳' }, { id: 'bit', label: 'Bit / PayBox', icon: '📱' },
  { id: 'transfer', label: 'העברה', icon: '🏦' }, { id: 'other', label: 'אחר', icon: '•' },
];

export function RefundPanel({ sale, refunds, employees, licensed, docsReady, onRefund, onPrintSlip }: {
  sale: Sale; refunds: Refund[]; employees: { id: string; name: string }[]; licensed: boolean; docsReady: boolean;
  onRefund: (plan: RefundPlan & { id?: string }) => Promise<{ ok: boolean; error?: string; message?: string }>;
  onPrintSlip: (r: Refund) => void;
}) {
  const mine = useMemo(() => refunds.filter((r) => r.saleId === sale.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [refunds, sale.id]);
  const left = refundLeft(sale, mine);
  const done = returnedQty(sale, mine);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RefundRequest['mode']>('full');
  const [qty, setQty] = useState<number[]>([]);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<RefundMethod>(defaultRefundMethod(sale));
  const [restock, setRestock] = useState(true);
  const [reason, setReason] = useState('');
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // one id per refund being recorded — a retry after a lost answer finds it instead of refunding twice
  const refundId = useRef(crypto.randomUUID());
  useEffect(() => { setOpen(false); setMsg(null); setMode('full'); setQty(sale.items.map(() => 0)); setAmount(''); setReason(''); setMethod(defaultRefundMethod(sale)); }, [sale]);

  const req: RefundRequest = mode === 'full' ? { mode } : mode === 'items' ? { mode, qty } : { mode, amount: Number(amount) || 0 };
  const plan = planRefund(sale, mine, req, { method, restock, reason, employeeName: who });
  const canRestock = (mode === 'full' || mode === 'items') && sale.items.some((l, i) => l.itemId && l.kind === 'product' && l.qty - done[i] > 0);

  async function go() {
    if (!plan.ok) return;
    if (!window.confirm(`להחזיר ${ils(plan.refund.amount)} ב${methodLabel(method)}?${licensed && docsReady ? ' תופק חשבונית מס זיכוי.' : ''}`)) return;
    setBusy(true); setMsg(null);
    const r = await onRefund({ ...plan.refund, id: refundId.current });
    setBusy(false);
    if (r.ok) { refundId.current = crypto.randomUUID(); setOpen(false); setMsg({ ok: true, text: r.message ?? 'ההחזר נרשם' }); } else setMsg({ ok: false, text: r.error ?? 'ההחזר לא נרשם. נסו שוב.' });
  }

  if (sale.status !== 'paid') return null;
  return (
    <div className="mb-3 rounded-2xl border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">↩️ החזרים</p>
        {left > 0 && !open && <Button size="sm" variant="primary" onClick={() => setOpen(true)}>החזר כספי</Button>}
        {left <= 0 && <span className="rounded-full bg-zinc-500/15 px-2.5 py-1 text-xs font-bold">הוחזר במלואו</span>}
      </div>
      {mine.length > 0 && (
        <ul className="mt-2 grid gap-1.5 text-sm">
          {mine.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2">
              <span className="min-w-0">
                <strong className="tabular-nums">−{ils(r.amount)}</strong> · {methodLabel(r.method)} · {formatIL(r.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                {r.items.length > 0 && <span className="block truncate text-xs text-muted">{r.items.map((l) => `${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''}`).join(' + ')}{r.restock ? ' · חזר למלאי' : ''}</span>}
                {r.reason && <span className="block text-xs text-muted">סיבה: {r.reason}</span>}
              </span>
              <button type="button" className="text-xs font-semibold text-primary" onClick={() => onPrintSlip(r)}>אישור החזר להדפסה</button>
            </li>
          ))}
          {left > 0 && <li className="text-xs text-muted">נשאר להחזיר עד {ils(left)}</li>}
        </ul>
      )}
      {msg && <p role="status" className={cx('mt-2 rounded-xl p-2 text-sm', msg.ok ? 'bg-emerald-500/15 font-semibold' : 'bg-warn/10 text-warn')}>{msg.text}</p>}

      {open && (
        <div className="mt-3 grid gap-3">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="מה מחזירים">
            {([['full', `הכל (${ils(left)})`], ['items', 'לפי פריטים'], ['amount', 'סכום אחר']] as const).map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => setMode(k)}
                className={cx('rounded-full border px-3 py-1.5 text-sm font-semibold', mode === k ? 'border-primary bg-primary-soft' : 'border-line')}>{l}</button>
            ))}
          </div>
          {mode === 'items' && (
            <ul className="grid gap-1.5">
              {sale.items.map((l, i) => {
                const max = l.qty - done[i];
                return (
                  <li key={i} className={cx('flex items-center gap-2 text-sm', max <= 0 && 'opacity-50')}>
                    <span className="min-w-0 flex-1 truncate">{l.name} <span className="text-xs text-muted">· {ils(l.price)}{done[i] ? ` · הוחזרו ${done[i]}` : ''}</span></span>
                    <button type="button" disabled={!qty[i]} className="h-9 w-9 rounded-full border border-line" aria-label={`פחות ${l.name}`} onClick={() => setQty(qty.map((q, k) => (k === i ? Math.max(0, q - 1) : q)))}>−</button>
                    <span className="w-6 text-center font-bold tabular-nums">{qty[i] ?? 0}</span>
                    <button type="button" disabled={(qty[i] ?? 0) >= max} className="h-9 w-9 rounded-full border border-line" aria-label={`עוד ${l.name}`} onClick={() => setQty(qty.map((q, k) => (k === i ? Math.min(max, q + 1) : q)))}>+</button>
                  </li>
                );
              })}
            </ul>
          )}
          {mode === 'amount' && (
            <Input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`עד ${ils(left)}`} className="h-12 text-center text-xl font-bold" aria-label="סכום ההחזר" />
          )}
          <div>
            <p className="mb-1.5 text-sm font-semibold">איך הכסף חוזר?</p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {METHODS.map((m) => (
                <button key={m.id} type="button" onClick={() => setMethod(m.id)} aria-pressed={method === m.id}
                  className={cx('flex h-16 flex-col items-center justify-center rounded-2xl border text-sm font-bold', method === m.id ? 'border-primary bg-primary-soft' : 'border-line bg-surface')}>
                  <span className="text-xl" aria-hidden>{m.icon}</span>{m.label}
                </button>
              ))}
            </div>
            {method === 'card' && <p className="mt-1 text-xs text-muted">את הזיכוי בכרטיס עושים במסוף / בחברת הסליקה — כאן הוא נרשם.</p>}
          </div>
          {canRestock && (
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} className="h-5 w-5" />המוצרים חזרו למלאי (תקינים למכירה)</label>
          )}
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="סיבה (לא חובה) — למשל: אלרגיה למוצר" aria-label="סיבת ההחזר" maxLength={200} />
          {employees.length > 0 && (
            <select value={who} onChange={(e) => setWho(e.target.value)} className="h-11 rounded-2xl border border-line bg-surface px-3 text-sm" aria-label="מי ביצע את ההחזר">
              <option value="">מי ביצע/ה? (לא חובה)</option>{employees.map((e) => <option key={e.id} value={e.name}>{e.name}</option>)}
            </select>
          )}
          <p className={cx('rounded-2xl p-3 text-center text-2xl font-black tabular-nums', plan.ok ? 'bg-amber-500/15 text-amber-800 dark:text-amber-200' : 'bg-surface-2 text-muted text-base font-semibold')}>
            {plan.ok ? `החזר: ${ils(plan.refund.amount)}` : REFUND_ERROR_HE[plan.error]}
          </p>
          {plan.ok && licensed && !docsReady && <p className="text-xs text-muted">פרטי העסק למסמכים לא מלאים — ההחזר יירשם בלי חשבונית זיכוי.</p>}
          {plan.ok && !licensed && <p className="text-xs text-muted">בעוסק פטור לא מופקת חשבונית זיכוי — ההחזר נרשם בקופה ובדוחות. מומלץ להחתים את הלקוח/ה על אישור ההחזר.</p>}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>ביטול</Button>
            <Button variant="primary" disabled={!plan.ok || busy} onClick={go}>{busy ? <><Spinner />רושם…</> : 'אישור ההחזר'}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** a printable "אישור החזר כספי" — not a tax document; the customer signs that the money came back */
export function refundSlipHtml(r: Refund, sale: Sale, business: string) {
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>אישור החזר כספי</title>
<style>body{font-family:Arial,system-ui,sans-serif;color:#111;margin:24px;max-width:640px}td{padding:6px;border-bottom:1px solid #ddd}h1{font-size:20px}.sig{margin-top:48px;border-top:1px solid #111;width:260px;padding-top:4px}</style></head><body>
<h1>${esc(business)} — אישור החזר כספי</h1>
<table>
<tr><td>תאריך</td><td>${esc(formatIL(r.createdAt))}</td></tr>
<tr><td>לקוח/ה</td><td>${esc(sale.customerName || 'לקוח מזדמן')}</td></tr>
<tr><td>עסקה מקורית</td><td>${esc(formatIL(sale.paidAt ?? sale.createdAt, { dateStyle: 'short' }))} · ${esc(ils(sale.total))}</td></tr>
${r.items.length ? `<tr><td>מה הוחזר</td><td>${esc(r.items.map((l) => `${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''}`).join(' + '))}</td></tr>` : ''}
<tr><td><strong>סכום ההחזר</strong></td><td><strong>${esc(ils(r.amount))}</strong></td></tr>
<tr><td>אמצעי</td><td>${esc(methodLabel(r.method))}</td></tr>
${r.reason ? `<tr><td>סיבה</td><td>${esc(r.reason)}</td></tr>` : ''}
${r.employeeName ? `<tr><td>בוצע ע״י</td><td>${esc(r.employeeName)}</td></tr>` : ''}
</table>
<p>אישור זה אינו מסמך מס.</p>
<p class="sig">חתימת הלקוח/ה: קיבלתי את ההחזר</p>
<script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`;
}
