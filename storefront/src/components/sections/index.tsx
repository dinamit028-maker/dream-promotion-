import { data } from '@/lib/data';
import { whatsappHref } from '@/lib/format';
import type { Site } from '@/lib/site';
import { safeImage, type Section } from '@/lib/theme';
import type { Store } from '@/lib/types';
import { resolveHref } from '../chrome';
import { Art, PlaceholderGrid, ProductGrid } from '../ui';
import { editField as F, editImage as I } from '@/lib/edit';

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
  const e = Boolean(site.edit);
  const Title = first ? 'h1' : 'h2';
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="wrap hero-grid">
        <div className="hero-text">
          {str(s, 'eyebrow') && <p className="eyebrow" {...F(e, 'eyebrow')}>{str(s, 'eyebrow')}</p>}
          <Title id="hero-title" className="hero-title" {...F(e, 'title')}>{str(s, 'title') || site.store.name}</Title>
          {str(s, 'subtitle') && <p className="hero-sub" {...F(e, 'subtitle')}>{str(s, 'subtitle')}</p>}
          <div className="actions">
            <Button label={str(s, 'primaryLabel')} href={str(s, 'primaryHref')} store={site.store} />
            <Button label={str(s, 'secondaryLabel')} href={str(s, 'secondaryHref')} store={site.store} kind="ghost" />
          </div>
        </div>
        <div className="hero-media" {...I(e, 'image')}>
          {img
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={img} alt="" className="hero-img" loading="eager" fetchPriority="high" decoding="async" />
            : <Art />}
        </div>
      </div>
    </section>
  );
}

async function CollectionsSection({ s, site, id }: { s: S; site: Live; id: string }) {
  const list = (await data.collections(site.storeId, site.preview)) ?? [];
  if (!list.length) return null;
  return (
    <section className="band" id={id} aria-labelledby={`${id}-t`}>
      <div className="wrap">
        <h2 id={`${id}-t`} className="band-title" {...F(Boolean(site.edit), 'title')}>{str(s, 'title') || 'קולקציות'}</h2>
        {str(s, 'subtitle') && <p className="muted" {...F(Boolean(site.edit), 'subtitle')}>{str(s, 'subtitle')}</p>}
        <ul className="tiles" role="list">
          {list.map((c) => (
            <li key={c.slug}>
              <a href={`/collections/${encodeURIComponent(c.slug)}`} className="tile">
                <span className="tile-media">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {c.image_url ? <img src={c.image_url} alt="" loading="lazy" decoding="async" /> : <Art className="tile-art" />}
                </span>
                <span className="tile-title">{c.title}</span>
                {c.count > 0 && <span className="tile-count">{c.count === 1 ? 'מוצר אחד' : `${c.count} מוצרים`}</span>}
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
  // no products yet: the owner's preview shows where they will be; a shopper sees nothing
  if (!list?.items.length) {
    if (!site.preview) return null;
    return (
      <section className="band" id={id} aria-labelledby={`${id}-t`}>
        <div className="wrap">
          <h2 id={`${id}-t`} className="band-title" {...F(Boolean(site.edit), 'title')}>{str(s, 'title') || 'מוצרים'}</h2>
          <PlaceholderGrid count={Math.min(limit, 4)} />
        </div>
      </section>
    );
  }
  const more = collection ? `/collections/${encodeURIComponent(collection)}` : '/collections/all';
  return (
    <section className="band" id={id} aria-labelledby={`${id}-t`}>
      <div className="wrap">
        <div className="band-head">
          <h2 id={`${id}-t`} className="band-title" {...F(Boolean(site.edit), 'title')}>{str(s, 'title') || 'מוצרים'}</h2>
          {list.total > list.items.length && <a href={more} className="more">{str(s, 'buttonLabel') || 'לכל המוצרים'}</a>}
        </div>
        <ProductGrid items={list.items} currency={site.store.currency} />
      </div>
    </section>
  );
}

function ImageText({ s, site, id }: { s: S; site: Live; id: string }) {
  const img = safeImage(s.image);
  const e = Boolean(site.edit);
  return (
    <section className="band band-soft" id={id} aria-labelledby={`${id}-t`}>
      <div className={`wrap split${str(s, 'imageSide') === 'end' ? ' split-end' : ''}`}>
        <div className="split-media" {...I(e, 'image')}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {img ? <img src={img} alt="" loading="lazy" decoding="async" /> : <Art />}
        </div>
        <div className="split-text">
          <h2 id={`${id}-t`} className="band-title" {...F(e, 'title')}>{str(s, 'title')}</h2>
          <div {...F(e, 'text', false)}>{str(s, 'text').split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>
          <Button label={str(s, 'buttonLabel')} href={str(s, 'buttonHref')} store={site.store} kind="ghost" />
        </div>
      </div>
    </section>
  );
}

function Steps({ s, id, e }: { s: S; id: string; e: boolean }) {
  const items = (Array.isArray(s.items) ? s.items : []) as { title: string; text: string }[];
  if (!items.length) return null;
  return (
    <section className="band" id={id} aria-labelledby={`${id}-t`}>
      <div className="wrap">
        <h2 id={`${id}-t`} className="band-title" {...F(e, 'title')}>{str(s, 'title')}</h2>
        <ol className="steps" {...F(e, 'items', false)}>
          {items.map((it, i) => (
            <li key={i} className="step"><span className="step-n" aria-hidden="true">{i + 1}</span><h3>{it.title}</h3>{it.text && <p>{it.text}</p>}</li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Faq({ s, id, e }: { s: S; id: string; e: boolean }) {
  const items = (Array.isArray(s.items) ? s.items : []) as { q: string; a: string }[];
  if (!items.length) return null;
  return (
    <section className="band" id={id} aria-labelledby={`${id}-t`}>
      <div className="wrap narrow">
        <h2 id={`${id}-t`} className="band-title" {...F(e, 'title')}>{str(s, 'title')}</h2>
        <div className="faq" {...F(e, 'items', false)}>
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
        <h2 id={`${id}-t`} className="band-title" {...F(Boolean(site.edit), 'title')}>{str(s, 'title') || 'יצירת קשר'}</h2>
        {str(s, 'text') && <p {...F(Boolean(site.edit), 'text')}>{str(s, 'text')}</p>}
        <div className="actions center">
          {wa && <a className="btn btn-light" href={wa} target="_blank" rel="noopener noreferrer">וואטסאפ</a>}
          {c.phone && <a className="btn btn-outline-light" href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}><bdi>{c.phone}</bdi></a>}
          {c.email && <a className="btn btn-outline-light" href={`mailto:${c.email}`}><bdi>{c.email}</bdi></a>}
        </div>
      </div>
    </section>
  );
}

function TextSection({ s, id, e }: { s: S; id: string; e: boolean }) {
  if (!str(s, 'title') && !str(s, 'text')) return null;
  return (
    <section className="band" aria-labelledby={`${id}-t`}>
      <div className="wrap narrow">
        {str(s, 'title') && <h2 id={`${id}-t`} className="band-title" {...F(e, 'title')}>{str(s, 'title')}</h2>}
        <div {...F(e, 'text', false)}>{str(s, 'text').split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>
      </div>
    </section>
  );
}

/**
 * 2.58: pictures with a caption — before / after, Instagram, a lookbook — and a button. With no picture yet, the owner's
 * preview shows where they will be; a shopper sees the title and the button only (or nothing, without a button either).
 */
function Gallery({ s, site, id }: { s: S; site: Live; id: string }) {
  const items = ((Array.isArray(s.items) ? s.items : []) as { image: string; caption: string }[]).filter((it) => safeImage(it.image));
  const button = str(s, 'buttonLabel') && resolveHref(str(s, 'buttonHref'), site.store) ? str(s, 'buttonLabel') : '';
  if (!items.length && !button && !site.preview) return null;
  return (
    <section className="band" id={id} aria-labelledby={`${id}-t`}>
      <div className="wrap">
        <h2 id={`${id}-t`} className="band-title" {...F(Boolean(site.edit), 'title')}>{str(s, 'title')}</h2>
        {str(s, 'text') && <p className="muted" {...F(Boolean(site.edit), 'text')}>{str(s, 'text')}</p>}
        {items.length > 0 ? (
          <ul className="gallery" role="list" {...F(Boolean(site.edit), 'items', false)}>
            {items.map((it, i) => (
              <li key={i} className="gallery-item">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={safeImage(it.image)!} alt={it.caption || ''} loading="lazy" decoding="async" />
                {it.caption && <span className="gallery-caption">{it.caption}</span>}
              </li>
            ))}
          </ul>
        ) : site.preview ? (
          <ul className="gallery" role="list" aria-label="מקום לתמונות" {...F(Boolean(site.edit), 'items', false)}>
            {[0, 1, 2, 3].map((i) => <li key={i} className="gallery-item gallery-empty"><Art /><span className="gallery-caption muted">כאן תופיע תמונה</span></li>)}
          </ul>
        ) : null}
        {button && <div className="actions"><Button label={button} href={str(s, 'buttonHref')} store={site.store} kind="ghost" /></div>}
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
    case 'steps': return <Steps s={s} id={id} e={Boolean(site.edit)} />;
    case 'faq': return <Faq s={s} id={id} e={Boolean(site.edit)} />;
    case 'contact': return <Contact s={s} site={site} id={id} />;
    case 'text': return <TextSection s={s} id={id} e={Boolean(site.edit)} />;
    case 'gallery': return <Gallery s={s} site={site} id={id} />;
    // the newsletter collects e-mail addresses only with consent to marketing — that is stage 5; until then it shows nothing
    case 'newsletter': return null;
    default: return null;
  }
}

