import type { Metadata, Viewport } from 'next';
import { Assistant, Rubik } from 'next/font/google';
import './globals.css';
import { VersionWatcher } from '@/components/system/VersionWatcher';

// every page is rendered fresh, so browsers never hold an old version of the app
export const dynamic = 'force-dynamic';

const body = Assistant({ subsets: ['hebrew', 'latin'], weight: ['400', '500', '600', '700'], variable: '--font-body' });
const display = Rubik({ subsets: ['hebrew', 'latin'], weight: ['500', '700', '800'], variable: '--font-display' });

export const metadata: Metadata = {
  title: 'Dream Promotion — מחלקת השיווק שלך, מונעת AI',
  description: 'תארו את העסק, העלו תמונות, וקבלו פוסטים, רילסים, תוכנית שבועית וקמפיינים.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl" className={`${body.variable} ${display.variable}`}>
      <body className="font-sans antialiased"><VersionWatcher />{children}</body>
    </html>
  );
}
