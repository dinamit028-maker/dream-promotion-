import type { NextConfig } from 'next';

/**
 * The storefront: one app for every business's store, chosen by the domain (src/proxy.ts). Every page is rendered on
 * request — a change of a price, a picture or stock shows at once — and reads the database only through sf_* (src/lib/data.ts).
 */
const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // metadata (title, canonical, verification) always in <head>, for every crawler — and a 404 keeps its status
  htmlLimitedBots: /.*/,
  // pg is for the local tests only (SF_DATA=pg); never bundled
  serverExternalPackages: ['pg'],
  // the browser tests run on *.test hosts (Chromium maps them to this machine)
  allowedDevOrigins: ['*.test'],
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
        { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
      ],
    }];
  },
};

export default config;
