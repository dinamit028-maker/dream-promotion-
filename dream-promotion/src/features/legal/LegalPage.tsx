import Link from 'next/link';
import type { ReactNode } from 'react';

export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL || '';
export const UPDATED = '27.09.2026';

/** Plain, readable legal page — Hebrew first, then English (review teams read English). */
export function LegalPage({ title, en, children, english }: { title: string; en: string; children: ReactNode; english: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12 leading-relaxed">
      <Link href="/" className="text-sm font-semibold text-primary">← Dream Promotion</Link>
      <h1 className="mt-4 font-display text-3xl font-extrabold">{title}</h1>
      <p className="mb-8 text-sm text-muted">עודכן לאחרונה: {UPDATED}</p>
      <div className="stack-y-4 text-[15px] [&_h2]:mt-8 [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-bold [&_li]:ms-5 [&_ul]:list-disc">
        {children}
      </div>
      <hr className="my-12 border-line" />
      <section dir="ltr" lang="en" className="stack-y-4 text-[15px] [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-bold [&_li]:ms-5 [&_ul]:list-disc">
        <h1 className="text-2xl font-extrabold">{en}</h1>
        <p className="text-sm text-muted">Last updated: September 27, 2026</p>
        {english}
      </section>
    </main>
  );
}
export const Contact = () => (CONTACT_EMAIL ? <a className="text-primary underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> : <span>דרך טופס הפנייה באתר</span>);
export const ContactEn = () => (CONTACT_EMAIL ? <a className="text-primary underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> : <span>through the contact option on our website</span>);
