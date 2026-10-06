import { money } from '@/lib/format';
import type { OrderView } from '@/lib/types';

/** an order's lines and sums — the "back from paying" page and the customer's order page */
export function OrderSummary({ order }: { order: OrderView }) {
  return (
    <section aria-labelledby="ol-t" className="order-lines">
      <h2 id="ol-t" className="summary-title">הזמנה {order.number}</h2>
      <ul role="list">
        {order.lines.map((l, i) => (
          <li key={i}><span>{l.qty} × {l.name}{l.variant ? ` — ${l.variant}` : ''}</span><bdi>{money(l.total, order.currency)}</bdi></li>
        ))}
      </ul>
      <dl className="sums">
        {order.discount > 0 && <div><dt>הנחה{order.coupon ? ` (${order.coupon})` : ''}</dt><dd><bdi>−{money(order.discount, order.currency)}</bdi></dd></div>}
        <div><dt>{order.method === 'delivery' ? 'משלוח' : 'איסוף עצמי'}</dt><dd>{order.shipping > 0 ? <bdi>{money(order.shipping, order.currency)}</bdi> : 'חינם'}</dd></div>
        <div className="sum-total"><dt>סה״כ</dt><dd><bdi>{money(order.total, order.currency)}</bdi></dd></div>
        {(order.refunded ?? 0) > 0 && <div><dt>הוחזר</dt><dd><bdi>−{money(order.refunded ?? 0, order.currency)}</bdi></dd></div>}
      </dl>
    </section>
  );
}
