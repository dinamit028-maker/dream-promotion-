'use client';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/ui/feedback';

/**
 * A customer's payment link (sent on WhatsApp or by email, or from the booking page): what is paid, how much, to whom —
 * and "לתשלום מאובטח", which opens the payment company's own page (the card is typed only there). Back from it, the page
 * asks the server, which asks the payment company directly; only that answer shows "שולם". A failure shows as a failure.
 */
interface Link {
  status: 'sent' | 'paid' | 'failed' | 'expired' | 'cancelled'; label: string; amount: number; currency: string; business: string; phone: string;
  customer: string; expiresAt: string; test: boolean; paidAt: string | null; late: boolean;
}
const money = (n: number) => `₪${n.toLocaleString('he-IL', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const day = (iso: string) => new Date(iso).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Asia/Jerusalem' });

export default function PayLinkPage(props: { params: Promise<{ ref: string }> }) {
  const { ref } = use(props.params);
  const [link, setLink] = useState<Link | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [back, setBack] = useState<'back' | 'failed' | null>(null);
  const started = useRef(false);

  const check = useCallback(async (): Promise<Link | null> => {
    const r = await fetch(`/api/pay/${ref}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'check' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.link) return null;
    setLink(j.link);
    return j.link as Link;
  }, [ref]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const r = new URLSearchParams(window.location.search).get('r');
    const from = r === 'back' || r === 'failed' ? r : null;
    setBack(from);
    if (from) {
      // back from the payment page: the server asks the payment company (a few times, while it is still being processed)
      setChecking(true);
      void (async () => {
        let l: Link | null = null;
        for (let i = 0; i < 5; i++) {
          l = await check().catch(() => null);
          if (!l || l.status !== 'sent' || from === 'failed') break;
          await new Promise((res) => setTimeout(res, 2500));
        }
        if (!l) await load();
        setChecking(false);
        window.history.replaceState(null, '', `/pay/${ref}`);
      })();
      return;
    }
    void load();
    async function load() {
      const res = await fetch(`/api/pay/${ref}`).catch(() => null);
      const j = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) { setMissing(j.message ?? 'הלינק לא נמצא.'); return; }
      setLink(j.link);
    }
  }, [ref, check]);

  async function pay() {
    setBusy(true); setMsg(null);
    const r = await fetch(`/api/pay/${ref}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok && typeof j.url === 'string') { window.location.href = j.url; return; }
    setBusy(false);
    if (j.link) setLink(j.link);
    setMsg(j.message ?? 'לא הצלחנו לפתוח את עמוד התשלום. נסו שוב בעוד רגע.');
  }

  if (missing) return <Page><p className="mt-16 text-center">{missing}</p></Page>;
  if (!link || checking) return (
    <Page><div className="mt-16 flex flex-col items-center gap-3"><Spinner />{checking && <p className="text-sm text-zinc-600">בודקים את התשלום מול חברת הסליקה…</p>}</div></Page>
  );
  const open = link.status === 'sent' || link.status === 'failed';
  return (
    <Page>
      <p className="text-center text-sm text-zinc-600">{link.customer ? `שלום ${link.customer},` : 'שלום,'} בקשת תשלום מאת</p>
      <h1 className="mt-1 text-center text-2xl font-extrabold">{link.business}</h1>
      <div className="mt-5 rounded-3xl border border-zinc-200 p-5 text-center">
        <p className="text-zinc-700">{link.label}</p>
        <p className="mt-2 text-4xl font-black tabular-nums">{money(link.amount)}</p>
        {link.test && <p className="mt-3 rounded-2xl bg-sky-50 p-2 text-sm font-semibold text-sky-800">תשלום בדיקה — לא יחויב כסף אמיתי</p>}
      </div>

      {link.status === 'paid' && (
        <div role="status" className="mt-5 rounded-3xl bg-emerald-50 p-5 text-center text-emerald-900">
          <p className="text-3xl">✓</p>
          <p className="mt-1 text-lg font-bold">התשלום התקבל. תודה!</p>
          {link.paidAt && <p className="text-sm">שולם ב-{day(link.paidAt)}{link.test ? ' (בדיקה)' : ''}</p>}
        </div>
      )}
      {link.status === 'failed' && (
        <div role="alert" className="mt-5 rounded-3xl bg-red-50 p-4 text-center text-red-900">
          <p className="font-bold">התשלום לא הצליח</p>
          <p className="text-sm">הכרטיס לא חויב. אפשר לנסות שוב.</p>
        </div>
      )}
      {link.status === 'sent' && back === 'failed' && (
        <div role="alert" className="mt-5 rounded-3xl bg-amber-50 p-4 text-center text-amber-900">
          <p className="font-bold">התשלום לא הושלם</p>
          <p className="text-sm">אפשר לנסות שוב.</p>
        </div>
      )}
      {link.status === 'sent' && back === 'back' && (
        <div role="status" className="mt-5 rounded-3xl bg-amber-50 p-4 text-center text-amber-900">
          <p className="font-bold">עוד לא קיבלנו אישור על התשלום</p>
          <p className="text-sm">אם שילמת — האישור יגיע בדקות הקרובות. אפשר לרענן את הדף.</p>
        </div>
      )}
      {link.status === 'expired' && <p className="mt-5 rounded-3xl bg-zinc-100 p-4 text-center">הלינק כבר לא בתוקף. אפשר לבקש מהעסק לינק חדש.</p>}
      {link.status === 'cancelled' && <p className="mt-5 rounded-3xl bg-zinc-100 p-4 text-center">העסק ביטל את בקשת התשלום הזו.</p>}

      {open && (
        <>
          <button type="button" onClick={pay} disabled={busy}
            className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-zinc-900 px-6 text-lg font-bold text-white disabled:opacity-60">
            {busy && <Spinner />}{link.status === 'failed' || back ? 'לנסות שוב' : 'לתשלום מאובטח'}
          </button>
          <p className="mt-2 text-center text-xs text-zinc-600">בתוקף עד {day(link.expiresAt)}. פרטי הכרטיס מוקלדים בעמוד של חברת הסליקה בלבד.</p>
        </>
      )}
      {msg && <p role="alert" className="mt-3 text-center text-sm font-semibold text-red-700">{msg}</p>}
      {link.phone && <p className="mt-6 text-center text-sm text-zinc-600">שאלות? {link.business} · <a className="underline" href={`tel:${link.phone.replace(/[^\d+]/g, '')}`}>{link.phone}</a></p>}
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <main dir="rtl" lang="he" className="mx-auto min-h-screen max-w-md bg-white p-4 pt-8 text-black">{children}</main>;
}
