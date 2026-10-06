import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { CartCount } from '@/components/CartCount';
import { confirmOrder } from '@/lib/checkout';
import { data } from '@/lib/data';
import { money } from '@/lib/format';
import { getSite, hostOf } from '@/lib/site';
import { hashToken, isToken, shopperKey } from '@/lib/tokens';
import type { OrderView } from '@/lib/types';

/**
 * Back from the payment page (?o=<the order's token>). What the provider put in the address is ignored: the server asks the
 * provider itself about the order's page, and shows what the database then says.
 */
export const metadata: Metadata = { title: 'ההזמנה שלך', robots: { index: false, follow: false }, referrer: 'no-referrer' };
type Props = { params: Promise<{ host: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ReturnPage({ params, searchParams }: Props) {
  const site = await getSite(hostOf((await params).host));
  const o = (await searchParams).o;
  if (!site?.live || !isToken(o)) notFound();
  let order = await data.order(site.storeId, hashToken(o));
  if (!order) notFound();
  if (['pending', 'expired', 'failed'].includes(order.status) && order.page) {
    const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if ((await data.rateHit(`return:${shopperKey(ip, site.storeId)}`, 60, 20).catch(() => true)) !== false) {
      await confirmOrder(site.storeId, order, 'return');
      order = (await data.order(site.storeId, hashToken(o))) ?? order;
    }
  }
  return (
    <div className="wrap narrow order-page">
      <Status order={order} />
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
        </dl>
      </section>
      <p><a href="/">חזרה לחנות</a></p>
    </div>
  );
}

function Status({ order }: { order: OrderView }) {
  if (order.status === 'paid' || order.status === 'test_paid') {
    return (
      <header className="page-head" role="status">
        <h1 className="page-title">ההזמנה התקבלה</h1>
        <CartCount n={0} />
        <p>תודה, {order.name}! מספר ההזמנה: <bdi>{order.number}</bdi>.</p>
        {order.test && <p className="note note-test">זו הזמנת בדיקה: לא חויב כסף, לא נוצרה מכירה ולא הופק מסמך.</p>}
      </header>
    );
  }
  if (order.status === 'failed') {
    return (
      <header className="page-head" role="status">
        <h1 className="page-title">התשלום לא הושלם</h1>
        <p>לא חויב כסף. המוצרים מחכים לכם בסל.</p>
        <a href="/cart" className="btn btn-primary">חזרה לסל</a>
      </header>
    );
  }
  if (order.status === 'expired') {
    return (
      <header className="page-head" role="status">
        <h1 className="page-title">הזמן לתשלום עבר</h1>
        <p>לא קיבלנו אישור תשלום. אם חויבתם — צרו איתנו קשר ונבדוק. אפשר גם לנסות שוב מהסל.</p>
        <a href="/cart" className="btn btn-primary">חזרה לסל</a>
      </header>
    );
  }
  return (
    <header className="page-head" role="status">
      <h1 className="page-title">בודקים את התשלום…</h1>
      <p>זה לוקח בדרך כלל כמה שניות. אם חזרתם מעמוד התשלום לפני שסיימתם — אפשר לחזור לסל.</p>
      <div className="actions"><a href="" className="btn btn-primary">רענון</a><a href="/cart" className="btn btn-ghost">חזרה לסל</a></div>
    </header>
  );
}
