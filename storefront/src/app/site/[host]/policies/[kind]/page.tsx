import { cache } from 'react';
import { editLink } from '@/lib/edit';
import type { Metadata } from 'next';
import { RichText } from '@/components/ui';
import { data } from '@/lib/data';
import { excerpt } from '@/lib/format';
import { og } from '@/lib/seo';
import { getSite, hostOf, liveSite, movedOr404 } from '@/lib/site';
import { POLICY_KINDS, type PolicyKind } from '@/lib/types';

/** a policy of the store (returns, privacy, accessibility…) — the business's own text, written in the dashboard */
type Props = { params: Promise<{ host: string; kind: string }> };
const policy = cache((store: string, kind: string, preview: boolean) => data.page(store, 'policy', kind, preview));
const known = (k: string): k is PolicyKind => (POLICY_KINDS as readonly string[]).includes(k);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host, kind } = await params;
  const site = await getSite(hostOf(host));
  if (!site?.live || !known(kind)) return {};
  const g = await policy(site.storeId, kind, site.preview);
  if (!g) return {};
  const description = g.seo_description || excerpt(g.body) || undefined;
  return { title: g.seo_title || g.title, description, alternates: { canonical: `/policies/${kind}` }, openGraph: og(site, { url: `/policies/${kind}`, title: g.seo_title || g.title, description }) };
}

export default async function PolicyPage({ params }: Props) {
  const { host, kind } = await params;
  const site = await liveSite(host);
  const g = known(kind) ? await policy(site.storeId, kind, site.preview) : null;
  if (!g) return movedOr404(site, `/policies/${kind}`);
  return (
    <div className="wrap content-page" {...editLink(Boolean(site.edit), `page:policy:${kind}`)}>
      <header className="page-head">
        <h1 className="page-title">{g.title}</h1>
        <p className="muted">עודכן: <time dateTime={g.updated_at}>{new Date(g.updated_at).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' })}</time></p>
      </header>
      <RichText text={g.body} />
    </div>
  );
}
