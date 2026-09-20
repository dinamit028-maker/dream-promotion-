import type { Metadata, Viewport } from 'next';
import { Assistant, Heebo } from 'next/font/google';
import './globals.css';

const body = Assistant({ subsets: ['hebrew', 'latin'], weight: ['400', '500', '600', '700'], variable: '--font-body' });
const display = Heebo({ subsets: ['hebrew', 'latin'], weight: ['700', '800', '900'], variable: '--font-display' });

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
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
