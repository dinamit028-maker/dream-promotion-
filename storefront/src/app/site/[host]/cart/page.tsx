import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CartView } from '@/components/CartView';
import { data } from '@/lib/data';
import { cartToken, shopSite } from '@/lib/shop';
import { hashToken, newToken } from '@/lib/tokens';

export const metadata: Metadata = { title: 'סל הקניות', robots: { index: false, follow: false } };
type Props = { params: Promise<{ host: string }> };

export default async function CartPage({ params }: Props) {
  const site = await shopSite((await params).host);
  if (!site) notFound();
  const cart = await data.cart(site.storeId, hashToken((await cartToken()) ?? newToken()), site.preview);
  if (!cart) notFound();
  return (
    <div className="wrap">
      <header className="page-head"><h1 className="page-title">סל הקניות</h1></header>
      <CartView initial={cart} />
    </div>
  );
}
