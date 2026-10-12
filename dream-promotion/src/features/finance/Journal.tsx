'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { Button, Card, Chip, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { Modal, Spinner } from '@/components/ui/feedback';
import { useLocations } from '@/features/locations/store';
import { LocationField, locationColumn } from '@/features/locations/LocationSwitch';
import { locationTag } from '@/features/locations/locations';
import { useFinance } from './FinanceScreen';
import { EXPENSE_CATEGORIES } from './expenses';
import { JOURNAL_MIGRATION, createEntry, loadEntries, loadWriter, reverseEntry, useJournalReadyState } from './journal-data';
import {
  KIND_HINT, KIND_LABEL, SIDE_LABEL, canReverse, draftAsEntry, effectText, emptyDraft, entriesTotals, journalErrors, journalTable, kindText, kindsFor, partyKinds,
  partyText, reverseErrors, vatAt, type JournalDraft, type JournalEntry, type JournalKind,
} from './journal';
import { TableCard } from './ReportBook';
import { LOAD_FAILED, LoadFailed, Note, PeriodPicker, Pill, Stat, ddmmyyyy, ils, periodNow, todayIL, type Period } from './ui';

/**
 * "פקודות יומן" (2.96, T13א — once migration 20261011005100 is in the database): a movement no document made — a correction, a
 * provision, a move between kinds — recorded by the business's owners with an explanation. It is in the VAT working paper, profit
 * and loss and the cards (marked "פקודה ידנית"), never changed and never removed: undone by a reversing entry, with a reason.
 * Every number follows the location picked at the top, as the reports do.
 */
export function Journal() {
  const ready = useJournalReadyState();
  const { profile, vat, settings, access, say } = useFinance();
  const locState = useLocations((x) => x.state);
  const [period, setPeriod] = useState<Period>(() => periodNow(profile.vatPeriod === 'monthly' ? 'month' : 'bimonth'));
  const [list, setList] = useState<JournalEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writer, setWriter] = useState(false);
  const [adding, setAdding] = useState(false);
  const [undo, setUndo] = useState<JournalEntry | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const r = await loadEntries(period);
    if (r.ok) setList(r.data); else { setList(null); setError(r.error); }
  }, [period]);
  useEffect(() => { if (ready) void load(); }, [ready, load]);
  useEffect(() => { if (ready) void loadWriter().then(setWriter); }, [ready]);

  const totals = useMemo(() => entriesTotals(list ?? []), [list]);
  const multi = locState.locations.filter((l) => l.active).length > 1;
  const table = useMemo(() => journalTable(list ?? [], { vatOn: vat, ...(multi ? { locationName: (id: string) => locState.locations.find((l) => l.id === id)?.name ?? null } : {}) }),
    [list, vat, multi, locState.locations]);

  if (ready === null) return <div className="py-8 text-center"><Spinner /></div>;
  if (!ready) return <Note tone="warn">{JOURNAL_MIGRATION}</Note>;
  return (
    <div className="grid gap-4">
      <p className="text-sm text-ink-2">
        תנועה שלא נוצרה ממסמך — תיקון, הפרשה או העברה בין סיווגים. נכללת בדוח המע״מ, ברווח והפסד ובכרטסות, ומסומנת "פקודה ידנית".
        אין מחיקה ואין עריכה: תיקון בפקודה הפוכה.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PeriodPicker value={period} onChange={setPeriod} vatKind={profile.vatPeriod === 'monthly' ? 'month' : 'bimonth'} />
        {writer ? <Button variant="primary" onClick={() => setAdding(true)}>+ פקודה ידנית</Button>
          : <span className="text-xs text-muted">רק הבעלים (ורואה חשבון שצורף לעסק) רושמים פקודות.</span>}
      </div>
      {error ? <LoadFailed message={error === LOAD_FAILED ? null : error} onRetry={() => void load()} /> : !list ? <div className="py-8 text-center"><Spinner /></div> : <>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Stat label="הכנסות מפקודות" value={ils(totals.income)} hint={vat ? `מע״מ עסקאות ${ils(totals.vatOut)}` : undefined} />
          <Stat label="הוצאות מפקודות" value={ils(totals.expense)} hint={vat ? `מע״מ תשומות ${ils(totals.vatIn)}` : undefined} />
          <Stat label="פקודות בתקופה" value={String(totals.count)} hint="כולל פקודות הפוכות" />
          {access.lockedUntil ? <Stat label="ספרים סגורים עד" value={ddmmyyyy(access.lockedUntil)} hint="פקודה — רק אחרי התאריך הזה" /> : null}
        </div>
        {!list.length ? <Card className="p-4"><p className="text-sm text-muted">אין פקודות ידניות בתקופה הזו.</p></Card> : (
          <ul className="grid gap-2" aria-label="פקודות יומן">
            {list.map((e) => {
              const where = locationTag(locState, { location_id: e.locationId }, locState.businessId ?? '');
              return (
                <li key={e.id} data-entry={e.number}>
                  <Card className="p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="tabular-nums">פקודה {e.number}</strong>
                      <span className="text-sm text-muted">{ddmmyyyy(e.date)}</span>
                      <Pill tone={e.kind === 'income' ? 'ok' : e.kind === 'expense' ? 'warn' : 'info'}>
                        {kindText(e)}
                      </Pill>
                      {e.reversesNumber != null && <Pill tone="info">הופכת את פקודה {e.reversesNumber}</Pill>}
                      {e.reversedBy != null && <Pill tone="bad">בוטלה בפקודה {e.reversedBy}</Pill>}
                      {where && <span className="text-xs text-muted">{where}</span>}
                      <span className="ms-auto text-sm tabular-nums">{e.kind === 'vat' ? `מע״מ ${ils(e.vat)}` : `${ils(e.amount)}${vat && e.vat ? ` + מע״מ ${ils(e.vat)}` : ''}`}</span>
                    </div>
                    <p className="mt-1 text-sm">{e.explanation}</p>
                    {e.party && <p className="text-xs text-muted">{partyText(e.party)}</p>}
                    <p className="text-xs text-muted">{effectText(e)}</p>
                    {writer && canReverse(e) && (
                      <div className="mt-2"><Button size="sm" variant="ghost" onClick={() => setUndo(e)}>פקודה הפוכה</Button></div>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
        <TableCard table={table} period={period} subtitle={`${period.label}`} empty="אין פקודות ידניות בתקופה הזו." />
      </>}
      {adding && <NewEntryDialog vatRate={settings.vatRate} vatOn={vat} lockedUntil={access.lockedUntil} onClose={() => setAdding(false)}
        onDone={(n) => { setAdding(false); say(`פקודה ${n} נרשמה`); void load(); }} />}
      {undo && <ReverseDialog entry={undo} vatOn={vat} lockedUntil={access.lockedUntil} onClose={() => setUndo(null)}
        onDone={(n) => { const was = undo.number; setUndo(null); say(`פקודה ${n} הופכת את פקודה ${was}`); void load(); }} />}
    </div>
  );
}

function NewEntryDialog({ vatRate, vatOn, lockedUntil, onClose, onDone }: {
  vatRate: number; vatOn: boolean; lockedUntil: string | null; onClose: () => void; onDone: (number: number) => void;
}) {
  const today = todayIL();
  const leads = useApp((s) => s.leads);
  const locState = useLocations((x) => x.state);
  const [id] = useState(() => crypto.randomUUID());
  const [d, setD] = useState<JournalDraft>(() => emptyDraft(today));
  const [q, setQ] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<JournalDraft>) => setD((x) => ({ ...x, ...p }));
  const kinds = kindsFor(vatOn);
  const sides = partyKinds(d.kind);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    return leads.filter((l) => l.name.toLowerCase().includes(s) || (l.phone ?? '').replace(/\D/g, '').includes(s.replace(/\D/g, '') || '§')).slice(0, 6);
  }, [q, leads]);
  const amount = Number(d.amount.replace(/,/g, ''));
  const suggested = Number.isFinite(amount) && amount !== 0 ? vatAt(amount, vatRate) : null;
  const preview = effectText(draftAsEntry(d, vatOn));
  // a kind that takes no party (VAT), or the other kind of party, drops what was picked
  const pickKind = (k: JournalKind) => setD((x) => ({ ...x, kind: k, vatSide: k === 'vat' ? x.vatSide : null,
    party: x.party && partyKinds(k).includes(x.party.kind) ? x.party : null, ...(k === 'vat' ? { amount: '' } : {}), ...(k === 'other' ? { vat: '' } : {}) }));
  async function save() {
    const e = journalErrors(d, { today, lockedUntil, vatOn });
    if (e.length) { setErrors(e); return; }
    if (!window.confirm(`לרשום את הפקודה? ${preview}. פקודה שנרשמה לא נמחקת ולא משתנה — תיקון רק בפקודה הפוכה.`)) return;
    setBusy(true); setErrors([]);
    const r = await createEntry(id, { ...d, locationId: locationColumn(locState, d.locationId).location_id ?? null }, vatOn);
    setBusy(false);
    if (!r.ok) { setErrors([r.error]); return; }
    onDone(r.data.number);
  }
  return (
    <Modal open onClose={onClose} wide>
      <h3 className="mb-1 font-display text-lg font-extrabold">פקודה ידנית</h3>
      <p className="mb-3 text-sm text-muted">תנועה שלא נוצרה ממסמך. אחרי הרישום — אין עריכה ואין מחיקה; תיקון בפקודה הפוכה.</p>
      <div className="mb-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="סוג הפקודה">
        {kinds.map((k) => <Chip key={k} on={d.kind === k} onClick={() => pickKind(k)} role="radio" aria-checked={d.kind === k}>{KIND_LABEL[k]}</Chip>)}
      </div>
      <p className="mb-3 text-xs text-muted">{KIND_HINT[d.kind]}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="תאריך"><Input type="date" value={d.date} max={today} onChange={(e) => set({ date: e.target.value || today })} /></Field>
        <LocationField value={d.locationId} onChange={(v) => set({ locationId: v })} />
        {d.kind !== 'vat' && (
          <Field label={vatOn && d.kind !== 'other' ? 'סכום לפני מע״מ' : 'סכום'}>
            <Input inputMode="decimal" value={d.amount} onChange={(e) => set({ amount: e.target.value })} placeholder="למשל 250 (מינוס לתיקון שמקטין)" dir="ltr" />
          </Field>
        )}
        {vatOn && d.kind !== 'other' && (
          <Field label={d.kind === 'vat' ? 'סכום המע״מ' : 'מע״מ'}>
            <div className="flex gap-1.5">
              <Input inputMode="decimal" value={d.vat} onChange={(e) => set({ vat: e.target.value })} placeholder="0" dir="ltr" aria-label={d.kind === 'vat' ? 'סכום המע״מ' : 'מע״מ'} />
              {d.kind !== 'vat' && suggested != null && (
                <Button size="sm" variant="ghost" onClick={() => set({ vat: String(suggested) })}>{`לפי ${vatRate}%: ${ils(suggested)}`}</Button>
              )}
            </div>
          </Field>
        )}
        {d.kind === 'vat' && (
          <Field label="איפה בדוח המע״מ">
            <div className="flex gap-1.5" role="radiogroup" aria-label="עסקאות או תשומות">
              {(['output', 'input'] as const).map((s) => <Chip key={s} on={d.vatSide === s} onClick={() => set({ vatSide: s })} role="radio" aria-checked={d.vatSide === s}>{SIDE_LABEL[s]}</Chip>)}
            </div>
          </Field>
        )}
        {d.kind === 'expense' && (
          <Field label="סוג הוצאה">
            <Select value={d.category} onChange={(e) => set({ category: e.target.value })}>
              {EXPENSE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </Field>
        )}
      </div>
      {sides.length > 0 && (
        <div className="mt-2 grid gap-2">
          <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="שייך ל">
            <span className="text-sm font-semibold">שייך ל:</span>
            <Chip on={!d.party} onClick={() => set({ party: null })} role="radio" aria-checked={!d.party}>אף אחד</Chip>
            {sides.map((k) => <Chip key={k} on={d.party?.kind === k} onClick={() => set({ party: { kind: k, leadId: null, name: '', dealer: '' } })} role="radio" aria-checked={d.party?.kind === k}>
              {k === 'customer' ? 'לקוח' : 'ספק'}</Chip>)}
          </div>
          {d.party?.kind === 'customer' && (
            <div className="grid gap-2">
              <div className="relative">
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לקוח ברשימת הלקוחות (שם או טלפון)" aria-label="חיפוש לקוח" />
                {hits.length > 0 && (
                  <div className="absolute inset-x-0 top-full z-10 mt-1 grid rounded-2xl border border-line bg-surface p-1 shadow-lg">
                    {hits.map((l) => <button key={l.id} type="button" onClick={() => { set({ party: { kind: 'customer', leadId: l.id, name: l.name, dealer: l.billingDealer ?? '' } }); setQ(''); }}
                      className="rounded-xl px-3 py-2 text-start text-sm hover:bg-surface-2">{l.name}{l.phone ? ` · ${l.phone}` : ''}</button>)}
                  </div>
                )}
              </div>
              {d.party.leadId && <p className="text-xs text-muted">מקושר לכרטיס של {d.party.name} · <button type="button" className="text-primary" onClick={() => set({ party: { kind: 'customer', leadId: null, name: '', dealer: '' } })}>ניתוק</button></p>}
            </div>
          )}
          {d.party && !d.party.leadId && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input value={d.party.name} onChange={(e) => set({ party: { ...d.party!, name: e.target.value } })} placeholder={d.party.kind === 'customer' ? 'שם הלקוח' : 'שם הספק'}
                aria-label={d.party.kind === 'customer' ? 'שם הלקוח' : 'שם הספק'} maxLength={120} />
              <Input value={d.party.dealer} onChange={(e) => set({ party: { ...d.party!, dealer: e.target.value.replace(/\D/g, '').slice(0, 9) } })} placeholder="ע.מ / ח.פ (לא חובה)"
                inputMode="numeric" dir="ltr" aria-label="מספר עוסק" />
            </div>
          )}
          <p className="text-xs text-muted">{d.party ? 'הפקודה תופיע בכרטסת שלו — לא ב"חייבים" (היא לא חשבונית).' : 'בלי לקוח או ספק — רק בסיכומים ובדוחות.'}</p>
        </div>
      )}
      <Field label="הסבר (חובה)"><Textarea value={d.explanation} onChange={(e) => set({ explanation: e.target.value })} maxLength={500} className="min-h-16"
        placeholder="מה הפקודה ולמה — למשל: הפרשה לחופשה לפי רואה החשבון" /></Field>
      <p className="mt-1 text-sm">משפיעה על: <strong>{preview}</strong></p>
      {errors.length > 0 && <div className="mt-2"><Note tone="warn">{errors.map((e) => <span key={e} className="block">{e}</span>)}</Note></div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'רושם…' : 'רישום הפקודה'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}

function ReverseDialog({ entry, vatOn, lockedUntil, onClose, onDone }: {
  entry: JournalEntry; vatOn: boolean; lockedUntil: string | null; onClose: () => void; onDone: (number: number) => void;
}) {
  const today = todayIL();
  const [id] = useState(() => crypto.randomUUID());
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const opposite = effectText({ kind: entry.kind, amount: -entry.amount, vat: vatOn ? -entry.vat : 0, vatSide: entry.vatSide });
  async function save() {
    const e = reverseErrors(entry, { date, reason }, { today, lockedUntil });
    if (e.length) { setErrors(e); return; }
    setBusy(true); setErrors([]);
    const r = await reverseEntry(id, entry.id, date, reason);
    setBusy(false);
    if (!r.ok) { setErrors([r.error]); return; }
    onDone(r.data.number);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">פקודה הפוכה לפקודה {entry.number}</h3>
      <p className="mb-3 text-sm text-muted">אותה פקודה בסימן הפוך — פעם אחת, עם סיבה. פקודה {entry.number} נשארת, מסומנת "בוטלה".</p>
      <p className="mb-2 text-sm">{entry.explanation}</p>
      <Field label="תאריך"><Input type="date" value={date} min={entry.date} max={today} onChange={(e) => setDate(e.target.value || today)} /></Field>
      <Field label="סיבה (חובה)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="min-h-12" /></Field>
      <p className="mt-1 text-sm">משפיעה על: <strong>{opposite}</strong></p>
      {errors.length > 0 && <div className="mt-2"><Note tone="warn">{errors.map((e) => <span key={e} className="block">{e}</span>)}</Note></div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'רושם…' : 'רישום הפקודה ההפוכה'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}
