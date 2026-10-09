import type { Metadata } from 'next';

// a customer's health declaration: not for search engines, and the page title says nothing about the platform
export const metadata: Metadata = { title: 'הצהרת בריאות', robots: { index: false, follow: false, nocache: true } };

export default function DeclarationLayout({ children }: { children: React.ReactNode }) {
  return children;
}
