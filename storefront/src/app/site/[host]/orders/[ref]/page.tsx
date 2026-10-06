import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { OrderRequest } from '@/components/OrderRequest';
import { OrderSummary } from '@/components/OrderSummary';
import { FULFILLMENT_TEXT, orderOfRef } from '@/lib/orders';
import { getSite, hostOf } from '@/lib/site';

/**
 * The customer's order (Dream Commerce stage 4): its status, the goods, its document (a PDF on this domain), and a request to
 * cancel or return. Reached by the checkout's own link or the signed link in an email — never indexed, never by number alone.
 */
export const metadata: Metadata = { title: 'ההזמנה שלך', robots: { index: false, follow: false }, referrer: 'no-referrer' };
type Props = { params: Promise<{ host: string; ref: string }> };

export default async function OrderPage({ params }: Props) {
  const { host, ref } = await params;
  const site = await getSite(hostOf(host));
  if (!site?.live) notFound();
  const order = await orderOfRef(site.storeId, ref);
  if (!order) notFound();
  const paid = order.status === 'paid' || order.status === 'test_paid' || order.status === 'partially_refunded';
  return (
    <div className="wrap narrow order-page">
      <header className="page-head">
        <h1 className="page-title">הזמנה <bdi>{order.number}</bdi></h1>
        <p>{order.name}</p>
        {order.test && <p className="note note-test">זו הזמנת בדיקה: לא חויב כסף, לא נוצרה מכירה ולא הופק מסמך.</p>}
        {order.status === 'refunded' && <p className="note">ההזמנה הוחזרה, והכסף הוחזר לכרטיס שבו שילמתם.</p>}
        {!paid && order.status !== 'refunded' && <p className="note">ההזמנה עוד לא שולמה.</p>}
      </header>
      {paid && (
        <section aria-labelledby="st-t" className="order-status">
          <h2 id="st-t" className="summary-title">מה המצב</h2>
          <p role="status">{FULFILLMENT_TEXT[order.fulfillment ?? 'unfulfilled'] ?? FULFILLMENT_TEXT.unfulfilled}</p>
          {order.fulfillment === 'shipped' && order.tracking && (
            <p>מספר מעקב: <bdi dir="ltr">{order.tracking}</bdi>{order.tracking_url ? <> · <a href={order.tracking_url} target="_blank" rel="noopener noreferrer">מעקב אחר המשלוח</a></> : null}</p>
          )}
          {!order.test && (order.doc_token
            ? <p><a href={`/orders/${encodeURIComponent(ref)}/document`} target="_blank" rel="noopener">המסמך של ההזמנה (PDF)</a></p>
            : <p className="muted">החשבונית תופיע כאן בקרוב.</p>)}
        </section>
      )}
      <OrderSummary order={order} />
      {paid && (
        <section aria-labelledby="rq-t">
          <h2 id="rq-t" className="summary-title">ביטול או החזרה</h2>
          {order.request
            ? <p className="note">התקבלה בקשה ל{order.request === 'cancel' ? 'ביטול' : 'החזרה'}. נחזור אליכם.</p>
            : <><p className="muted">לפי <a href="/policies/returns">מדיניות הביטולים וההחזרות</a>. הבקשה נשלחת לחנות, והיא תחזור אליכם.</p><OrderRequest orderRef={ref} /></>}
        </section>
      )}
      <p><a href="/">חזרה לחנות</a></p>
    </div>
  );
}
