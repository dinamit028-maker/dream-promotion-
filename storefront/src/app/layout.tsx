import '@fontsource-variable/heebo';
import '@fontsource-variable/rubik';
import '@fontsource-variable/assistant';
import '@fontsource-variable/frank-ruhl-libre';
import './globals.css';
import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { permanentRedirect } from 'next/navigation';
import { after } from 'next/server';
import { ComingSoon, StoreChrome } from '@/components/chrome';
import { getSite, markSeen } from '@/lib/site';
import { safeImage, themeClasses, themeCss } from '@/lib/theme';
import { isFullStore } from '@/lib/types';

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

async function current() {
  const h = await headers();
  return { h, site: await getSite(h.get('x-sf-host') ?? '') };
}

export async function generateMetadata(): Promise<Metadata> {
  const { site } = await current();
  // the tab's icon: the store's logo, else none at all ("data:," — no request for a /favicon.ico that does not exist)
  if (!site) return { title: 'הדף לא נמצא', robots: { index: false, follow: false }, icons: { icon: 'data:,' } };
  const s = site.store;
  // only a store open to everyone, at its primary address, is indexed: never before publishing, locked, previewed or by password
  const indexable = site.via === 'public' && !site.locked && !site.platform && s.status === 'published';
  return {
    metadataBase: new URL(site.origin),
    title: { default: s.name, template: `%s | ${s.name}` },
    description: isFullStore(s) && s.description ? s.description : undefined,
    robots: indexable ? undefined : { index: false, follow: false },
    verification: indexable && isFullStore(s) && s.gsc_code ? { google: s.gsc_code } : undefined,
    openGraph: { siteName: s.name, locale: s.lang === 'he' ? 'he_IL' : 'en_US', type: 'website' },
    formatDetection: { telephone: false, email: false, address: false },
    icons: { icon: safeImage(s.logo_url) ?? 'data:,' },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { h, site } = await current();
  const nonce = h.get('x-nonce') ?? undefined;
  // www ↔ the bare name, and the subdomain ↔ the store's own domain once it works: one address per store (308, permanent)
  if (site && !site.isPrimary && site.primaryDomain && site.via !== 'token' && (!site.platform || site.platformSlug)) {
    permanentRedirect(`https://${site.primaryDomain}${h.get('x-sf-path') || '/'}`);
  }
  // the storefront served this domain: it works (DNS + certificate) — the dashboard shows it "active"
  if (site && !site.platform) after(() => markSeen(site.host, site.subdomain));
  const lang = site?.store.lang ?? 'he';
  return (
    <html lang={lang} dir={lang === 'he' ? 'rtl' : 'ltr'}>
      <head>
        {site?.theme && <style nonce={nonce} dangerouslySetInnerHTML={{ __html: themeCss(site.theme) }} />}
      </head>
      {/* 2.63: the design choices as classes (every one from a fixed list — lib/variants.ts) */}
      <body className={site?.theme ? themeClasses(site.theme) : undefined}>
        {!site ? (
          <main id="main" className="bare">{children}</main>
        ) : site.live && isFullStore(site.store) ? (
          <StoreChrome site={{ ...site, store: site.store }}>{children}</StoreChrome>
        ) : (
          <ComingSoon name={site.store.name} logo={site.store.logo_url} password={site.passwordPage} />
        )}
      </body>
    </html>
  );
}
