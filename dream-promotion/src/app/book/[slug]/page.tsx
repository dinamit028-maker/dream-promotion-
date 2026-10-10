'use client';
import { use, useEffect, useMemo, useState } from 'react';
import { Button, Input, Textarea } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { icsFile } from '@/features/booking/slots';
import { waLink } from '@/features/crm/crm';

/**
 * The public booking page of one business: dream-promotion.vercel.app/book/<slug>.
 * No account needed: service → day → time → name & phone → booked (and it lands in the CRM).
 */
type Biz = { title: string; address: string; phone: string; message: string; services: { id: string; name: string; minutes: number; price: number | null; deposit?: number | null }[]; days: string[] };
const DAY = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const dayLabel = (d: string) => {
  const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
  const [, m, dd] = d.split('-');
  return { wd: DAY[wd], date: `${Number(dd)}.${Number(m)}` };
};

export default function BookPage(props: { params: Promise<{ slug: string }> }) {
  const params = use(props.params);   // Next 15: a page's params arrive as a promise
  const [biz, setBiz] = useState<Biz | null>(null);
  const [missing, setMissing] = useState<string | false>(false);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [slots, setSlots] = useState<{ time: string; start: string }[] | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', email: '', note: '', website: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; start: string; end: string; service: string; whenHe: string; title: string; address: string;
    deposit?: { amount: number; url: string } | null } | null>(null);

  useEffect(() => {
    fetch(`/api/book/${params.slug}`).then(async (r) => {
      if (!r.ok) { const j = await r.json().catch(() => ({})); setMissing(j.code === 'unavailable' ? j.message : 'דף ההזמנות לא זמין כרגע.'); return; }
      const j = await r.json(); setBiz(j);
      if (j.services?.length === 1) setServiceId(j.services[0].id);
    }).catch(() => setMissing('דף ההזמנות לא זמין כרגע.'));
  }, [params.slug]);

  const service = useMemo(() => biz?.services.find((s) => s.id === serviceId) ?? null, [biz, serviceId]);

  useEffect(() => {
    if (!serviceId || !day) return;
    setSlots(null); setStart(null);
    fetch(`/api/book/${params.slug}/slots?service=${serviceId}&date=${day}`).then((r) => r.json()).then((j) => setSlots(j.slots ?? [])).catch(() => setSlots([]));
  }, [params.slug, serviceId, day]);

  async function book() {
    if (!start || !serviceId) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/book/${params.slug}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, serviceId, start }) });
      const j = await r.json();
      if (!r.ok) {
        setError(j.message || 'לא הצלחנו לקבוע את התור. נסו שוב.');
        if (j.code === 'slot_taken' && day) { setStart(null); setDay(null); setTimeout(() => setDay(day), 0); }
        return;
      }
      setDone(j);
    } catch { setError('אין חיבור. נסו שוב.'); }
    finally { setBusy(false); }
  }
  function downloadIcs() {
    if (!done) return;
    const blob = new Blob([icsFile({ uid: done.id, start: done.start, end: done.end, title: `${done.service} · ${done.title}`, location: done.address })], { type: 'text/calendar' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'appointment.ics'; a.click();
  }

  if (missing) return <Shell><p className="text-center text-ink-2">{missing}</p></Shell>;
  if (!biz) return <Shell><div className="flex justify-center py-10"><Spinner /></div></Shell>;

  if (done) return (
    <Shell title={biz.title}>
      <div className="rounded-3xl bg-emerald-500/10 p-6 text-center">
        <p className="text-4xl">✓</p>
        <h2 className="mt-2 font-display text-2xl font-extrabold">התור נקבע</h2>
        <p className="mt-2 text-lg">{done.service}</p>
        <p className="font-semibold">{done.whenHe}</p>
        {done.address && <p className="mt-1 text-sm text-ink-2">{done.address}</p>}
      </div>
      {done.deposit && (
        <div className="mt-4 rounded-3xl border border-line bg-surface p-4 text-center">
          <p className="font-semibold">מקדמה לתור: ₪{Number(done.deposit.amount).toLocaleString('he-IL')}</p>
          <p className="mt-1 text-sm text-ink-2">אפשר לשלם עכשיו בלינק מאובטח. המקדמה תקוזז מהתשלום על התור.</p>
          <a href={done.deposit.url} className="mt-3 inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-6 font-bold text-white">לתשלום המקדמה</a>
        </div>
      )}
      <div className="mt-4 grid gap-2">
        <Button variant="primary" onClick={downloadIcs}>הוספה ליומן שלי</Button>
        {waLink(biz.phone) && <a href={waLink(biz.phone)} target="_blank" rel="noopener" className="rounded-full border border-line px-4 py-3 text-center font-semibold">שאלה לעסק בוואטסאפ</a>}
      </div>
    </Shell>
  );

  return (
    <Shell title={biz.title} address={biz.address}>
      {biz.message && <p className="mb-5 rounded-2xl bg-surface-2 p-3 text-sm">{biz.message}</p>}

      <Step n={1} title="מה קובעים?">
        <div className="grid gap-2">
          {biz.services.map((s) => (
            <button key={s.id} type="button" onClick={() => { setServiceId(s.id); setStart(null); }}
              className={cx('flex items-center justify-between rounded-2xl border p-4 text-start', serviceId === s.id ? 'border-primary bg-primary-soft' : 'border-line bg-surface')}>
              <span><strong className="block">{s.name}</strong><span className="text-sm text-muted">{s.minutes} דקות{s.deposit ? ` · מקדמה ₪${Number(s.deposit).toLocaleString('he-IL')}` : ''}</span></span>
              {s.price != null && <span className="font-bold">₪{Number(s.price).toLocaleString('he-IL')}</span>}
            </button>
          ))}
          {!biz.services.length && <p className="text-sm text-muted">אין כרגע שירותים להזמנה.</p>}
        </div>
      </Step>

      {service && (
        <Step n={2} title="באיזה יום?">
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {biz.days.slice(0, 21).map((d) => {
              const l = dayLabel(d);
              return (
                <button key={d} type="button" onClick={() => setDay(d)}
                  className={cx('min-w-[64px] shrink-0 rounded-2xl border px-2 py-2 text-center', day === d ? 'border-primary bg-primary text-white' : 'border-line bg-surface')}>
                  <span className="block text-xs">{l.wd}</span><strong className="block">{l.date}</strong>
                </button>
              );
            })}
          </div>
        </Step>
      )}

      {service && day && (
        <Step n={3} title="באיזו שעה?">
          {slots === null ? <Spinner /> : slots.length ? (
            <div className="grid grid-cols-4 gap-2">
              {slots.map((s) => (
                <button key={s.start} type="button" onClick={() => setStart(s.start)}
                  className={cx('rounded-xl border py-2.5 text-center font-semibold tabular-nums', start === s.start ? 'border-primary bg-primary text-white' : 'border-line bg-surface')}>{s.time}</button>
              ))}
            </div>
          ) : <p className="text-sm text-muted">אין שעות פנויות ביום הזה. נסו יום אחר.</p>}
        </Step>
      )}

      {start && (
        <Step n={4} title="פרטים">
          <div className="grid gap-3">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="שם מלא" autoComplete="name" />
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="טלפון נייד" inputMode="tel" autoComplete="tel" dir="ltr" />
            <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="אימייל (לא חובה)" inputMode="email" autoComplete="email" dir="ltr" />
            <Textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="הערה לעסק (לא חובה)" className="min-h-[70px]" />
            {/* bots fill this; people never see it */}
            <input tabIndex={-1} autoComplete="off" aria-hidden className="hidden" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            {error && <p className="text-sm text-warn">{error}</p>}
            <Button variant="primary" size="lg" onClick={book} disabled={busy || !form.name.trim() || form.phone.replace(/\D/g, '').length < 9}>
              {busy ? <><Spinner />קובע…</> : 'קביעת התור'}
            </Button>
          </div>
        </Step>
      )}
    </Shell>
  );
}

function Shell({ title, address, children }: { title?: string; address?: string; children: React.ReactNode }) {
  return (
    <main dir="rtl" className="mx-auto min-h-screen max-w-md px-4 pb-16 pt-8">
      {title && <h1 className="font-display text-3xl font-black">{title}</h1>}
      {address && <p className="mb-5 mt-1 text-sm text-ink-2">{address}</p>}
      {!address && title && <div className="mb-5" />}
      {children}
      <p className="mt-10 text-center text-[11px] text-muted">זימון תורים · Dream Promotion</p>
    </main>
  );
}
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 flex items-center gap-2 font-bold"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs text-white">{n}</span>{title}</h2>
      {children}
    </section>
  );
}
