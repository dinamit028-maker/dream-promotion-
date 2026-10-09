'use client';
import { use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ProductEditor } from '@/features/catalog/ProductEditor';
import type { EditorFocus } from '@/features/catalog/PublishSwitch';
import { productHref, storeHref } from '@/features/store/routes';

const FOCUS: EditorFocus[] = ['images', 'description', 'ai', 'variants', 'stock', 'online'];

/** one product, on its own page (a new one: /store/products/new) */
export default function StoreProductPage(props: { params: Promise<{ id: string }>; searchParams: Promise<{ focus?: string }> }) {
  // Next 15: a page's params and searchParams arrive as promises
  const params = use(props.params), searchParams = use(props.searchParams);
  const router = useRouter();
  const isNew = params.id === 'new';
  const focus = FOCUS.find((f) => f === searchParams?.focus);
  return (
    <div className="mx-auto max-w-3xl">
      <Link href={storeHref('products')} className="mb-3 inline-flex min-h-11 items-center text-sm font-semibold text-primary">→ כל המוצרים</Link>
      <ProductEditor itemId={isNew ? null : params.id} focus={focus}
        onSaved={(it) => { if (isNew) router.replace(productHref(it.id)); }}
        onDeleted={() => router.push(storeHref('products'))} />
    </div>
  );
}
