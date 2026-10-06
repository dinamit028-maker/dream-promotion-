import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { CheckoutForm } from '@/components/CheckoutForm';
import { data } from '@/lib/data';
import { money } from '@/lib/format';
import { cartToken, shopSite } from '@/lib/shop';
import { hashToken } from '@/lib/tokens';

export const metadata: Metadata = { title: 'תשלום', robots: { index: false, follow: false } };
type Props = { params: Promise<{ host: string }> };

export default async function CheckoutPage({ params }: Props) {
  const site = await shopSite((await params).host);
  if (!site) notFound();
  const token = await cartToken();
  const cart = token ? await data.cart(site.storeId, hashToken(token), site.preview) : null;
  if (!cart?.can_checkout) redirect('/cart');
  return (
    <div className="wrap narrow">
      <header className="page-head"><h1 className="page-title">פרטים ותשלום</h1></header>
      <details className="order-peek">
        <summary>{cart.count} פריטים · <bdi>{money(cart.subtotal - cart.discount, cart.currency)}</bdi></summary>
        <ul role="list">
          {cart.lines.map((l) => (
            <li key={`${l.item}:${l.variant ?? ''}`}>{l.qty} × {l.name}{l.variant_label ? ` — ${l.variant_label}` : ''} · <bdi>{money(l.line_total, cart.currency)}</bdi></li>
          ))}
        </ul>
        <a href="/cart">עריכת הסל</a>
      </details>
      <CheckoutForm cart={cart} hasTerms={site.store.policies.some((p) => p.policy === 'terms')} />
    </div>
  );
}
