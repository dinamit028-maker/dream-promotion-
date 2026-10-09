'use client';
import { use } from 'react';
import Link from 'next/link';
import { StoreOrder } from '@/features/store/StoreOrders';
import { storeHref } from '@/features/store/routes';

/** one order, on its own page */
export default function StoreOrderPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);   // Next 15: a page's params arrive as a promise
  return (
    <div className="mx-auto max-w-3xl">
      <Link href={storeHref('orders')} className="mb-3 inline-flex min-h-11 items-center text-sm font-semibold text-primary">→ כל ההזמנות</Link>
      <StoreOrder id={params.id} />
    </div>
  );
}
