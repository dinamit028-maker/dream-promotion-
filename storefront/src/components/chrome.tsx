import type { ReactNode } from 'react';
import { safeHref } from '@/lib/theme';
import { whatsappHref } from '@/lib/format';
import type { Site } from '@/lib/site';
import type { Link, PolicyKind, Store } from '@/lib/types';
import { CartBadge } from './CartBadge';
import { UnlockForm } from './UnlockForm';
import { CookieConsent, CookieSettings } from './CookieConsent';
import { EditBridge } from './EditBridge';
import { editLink } from '@/lib/edit';

export const POLICY_TITLE: Record<PolicyKind, string> = {
  returns: 'ביטולים והחזרות', privacy: 'מדיניות פרטיות', accessibility: 'הצהרת נגישות', terms: 'תנאי שימוש', shipping: 'משלוחים',
};

/** a menu link → a safe address ("whatsapp" → the store's WhatsApp); a link that does not fit is dropped */
export function resolveHref(href: string, store: Store): string | null {
  const h = safeHref(href);
  if (h === 'whatsapp') return whatsappHref(store.contact.whatsapp, `היי, הגעתי מהאתר של ${store.name}`);
  return h;
}
const external = (href: string) => /^https:\/\//.test(href);

/** the main menu: the business's, else "all the bags" + the collections */
function mainLinks(store: Store): Link[] {
  if (store.menus.main.length) return store.menus.main;
  return [{ label: 'כל המוצרים', href: '/collections/all' }, ...store.collections.slice(0, 4).map((c) => ({ label: c.title, href: `/collections/${c.slug}` })),
    { label: 'צרו קשר', href: '#contact' }];
}

function NavLink({ link, store }: { link: Link; store: Store }) {
  const href = resolveHref(link.href, store);
  if (!href) return null;
  return <li><a href={href} {...(external(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{link.label}</a></li>;
}

export function Header({ site }: { site: Site & { store: Store } }) {
  const { store, theme } = site;
  const links = mainLinks(store);
  const ann = theme?.announcement;
  const annHref = ann?.href ? resolveHref(ann.href, store) : null;
  const e = Boolean(site.edit);
  return (
    <>
      {ann?.enabled && ann.text && (
        <div className="announce" {...editLink(e, 'announcement')}>{annHref ? <a href={annHref}>{ann.text}</a> : ann.text}</div>
      )}
      <header className="site-header" {...editLink(e, 'menus:main')}>
        <div className="wrap header-row">
          <details className="menu">
            <summary aria-label="פתיחת התפריט"><span className="burger" aria-hidden="true" /></summary>
            <nav aria-label="תפריט ראשי" className="menu-panel">
              <ul role="list">{links.map((l, i) => <NavLink key={i} link={l} store={store} />)}</ul>
            </nav>
          </details>
          <a href="/" className="brand" {...editLink(e, 'settings')} aria-label={`${store.name} — דף הבית`}>
            {store.logo_url
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={store.logo_url} alt={store.name} className="brand-logo" />
              : <span className="brand-name">{store.name}</span>}
          </a>
          <nav aria-label="תפריט ראשי" className="nav-wide">
            <ul role="list">{links.map((l, i) => <NavLink key={i} link={l} store={store} />)}</ul>
          </nav>
          {/* 2.63, the header "search-heavy": a search field in the header itself (a plain form to the store's own search page) */}
          {theme?.chrome.header === 'search-heavy' && (
            <form action="/search" role="search" className="header-search">
              <label htmlFor="header-q" className="sr-only">חיפוש באתר</label>
              <input id="header-q" name="q" type="search" placeholder="מה מחפשים?" enterKeyHint="search" />
              <button type="submit" className="btn btn-primary">חיפוש</button>
            </form>
          )}
          {/* the search and the cart together (2.63: a header variant places them as one; the classic header ignores the box) */}
          <div className="header-tools">
            <a href="/search" className="icon-link" aria-label="חיפוש">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" /><path d="m20 20-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            </a>
            {store.can_buy && <CartBadge />}
          </div>
        </div>
      </header>
    </>
  );
}

export function Footer({ site }: { site: Site & { store: Store } }) {
  const { store } = site;
  const e = Boolean(site.edit);
  const wa = whatsappHref(store.contact.whatsapp, `היי, הגעתי מהאתר של ${store.name}`);
  const year = new Date().getFullYear();
  const footerLinks = store.menus.footer.length ? store.menus.footer : store.collections.slice(0, 6).map((c) => ({ label: c.title, href: `/collections/${c.slug}` }));
  return (
    <footer className="site-footer">
      <div className="wrap footer-grid">
        <section aria-labelledby="f-store" {...editLink(e, 'settings')}>
          <h2 id="f-store" className="footer-title">{store.name}</h2>
          {store.description && <p className="muted">{store.description}</p>}
        </section>
        {footerLinks.length > 0 && (
          <nav aria-labelledby="f-shop" {...editLink(e, 'menus:footer')}>
            <h2 id="f-shop" className="footer-title">חנות</h2>
            <ul role="list">{footerLinks.map((l, i) => <NavLink key={i} link={l} store={store} />)}</ul>
          </nav>
        )}
        {/* no policy published yet, no checkout, no cookies: no empty "מידע" heading */}
        {(store.policies.length > 0 || store.can_buy || (store.ga4_id && !site.preview)) && (
          <nav aria-labelledby="f-info">
            <h2 id="f-info" className="footer-title">מידע</h2>
            <ul role="list">
              {store.policies.map((p) => <li key={p.policy} {...editLink(e, `page:policy:${p.policy}`)}><a href={`/policies/${p.policy}`}>{p.title || POLICY_TITLE[p.policy]}</a></li>)}
              {store.can_buy && <li><a href="/cancel">ביטול עסקה</a></li>}
              {store.ga4_id && !site.preview && <li><CookieSettings /></li>}
            </ul>
          </nav>
        )}
        <section aria-labelledby="f-contact" id="contact-details" {...editLink(e, 'settings')}>
          <h2 id="f-contact" className="footer-title">יצירת קשר</h2>
          <ul role="list" className="contact-list">
            {store.contact.phone && <li><a href={`tel:${store.contact.phone.replace(/[^\d+]/g, '')}`}><bdi>{store.contact.phone}</bdi></a></li>}
            {wa && <li><a href={wa} target="_blank" rel="noopener noreferrer">וואטסאפ</a></li>}
            {store.contact.email && <li><a href={`mailto:${store.contact.email}`}><bdi>{store.contact.email}</bdi></a></li>}
            {store.contact.address && <li>{store.contact.address}</li>}
          </ul>
        </section>
      </div>
      <div className="wrap legal" {...editLink(e, 'settings')}>
        <p>
          {store.legal.name}
          {store.legal.number && <> · {store.legal.number_kind === 'company' ? 'ח.פ.' : 'ע.מ.'} <bdi>{store.legal.number}</bdi></>}
          {store.legal.address && <> · {store.legal.address}</>}
        </p>
        <p>© {year} {store.name}</p>
      </div>
    </footer>
  );
}

/** a draft seen through a preview token: the owner always knows the shoppers do not see this yet */
function PreviewBar({ site }: { site: Site }) {
  return (
    <div className="preview-bar" role="status">
      <strong>תצוגה מקדימה</strong> — {site.store.status === 'published' ? 'כך ייראה האתר אחרי הפרסום. הלקוחות רואים עדיין את הגרסה שפורסמה.' : 'החנות עוד לא באוויר. רק מי שקיבל את הקישור רואה את זה.'}
      {' '}<a href="/?preview=off">יציאה</a>
    </div>
  );
}

export function StoreChrome({ site, children }: { site: Site & { store: Store }; children: ReactNode }) {
  const analytics = site.via === 'public' && !site.locked && !site.platform && site.store.status === 'published' ? site.store.ga4_id : '';
  return (
    <>
      <a href="#main" className="skip">דלגו לתוכן</a>
      {site.via === 'token' && !site.edit && <PreviewBar site={site} />}
      {site.via === 'password' && <p className="preview-bar" role="status"><strong>האתר עוד לא פתוח לכולם</strong> — נכנסתם עם סיסמה.</p>}
      <Header site={site} />
      <main id="main" tabIndex={-1}>{children}</main>
      <Footer site={site} />
      {analytics && <CookieConsent ga4={analytics} />}
      {site.edit && <EditBridge dashboard={site.edit.origin} />}
    </>
  );
}

export function ComingSoon({ name, logo, password = false }: { name: string; logo: string; password?: boolean }) {
  return (
    <main id="main" className="soon">
      {logo
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={logo} alt={name} className="soon-logo" />
        : <p className="soon-name">{name}</p>}
      <h1>בקרוב</h1>
      <p className="muted">האתר בהכנה. נשמח לראות אתכם כאן ממש בקרוב.</p>
      {password && <UnlockForm />}
    </main>
  );
}
