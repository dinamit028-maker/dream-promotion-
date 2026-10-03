import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { VersionWatcher } from '@/components/system/VersionWatcher';
import { THEME_BOOT } from '@/lib/theme';

// every page is rendered fresh, so browsers never hold an old version of the app
export const dynamic = 'force-dynamic';

// fonts ship with the app: the build never depends on reaching Google Fonts
const body = localFont({ src: '../../assets/fonts/Assistant.ttf', weight: '200 800', variable: '--font-body', display: 'swap' });
const display = localFont({ src: '../../assets/fonts/Rubik.ttf', weight: '300 900', variable: '--font-display', display: 'swap' });

export const metadata: Metadata = {
  title: 'Dream Promotion — מחלקת השיווק שלך, מונעת AI',
  description: 'תארו את העסק, העלו תמונות, וקבלו פוסטים, רילסים, תוכנית שבועית וקמפיינים.',
  // home-screen app on iPhone (needed there for sale notifications)
  appleWebApp: { capable: true, title: 'Dream Promotion', statusBarStyle: 'black-translucent' },
  icons: { icon: '/icons/icon-192.png', apple: '/icons/icon-180.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl" data-theme="dark" suppressHydrationWarning className={`${body.variable} ${display.variable}`}>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} /></head>
      <body className="font-sans antialiased"><VersionWatcher />{children}</body>
    </html>
  );
}
