'use client';
import { use, useEffect, useState } from 'react';
import { CONFIRM_LINE, checkAnswers, progress, type Answers, type Field } from '@/features/client-file/declarations';
import { Question, SignaturePad, btn, input } from '@/features/client-file/DeclarationForm';

/**
 * The customer's health declaration (/h/<token>, docs/CLIENT FILE ENGINEERING HE.md §5.1א–5.3): on the phone, no
 * sign-in, right to left. Nothing is pre-selected — every yes/no is the customer's own choice; the follow-ups of a "yes"
 * open under the question; a progress bar; the answers are kept in this browser tab (sessionStorage) if the page closes
 * half way. Each declaration has its own signature, full name and confirmation line ("same signature" copies the
 * signature, never the confirmation). The server checks everything again.
 */
interface Decl { n: number; title: string; version: number; fields: Field[]; acks: string[] }
interface Page { business: string; firstName: string; expiresAt: string; declarations: Decl[] }
interface Filled { answers: Answers; acks: boolean[]; name: string; signature: string; confirm: boolean }
const empty = (d: Decl): Filled => ({ answers: {}, acks: d.acks.map(() => false), name: '', signature: '', confirm: false });


export default function DeclarationPage(props: { params: Promise<{ token: string }> }) {
  const { token } = use(props.params);
  const store = `declaration:${token.slice(0, 16)}`;
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [filled, setFilled] = useState<Filled[]>([]);
  const [problem, setProblem] = useState<{ id: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ title: string; file: string; pdf: string }[] | null>(null);

  useEffect(() => {
    fetch(`/api/h/${token}`, { cache: 'no-store' }).then(async (r) => {
      const j = await r.json().catch(() => null);
      if (!r.ok) { setError(j?.message ?? 'הקישור לא נמצא.'); return; }
      const p = j as Page;
      setPage(p);
      let saved: Filled[] | null = null;
      try { saved = JSON.parse(sessionStorage.getItem(store) ?? 'null'); } catch { /* nothing kept */ }
      setFilled(p.declarations.map((d, i) => {
        const s = saved?.[i];
        // signatures are not kept between visits — the customer signs again
        return s ? { ...empty(d), answers: s.answers ?? {}, acks: d.acks.map((_, k) => Boolean(s.acks?.[k])), name: s.name ?? '' } : empty(d);
      }));
    }).catch(() => setError('אין חיבור כרגע. נסו שוב בעוד רגע.'));
  }, [token, store]);

  useEffect(() => {
    if (!filled.length || done) return;
    try { sessionStorage.setItem(store, JSON.stringify(filled.map((f) => ({ answers: f.answers, acks: f.acks, name: f.name })))); } catch { /* private mode */ }
  }, [filled, store, done]);

  const set = (i: number, p: Partial<Filled>) => setFilled((all) => all.map((f, k) => (k === i ? { ...f, ...p } : f)));
  const answer = (i: number, key: string, v: Answers[string] | undefined) => {
    setProblem((p) => (p?.id === `d${i}-${key}` ? null : p));   // the question just answered is no longer marked
    setAnswer(i, key, v);
  };
  const setAnswer = (i: number, key: string, v: Answers[string] | undefined) => setFilled((all) => all.map((f, k) => {
    if (k !== i) return f;
    const a = { ...f.answers };
    if (v === undefined || (Array.isArray(v) && !v.length) || v === '') delete a[key]; else a[key] = v;
    return { ...f, answers: a };
  }));
  const goTo = (id: string, message: string) => {
    setProblem({ id, message });
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => (el?.querySelector('input, textarea, button, canvas') as HTMLElement | null)?.focus({ preventScroll: true }), 350);
  };

  async function submit() {
    if (!page || busy) return;
    // the first thing missing, in page order; what is sent is only what was asked (a closed follow-up is not sent)
    const kept: Answers[] = [];
    for (const [i, d] of page.declarations.entries()) {
      const f = filled[i];
      const a = checkAnswers(d.fields, d.acks, f.answers, f.acks);
      if (!a.ok) return goTo(`d${i}-${a.missing}`, a.message);
      kept.push(a.answers);
      if (f.name.trim().length < 2) return goTo(`d${i}-signer_name`, 'חסר שם מלא.');
      if (!f.signature) return goTo(`d${i}-signature`, 'חסרה חתימה.');
      if (!f.confirm) return goTo(`d${i}-confirm`, 'יש לסמן את שורת האישור לפני החתימה.');
    }
    setBusy(true); setProblem(null);
    try {
      const r = await fetch(`/api/h/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ declarations: filled.map((f, i) => ({ answers: kept[i], acks: f.acks, signerName: f.name, signature: f.signature, confirm: f.confirm })) }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        if (j?.code === 'missing') goTo(`d${j.declaration}-${j.missing}`, j.message);
        else setError(j?.message ?? 'החתימה לא נשמרה. נסו שוב.');
        return;
      }
      try { sessionStorage.removeItem(store); } catch { /* nothing */ }
      setDone(j.pdfs ?? []);
      window.scrollTo({ top: 0 });
    } catch {
      setProblem({ id: '', message: 'אין חיבור כרגע — התשובות נשמרו בטלפון. נסו שוב בעוד רגע.' });
    } finally { setBusy(false); }
  }

  const shell = (children: React.ReactNode) => (
    <main dir="rtl" lang="he" className="min-h-screen bg-zinc-50 px-4 py-6 text-black" style={{ colorScheme: 'light' }}>
      <div className="mx-auto max-w-xl">{children}</div>
    </main>
  );
  if (error) return shell(<p className="mt-16 text-center text-lg" role="alert">{error}</p>);
  if (!page) return shell(<p className="mt-16 text-center" aria-live="polite">טוען…</p>);
  if (done) return shell(
    <div className="mt-10 rounded-2xl bg-white p-6 text-center shadow-sm">
      <p className="text-2xl font-bold">תודה, ההצהרה התקבלה ✓</p>
      <p className="mt-2 text-zinc-600">{page.business} קיבל/ה את ההצהרה החתומה.</p>
      {done.length > 0 && <p className="mt-4 text-sm text-zinc-600">אפשר לשמור עותק עכשיו (הקישור לא יציג אותו שוב):</p>}
      <div className="mt-3 flex flex-col gap-2">
        {done.map((p) => (
          <button key={p.file} type="button" className={`${btn} border-[#6b3bf5] bg-[#6b3bf5] text-white`} onClick={() => {
            const bytes = Uint8Array.from(atob(p.pdf), (c) => c.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
            const a = document.createElement('a'); a.href = url; a.download = p.file; a.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
          }}>הורדת עותק: {p.title}</button>
        ))}
      </div>
    </div>,
  );

  const totals = page.declarations.reduce((s, d, i) => { const p = progress(d.fields, filled[i]?.answers ?? {}); return { done: s.done + p.done, total: s.total + p.total }; }, { done: 0, total: 0 });
  return shell(
    <>
      <header className="mb-4">
        <p className="text-sm text-zinc-600">{page.business}</p>
        <h1 className="text-2xl font-bold">{page.firstName ? `שלום ${page.firstName},` : 'שלום,'} {page.declarations.length > 1 ? `${page.declarations.length} הצהרות בריאות` : 'הצהרת בריאות'}</h1>
        <p className="mt-1 text-sm text-zinc-600">יש לענות בעצמך על כל שאלה. אף תשובה לא מסומנת מראש.</p>
      </header>
      <div className="sticky top-0 z-10 -mx-4 mb-4 bg-zinc-50/95 px-4 py-2 backdrop-blur" aria-live="polite">
        <div className="flex justify-between text-sm font-semibold"><span>{totals.done} מתוך {totals.total} נענו</span></div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-200" role="progressbar" aria-valuemin={0} aria-valuemax={totals.total} aria-valuenow={totals.done} aria-label="התקדמות">
          <div className="h-full rounded-full bg-[#6b3bf5] transition-[width]" style={{ width: `${totals.total ? (totals.done / totals.total) * 100 : 100}%` }} />
        </div>
      </div>

      {page.declarations.map((d, i) => {
        const f = filled[i] ?? empty(d);
        return (
          <section key={d.n} className="mb-6 rounded-2xl bg-white p-4 shadow-sm" aria-labelledby={`d${i}-title`}>
            <h2 id={`d${i}-title`} className="mb-3 text-xl font-bold">{d.title}</h2>
            {d.fields.map((field) => (
              <Question key={field.key} id={`d${i}-${field.key}`} prefix={`d${i}`} field={field} answers={f.answers} problem={problem}
                onAnswer={(k, v) => answer(i, k, v)} />
            ))}
            {d.acks.map((a, k) => (
              <label key={k} id={`d${i}-ack_${k}`} className={`mb-3 flex items-start gap-3 rounded-xl border p-3 ${problem?.id === `d${i}-ack_${k}` ? 'border-red-600' : 'border-zinc-200'}`}>
                <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[#6b3bf5]" checked={f.acks[k] ?? false}
                  onChange={(e) => set(i, { acks: f.acks.map((x, j) => (j === k ? e.target.checked : x)) })} aria-invalid={problem?.id === `d${i}-ack_${k}`} />
                <span className="whitespace-pre-wrap">{a}</span>
              </label>
            ))}

            <div className="mt-4 border-t border-zinc-200 pt-4">
              <label id={`d${i}-signer_name`} className="mb-3 block">
                <span className="mb-1 block font-semibold">שם מלא <span aria-hidden className="text-red-600">*</span></span>
                <input className={`${input} ${problem?.id === `d${i}-signer_name` ? 'border-red-600' : ''}`} value={f.name} autoComplete="name"
                  onChange={(e) => set(i, { name: e.target.value })} aria-required aria-invalid={problem?.id === `d${i}-signer_name`} />
              </label>
              <div id={`d${i}-signature`} className="mb-3">
                <span className="mb-1 block font-semibold">חתימה באצבע <span aria-hidden className="text-red-600">*</span></span>
                <SignaturePad value={f.signature} onChange={(v) => set(i, { signature: v })} invalid={problem?.id === `d${i}-signature`} />
                {i > 0 && filled[0]?.signature && !f.signature && (
                  <button type="button" className="mt-2 text-sm font-semibold text-[#6b3bf5] underline" onClick={() => set(i, { signature: filled[0].signature, name: f.name || filled[0].name })}>
                    השתמש/י באותה חתימה
                  </button>
                )}
              </div>
              <label id={`d${i}-confirm`} className={`flex items-start gap-3 rounded-xl border p-3 ${problem?.id === `d${i}-confirm` ? 'border-red-600' : 'border-zinc-200'}`}>
                <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[#6b3bf5]" checked={f.confirm} onChange={(e) => set(i, { confirm: e.target.checked })}
                  aria-invalid={problem?.id === `d${i}-confirm`} />
                <span className="font-semibold">{CONFIRM_LINE}</span>
              </label>
              <p className="mt-2 text-xs text-zinc-500">התאריך והשעה נרשמים אוטומטית בשרת בזמן השליחה.</p>
            </div>
          </section>
        );
      })}

      {problem && <p className="mb-3 rounded-xl bg-red-50 p-3 font-semibold text-red-700" role="alert">{problem.message}</p>}
      <button type="button" onClick={submit} disabled={busy} className={`${btn} mb-10 w-full border-[#6b3bf5] bg-[#6b3bf5] text-lg text-white disabled:opacity-60`}>
        {busy ? 'שולח…' : 'חתום/י ושלח/י'}
      </button>
    </>,
  );
}
