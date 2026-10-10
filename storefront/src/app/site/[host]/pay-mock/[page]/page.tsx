import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { money } from '@/lib/format';
import { mockAllowed, mockPages } from '@/lib/pay/mock';

/** the pretend provider's payment page — local tests and development only (mockAllowed), never on Vercel */
export const metadata: Metadata = { robots: { index: false, follow: false } };
type Props = { params: Promise<{ host: string; page: string }> };

export default async function MockPay({ params }: Props) {
  if (!mockAllowed()) notFound();
  const { page } = await params;
  const p = mockPages.get(page);
  if (!p) notFound();
  return (
    <div className="wrap narrow">
      <h1 className="page-title">תשלום לבדיקה</h1>
      <p className="muted">עמוד מדומה של ספק הסליקה. לא מוזן כאן שום כרטיס.</p>
      <p>{p.req.itemName || `הזמנה ${p.req.number}`} · <bdi>{money(p.req.amount, p.req.currency)}</bdi></p>
      <div className="row-actions">
        <form method="post" action={`/api/pay-mock/${encodeURIComponent(page)}?a=approve`}><button className="btn btn-primary" type="submit">אישור התשלום</button></form>
        <form method="post" action={`/api/pay-mock/${encodeURIComponent(page)}?a=decline`}><button className="btn" type="submit">סירוב</button></form>
      </div>
    </div>
  );
}
