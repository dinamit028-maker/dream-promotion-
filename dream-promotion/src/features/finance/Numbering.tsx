'use client';
import { useEffect, useState } from 'react';
import { Button, Card, Field, Input } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { DOC_LABEL } from '@/features/documents/documents';
import { formatIL } from '@/lib/il-time';
import { multiLocation } from '@/features/locations/locations';
import { useLocations } from '@/features/locations/store';
import { Note, Pill } from './ui';
import { loadNumbering, setBranchCode, switchPerLocation } from './numbering-data';
import { SWITCH_CONFIRM, SWITCH_EXPLAIN, branchCodeProblem, canSwitch, normalizeCode, showNumbering, type NumberingState } from './numbering';

/**
 * 2.120 — "מספור מסמכים" in the money settings (migration 20261127007000; the accountant's answer 5, the owner's decisions of
 * 26.11.2026): how the business numbers its documents now, the owner's one-way switch to a series per location (confirmed in the
 * page: "פעם אחת, אין דרך חזרה"), and each location's branch code ('01'–'99', until its first document of its series).
 * Shown only to the owner, only with more than one active location, and only once the migration is in the database
 * (showNumbering) — otherwise nothing at all (a business with one location sees nothing of locations).
 */
export function NumberingSettings({ say, fail }: { say: (m: string) => void; fail: (m: string) => void }) {
  const loc = useLocations((x) => x.state);
  const [state, setState] = useState<NumberingState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const multi = multiLocation(loc);
  useEffect(() => {
    if (!loc.owner || !multi) return;
    let alive = true;
    void loadNumbering().then((r) => {
      if (!alive) return;
      if (r.ok && r.ready) setState(r.state);
      else if (!r.ok) setError(r.error);
    });
    return () => { alive = false; };
  }, [loc.owner, multi]);
  if (!loc.owner || !multi) return null;
  if (error && !state) return <Card className="p-4"><p className="mb-1 font-bold">מספור מסמכים</p><Note tone="warn">{error}</Note></Card>;
  if (!state) return null;   // before migration 7000 (or still asking): nothing
  if (!showNumbering({ owner: loc.owner, multi, state })) return null;

  async function doSwitch() {
    if (typed.trim() !== SWITCH_CONFIRM) return;
    setBusy(true);
    const r = await switchPerLocation();
    setBusy(false);
    if (!r.ok) { fail(r.error); return; }
    setState(r.state); setConfirming(false); setTyped('');
    say('מעכשיו לכל סניף סדרת מספור משלו. מסמכים שכבר הופקו לא השתנו.');
  }
  async function saveCode(id: string) {
    const code = codes[id] ?? '';
    const others = state!.locations.filter((l) => l.id !== id).map((l) => l.branchCode);
    const bad = branchCodeProblem(code, others);
    if (bad) { fail(bad); return; }
    setBusy(true);
    const r = await setBranchCode(id, code);
    if (r.ok) { const again = await loadNumbering(); if (again.ok && again.ready) setState(again.state); setCodes((c) => { const n = { ...c }; delete n[id]; return n; }); say(`קוד הסניף נשמר: ${r.code ?? normalizeCode(code)}`); }
    else fail(r.error);
    setBusy(false);
  }

  return (
    <Card className="p-4"><section aria-label="מספור מסמכים">
      <p className="mb-1 font-bold">מספור מסמכים</p>
      {state.perLocation ? (
        <p className="mb-2 text-sm"><Pill tone="ok">לפי סניף</Pill> מסמכים חדשים ממוספרים בסדרה של הסניף: קוד הסניף ואחריו המספר הרץ (למשל 01000001).
          {state.since ? ` מאז ${formatIL(state.since)}.` : ''} מסמכים שהופקו לפני כן שומרים את המספר שלהם.</p>
      ) : (
        <p className="mb-2 text-sm"><Pill tone="info">סדרה אחת לעסק</Pill> כל הסניפים ממוספרים יחד, בסדרה אחת לכל סוג מסמך.</p>
      )}

      <ul className="mb-2 grid gap-2 text-sm">{state.locations.map((l) => {
        const others = state.locations.filter((x) => x.id !== l.id).map((x) => x.branchCode);
        const draft = codes[l.id];
        return (
          <li key={l.id} className="rounded-2xl border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="min-w-0 flex-1 truncate">{l.name}{l.active ? '' : ' (סגור)'}</strong>
              <span>קוד סניף: <strong dir="ltr" className="tabular-nums">{l.branchCode ?? '—'}</strong></span>
              {l.codeFixed && <Pill tone="info">נקבע</Pill>}
            </div>
            {!l.codeFixed && (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Field label="קוד חדש (01–99)">
                  <Input value={draft ?? ''} onChange={(e) => setCodes((c) => ({ ...c, [l.id]: e.target.value.replace(/\D/g, '').slice(0, 2) }))}
                    inputMode="numeric" dir="ltr" className="w-20" aria-label={`קוד סניף — ${l.name}`} />
                </Field>
                <Button size="sm" variant="ghost" disabled={busy || !draft} onClick={() => void saveCode(l.id)}>שמירת הקוד</Button>
                {draft ? <span className="text-xs text-muted">{branchCodeProblem(draft, others)}</span> : null}
              </div>
            )}
            {l.series.length > 0 && (
              <ul className="mt-2 grid gap-0.5 text-xs text-muted">{l.series.map((x) => (
                <li key={x.docType}>{DOC_LABEL[x.docType] ?? x.docType}: האחרון <span dir="ltr" className="tabular-nums">{x.last}</span> · הבא <span dir="ltr" className="tabular-nums">{x.next}</span></li>
              ))}</ul>
            )}
          </li>
        );
      })}</ul>
      <p className="mb-2 text-xs text-muted">קוד הסניף — שתי הספרות הראשונות של מספרי המסמכים של הסניף, ומזהה הסניף בקובץ לרשות המסים. אפשר לשנות אותו עד המסמך הראשון של הסניף בסדרה שלו.</p>

      {canSwitch(state) && !confirming && (
        <Button variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>מעבר למספור לפי סניף…</Button>
      )}
      {canSwitch(state) && confirming && (
        <section aria-label="אישור מעבר למספור לפי סניף" className="grid gap-2 rounded-2xl border border-amber-500/50 p-3 text-sm">
          <p className="font-bold">מעבר למספור לפי סניף — {SWITCH_CONFIRM}</p>
          <ul className="grid list-disc gap-1 ps-5">{SWITCH_EXPLAIN.map((x) => <li key={x}>{x}</li>)}</ul>
          <Field label={`כדי לאשר — הקלידו: ${SWITCH_CONFIRM}`}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="אישור המעבר" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy || typed.trim() !== SWITCH_CONFIRM} onClick={() => void doSwitch()}>{busy ? 'רגע…' : 'מעבר למספור לפי סניף'}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setConfirming(false); setTyped(''); }}>ביטול</Button>
          </div>
        </section>
      )}
      {busy && !confirming && <Spinner />}
    </section></Card>
  );
}
