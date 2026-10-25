import type { Metadata } from 'next';

// an employee's טופס 101: not for search engines, no app manifest of Dream, and the title says nothing about the platform
export const metadata: Metadata = { title: 'טופס 101', manifest: null, robots: { index: false, follow: false, nocache: true } };

export default function Form101Layout({ children }: { children: React.ReactNode }) {
  return children;
}
