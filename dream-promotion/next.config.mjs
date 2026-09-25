/** @type {import('next').NextConfig} */
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now());

const nextConfig = {
  reactStrictMode: true,
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
  experimental: {
    // the final-reel renderer runs the ffmpeg binary and burns captions with the bundled Hebrew font
    serverComponentsExternalPackages: ['ffmpeg-static'],
    outputFileTracingIncludes: {
      '/api/reel/render': ['./node_modules/ffmpeg-static/ffmpeg', './assets/fonts/**'],
    },
  },
  // the client compares this with /api/version and reloads itself after every deploy
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
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
