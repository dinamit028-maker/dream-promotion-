import { redirect } from 'next/navigation';

/** stage 1 has one screen — the products (the store's overview comes with orders, stage 4) */
export default function StorePage() { redirect('/store/products'); }
