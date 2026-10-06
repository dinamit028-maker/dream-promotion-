import { cache } from 'react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { VariantPicker } from '@/components/VariantPicker';
import { JsonLd, Picture, ProductGrid, RichText } from '@/components/ui';
import { data } from '@/lib/data';
import { excerpt } from '@/lib/format';
import { breadcrumbsJsonLd, og, productJsonLd } from '@/lib/seo';
import { decodeSlug, getSite, hostOf, liveSite, movedOr404 } from '@/lib/site';
import { isFullStore } from '@/lib/types';

type Props = { params: Promise<{ host: string; slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
const product = cache((store: string, slug: string, preview: boolean) => data.product(store, slug, preview));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host, slug } = await params;
  const site = await getSite(hostOf(host));
  if (!site?.live || !isFullStore(site.store)) return {};
  const p = await product(site.storeId, decodeSlug(slug), site.preview);
  if (!p) return {};
  const path = `/products/${encodeURIComponent(p.slug)}`;
  const description = p.seo_description || excerpt(p.description) || undefined;
  const image = p.images[0] ? (p.images[0].sizes?.['1600'] || p.images[0].sizes?.['800'] || p.images[0].url) : undefined;
  return {
    title: p.seo_title || p.name,
    description,
    alternates: { canonical: path },
    openGraph: og(site, { url: path, title: p.seo_title || p.name, description, image }),
  };
}

export default async function ProductPage({ params, searchParams }: Props) {
  const { host, slug } = await params;
  const site = await liveSite(host);
  const s = decodeSlug(slug);
  const p = await product(site.storeId, s, site.preview);
  if (!p) return movedOr404(site, `/products/${s}`);
  const sp = await searchParams;
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const path = `/products/${encodeURIComponent(p.slug)}`;
  const crumbs = [{ name: 'דף הבית', path: '/' }, ...(p.collection ? [{ name: p.collection.title, path: `/collections/${encodeURIComponent(p.collection.slug)}` }] : []), { name: p.name, path }];
  const whatsapp = site.theme.product.whatsapp ? site.store.contact.whatsapp : '';
  const details = [
    ...p.fields.map((f) => ({ label: f.label, value: f.value })),
    ...(p.manufacturer ? [{ label: 'יצרן', value: p.manufacturer }] : []),
    ...(p.country_of_origin ? [{ label: 'ארץ ייצור', value: p.country_of_origin }] : []),
  ];
  return (
    <div className="wrap">
      <JsonLd data={productJsonLd(site, p)} nonce={nonce} />
      <JsonLd data={breadcrumbsJsonLd(site.origin, crumbs)} nonce={nonce} />
      <nav className="crumbs" aria-label="פירורי לחם">
        <ol>{crumbs.map((c, i) => <li key={c.path}>{i < crumbs.length - 1 ? <a href={c.path}>{c.name}</a> : <span aria-current="page">{c.name}</span>}</li>)}</ol>
      </nav>
      <article className="product">
        <div className="gallery" aria-label="תמונות המוצר">
          {p.images.length ? p.images.map((img, i) => (
            <figure key={img.id ?? img.url} id={img.id ? `img-${img.id}` : undefined}>
              <Picture pic={img} alt={img.alt || (i === 0 ? p.name : `${p.name} — תמונה ${i + 1}`)} sizes="(min-width: 900px) 55vw, 88vw" eager={i === 0} />
            </figure>
          )) : <div className="gallery-empty" aria-hidden="true" />}
        </div>
        <div className="product-info">
          <h1 className="product-title">{p.name}</h1>
          <VariantPicker product={p} currency={site.store.currency} whatsapp={whatsapp} pageUrl={`${site.origin}${path}`}
            initialVariant={typeof sp.variant === 'string' ? sp.variant : undefined} />
          {details.length > 0 && (
            <dl className="facts">{details.map((d) => <div key={d.label}><dt>{d.label}</dt><dd>{d.value}</dd></div>)}</dl>
          )}
          {p.description && <RichText text={p.description} />}
        </div>
      </article>
      {site.theme.product.related && p.related.length > 0 && (
        <section className="band related" aria-labelledby="related-t">
          <h2 id="related-t" className="band-title">אולי יעניין אותך גם</h2>
          <ProductGrid items={p.related} currency={site.store.currency} />
        </section>
      )}
    </div>
  );
}
