'use client';
import Link from 'next/link';
import { StoreOrder } from '@/features/store/StoreOrders';
import { storeHref } from '@/features/store/routes';

/** one order, on its own page */
export default function StoreOrderPage({ params }: { params: { id: string } }) {
  return (
    <div className="mx-auto max-w-3xl">
      <Link href={storeHref('orders')} className="mb-3 inline-flex min-h-11 items-center text-sm font-semibold text-primary">→ כל ההזמנות</Link>
      <StoreOrder id={params.id} />
    </div>
  );
}
