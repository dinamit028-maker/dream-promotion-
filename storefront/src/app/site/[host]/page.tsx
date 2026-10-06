import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { SectionView } from '@/components/sections';
import { JsonLd } from '@/components/ui';
import { editSection } from '@/lib/edit';
import { og, orgJsonLd } from '@/lib/seo';
import { getSite, hostOf, liveSite } from '@/lib/site';
import { isFullStore } from '@/lib/types';

type Props = { params: Promise<{ host: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const site = await getSite(hostOf((await params).host));
  if (!site?.live || !isFullStore(site.store)) return {};
  return {
    title: { absolute: site.store.name },
    alternates: { canonical: '/' },
    openGraph: og(site, { url: '/', title: site.store.name, description: site.store.description, image: site.store.logo_url || null }),
  };
}

export default async function Home({ params }: Props) {
  const site = await liveSite((await params).host);
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const sections = site.theme.sections.filter((s) => !s.hidden);
  return (
    <>
      <JsonLd data={orgJsonLd(site)} nonce={nonce} />
      {sections[0]?.type !== 'hero' && <h1 className="sr-only">{site.store.name}</h1>}
      {sections.map((s, i) => site.edit
        // the visual editor (2.61): each section is one element the owner clicks to edit
        ? <div key={s.id} {...editSection(true, s.id, s.type)}><SectionView section={s} site={site} first={i === 0} /></div>
        : <SectionView key={s.id} section={s} site={site} first={i === 0} />)}
    </>
  );
}
