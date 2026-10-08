import { data } from '@/lib/data';
import { whatsappHref } from '@/lib/format';
import type { Site } from '@/lib/site';
import { safeImage, type Section } from '@/lib/theme';
import type { Block, Column } from '@/lib/builder-registry';
import type { Store } from '@/lib/types';
import { resolveHref } from '../chrome';
import { Art, PlaceholderGrid, ProductGrid } from '../ui';
import { editBlock, editColumn, editField as F, editImage as I } from '@/lib/edit';
import { kitCollectionImage, kitCollectionPictures, kitGallery, kitHero, kitImage, type KitPicture } from '@/lib/kit-images';

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
  // the kit's second wide picture when the owner chose it (kitImage 2), else its first
  const kit = (s.kitImage === 2 ? hero?.second : null) ?? hero?.wide ?? null;
  const e = Boolean(site.edit);
  const Title = first ? 'h1' : 'h2';
  const v = img || kit ? variant || 'split' : 'split';
  const side = hero?.textSafe || 'start';
  const mobile = v !== 'split' && v !== 'slider' ? hero?.mobile : null;
  // a slider (2.63): the kit's two wide pictures, side by side in one row that scrolls (no script); the business's picture is one
  const slides = v === 'slider' && kit && hero?.second ? [kit, hero.second] : null;
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
            : slides ? <div className="hero-slides" role="group" aria-label="תמונות">{slides.map((p, i) => <KitImg key={p.src} pic={p} className="hero-img" eager={i === 0} />)}</div>
            : kit ? <KitImg pic={kit} className="hero-img" eager mobile={mobile} /> : <Art />}
        </div>
      </div>
    </section>
  );
}

async function CollectionsSection({ s, site, id, variant }: { s: S; site: Live; id: string; variant: string }) {
  const list = (await data.collections(site.storeId, site.preview)) ?? [];
  // 2.69: no collections yet — the owner's preview shows where they will be (the kit's pictures, else drawings); a shopper nothing
  if (!list.length) {
    if (!site.preview) return null;
    const pics = kitCollectionPictures(kitOf(site));
    return (
      <section className="band" id={id} aria-labelledby={`${id}-t`}>
        <div className="wrap">
          <h2 id={`${id}-t`} className="band-title" {...F(Boolean(site.edit), 'title')}>{str(s, 'title') || 'קולקציות'}</h2>
          {str(s, 'subtitle') && <p className="muted" {...F(Boolean(site.edit), 'subtitle')}>{str(s, 'subtitle')}</p>}
          <ul className={`tiles tiles--${variant || site.theme?.commerce.collectionCard || 'grid'}`} role="list" aria-label="מקום לסוגי המוצרים">
            {(pics.length ? pics : [null, null, null]).map((pic, i) => (
              <li key={pic?.src ?? i}><span className="tile">
                <span className="tile-media">{pic ? <KitImg pic={pic} /> : <Art className="tile-art" />}</span>
                <span className="tile-title muted">כאן יופיע סוג מוצרים</span>
              </span></li>
            ))}
          </ul>
        </div>
      </section>
    );
  }
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

async function ProductsSection({ s, site, id, variant }: { s: S; site: Live; id: string; variant: string }) {
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
          <PlaceholderGrid count={Math.min(limit, 4)} layout={variant} />
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
        <ProductGrid items={list.items} currency={site.store.currency} layout={variant} />
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

function Steps({ s, id, e, variant }: { s: S; id: string; e: boolean; variant: string }) {
  const items = (Array.isArray(s.items) ? s.items : []) as { title: string; text: string }[];
  if (!items.length) return null;
  return (
    <section className="band" id={id} aria-labelledby={`${id}-t`}>
      <div className="wrap">
        <h2 id={`${id}-t`} className="band-title" {...F(e, 'title')}>{str(s, 'title')}</h2>
        <ol className={`steps steps--${variant || 'cards'}`} {...F(e, 'items', false)}>
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

/**
 * 2.67: a free section — up to 4 columns (a width of 12 each; on a phone they stack), each with its blocks: a heading, a
 * paragraph, a button, a picture, a tag, a space. Every value was checked by cleanColumns (theme.ts). A block without
 * content is left out for shoppers; the owner's preview shows where a picture will be.
 */
function BlockView({ b, site }: { b: Block; site: Live }) {
  const e = Boolean(site.edit);
  const t = b.settings;
  const mark = editBlock(e, b.id);
  switch (b.type) {
    case 'heading': return t.text ? <h2 className={`blk blk-h blk-h-${t.size}`} {...mark}>{t.text}</h2> : null;
    case 'paragraph': return t.text ? <div className="blk blk-p" {...mark}>{t.text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div> : null;
    case 'button': {
      const btn = <Button label={t.label} href={t.href} store={site.store} kind={t.style === 'ghost' ? 'ghost' : 'primary'} />;
      return t.label && resolveHref(t.href, site.store) ? <div className="blk blk-btn" {...mark}>{btn}</div> : null;
    }
    case 'image': {
      const src = safeImage(t.image);
      // eslint-disable-next-line @next/next/no-img-element
      if (src) return <div className="blk blk-img" {...mark}><img src={src} alt={t.alt} loading="lazy" decoding="async" /></div>;
      // the owner's preview: where a picture will be — the kit's (as an image beside words), else the drawing
      if (!site.preview) return null;
      const kit = kitImage(kitOf(site), 'imageText');
      return <div className="blk blk-img blk-img-empty" {...mark}>{kit ? <KitImg pic={kit} /> : <Art />}<span className="muted">כאן תופיע תמונה</span></div>;
    }
    case 'badge': return t.text ? <div className="blk blk-badge" {...mark}><span className="blk-tag">{t.text}</span></div> : null;
    case 'spacer': return <div className={`blk blk-space blk-space-${t.size}`} aria-hidden="true" {...mark} />;
  }
}

function Custom({ columns, site, id }: { columns: Column[]; site: Live; id: string }) {
  const e = Boolean(site.edit);
  if (!columns.length && !site.preview) return null;
  return (
    <section className="band blk-section" id={id}>
      <div className="wrap blk-grid">
        {columns.map((c) => (
          <div key={c.id} className={`blk-col blk-span-${c.span}${c.blocks.length ? '' : ' blk-col-empty'}`} {...editColumn(e, c.id)}>
            {c.blocks.map((b) => <BlockView key={b.id} b={b} site={site} />)}
          </div>
        ))}
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
    case 'products': return <ProductsSection s={s} site={site} id={id} variant={variant} />;
    case 'imageText': return <ImageText s={s} site={site} id={id} variant={variant} />;
    case 'steps': return <Steps s={s} id={id} e={Boolean(site.edit)} variant={variant} />;
    case 'faq': return <Faq s={s} id={id} e={Boolean(site.edit)} />;
    case 'contact': return <Contact s={s} site={site} id={id} variant={variant} />;
    case 'text': return <TextSection s={s} id={id} e={Boolean(site.edit)} />;
    case 'gallery': return <Gallery s={s} site={site} id={id} variant={variant} />;
    // the newsletter collects e-mail addresses only with consent to marketing — that is stage 5; until then it shows nothing
    case 'newsletter': return null;
    case 'custom': return <Custom columns={section.columns ?? []} site={site} id={id} />;
    default: return null;
  }
}

