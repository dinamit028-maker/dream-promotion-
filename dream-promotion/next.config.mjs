import { readFileSync } from 'node:fs';
/** @type {import('next').NextConfig} */
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now());
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const BUILD_DATE = new Date().toISOString().slice(0, 10);

const nextConfig = {
  reactStrictMode: true,
  // next/image is not used: no remote image optimizer (an open remotePatterns '**' let anyone use the server as an image proxy)
  images: { unoptimized: true },
  // the final-reel renderer runs the ffmpeg binary and burns captions with the bundled Hebrew font
  // (Next 15: both options left `experimental`)
  serverExternalPackages: ['ffmpeg-static'],
  outputFileTracingIncludes: {
    '/api/reel/render': ['./node_modules/ffmpeg-static/ffmpeg', './assets/fonts/**'],
    // the signed PDF of a document is drawn with the bundled Hebrew font (static Rubik, OFL)
    '/api/doc/[token]/pdf': ['./assets/fonts/Rubik-Regular.ttf', './assets/fonts/Rubik-Bold.ttf'],
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
    ];
  },
};
export default nextConfig;
