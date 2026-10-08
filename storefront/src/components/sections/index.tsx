import { data } from '@/lib/data';
import { whatsappHref } from '@/lib/format';
import type { Site } from '@/lib/site';
import { safeImage, type Section } from '@/lib/theme';
import type { Store } from '@/lib/types';
import { resolveHref } from '../chrome';
import { Art, PlaceholderGrid, ProductGrid } from '../ui';
import { editField as F, editImage as I } from '@/lib/edit';
import { kitCollectionImage, kitGallery, kitHero, kitImage, type KitPicture } from '@/lib/kit-images';

type S = Record<string, unknown>;
const str = (s: S, k: string) => (typeof s[k] === 'string' ? (s[k] as string) : '');
type Live = Site & { store: Store };
const kitOf = (site: Live) => site.theme?.kit ?? null;

/** a default picture of the starter kit (2.62), where the business has none of its own yet; with a portrait one for phones (2.63) */
function KitImg({ pic, className, eager = false, mobile }: { pic: KitPicture; className?: string; eager?: boolean; mobile?: KitPicture | null }) {
  if (mobile) {
    return (
      <picture>
        <source media="(max-width: 699px)" srcSet={mobile.src} />
        <KitImg pic={{ ...pic, className: `${pic.className} ${mobile.className.replace('kimg-', 'kimg-m-')}` }} className={className} eager={eager} />
      </picture>
    );
  }
  // no width / height attributes: they would set a height the business's own pictures do not get (the CSS sizes both alike)
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={pic.src} alt={pic.alt} className={[className, pic.className].filter(Boolean).join(' ')}
    loading={eager ? 'eager' : 'lazy'} {...(eager ? { fetchPriority: 'high' as const } : {})} decoding="async" />;
}

function Button({ label, href, store, kind = 'primary' }: { label: string; href: string; store: Store; kind?: 'primary' | 'ghost' }) {
  const to = label ? resolveHref(href, store) : null;
  if (!to) return null;
  const ext = /^https:\/\//.test(to);
  return <a className={`btn btn-${kind}`} href={to} {...(ext ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{label}</a>;
}

/**
 * The hero (2.63 — variants): "split" (text and picture side by side, the look of 2.61), "full-image" (the picture across
 * the page, the text on its free side — textSafe) and "editorial" (a large title, the picture wide below it). On a phone
 * the kit's portrait picture replaces the wide one. Without any picture every variant falls back to "split" with the drawing.
 */
function Hero({ s, site, first, variant }: { s: S; site: Live; first: boolean; variant: string }) {
  const img = safeImage(s.image);
  const hero = img ? null : kitHero(kitOf(site));
  const kit = hero?.wide ?? null;
  const e = Boolean(site.edit);
  const Title = first ? 'h1' : 'h2';
  const v = img || kit ? variant || 'split' : 'split';
  const side = hero?.textSafe || 'start';
  const mobile = v !== 'split' ? hero?.mobile : null;
  return (
    <section className={`hero hero--${v} hero-safe-${side}`} aria-labelledby="hero-title">
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
            : kit ? <KitImg pic={kit} className="hero-img" eager mobile={mobile} /> : <Art />}
        </div>
      </div>
    </section>
  );
}

async function CollectionsSection({ s, site, id, variant }: { s: S; site: Live; id: string; variant: string }) {
  const list = (await data.collections(site.storeId, site.preview)) ?? [];
  if (!list.length) return null;
  return (
    <section className="band" id={id} aria-labelledby={`${id}-t`}>
      <div className="wrap">
        <h2 id={`${id}-t`} className="band-title" {...F(Boolean(site.edit), 'title')}>{str(s, 'title') || 'קולקציות'}</h2>
        {str(s, 'subtitle') && <p className="muted" {...F(Boolean(site.edit), 'subtitle')}>{str(s, 'subtitle')}</p>}
        <ul className={`tiles tiles--${variant || site.theme?.commerce.collectionCard || 'grid'}`} role="list">
          {list.map((c) => (
            <li key={c.slug}>
              <a href={`/collections/${encodeURIComponent(c.slug)}`} className="tile">
                <span className="tile-media">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {c.image_url ? <img src={c.image_url} alt="" loading="lazy" decoding="async" /> : <CollectionArt kit={kitOf(site)} slug={c.slug} />}
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

/** a collection's tile without a picture of its own: the kit's picture for it, else the drawing */
export function CollectionArt({ kit, slug }: { kit: string | null; slug: string }) {
  const pic = kitCollectionImage(kit, slug);
  return pic ? <KitImg pic={pic} /> : <Art className="tile-art" />;
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

function ImageText({ s, site, id, variant }: { s: S; site: Live; id: string; variant: string }) {
  const img = safeImage(s.image);
  const kit = img ? null : kitImage(kitOf(site), 'imageText');
  const e = Boolean(site.edit);
  return (
    <section className={`band band-soft it--${variant || 'split'}`} id={id} aria-labelledby={`${id}-t`}>
      <div className={`wrap split${str(s, 'imageSide') === 'end' ? ' split-end' : ''}`}>
        <div className="split-media" {...I(e, 'image')}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {img ? <img src={img} alt="" loading="lazy" decoding="async" /> : kit ? <KitImg pic={kit} /> : <Art />}
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

function Contact({ s, site, id, variant }: { s: S; site: Live; id: string; variant: string }) {
  const c = site.store.contact;
  const wa = whatsappHref(c.whatsapp, `היי, הגעתי מהאתר של ${site.store.name}`);
  if (!wa && !c.phone && !c.email) return null;
  const light = variant === 'centered';
  return (
    <section className={`band contact--${variant || 'dark'} ${variant === 'centered' ? 'band-soft' : 'band-ink'}`} id="contact" aria-labelledby={`${id}-t`}>
      <div className="wrap narrow center">
        <h2 id={`${id}-t`} className="band-title" {...F(Boolean(site.edit), 'title')}>{str(s, 'title') || 'יצירת קשר'}</h2>
        {str(s, 'text') && <p {...F(Boolean(site.edit), 'text')}>{str(s, 'text')}</p>}
        <div className="actions center">
          {wa && <a className={`btn ${light ? 'btn-primary' : 'btn-light'}`} href={wa} target="_blank" rel="noopener noreferrer">וואטסאפ</a>}
          {c.phone && <a className={`btn ${light ? 'btn-ghost' : 'btn-outline-light'}`} href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}><bdi>{c.phone}</bdi></a>}
          {c.email && <a className={`btn ${light ? 'btn-ghost' : 'btn-outline-light'}`} href={`mailto:${c.email}`}><bdi>{c.email}</bdi></a>}
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
 * preview shows where they will be — with the kit's pictures when it has some (2.62); a shopper sees the title and the button
 * only (or nothing, without a button either): a gallery says "this is us", so a stock picture is never shown to a shopper.
 */
function Gallery({ s, site, id, variant }: { s: S; site: Live; id: string; variant: string }) {
  const items = ((Array.isArray(s.items) ? s.items : []) as { image: string; caption: string }[]).filter((it) => safeImage(it.image));
  const button = str(s, 'buttonLabel') && resolveHref(str(s, 'buttonHref'), site.store) ? str(s, 'buttonLabel') : '';
  if (!items.length && !button && !site.preview) return null;
  const samples = !items.length && site.preview ? kitGallery(kitOf(site)) : [];
  return (
    <section className="band" id={id} aria-labelledby={`${id}-t`}>
      <div className="wrap">
        <h2 id={`${id}-t`} className="band-title" {...F(Boolean(site.edit), 'title')}>{str(s, 'title')}</h2>
        {str(s, 'text') && <p className="muted" {...F(Boolean(site.edit), 'text')}>{str(s, 'text')}</p>}
        {items.length > 0 ? (
          <ul className={`gallery gallery--${variant || 'grid'}`} role="list" {...F(Boolean(site.edit), 'items', false)}>
            {items.map((it, i) => (
              <li key={i} className="gallery-item">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={safeImage(it.image)!} alt={it.caption || ''} loading="lazy" decoding="async" />
                {it.caption && <span className="gallery-caption">{it.caption}</span>}
              </li>
            ))}
          </ul>
        ) : samples.length ? (
          <ul className={`gallery gallery--${variant || 'grid'}`} role="list" aria-label="מקום לתמונות" {...F(Boolean(site.edit), 'items', false)}>
            {samples.map((pic) => <li key={pic.src} className="gallery-item"><KitImg pic={pic} /><span className="gallery-caption muted">כאן תופיע תמונה שלכם</span></li>)}
          </ul>
        ) : site.preview ? (
          <ul className={`gallery gallery--${variant || 'grid'}`} role="list" aria-label="מקום לתמונות" {...F(Boolean(site.edit), 'items', false)}>
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
  const variant = section.variant ?? '';
  switch (section.type) {
    case 'hero': return <Hero s={s} site={site} first={first} variant={variant} />;
    case 'collections': return <CollectionsSection s={s} site={site} id={id} variant={variant} />;
    case 'products': return <ProductsSection s={s} site={site} id={id} />;
    case 'imageText': return <ImageText s={s} site={site} id={id} variant={variant} />;
    case 'steps': return <Steps s={s} id={id} e={Boolean(site.edit)} />;
    case 'faq': return <Faq s={s} id={id} e={Boolean(site.edit)} />;
    case 'contact': return <Contact s={s} site={site} id={id} variant={variant} />;
    case 'text': return <TextSection s={s} id={id} e={Boolean(site.edit)} />;
    case 'gallery': return <Gallery s={s} site={site} id={id} variant={variant} />;
    // the newsletter collects e-mail addresses only with consent to marketing — that is stage 5; until then it shows nothing
    case 'newsletter': return null;
    default: return null;
  }
}

