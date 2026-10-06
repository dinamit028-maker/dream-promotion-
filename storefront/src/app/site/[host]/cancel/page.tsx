import type { Metadata } from 'next';
import { OrderRequest } from '@/components/OrderRequest';
import { liveSite } from '@/lib/site';

/**
 * "ביטול עסקה": a way to ask to cancel (or return) an order made on the site, with its number and the email it was made
 * with — also without the order's link. NEEDS_LEGAL_VERIFICATION: what the consumer-protection law requires of this page
 * (the wording, what else to ask) is the lawyer's.
 */
export const metadata: Metadata = { title: 'ביטול עסקה', robots: { index: false, follow: true } };
type Props = { params: Promise<{ host: string }> };

export default async function CancelPage({ params }: Props) {
  const site = await liveSite((await params).host);
  return (
    <div className="wrap narrow">
      <header className="page-head">
        <h1 className="page-title">ביטול עסקה</h1>
        <p>הזמנתם ב{site.store.name} ורוצים לבטל או להחזיר? מלאו את מספר ההזמנה ואת האימייל שאיתו הזמנתם. הבקשה נשלחת לחנות, והיא תחזור אליכם.</p>
        <p className="muted">הפרטים המלאים ב<a href="/policies/returns">מדיניות הביטולים וההחזרות</a>.</p>
      </header>
      <OrderRequest />
    </div>
  );
}
