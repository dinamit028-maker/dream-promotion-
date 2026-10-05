'use client';
import { ProductsScreen } from '@/features/catalog/ProductsScreen';
import { productHref } from '@/features/store/routes';

export default function StoreProductsPage() {
  return <ProductsScreen title="מוצרים" editHref={productHref} />;
}
