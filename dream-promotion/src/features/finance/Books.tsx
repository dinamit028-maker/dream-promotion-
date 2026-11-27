'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Card, Field, Input } from '@/components/ui/primitives';
import { Note, Pill, ddmmyyyy, ils, todayIL } from './ui';
import { loadBooks, moveBooksStart, replayNow } from './books-data';
import { useBooksArea } from './ledger-data';
import { financeHref } from './routes';
import { latestStart, monthOf, firstOf, replayMessage, showBooks, startMonthProblem, startMoveExplain, type BooksState } from './books';

/**
 * 2.121 — "ספרים" in the money settings (stage 4ב, migration 20261128007100; answers 13 / 14 of stage 4): read only — since when
 * the business keeps double-entry books, whether the opening balances were entered, how many entries were written and how many
 * sources did not post (gl_unposted). The owner only, and only once the migration is in the database — otherwise nothing at all.
 * The one action: while nothing was posted (canMoveStart), the owner may move the start to the 1st of another month, confirmed in
 * the page. The opening balances' form, the ledgers and the reports are stage 4ד.
 */
export function BooksSettings({ say, fail, business }: { say: (m: string) => void; fail: (m: string) => void; business: string | null }) {
  const [state, setState] = useState<BooksState | null>(null);
  const [unposted, setUnposted] = useState<number | null>(null);
  const [suspense, setSuspense] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // 2.123: the books' screens ("הנהלת חשבונות") — once migration 7200 is in the database
  const area = useBooksArea();
  async function reload() {
    const r = await loadBooks();
    if (r.ok && r.ready) { setState(r.state); setUnposted(r.unposted); setSuspense(r.suspense); setError(null); }
    else if (!r.ok) setError(r.error);
  }
  useEffect(() => {
    let alive = true;
    void loadBooks().then((r) => {
      if (!alive) return;
      if (r.ok && r.ready) { setState(r.state); setUnposted(r.unposted); setSuspense(r.suspense); }
      else if (!r.ok) setError(r.error);
    });
    return () => { alive = false; };
  }, []);
  if (error && !state) return null;              // not readable (a member who is not the owner, a cashier): nothing
  if (!showBooks(state)) return null;            // before migration 7100, still asking, or not the owner

  const today = todayIL();
  const problem = month ? startMonthProblem(month, today, state.startDate) : null;
  const day = month && !problem ? firstOf(month) : null;
  async function doMove() {
    if (!day) return;
    setBusy(true);
    const r = await moveBooksStart(day);
    if (!r.ok) { setBusy(false); fail(r.error); return; }
    setConfirming(false); setMonth('');
    // 7100: the move posts nothing itself — what was issued since the new start is posted here, in batches (the rest tonight)
    const p = business && day <= today ? await replayNow(business) : null;
    setBusy(false);
    await reload();
    say(`תחילת הספרים נשמרה: ${ddmmyyyy(day)}.${p && p.ok && (p.posted || p.failed || p.left) ? ` ${replayMessage(p)}` : ''}`);
  }

  // what did not post, now (the owner): a few batches here, the rest by the night's timer (replayPending)
  async function doReplay() {
    if (!business) return;
    setBusy(true);
    const r = await replayNow(business, { retry: true });   // the owner asks: what failed today is tried again
    setBusy(false);
    if (!r.ok) { fail(r.error); return; }
    await reload();
    say(replayMessage(r));
  }

  return (
    <Card className="p-4"><section aria-label="ספרים">
      <p className="mb-1 font-bold">ספרים (הנהלת חשבונות כפולה)</p>
      <ul className="mb-2 grid gap-1 text-sm">
        <li>תחילת הספרים: <strong dir="ltr" className="tabular-nums">{ddmmyyyy(state.startDate)}</strong>{' '}
          {state.started ? <Pill tone="ok">פעילים</Pill> : <span className="text-xs text-muted">(יתחילו בתאריך הזה)</span>}</li>
        <li>יתרות פתיחה: {state.openingEntered ? <Pill tone="ok">נרשמו</Pill> : <Pill tone="warn">עוד לא נרשמו</Pill>}</li>
        <li>פקודות שנרשמו: <strong className="tabular-nums">{state.transactions}</strong></li>
        {unposted != null && (
          <li className="flex flex-wrap items-center gap-2"><span>ממתינים לרישום: <strong className="tabular-nums">{unposted}</strong>{unposted > 0 ? ' — לא נרשמו בספרים (הסיבה נשמרת; ננסה שוב כל לילה)' : ''}</span>
            {unposted > 0 && business && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void doReplay()}>{busy ? 'רושם…' : 'לרשום עכשיו'}</Button>}</li>
        )}
        {suspense != null && suspense !== 0 && (
          <li>חשבון מעבר — לבירור (9100): <strong dir="ltr" className="tabular-nums">{ils(suspense)}</strong> — סכומים שלא נמצא להם חשבון; לבירור עם רואה החשבון.</li>
        )}
      </ul>
      <p className="mb-2 text-xs text-muted">כל מסמך, תשלום והפקדה מתאריך ההתחלה נרשמים בספרים לבד (פקודה מאוזנת לכל אחד). מה שהופק לפני כן — לא.{area.state ? ' יתרות הפתיחה, לוח החשבונות, הכרטסות והדוחות — ב"הנהלת חשבונות".' : ''}</p>
      {area.state && <p className="mb-2"><Link href={financeHref('books', state.openingEntered ? {} : { view: 'opening' })} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm font-semibold">
        {state.openingEntered ? 'להנהלת החשבונות' : 'להנהלת החשבונות — יתרות פתיחה'}</Link></p>}

      {state.canMoveStart && !confirming && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="להזיז את תחילת הספרים לחודש">
            <Input type="month" value={month} min={monthOf('2000-01-01')} max={monthOf(latestStart(today))} onChange={(e) => setMonth(e.target.value)}
              aria-label="חודש תחילת הספרים" dir="ltr" className="w-40" />
          </Field>
          <Button size="sm" variant="ghost" disabled={busy || !day} onClick={() => setConfirming(true)}>הזזה…</Button>
          {problem && <span aria-live="polite" className="text-xs text-warn">{problem}</span>}
        </div>
      )}
      {state.canMoveStart && confirming && day && (
        <section aria-label="אישור הזזת תחילת הספרים" className="grid gap-2 rounded-2xl border border-amber-500/50 p-3 text-sm">
          <p className="font-bold">להזיז את תחילת הספרים ל-{ddmmyyyy(day)}?</p>
          <ul className="grid list-disc gap-1 ps-5">{startMoveExplain(day, today, state.startDate).map((x) => <li key={x}>{x}</li>)}</ul>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void doMove()}>{busy ? 'רגע…' : `אישור — ${ddmmyyyy(day)}`}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>ביטול</Button>
          </div>
        </section>
      )}
      {!state.canMoveStart && <Note tone="info">כבר נרשמו פקודות בספרים — תאריך ההתחלה קבוע.</Note>}
    </section></Card>
  );
}
