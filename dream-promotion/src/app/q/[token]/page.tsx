'use client';
import { use, useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/feedback';
import { issuerIdLine } from '@/features/finance/rules';

/** A customer's link to a quote (sent on WhatsApp): read it, print it, accept or decline it with a name — once. */
interface Q {
  number: number; status: string; customerName: string; customerDealer: string; lines: { name: string; qty: number; unitPriceExVat: number; totalExVat: number }[];
  beforeDiscount: number; discount: number; afterDiscount: number; vatRate: number; vatAmount: number; total: number; validUntil: string | null; notes: string;
  createdAt: string; decidedAt: string | null; decisionBy: string; version: string;
  issuer: { name: string; tradingName?: string; dealerNumber?: string; entityType?: string; phone?: string; email?: string; street?: string; houseNo?: string; city?: string } | null;
}
const money = (n: number) => `₪${n.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');

export default function SharedQuotePage(props: { params: Promise<{ token: string }> }) {
  const params = use(props.params);   // Next 15: a page's params arrive as a promise
  const [q, setQ] = useState<Q | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/quote/${params.token}`).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMissing(j.code === 'unavailable' ? j.message : 'ההצעה לא נמצאה.'); return; }
      setQ(j.quote);
    }).catch(() => setMissing('ההצעה לא נמצאה.'));
  }, [params.token]);
  async function decide(decision: 'accept' | 'reject') {
    setBusy(true); setMsg(null);
    const r = await fetch(`/api/quote/${params.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, name, note, version: q?.version ?? '' }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(j.message ?? 'משהו השתבש. נסו שוב.'); return; }
    setQ(j.quote); setMsg(decision === 'accept' ? 'תודה! ההצעה אושרה והעסק קיבל הודעה.' : 'התשובה נשלחה לעסק.');
  }
  if (missing) return <main dir="rtl" className="mx-auto min-h-screen max-w-3xl bg-white p-4 text-black"><p className="mt-16 text-center">{missing}</p></main>;
  if (!q) return <main dir="rtl" className="flex min-h-screen justify-center bg-white py-16"><Spinner /></main>;
  const i = q.issuer;
  return (
    <main dir="rtl" className="mx-auto min-h-screen max-w-3xl bg-white p-4 text-black print:p-0">
      <div className="mb-4 flex justify-end print:hidden"><button type="button" onClick={() => window.print()} className="rounded-full border border-zinc-300 px-5 py-2.5 font-semibold">הדפסה</button></div>
      <div className="rounded-xl border border-zinc-200 p-4 print:border-0">
        <div className="flex flex-wrap justify-between gap-4">
          <div>{i && <><strong className="text-lg">{i.name}</strong>{i.tradingName && <div>{i.tradingName}</div>}<div className="text-sm">{issuerIdLine(i)}</div>
            <div className="text-sm text-zinc-600">{[i.street, i.houseNo, i.city].filter(Boolean).join(' ')}{i.phone ? ` · ${i.phone}` : ''}{i.email ? ` · ${i.email}` : ''}</div></>}</div>
          <div className="text-left"><strong className="text-lg">הצעת מחיר מס׳ {q.number}</strong><div className="text-sm">תאריך: {day(q.createdAt)}</div>
            {q.validUntil && <div className="text-sm">בתוקף עד: {day(q.validUntil)}</div>}</div>
        </div>
        <p className="mt-3">לכבוד: <strong>{q.customerName || 'לקוח'}</strong>{q.customerDealer ? ` · ע.מ / ח.פ ${q.customerDealer}` : ''}</p>
        <table className="mt-3 w-full border-collapse text-sm">
          <thead><tr className="bg-zinc-100"><th className="border border-zinc-300 p-1.5 text-right">תיאור</th><th className="border border-zinc-300 p-1.5">כמות</th><th className="border border-zinc-300 p-1.5">סה״כ{q.vatRate ? ' (לפני מע״מ)' : ''}</th></tr></thead>
          <tbody>{q.lines.map((l, k) => <tr key={k}><td className="border border-zinc-300 p-1.5">{l.name}</td><td className="border border-zinc-300 p-1.5 text-center">{l.qty}</td><td className="border border-zinc-300 p-1.5 text-center">{money(l.totalExVat)}</td></tr>)}</tbody>
        </table>
        <div className="mt-3 grid gap-1 text-sm">
          {q.discount > 0 && <div className="flex justify-between"><span>הנחה</span><span>-{money(q.discount)}</span></div>}
          {q.vatRate > 0 && <div className="flex justify-between"><span>לפני מע״מ</span><span>{money(q.afterDiscount)}</span></div>}
          {q.vatRate > 0 && <div className="flex justify-between"><span>מע״מ {q.vatRate}%</span><span>{money(q.vatAmount)}</span></div>}
          <div className="flex justify-between text-base font-bold"><span>סה״כ</span><span>{money(q.total)}</span></div>
        </div>
        {q.notes && <p className="mt-3 whitespace-pre-wrap text-sm">{q.notes}</p>}
        <p className="mt-3 text-xs text-zinc-500">הצעת מחיר אינה חשבונית ואינה קבלה.</p>
      </div>
      <div className="mt-4 rounded-xl border border-zinc-200 p-4 print:hidden">
        {q.status === 'sent' ? <>
          <p className="mb-2 font-semibold">אישור ההצעה</p>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="השם שלך" className="mb-2 w-full rounded-lg border border-zinc-300 p-3" aria-label="השם שלך" maxLength={80} />
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="הערה לעסק (לא חובה)" className="mb-2 w-full rounded-lg border border-zinc-300 p-3" aria-label="הערה" maxLength={500} />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || name.trim().length < 2} onClick={() => void decide('accept')} className="rounded-full bg-[#6b3bf5] px-6 py-3 font-semibold text-white disabled:opacity-50">אני מאשר/ת את ההצעה</button>
            <button type="button" disabled={busy || name.trim().length < 2} onClick={() => void decide('reject')} className="rounded-full border border-zinc-300 px-6 py-3 font-semibold disabled:opacity-50">לא מתאים לי</button>
          </div>
        </> : <p className="font-semibold">{q.status === 'accepted' ? `ההצעה אושרה${q.decisionBy ? ` על ידי ${q.decisionBy}` : ''}${q.decidedAt ? ` ב-${day(q.decidedAt)}` : ''}.`
          : q.status === 'rejected' ? 'ההצעה נדחתה.' : q.status === 'expired' ? 'תוקף ההצעה פג — אפשר לפנות לעסק להצעה מעודכנת.' : q.status === 'converted' ? 'ההצעה אושרה והפכה להזמנה.' : 'ההצעה אינה פעילה.'}</p>}
        {msg && <p className="mt-2 text-sm">{msg}</p>}
      </div>
    </main>
  );
}
