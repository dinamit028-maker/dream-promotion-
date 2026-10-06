import type { Metadata } from 'next';
import { Filters, Results } from '@/components/listing';
import { data } from '@/lib/data';
import { parseQuery } from '@/lib/query';
import { liveSite } from '@/lib/site';

type SP = Record<string, string | string[] | undefined>;
type Props = { params: Promise<{ host: string }>; searchParams: Promise<SP> };

// a page of results is never indexed (its links are followed)
export const metadata: Metadata = { title: 'חיפוש', robots: { index: false, follow: true } };

export default async function SearchPage({ params, searchParams }: Props) {
  const site = await liveSite((await params).host);
  const sp = await searchParams;
  const { page, ...q } = parseQuery(sp);
  const l = await data.products(site.storeId, q, site.preview);
  return (
    <div className="wrap">
      <header className="page-head">
        <h1 className="page-title">{q.q ? <>חיפוש: <bdi>{q.q}</bdi></> : 'חיפוש'}</h1>
      </header>
      {l && (
        <>
          <Filters list={l} query={q} sp={sp} path="/search" sorts={['newest', 'price_asc', 'price_desc', 'name']} showSearch />
          {q.q || Object.keys(sp).length ? <Results list={l} currency={site.store.currency} page={page} path="/search" sp={sp} /> : <p className="empty">מה מחפשים? אפשר לכתוב שם של מוצר, סוג או מק״ט.</p>}
        </>
      )}
    </div>
  );
}
