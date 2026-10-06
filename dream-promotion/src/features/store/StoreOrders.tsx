'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { PageHead, Pill } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { eventText, ORDER_FILTERS, orderLabel, type OrderEvent, type OrderLine, type OrderRow } from './checkout';
import { loadOrder, loadOrders } from './data';
import { orderHref, storeHref } from './routes';
import { Block, Notice } from './ui';

/**
 * "הזמנות" (2.56, basic): the orders from the site — number, customer, sum, status — and one order with its lines and its
 * timeline. Read only: what changes an order is the payment provider's answer (stage 3), and from stage 4 the handling,
 * the document and refunds. A cashier sees nothing here (the database), a viewer reads.
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
      <PageHead title="הזמנות" sub="ההזמנות מהאתר. בשלב הזה כולן הזמנות בדיקה: בלי חיוב אמיתי, בלי מכירה ובלי מסמך." />
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
  const [d, setD] = useState<{ order: OrderRow; lines: OrderLine[]; events: OrderEvent[] } | null | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => { void loadOrder(id).then((r) => (r.ok ? setD(r.data) : setError(r.error))); }, [id]);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (d === undefined) return <p className="flex items-center gap-2 text-muted"><Spinner /> טוען…</p>;
  if (d === null) return <Notice tone="warn">ההזמנה לא נמצאה (אולי של עסק אחר).</Notice>;
  const { order: o, lines, events } = d;
  const l = orderLabel(o);
  const a = o.address;
  return (
    <>
      <PageHead title={`הזמנה #${o.number}`} sub={when(o.createdAt)} action={<Pill tone={TONE[l.tone]}>{l.text}</Pill>} />
      {o.isTest && <Notice tone="warn">הזמנת בדיקה: לא חויב כסף, לא נוצרה מכירה, המלאי לא זז ולא הופק מסמך.</Notice>}
      <Block title="הקונה">
        <p className="font-semibold">{o.customerName}</p>
        <p><a href={`tel:${o.customerPhone}`} className="text-primary" dir="ltr">{o.customerPhone}</a> · <a href={`mailto:${o.customerEmail}`} className="text-primary" dir="ltr">{o.customerEmail}</a></p>
        <p className="mt-2 text-sm">{o.deliveryMethod === 'delivery' ? `משלוח: ${[a.street, a.house].filter(Boolean).join(' ')}${a.apartment ? `, דירה ${a.apartment}` : ''}, ${a.city ?? ''}` : 'איסוף עצמי'}</p>
        {o.notes && <p className="mt-2 rounded-md bg-surface-2 p-3 text-sm">{o.notes}</p>}
      </Block>
      <Block title="המוצרים">
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
        </dl>
      </Block>
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
