import type { Metadata } from 'next';
import { Art } from '@/components/ui';
import { data } from '@/lib/data';
import { liveSite } from '@/lib/site';

type Props = { params: Promise<{ host: string }> };

export const metadata: Metadata = { title: 'קולקציות', alternates: { canonical: '/collections' } };

export default async function CollectionsPage({ params }: Props) {
  const site = await liveSite((await params).host);
  const list = (await data.collections(site.storeId, site.preview)) ?? [];
  return (
    <div className="wrap">
      <header className="page-head"><h1 className="page-title">קולקציות</h1></header>
      <ul className="tiles" role="list">
        <li>
          <a href="/collections/all" className="tile">
            <span className="tile-media"><Art className="tile-art" /></span>
            <span className="tile-title">כל המוצרים</span>
          </a>
        </li>
        {list.map((c) => (
          <li key={c.slug}>
            <a href={`/collections/${encodeURIComponent(c.slug)}`} className="tile">
              <span className="tile-media">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {c.image_url ? <img src={c.image_url} alt="" loading="lazy" decoding="async" /> : <Art className="tile-art" />}
              </span>
              <span className="tile-title">{c.title}</span>
              <span className="tile-count">{c.count === 1 ? 'מוצר אחד' : `${c.count} מוצרים`}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
