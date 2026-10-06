import { documentPdf } from '@/lib/dashboard';
import { orderOfRef } from '@/lib/orders';
import { getSite, hostOf } from '@/lib/site';

/**
 * The order's document (PDF) on the business's own domain: the order is found by the customer's link, its document's share
 * token is read from the database, and the file comes from the dashboard's server (its address never reaches the customer).
 */
type Ctx = { params: Promise<{ host: string; ref: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { host, ref } = await params;
  const site = await getSite(hostOf(host));
  const none = () => new Response('המסמך לא נמצא.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (!site?.live) return none();
  const order = await orderOfRef(site.storeId, ref);
  if (!order?.doc_token) return none();
  const r = await documentPdf(order.doc_token);
  if (!r?.body) return none();
  return new Response(r.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="order-${order.number}.pdf"`,
      'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer',
    },
  });
}
