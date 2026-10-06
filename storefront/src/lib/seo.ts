import { excerpt, variantLabel } from './format';
import type { Site } from './site';
import type { Product, Store } from './types';

/** schema.org for search engines: who the business is, the site (with its search), a product, the breadcrumbs */
type Live = Site & { store: Store };
const enc = (s: string) => encodeURIComponent(s);

export function orgJsonLd(site: Live) {
  const { store, origin } = site;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization', '@id': `${origin}/#org`, name: store.legal.name || store.name, url: `${origin}/`,
        ...(store.logo_url ? { logo: store.logo_url } : {}),
        ...(store.contact.phone ? { telephone: store.contact.phone } : {}),
        ...(store.contact.email ? { email: store.contact.email } : {}),
        ...(store.legal.address ? { address: { '@type': 'PostalAddress', streetAddress: store.legal.address, addressCountry: store.country } } : {}),
      },
      {
        '@type': 'WebSite', '@id': `${origin}/#website`, url: `${origin}/`, name: store.name, inLanguage: store.lang === 'he' ? 'he-IL' : 'en',
        publisher: { '@id': `${origin}/#org` },
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: `${origin}/search?q={search_term_string}` },
          'query-input': 'required name=search_term_string',
        },
      },
    ],
  };
}

export function breadcrumbsJsonLd(origin: string, items: { name: string; path: string }[]) {
  return {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: `${origin}${it.path}` })),
  };
}

const gtin = (code: string) => (/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(code) ? code : undefined);
const availability = (ok: boolean) => (ok ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock');

export function productJsonLd(site: Live, p: Product) {
  const url = `${site.origin}/products/${enc(p.slug)}`;
  const images = p.images.map((i) => i.sizes?.['1600'] || i.sizes?.['800'] || i.url).filter(Boolean);
  const currency = site.store.currency;
  const offers = p.variants.length
    ? p.variants.map((v) => ({
        '@type': 'Offer', url: `${url}?variant=${v.id}`, name: variantLabel(v) || undefined, sku: v.sku || undefined, gtin: gtin(v.barcode),
        price: v.price, priceCurrency: currency, availability: availability(v.in_stock), itemCondition: 'https://schema.org/NewCondition',
      }))
    : { '@type': 'Offer', url, price: p.price, priceCurrency: currency, availability: availability(p.in_stock), itemCondition: 'https://schema.org/NewCondition' };
  return {
    '@context': 'https://schema.org', '@type': 'Product', '@id': `${url}#product`, name: p.name, url,
    description: excerpt(p.seo_description || p.description, 500) || undefined,
    image: images.length ? images : undefined,
    sku: p.sku || undefined, gtin: gtin(p.barcode),
    brand: p.manufacturer ? { '@type': 'Brand', name: p.manufacturer } : undefined,
    countryOfOrigin: p.country_of_origin || undefined,
    offers,
  };
}

/** Open Graph of a page: a page's own object replaces the layout's (Next merges metadata one key deep), so every page
 *  builds it here, with the store's name */
export function og(site: Site, o: { url: string; title?: string; description?: string; image?: string | null; type?: 'website' | 'article' }) {
  return {
    siteName: site.store.name, locale: site.store.lang === 'he' ? 'he_IL' : 'en_US', type: o.type ?? 'website',
    url: o.url, title: o.title, description: o.description || undefined, images: o.image ? [o.image] : undefined,
  };
}
