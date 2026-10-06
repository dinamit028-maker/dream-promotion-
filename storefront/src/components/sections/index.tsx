import { data } from '@/lib/data';
import { whatsappHref } from '@/lib/format';
import type { Site } from '@/lib/site';
import { safeImage, type Section } from '@/lib/theme';
import type { Store } from '@/lib/types';
import { resolveHref } from '../chrome';
import { BagArt, ProductGrid } from '../ui';

type S = Record<string, unknown>;
const str = (s: S, k: string) => (typeof s[k] === 'string' ? (s[k] as string) : '');
type Live = Site & { store: Store };

function Button({ label, href, store, kind = 'primary' }: { label: string; href: string; store: Store; kind?: 'primary' | 'ghost' }) {
  const to = label ? resolveHref(href, store) : null;
  if (!to) return null;
  const ext = /^https:\/\//.test(to);
  return <a className={`btn btn-${kind}`} href={to} {...(ext ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{label}</a>;
}

function Hero({ s, site, first }: { s: S; site: Live; first: boolean }) {
  const img = safeImage(s.image);
  const Title = first ? 'h1' : 'h2';
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="wrap hero-grid">
        <div className="hero-text">
          {str(s, 'eyebrow') && <p className="eyebrow">{str(s, 'eyebrow')}</p>}
          <Title id="hero-title" className="hero-title">{str(s, 'title') || site.store.name}</Title>
          {str(s, 'subtitle') && <p className="hero-sub">{str(s, 'subtitle')}</p>}
          <div className="actions">
            <Button label={str(s, 'primaryLabel')} href={str(s, 'primaryHref')} store={site.store} />
            <Button label={str(s, 'secondaryLabel')} href={str(s, 'secondaryHref')} store={site.store} kind="ghost" />
          </div>
        </div>
        <div className="hero-media">
          {img
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={img} alt="" className="hero-img" loading="eager" fetchPriority="high" decoding="async" />
            : <BagArt />}
        </div>
      </div>
    </section>
  );
}

async function CollectionsSection({ s, site, id }: { s: S; site: Live; id: string }) {
  const list = (await data.collections(site.storeId, site.preview)) ?? [];
  if (!list.length) return null;
  return (
    <section className="band" aria-labelledby={`${id}-t`}>
      <div className="wrap">
        <h2 id={`${id}-t`} className="band-title">{str(s, 'title') || 'קולקציות'}</h2>
        {str(s, 'subtitle') && <p className="muted">{str(s, 'subtitle')}</p>}
        <ul className="tiles" role="list">
          {list.map((c) => (
            <li key={c.slug}>
              <a href={`/collections/${encodeURIComponent(c.slug)}`} className="tile">
                <span className="tile-media">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {c.image_url ? <img src={c.image_url} alt="" loading="lazy" decoding="async" /> : <BagArt className="tile-art" />}
                </span>
                <span className="tile-title">{c.title}</span>
                <span className="tile-count">{c.count === 1 ? 'מוצר אחד' : `${c.count} מוצרים`}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

async function ProductsSection({ s, site, id }: { s: S; site: Live; id: string }) {
  const collection = str(s, 'collection');
  const limit = typeof s.limit === 'number' ? s.limit : 8;
  const list = await data.products(site.storeId, { collection: collection || undefined, limit, sort: collection ? undefined : 'newest' }, site.preview);
  if (!list?.items.length) return null;
  const more = collection ? `/collections/${encodeURIComponent(collection)}` : '/collections/all';
  return (
    <section className="band" aria-labelledby={`${id}-t`}>
      <div className="wrap">
        <div className="band-head">
          <h2 id={`${id}-t`} className="band-title">{str(s, 'title') || 'מוצרים'}</h2>
          {list.total > list.items.length && <a href={more} className="more">{str(s, 'buttonLabel') || 'לכל המוצרים'}</a>}
        </div>
        <ProductGrid items={list.items} currency={site.store.currency} />
      </div>
    </section>
  );
}

function ImageText({ s, site, id }: { s: S; site: Live; id: string }) {
  const img = safeImage(s.image);
  return (
    <section className="band band-soft" aria-labelledby={`${id}-t`}>
      <div className={`wrap split${str(s, 'imageSide') === 'end' ? ' split-end' : ''}`}>
        <div className="split-media">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {img ? <img src={img} alt="" loading="lazy" decoding="async" /> : <BagArt />}
        </div>
        <div className="split-text">
          <h2 id={`${id}-t`} className="band-title">{str(s, 'title')}</h2>
          {str(s, 'text').split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
          <Button label={str(s, 'buttonLabel')} href={str(s, 'buttonHref')} store={site.store} kind="ghost" />
        </div>
      </div>
    </section>
  );
}

function Steps({ s, id }: { s: S; id: string }) {
  const items = (Array.isArray(s.items) ? s.items : []) as { title: string; text: string }[];
  if (!items.length) return null;
  return (
    <section className="band" aria-labelledby={`${id}-t`}>
      <div className="wrap">
        <h2 id={`${id}-t`} className="band-title">{str(s, 'title')}</h2>
        <ol className="steps">
          {items.map((it, i) => (
            <li key={i} className="step"><span className="step-n" aria-hidden="true">{i + 1}</span><h3>{it.title}</h3>{it.text && <p>{it.text}</p>}</li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Faq({ s, id }: { s: S; id: string }) {
  const items = (Array.isArray(s.items) ? s.items : []) as { q: string; a: string }[];
  if (!items.length) return null;
  return (
    <section className="band" aria-labelledby={`${id}-t`}>
      <div className="wrap narrow">
        <h2 id={`${id}-t`} className="band-title">{str(s, 'title')}</h2>
        <div className="faq">
          {items.map((it, i) => <details key={i}><summary>{it.q}</summary><p>{it.a}</p></details>)}
        </div>
      </div>
    </section>
  );
}

function Contact({ s, site, id }: { s: S; site: Live; id: string }) {
  const c = site.store.contact;
  const wa = whatsappHref(c.whatsapp, `היי, הגעתי מהאתר של ${site.store.name}`);
  if (!wa && !c.phone && !c.email) return null;
  return (
    <section className="band band-ink" id="contact" aria-labelledby={`${id}-t`}>
      <div className="wrap narrow center">
        <h2 id={`${id}-t`} className="band-title">{str(s, 'title') || 'יצירת קשר'}</h2>
        {str(s, 'text') && <p>{str(s, 'text')}</p>}
        <div className="actions center">
          {wa && <a className="btn btn-light" href={wa} target="_blank" rel="noopener noreferrer">וואטסאפ</a>}
          {c.phone && <a className="btn btn-outline-light" href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}><bdi>{c.phone}</bdi></a>}
          {c.email && <a className="btn btn-outline-light" href={`mailto:${c.email}`}><bdi>{c.email}</bdi></a>}
        </div>
      </div>
    </section>
  );
}

function TextSection({ s, id }: { s: S; id: string }) {
  if (!str(s, 'title') && !str(s, 'text')) return null;
  return (
    <section className="band" aria-labelledby={`${id}-t`}>
      <div className="wrap narrow">
        {str(s, 'title') && <h2 id={`${id}-t`} className="band-title">{str(s, 'title')}</h2>}
        {str(s, 'text').split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
      </div>
    </section>
  );
}

/** one section of the template, by its type */
export function SectionView({ section, site, first }: { section: Section; site: Live; first: boolean }) {
  const { settings: s, id } = section;
  switch (section.type) {
    case 'hero': return <Hero s={s} site={site} first={first} />;
    case 'collections': return <CollectionsSection s={s} site={site} id={id} />;
    case 'products': return <ProductsSection s={s} site={site} id={id} />;
    case 'imageText': return <ImageText s={s} site={site} id={id} />;
    case 'steps': return <Steps s={s} id={id} />;
    case 'faq': return <Faq s={s} id={id} />;
    case 'contact': return <Contact s={s} site={site} id={id} />;
    case 'text': return <TextSection s={s} id={id} />;
    default: return null;
  }
}

