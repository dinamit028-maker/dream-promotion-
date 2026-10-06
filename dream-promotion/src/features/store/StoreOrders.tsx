'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Field, Input, PageHead, Pill, Select } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { DOC_LABEL } from '@/features/documents/documents';
import { DOCUMENT_STATUS_HE, EMAIL_KIND_HE, FULFILLMENT_HE, eventText, ORDER_FILTERS, orderLabel, type OrderRow } from './checkout';
import { packingSlip } from './commerce';
import { alertsSeen, loadOrder, loadOrders, refundOrder, retryOrderDocument, setFulfillment, type OrderDetail } from './data';
import { orderHref, storeHref } from './routes';
import { Block, Notice } from './ui';

/**
 * "הזמנות" (2.56; full from 2.57): the orders from the site — number, customer, sum, status — and one order: its lines,
 * the customer, its document, the goods (status, tracking, a packing slip), refunds, the emails sent and the timeline.
 * What is paid is the payment provider's answer only; the handling is the owner's. A cashier sees nothing here (the
 * database), a viewer reads (the database and the server refuse their writes).
 */
const ils = (n: number) => `₪${n.toLocaleString('he-IL', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const when = (iso: string) => new Date(iso).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const TONE = { ok: 'ok', warn: 'warn', bad: 'warn', muted: 'default' } as const;

export function StoreOrders() {
  const [list, setList] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<(typeof ORDER_FILTERS)[number]['id']>('all');
  useEffect(() => { void loadOrders().then((r) => (r.ok ? setList(r.data) : setError(r.error))); }, []);
  const shown = useMemo(() => (list ?? []).filter((o) => ORDER_FILTERS.find((f) => f.id === filter)!.match(o.paymentStatus)), [list, filter]);
  return (
    <>
      <PageHead title="הזמנות" sub="ההזמנות מהאתר. הזמנת בדיקה מסומנת „בדיקה“: בלי חיוב אמיתי, בלי מכירה ובלי מסמך." />
      {error && <Notice tone="error">{error}</Notice>}
      <div role="tablist" aria-label="סינון" className="mb-3 flex flex-wrap gap-2">
        {ORDER_FILTERS.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}
            className={cx('min-h-11 rounded-full border px-4 text-sm font-semibold', filter === f.id ? 'border-ink bg-ink text-white' : 'border-line')}>{f.label}</button>
        ))}
      </div>
      {!list && !error ? <p className="flex items-center gap-2 text-muted"><Spinner /> טוען…</p> : shown.length === 0 ? (
        <Block title="אין הזמנות">
          <p className="text-muted">{list?.length ? 'אין הזמנות בסינון הזה.' : <>עוד אין הזמנות. אפשר לנסות הזמנת בדיקה מהתצוגה המקדימה, אחרי שמפעילים <Link href={storeHref('selling')} className="text-primary underline underline-offset-2">מכירה באתר</Link>.</>}</p>
        </Block>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {shown.map((o) => {
            const l = orderLabel(o);
            return (
              <li key={o.id}>
                <Link href={orderHref(o.id)} className="flex min-h-14 items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block font-bold">#{o.number} · {o.customerName}</span>
                    <span className="block text-sm text-muted">{when(o.createdAt)} · {o.deliveryMethod === 'delivery' ? 'משלוח' : 'איסוף'}</span>
                  </span>
                  <span className="text-end">
                    <bdi className="block font-bold">{ils(o.total)}</bdi>
                    <Pill tone={TONE[l.tone]}>{l.text}</Pill>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

export function StoreOrder({ id }: { id: string }) {
  const [d, setD] = useState<OrderDetail | null | undefined>(undefined);
  const [error, setError] = useState('');
  const reload = useCallback(() => loadOrder(id).then((r) => (r.ok ? setD(r.data) : setError(r.error))), [id]);
  useEffect(() => { void reload(); void alertsSeen(id); }, [id, reload]);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (d === undefined) return <p className="flex items-center gap-2 text-muted"><Spinner /> טוען…</p>;
  if (d === null) return <Notice tone="warn">ההזמנה לא נמצאה (אולי של עסק אחר).</Notice>;
  const { order: o, lines, events } = d;
  const l = orderLabel(o);
  const a = o.address;
  const paid = ['paid', 'partially_refunded', 'refunded', 'test_paid'].includes(o.paymentStatus);
  const print = () => {
    const w = window.open('', '_blank');   // opened in the tap itself (phones block a window opened later)
    if (!w) return;
    w.document.write(packingSlip(d.storeName, o, lines));
    w.document.close();
    w.focus();
    w.print();
  };
  return (
    <>
      <PageHead title={`הזמנה #${o.number}`} sub={when(o.createdAt)} action={<Pill tone={TONE[l.tone]}>{l.text}</Pill>} />
      {o.isTest && <Notice tone="warn">הזמנת בדיקה: לא חויב כסף, לא נוצרה מכירה, המלאי לא זז ולא הופק מסמך.</Notice>}
      {o.requestKind && (
        <Notice tone="warn">הלקוח ביקש {o.requestKind === 'cancel' ? 'לבטל' : 'להחזיר'} את ההזמנה{o.requestedAt ? ` (${when(o.requestedAt)})` : ''}{o.requestNote ? `: „${o.requestNote}“` : '.'} הבקשה לא מחזירה כסף בעצמה — מחליטים ומבצעים החזר למטה.</Notice>
      )}
      {!o.isTest && paid && <DocumentBlock d={d} onChange={reload} />}
      <Block title="הקונה">
        <p className="font-semibold">{o.customerName}</p>
        <p><a href={`tel:${o.customerPhone}`} className="text-primary" dir="ltr">{o.customerPhone}</a> · <a href={`mailto:${o.customerEmail}`} className="text-primary" dir="ltr">{o.customerEmail}</a></p>
        <p className="mt-2 text-sm">{o.deliveryMethod === 'delivery' ? `משלוח: ${[a.street, a.house].filter(Boolean).join(' ')}${a.apartment ? `, דירה ${a.apartment}` : ''}, ${a.city ?? ''}` : 'איסוף עצמי'}</p>
        {o.notes && <p className="mt-2 rounded-md bg-surface-2 p-3 text-sm">{o.notes}</p>}
        {o.leadId && <p className="mt-2 text-sm text-muted">הלקוח נמצא בלקוחות (כרטיס „{o.customerName}“), עם ההזמנה בהיסטוריה.</p>}
      </Block>
      <Block title="המוצרים" action={<Button type="button" variant="ghost" size="sm" onClick={print}>🖨️ תעודת ליקוט</Button>}>
        <ul className="divide-y divide-line">
          {lines.map((x, i) => (
            <li key={i} className="flex items-center justify-between gap-3 py-2">
              <span>{x.qty} × {x.name}{x.variantLabel ? ` — ${x.variantLabel}` : ''}{x.sku ? <span className="text-xs text-muted" dir="ltr"> ({x.sku})</span> : null}</span>
              <bdi className="font-semibold">{ils(x.lineTotal)}</bdi>
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex justify-between"><dt className="text-muted">מוצרים</dt><dd><bdi>{ils(o.subtotal)}</bdi></dd></div>
          {o.discount > 0 && <div className="flex justify-between"><dt className="text-muted">הנחה{o.couponCode ? ` (${o.couponCode})` : ''}</dt><dd><bdi>−{ils(o.discount)}</bdi></dd></div>}
          <div className="flex justify-between"><dt className="text-muted">{o.deliveryMethod === 'delivery' ? 'משלוח' : 'איסוף'}</dt><dd>{o.shipping ? <bdi>{ils(o.shipping)}</bdi> : 'חינם'}</dd></div>
          <div className="flex justify-between border-t border-line pt-1 font-bold"><dt>סה״כ</dt><dd><bdi>{ils(o.total)}</bdi></dd></div>
          {o.refundedTotal > 0 && <div className="flex justify-between text-warn"><dt>הוחזר</dt><dd><bdi>−{ils(o.refundedTotal)}</bdi></dd></div>}
        </dl>
      </Block>
      {paid && <FulfillmentBlock o={o} onChange={reload} />}
      {paid && !o.isTest && o.saleId && <RefundBlock d={d} onChange={reload} />}
      {d.emails.length > 0 && (
        <Block title="מיילים ללקוח">
          <ul className="space-y-1 text-sm">
            {d.emails.map((m, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-2">
                <span>{EMAIL_KIND_HE[m.kind] ?? m.kind}</span>
                {/* "נשלח" only with the provider's id (the database refuses "sent" without it) */}
                <span className={m.status === 'failed' ? 'text-red-600' : m.status === 'sent' ? 'text-ok' : 'text-muted'}>
                  {m.status === 'sent' ? `נשלח ✓${m.sentAt ? ` · ${when(m.sentAt)}` : ''}` : m.status === 'failed' ? `לא נשלח${m.error ? ` (${m.error})` : ''}` : 'ממתין לשליחה'}
                </span>
              </li>
            ))}
          </ul>
        </Block>
      )}
      <Block title="ציר הזמן">
        <ol className="space-y-2">
          {events.map((e, i) => (
            <li key={i} className="flex gap-3 text-sm"><span className="shrink-0 text-muted">{when(e.at)}</span><span>{eventText(e)}</span></li>
          ))}
        </ol>
      </Block>
    </>
  );
}

/** the document of the order's sale: issued (with its link), waiting, or blocked with the reason and "נסו שוב" */
function DocumentBlock({ d, onChange }: { d: OrderDetail; onChange: () => void }) {
  const o = d.order;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const retry = async () => {
    setBusy(true); setMsg('');
    const r = await retryOrderDocument(o.id);
    setBusy(false);
    if (!r.ok) setMsg(r.error); else if (r.data.document !== 'issued') setMsg(r.data.error ?? 'המסמך עוד לא הופק.');
    onChange();
  };
  return (
    <Block title="מסמך" sub={DOCUMENT_STATUS_HE[o.documentStatus]}>
      {!o.saleId && <p className="text-sm text-muted">המכירה נרשמת בשרת בדקות הקרובות, ואחריה מופק המסמך.</p>}
      {o.documentStatus === 'blocked' && <>
        <Notice tone="error">{o.documentError || 'המסמך לא הופק.'}</Notice>
        <p className="mb-2 text-sm text-muted">אחרי שמתקנים (למשל פרטי העסק בהגדרות) — מנסים שוב. ההזמנה מופיעה גם בכספים, ב„מכירות ששולמו בלי מסמך“.</p>
        <Button type="button" variant="primary" disabled={busy} onClick={() => void retry()}>{busy ? 'מנסה…' : 'נסו שוב'}</Button>
      </>}
      {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
      {d.docs.length > 0 && (
        <ul className="space-y-1 text-sm">
          {d.docs.map((x) => (
            <li key={x.id}><a href={`/d/${x.token}`} target="_blank" rel="noopener" className="text-primary underline underline-offset-2">{DOC_LABEL[x.type] ?? x.type} {x.number}</a></li>
          ))}
        </ul>
      )}
    </Block>
  );
}

const STEPS = ['unfulfilled', 'processing', 'ready', 'shipped', 'delivered', 'returned'] as const;
/** where the goods stand; "ready" (pickup) and "shipped" (delivery, with tracking) tell the customer by email */
function FulfillmentBlock({ o, onChange }: { o: OrderRow; onChange: () => void }) {
  const [status, setStatus] = useState(o.fulfillmentStatus);
  const [tracking, setTracking] = useState(o.trackingNumber);
  const [url, setUrl] = useState(o.trackingUrl);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const steps = STEPS.filter((s) => (o.deliveryMethod === 'pickup' ? s !== 'shipped' : s !== 'ready'));
  const save = async () => {
    setBusy(true); setMsg(null);
    const r = await setFulfillment(o.id, status, tracking.trim(), url.trim());
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: 'נשמר.' } : { ok: false, text: r.error });
    if (r.ok) onChange();
  };
  return (
    <Block title="טיפול בהזמנה" sub={`עכשיו: ${FULFILLMENT_HE[o.fulfillmentStatus] ?? o.fulfillmentStatus}${o.trackingNumber ? ` · מעקב ${o.trackingNumber}` : ''}`}>
      <Field label="מצב">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          {steps.map((s) => <option key={s} value={s}>{FULFILLMENT_HE[s]}</option>)}
        </Select>
      </Field>
      {status === 'shipped' && <>
        <Field label="מספר מעקב (לא חובה)"><Input value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={60} dir="ltr" /></Field>
        <Field label="קישור למעקב (לא חובה)"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" dir="ltr" inputMode="url" /></Field>
      </>}
      <p className="mb-3 text-sm text-muted">{o.deliveryMethod === 'pickup' ? '„מוכן לאיסוף“ שולח ללקוח מייל.' : '„נשלח“ שולח ללקוח מייל, עם מספר המעקב.'}</p>
      <Button type="button" variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'שומר…' : 'שמירה'}</Button>
      {msg && <p className={cx('mt-2 text-sm', msg.ok ? 'text-ok' : 'text-red-600')} role="status">{msg.text}</p>}
    </Block>
  );
}

/**
 * "החזר": the money goes back in the payment company's own screen; here it is recorded (the register's rules: all, items
 * or a sum, back to stock or not) with the credit invoice, after the owner confirms it was done there.
 */
function RefundBlock({ d, onChange }: { d: OrderDetail; onChange: () => void }) {
  const o = d.order;
  const left = Math.max(0, Math.round((o.total - o.refundedTotal) * 100) / 100);
  const [mode, setMode] = useState<'full' | 'items' | 'amount'>('full');
  const [qty, setQty] = useState<number[]>(() => d.saleItems.map(() => 0));
  const [amount, setAmount] = useState('');
  const [restock, setRestock] = useState(true);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (left <= 0) {
    return <Block title="החזר"><p className="text-sm text-muted">כל הסכום הוחזר.</p>{d.refunds.map((r) => <p key={r.id} className="text-sm">{when(r.at)} · {ils(r.amount)}{r.reason ? ` · ${r.reason}` : ''}</p>)}</Block>;
  }
  const send = async () => {
    setBusy(true); setMsg(null);
    const r = await refundOrder({ orderId: o.id, mode, qty, amount: Number(amount) || 0, restock, reason, confirmed });
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.error }); return; }
    const credit = r.data.credit === 'issued' ? ' הופקה חשבונית זיכוי.' : r.data.credit === 'not_required' ? '' : ` חשבונית הזיכוי לא הופקה: ${r.data.credit}`;
    setMsg({ ok: true, text: `נרשם החזר של ${ils(r.data.amount)}.${credit}` });
    setConfirmed(false);
    onChange();
  };
  return (
    <Block title="החזר" sub={`אפשר להחזיר עד ${ils(left)}`}>
      {d.refunds.length > 0 && <ul className="mb-3 space-y-1 text-sm">{d.refunds.map((r) => <li key={r.id}>{when(r.at)} · {ils(r.amount)}{r.restock ? ' · חזר למלאי' : ''}{r.reason ? ` · ${r.reason}` : ''}</li>)}</ul>}
      <div role="radiogroup" aria-label="מה מחזירים" className="mb-3 flex flex-wrap gap-2">
        {([['full', 'הכול'], ['items', 'פריטים'], ['amount', 'סכום']] as const).map(([k, t]) => (
          <button key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => setMode(k)}
            className={cx('min-h-11 rounded-full border px-4 text-sm font-semibold', mode === k ? 'border-ink bg-ink text-white' : 'border-line')}>{t}</button>
        ))}
      </div>
      {mode === 'items' && (
        <ul className="mb-3 space-y-2">
          {d.saleItems.map((x, i) => (
            <li key={i} className="flex items-center justify-between gap-2 text-sm">
              <span>{x.name} · {ils(x.price)} (נקנו {x.qty})</span>
              <Input type="number" min={0} max={x.qty} value={qty[i] ?? 0} aria-label={`כמה מ${x.name}`} className="w-20"
                onChange={(e) => setQty((q) => q.map((n, j) => (j === i ? Math.max(0, Math.min(x.qty, Number(e.target.value) || 0)) : n)))} />
            </li>
          ))}
        </ul>
      )}
      {mode === 'amount' && <Field label="סכום להחזר (₪)"><Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></Field>}
      {mode !== 'amount' && <label className="mb-3 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> המוצרים חוזרים למלאי</label>}
      <Field label="סיבה (לא חובה)"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></Field>
      <label className="mb-3 flex min-h-11 items-start gap-2 text-sm font-semibold">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
        ההחזר בוצע בממשק של חברת הסליקה (הכסף כבר חזר לכרטיס של הלקוח)
      </label>
      <Button type="button" variant="primary" disabled={busy || !confirmed} onClick={() => void send()}>{busy ? 'רושם…' : 'רישום ההחזר'}</Button>
      {msg && <p className={cx('mt-2 text-sm', msg.ok ? 'text-ok' : 'text-red-600')} role="status">{msg.text}</p>}
    </Block>
  );
}
