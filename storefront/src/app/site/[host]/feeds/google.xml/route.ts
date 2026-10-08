import { data } from '@/lib/data';
import { shared } from '@/lib/shared-cache';
import { feedItems, feedXml } from '@/lib/feed';
import { getSite, hostOf } from '@/lib/site';
import type { Product } from '@/lib/types';

/**
 * /feeds/google.xml (2.60): the products of a store on the air for Google Merchant Center, which pulls it on a schedule.
 * The same doors as the sitemap (on the air, open to all, its primary address). Every product through sf_product — the
 * page's own data — a few at a time; cached for an hour at the edge, and a counter so the address cannot be hammered.
 */
const MAX_PRODUCTS = 1000, AT_ONCE = 8;
const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

export async function GET(_req: Request, { params }: { params: Promise<{ host: string }> }) {
  const site = await getSite(hostOf((await params).host));
  if (!site || site.via !== 'public' || site.locked || site.platform || !site.isPrimary) return notFound();
  if ((await data.rateHit(`feed:${site.storeId}`, 600, 30).catch(() => true)) === false) {
    return new Response('Too many requests', { status: 429, headers: { 'Retry-After': '600' } });
  }
  const map = await shared.sitemap(site.storeId);
  if (!map) return notFound();
  const store = site.store as { name?: string; currency?: string; description?: string };
  const o = { origin: site.origin, currency: store.currency || 'ILS', storeName: store.name ?? '', description: store.description ?? '' };
  const slugs = map.products.slice(0, MAX_PRODUCTS).map((p) => p.slug);
  const products: Product[] = [];
  for (let i = 0; i < slugs.length; i += AT_ONCE) {
    const got = await Promise.all(slugs.slice(i, i + AT_ONCE).map((s) => data.product(site.storeId, s, false).catch(() => null)));
    products.push(...got.filter((p): p is Product => Boolean(p)));
  }
  return new Response(feedXml(products.flatMap((p) => feedItems(p, o)), o), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=3600' },
  });
}
