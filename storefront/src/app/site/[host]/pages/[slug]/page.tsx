import { cache } from 'react';
import type { Metadata } from 'next';
import { RichText } from '@/components/ui';
import { data } from '@/lib/data';
import { excerpt } from '@/lib/format';
import { og } from '@/lib/seo';
import { decodeSlug, getSite, hostOf, liveSite, movedOr404 } from '@/lib/site';

type Props = { params: Promise<{ host: string; slug: string }> };
const page = cache((store: string, slug: string, preview: boolean) => data.page(store, 'page', slug, preview));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host, slug } = await params;
  const site = await getSite(hostOf(host));
  if (!site?.live) return {};
  const g = await page(site.storeId, decodeSlug(slug), site.preview);
  if (!g) return {};
  const path = `/pages/${encodeURIComponent(g.slug)}`;
  const description = g.seo_description || excerpt(g.body) || undefined;
  return { title: g.seo_title || g.title, description, alternates: { canonical: path }, openGraph: og(site, { url: path, title: g.seo_title || g.title, description }) };
}

export default async function ContentPage({ params }: Props) {
  const { host, slug } = await params;
  const site = await liveSite(host);
  const s = decodeSlug(slug);
  const g = await page(site.storeId, s, site.preview);
  if (!g) return movedOr404(site, `/pages/${s}`);
  return (
    <div className="wrap content-page">
      <header className="page-head"><h1 className="page-title">{g.title}</h1></header>
      <RichText text={g.body} />
    </div>
  );
}
