'use client';
import { useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/feedback';
import { docBody, toDoc } from '@/features/documents/DocumentsTab';

/** The customer's link to a document (sent on WhatsApp): view, print or save as PDF. */
export default function SharedDocPage({ params }: { params: { token: string } }) {
  const [html, setHtml] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    fetch(`/api/doc/${params.token}`).then(async (r) => {
      if (!r.ok) { setMissing(true); return; }
      const j = await r.json();
      setHtml(docBody(toDoc(j.doc), j.business, 'מסמך ממוחשב'));
    }).catch(() => setMissing(true));
  }, [params.token]);
  return (
    <main dir="rtl" className="mx-auto min-h-screen max-w-3xl bg-white p-4 text-black print:p-0">
      {missing ? <p className="mt-16 text-center">המסמך לא נמצא.</p> : !html ? <div className="flex justify-center py-16"><Spinner /></div> : <>
        <div className="mb-4 flex justify-end gap-2 print:hidden">
          <button type="button" onClick={() => window.print()} className="rounded-full bg-[#6b3bf5] px-5 py-2.5 font-semibold text-white">הדפסה / שמירה כ-PDF</button>
        </div>
        <div className="rounded-xl border border-zinc-200 p-4 print:border-0 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-zinc-300 [&_td]:p-1.5 [&_th]:border [&_th]:border-zinc-300 [&_th]:bg-zinc-100 [&_th]:p-1.5 [&_.h]:flex [&_.h]:justify-between [&_.mark]:border [&_.mark]:border-black [&_.mark]:px-2 [&_.muted]:text-xs [&_.muted]:text-zinc-500"
          dangerouslySetInnerHTML={{ __html: html }} />
      </>}
    </main>
  );
}
