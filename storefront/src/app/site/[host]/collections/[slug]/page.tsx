import { cache } from 'react';
import { editLink } from '@/lib/edit';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Filters, Results } from '@/components/listing';
import { JsonLd } from '@/components/ui';
import { data } from '@/lib/data';
import { excerpt } from '@/lib/format';
import { parseQuery } from '@/lib/query';
import { breadcrumbsJsonLd, og } from '@/lib/seo';
import { decodeSlug, getSite, hostOf, liveSite, movedOr404 } from '@/lib/site';
import { isFullStore, type ProductQuery, type Sort } from '@/lib/types';

type SP = Record<string, string | string[] | undefined>;
type Props = { params: Promise<{ host: string; slug: string }>; searchParams: Promise<SP> };
const list = cache((store: string, q: string, preview: boolean) => data.products(store, JSON.parse(q) as ProductQuery, preview));

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { host, slug } = await params;
  const site = await getSite(hostOf(host));
  if (!site?.live || !isFullStore(site.store)) return {};
  const s = decodeSlug(slug);
  const sp = await searchParams;
  const filtered = Object.keys(sp).length > 0;
  const path = `/collections/${encodeURIComponent(s)}`;
  // a filtered list or a further page is never indexed; anything else keeps the layout's robots (a preview: noindex)
  const narrowed = filtered ? { robots: { index: false, follow: true } } : {};
  if (s === 'all') return { title: 'כל המוצרים', alternates: { canonical: path }, openGraph: og(site, { url: path, title: 'כל המוצרים' }), ...narrowed };
  const { page, ...q } = parseQuery(sp);
  const l = await list(site.storeId, JSON.stringify({ ...q, collection: s }), site.preview);
  const c = l?.collection;
  if (!c) return {};
  return {
    title: c.seo_title || c.title,
    description: c.seo_description || excerpt(c.description) || undefined,
    alternates: { canonical: path },
    openGraph: og(site, { url: path, title: c.seo_title || c.title, description: c.seo_description || excerpt(c.description), image: c.image_url || null }),
    ...(filtered || page > 1 ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function CollectionPage({ params, searchParams }: Props) {
  const { host, slug } = await params;
  const site = await liveSite(host);
  const s = decodeSlug(slug);
  const sp = await searchParams;
  const { page, ...q } = parseQuery(sp);
  const l = await list(site.storeId, JSON.stringify({ ...q, collection: s }), site.preview);
  if (!l) return movedOr404(site, `/collections/${s}`);
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const path = `/collections/${encodeURIComponent(s)}`;
  const title = l.collection?.title ?? 'כל המוצרים';
  const sorts: Sort[] = l.collection ? ['manual', 'newest', 'price_asc', 'price_desc', 'name'] : ['newest', 'price_asc', 'price_desc', 'name'];
  return (
    <div className="wrap" {...editLink(Boolean(site.edit) && Boolean(l.collection), `collection:${s}`)}>
      <JsonLd data={breadcrumbsJsonLd(site.origin, [{ name: 'דף הבית', path: '/' }, { name: title, path }])} nonce={nonce} />
      <nav className="crumbs" aria-label="פירורי לחם"><ol><li><a href="/">דף הבית</a></li><li><span aria-current="page">{title}</span></li></ol></nav>
      <header className="page-head">
        <h1 className="page-title">{title}</h1>
        {l.collection?.description && <p className="muted">{l.collection.description}</p>}
      </header>
      <Filters list={l} query={q} sp={sp} path={path} sorts={sorts} />
      <Results list={l} currency={site.store.currency} page={page} path={path} sp={sp} />
    </div>
  );
}
