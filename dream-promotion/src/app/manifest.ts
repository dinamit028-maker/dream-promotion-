import type { MetadataRoute } from 'next';
/** Lets the app be added to the home screen (needed for notifications on iPhone). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Dream Promotion', short_name: 'Dream Promotion', start_url: '/dashboard', display: 'standalone', dir: 'rtl', lang: 'he',
    background_color: '#0b0a16', theme_color: '#6b3bf5',
    icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
  };
}
