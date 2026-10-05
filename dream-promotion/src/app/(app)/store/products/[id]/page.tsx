'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ProductEditor } from '@/features/catalog/ProductEditor';
import type { EditorFocus } from '@/features/catalog/PublishSwitch';
import { productHref, storeHref } from '@/features/store/routes';

const FOCUS: EditorFocus[] = ['images', 'description', 'ai', 'variants', 'stock', 'online'];

/** one product, on its own page (a new one: /store/products/new) */
export default function StoreProductPage({ params, searchParams }: { params: { id: string }; searchParams: { focus?: string } }) {
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
