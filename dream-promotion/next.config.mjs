import { readFileSync } from 'node:fs';
/** @type {import('next').NextConfig} */
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now());
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const BUILD_DATE = new Date().toISOString().slice(0, 10);

const nextConfig = {
  reactStrictMode: true,
  // Next 15's dev badge sits over the bottom bar's corner button ("תפריט") on a phone — and the e2e taps it
  devIndicators: false,
  // next/image is not used: no remote image optimizer (an open remotePatterns '**' let anyone use the server as an image proxy)
  images: { unoptimized: true },
  // the final-reel renderer runs the ffmpeg binary and burns captions with the bundled Hebrew font
  // (Next 15: both options left `experimental`)
  serverExternalPackages: ['ffmpeg-static'],
  outputFileTracingIncludes: {
    '/api/reel/render': ['./node_modules/ffmpeg-static/ffmpeg', './assets/fonts/**'],
    // the signed PDF of a document is drawn with the bundled Hebrew font (static Rubik, OFL)
    '/api/doc/[token]/pdf': ['./assets/fonts/Rubik-Regular.ttf', './assets/fonts/Rubik-Bold.ttf'],
    // the signed health declaration (client file) — the same font
    '/api/h/[token]': ['./assets/fonts/Rubik-Regular.ttf', './assets/fonts/Rubik-Bold.ttf'],
  },
  // the client compares this with /api/version and reloads itself after every deploy
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID, NEXT_PUBLIC_APP_VERSION: APP_VERSION, NEXT_PUBLIC_BUILD_DATE: BUILD_DATE },
  async headers() {
    return [
      {
        // pages and API: never served from browser cache, so a new deploy shows up immediately.
        // hashed files under /_next/static stay cached — they change name on every build.
        source: '/((?!_next/static|_next/image|favicon.ico).*)',
        headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
      },
      {
        // a customer's health declaration (/h/<token>): never indexed, never framed, no script, style or connection
        // from anywhere but this site (Next's own inline scripts need 'unsafe-inline'; development also needs eval)
        source: '/h/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: [
            "default-src 'self'", `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
            "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self'",
            "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
          ].join('; ') },
        ],
      },
    ];
  },
};
export default nextConfig;
