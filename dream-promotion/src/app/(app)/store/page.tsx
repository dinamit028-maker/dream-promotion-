import { redirect } from 'next/navigation';

/** the store opens at its products (the store's overview comes with orders, stage 4) */
export default function StorePage() { redirect('/store/products'); }
