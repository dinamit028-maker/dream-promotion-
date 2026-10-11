'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { Button, Card, Chip, Field, Input, Textarea } from '@/components/ui/primitives';
import { Modal, Spinner } from '@/components/ui/feedback';
import { DOC_LABEL } from '@/features/documents/documents';
import { useLocations } from '@/features/locations/store';
import { LocationField, locationColumn } from '@/features/locations/LocationSwitch';
import { defaultLocation, locationName, multiLocation } from '@/features/locations/locations';
import { useFinance } from './FinanceScreen';
import { CASH_MIGRATION, cancelDeposit, createDeposit, loadChequeBook, loadDeposits, loadDesks, useCashReadyState } from './cash-data';
import {
  DESK_HINT, DESK_LABEL, DESK_METHODS, DUE_LABEL, chequeDue, chequesTable, depositErrors, depositTotal, deskValue, type Cheque, type ChequeBook, type Deposit, type Desks,
} from './desks';
import { LEDGER_SOURCE_HE, payLabel, toLedgerRow, type LedgerRow, type PayMethod } from './payments';
import { TableCard } from './ReportBook';
import { LOAD_FAILED, LoadFailed, Note, PeriodPicker, Pill, Stat, ddmmyyyy, ils, periodNow, todayIL, type Period } from './ui';

/**
 * "קופות והפקדות" (2.95, T9 — once the business turned the desks on): a desk for every way money comes in, read from the payments
 * ledger; the cash the desk holds and the cheques in the drawer (each with its due day — the reminder comes before it); a deposit
 * of cash and cheques to the bank (one deposit, many receipts — a deposited receipt leaves the desk), and the report of the
 * cheques deposited. Every number follows the location picked at the top, as the ledger does.
 */
type Tab = 'moves' | 'cheques' | 'deposits';

export function CashDesks() {
  const { profile, params, clearParams, say, go } = useFinance();
  const ready = useCashReadyState();
  const locState = useLocations((x) => x.state);
  const [period, setPeriod] = useState<Period>(() => periodNow('month'));
  const [tab, setTab] = useState<Tab>('moves');
  const [method, setMethod] = useState<PayMethod | 'all'>('all');
  const [desks, setDesks] = useState<Desks | null>(null);
  const [book, setBook] = useState<ChequeBook | null>(null);
  const [deps, setDeps] = useState<Deposit[] | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newDep, setNewDep] = useState(false);
  const [cancelling, setCancelling] = useState<Deposit | null>(null);

  // ?tab=cheques — the reminder's notification opens the cheques
  useEffect(() => { const t = params.get('tab'); if (t === 'cheques' || t === 'deposits') { setTab(t); clearParams(); } }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, b, p, led] = await Promise.all([loadDesks(period), loadChequeBook(period), loadDeposits(period),
        supabase().from('payments').select('*').gte('paid_on', period.from).lte('paid_on', period.to).neq('method', 'withholding')
          .order('paid_on', { ascending: false }).order('created_at', { ascending: false }).limit(500)]);
      if (!d.ok) { setError(d.error); return; }
      setDesks(d.data);
      setBook(b.ok ? b.data : { drawer: [], deposited: [] });
      setDeps(p.ok ? p.data : []);
      setLedger(led.error ? [] : ((led.data ?? []) as any[]).map(toLedgerRow));
    } catch { setError(LOAD_FAILED); }
  }, [period]);
  useEffect(() => { if (ready && profile.cashDrawers) void load(); }, [ready, profile.cashDrawers, load]);

  const moves = useMemo(() => (ledger ?? []).filter((r) => method === 'all' || r.method === method), [ledger, method]);
  if (ready === null) return <div className="py-10 text-center"><Spinner /></div>;
  if (!ready) return <Note tone="warn">{CASH_MIGRATION}</Note>;
  if (!profile.cashDrawers) {
    return (
      <Card className="p-4">
        <p className="mb-1 font-bold">קופות, הפקדות והתאמת בנק — כבוי</p>
        <p className="mb-3 text-sm text-muted">קופה לכל אמצעי תשלום, הפקדות לבנק, מעקב צ׳קים והתאמה לקובץ תנועות מהבנק. מפעילים בהגדרות הכספים.</p>
        <Button variant="primary" onClick={() => go('settings')}>להגדרות הכספים</Button>
      </Card>
    );
  }
  const today = todayIL();
  const where = (loc: string | null) => (multiLocation(locState) && !locState.current && loc ? ` · ${locationName(locState, loc)}` : '');
  return (
    <div className="grid min-w-0 gap-3">
      <PeriodPicker value={period} onChange={setPeriod} />
      {error ? <LoadFailed message={error} onRetry={() => void load()} /> : !desks ? <div className="py-8 text-center"><Spinner /></div> : <>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          {DESK_METHODS.map((m) => {
            const v = deskValue(desks, m);
            return <Stat key={m} label={`קופת ${DESK_LABEL[m]}`} value={ils(v.value)} hint={<><span className="block">{v.sub}</span><span className="block opacity-80">{DESK_HINT[m]}</span></>}
              tone={m === 'cheque' && desks.cheques.dueCount ? 'warn' : undefined} onClick={() => { setTab(m === 'cheque' ? 'cheques' : 'moves'); setMethod(m === 'cheque' ? 'all' : m); }} />;
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => setNewDep(true)}>+ הפקדה לבנק</Button>
          <span className="text-sm text-muted">הפקדות בתקופה: {desks.deposits.count} · {ils(desks.deposits.total)}</span>
        </div>
        <div className="flex gap-1.5" role="tablist" aria-label="קופות">
          {([['moves', 'תנועות'], ['cheques', `צ׳קים (${desks.cheques.count})`], ['deposits', 'הפקדות']] as [Tab, string][]).map(([k, label]) => (
            <Chip key={k} on={tab === k} onClick={() => setTab(k)} role="tab" aria-selected={tab === k}>{label}</Chip>
          ))}
        </div>

        {tab === 'moves' && (
          <Card className="min-w-0 p-4">
            <div className="-mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1 pb-1">
              <Chip on={method === 'all'} onClick={() => setMethod('all')} className="shrink-0">הכל</Chip>
              {DESK_METHODS.map((m) => <Chip key={m} on={method === m} onClick={() => setMethod(m)} className="shrink-0">{DESK_LABEL[m]}</Chip>)}
            </div>
            {!moves.length ? <p className="text-sm text-muted">אין תנועות בתקופה הזו.</p> : (
              <ul className="grid gap-1 text-sm">{moves.slice(0, 200).map((r) => (
                <li key={r.id} className="flex min-w-0 items-center justify-between gap-2 border-b border-line py-1.5 last:border-0">
                  <span className="min-w-0 truncate">{ddmmyyyy(r.paidOn)} · {LEDGER_SOURCE_HE[r.source]} · {payLabel(r.method)}{r.note ? ` · ${r.note}` : ''}</span>
                  <strong className={r.direction === 'in' ? 'tabular-nums text-emerald-600 dark:text-emerald-400' : 'tabular-nums text-red-600 dark:text-red-400'}>{r.direction === 'in' ? '+' : '−'}{ils(r.amount)}</strong>
                </li>
              ))}</ul>
            )}
            <p className="mt-2 text-xs text-muted">מיומן התשלומים — בלי טבלת כסף נפרדת. כסף נכנס ויוצא רק עם מסמך, החזר או הוצאה.</p>
          </Card>
        )}

        {tab === 'cheques' && book && <>
          <Card className="min-w-0 p-4">
            <p className="mb-2 font-bold">צ׳קים בקופה ({book.drawer.length})</p>
            {!book.drawer.length ? <p className="text-sm text-muted">אין צ׳קים בקופה.</p> : (
              <ul className="grid gap-1.5 text-sm">{book.drawer.map((c) => {
                const due = chequeDue(c.dueDate, today, desks.remindDays);
                return (
                  <li key={c.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-line py-1.5 last:border-0">
                    <span className="min-w-0">
                      <strong>צ׳ק {c.number || 'בלי מספר'}</strong>{c.bank ? ` · בנק ${c.bank}` : ''}{c.customer ? ` · ${c.customer}` : ''}
                      <span className="block text-xs text-muted">{c.dueDate ? `לפירעון ${ddmmyyyy(c.dueDate)}` : 'בלי תאריך פירעון'}{c.docType && c.docNumber ? ` · ${DOC_LABEL[c.docType]} ${c.docNumber}` : ''}{where(c.location)}</span>
                    </span>
                    <span className="flex items-center gap-2">{DUE_LABEL[due] && <Pill tone={due === 'overdue' ? 'bad' : 'warn'}>{DUE_LABEL[due]}</Pill>}<strong className="tabular-nums">{ils(c.amount)}</strong></span>
                  </li>
                );
              })}</ul>
            )}
            <p className="mt-2 text-xs text-muted">{profile.chequeRemindDays ? `תזכורת לטלפון ${profile.chequeRemindDays} ימים לפני הפירעון (בין 08:00 ל-20:00).` : 'תזכורות לצ׳קים כבויות (הגדרות הכספים).'} צ׳ק יוצא מהקופה כשמפקידים אותו.</p>
          </Card>
          <TableCard table={chequesTable(book.deposited)} period={period} subtitle={`${ddmmyyyy(period.from)} – ${ddmmyyyy(period.to)}`} empty="לא הופקדו צ׳קים בתקופה הזו." />
        </>}

        {tab === 'deposits' && (
          <Card className="min-w-0 p-4">
            <p className="mb-2 font-bold">הפקדות ({deps?.length ?? 0})</p>
            {!deps?.length ? <p className="text-sm text-muted">אין הפקדות בתקופה הזו.</p> : (
              <ul className="grid gap-2 text-sm">{deps.map((d) => (
                <li key={d.id} className="rounded-2xl border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span><strong>הפקדה {d.number}</strong> · {ddmmyyyy(d.date)}{where(d.location)}</span>
                    <span className="flex items-center gap-2">
                      {d.status === 'cancelled' && <Pill tone="bad">בוטלה · {d.cancelReason}</Pill>}
                      {d.matched && <Pill tone="ok">הותאמה לבנק</Pill>}
                      <strong className="tabular-nums">{ils(d.total)}</strong>
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{d.cash ? `מזומן ${ils(d.cash)}` : ''}{d.cash && d.items.length ? ' · ' : ''}{d.items.length ? `${d.items.length} צ׳קים ${ils(d.cheques)}` : ''}{d.note ? ` · ${d.note}` : ''}</p>
                  {d.items.length > 0 && (
                    <ul className="mt-1 grid gap-0.5 text-xs">{d.items.map((x) => <li key={x.payment} className="flex justify-between gap-2"><span className="truncate">צ׳ק {x.number}{x.bank ? ` · בנק ${x.bank}` : ''}{x.customer ? ` · ${x.customer}` : ''}</span><span className="tabular-nums">{ils(x.amount)}</span></li>)}</ul>
                  )}
                  {d.status === 'active' && !d.matched && <Button size="sm" variant="ghost" className="mt-1" onClick={() => setCancelling(d)}>ביטול ההפקדה</Button>}
                </li>
              ))}</ul>
            )}
          </Card>
        )}
      </>}

      {newDep && desks && book && (
        <DepositDialog desks={desks} drawer={book.drawer} onClose={() => setNewDep(false)}
          onDone={(n) => { setNewDep(false); say(`הפקדה ${n} נרשמה`); setTab('deposits'); void load(); }} />
      )}
      {cancelling && <CancelDeposit deposit={cancelling} onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); say('ההפקדה בוטלה — הכסף והצ׳קים חזרו לקופה'); void load(); }} />}
    </div>
  );

}

/** a deposit recorded by mistake: cancelled with a reason (not after the bank matched it) */
function CancelDeposit({ deposit, onClose, onDone }: { deposit: Deposit; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function goCancel() {
    setBusy(true);
    const r = await cancelDeposit(deposit.id, reason);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    onDone();
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">ביטול הפקדה {deposit.number}</h3>
      <p className="mb-3 text-sm text-muted">רק אם נרשמה בטעות. המזומן והצ׳קים חוזרים לקופה; ההפקדה נשארת ברשימה, מסומנת "בוטלה".</p>
      <Field label="סיבה"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
      {err && <Note tone="warn">{err}</Note>}
      <div className="mt-3 flex gap-2"><Button variant="primary" disabled={busy || reason.trim().length < 2} onClick={() => void goCancel()}>ביטול ההפקדה</Button><Button variant="ghost" onClick={onClose}>חזרה</Button></div>
    </Modal>
  );
}

/** a new deposit: the date, the location (with several and "all" picked), cash (up to what the desk holds) and the cheques to take */
function DepositDialog({ desks, drawer, onClose, onDone }: { desks: Desks; drawer: Cheque[]; onClose: () => void; onDone: (number: number) => void }) {
  const locState = useLocations((x) => x.state);
  const today = todayIL();
  const [id] = useState(() => crypto.randomUUID());
  const [date, setDate] = useState(today);
  const [loc, setLoc] = useState<string | null>(null);
  const [cash, setCash] = useState(0);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const place = locationColumn(locState, loc).location_id ?? (multiLocation(locState) ? defaultLocation(locState) : null);
  const here = drawer.filter((c) => !place || !multiLocation(locState) || (c.location ?? locState.businessId) === place);
  const picked = here.filter((c) => chosen.has(c.id));
  const total = depositTotal(cash, picked);
  async function save() {
    const e = depositErrors({ cash, cheques: picked.length, desk: desks.cash, date, today });
    if (e.length) { setErrors(e); return; }
    setBusy(true); setErrors([]);
    const r = await createDeposit({ id, date, location: locationColumn(locState, loc).location_id ?? null, cash, cheques: picked.map((c) => c.id), note });
    setBusy(false);
    if (!r.ok) { setErrors([r.error]); return; }
    onDone(r.data.number);
  }
  return (
    <Modal open onClose={onClose} wide>
      <h3 className="mb-1 font-display text-lg font-extrabold">הפקדה לבנק</h3>
      <p className="mb-3 text-sm text-muted">מזומן וצ׳קים שלקחתם לבנק — הפקדה אחת לכמה קבלות. מה שהופקד יוצא מהקופה.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="תאריך ההפקדה"><Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value || today)} /></Field>
        <LocationField value={loc} onChange={(v) => { setLoc(v); setChosen(new Set()); }} />
      </div>
      <Field label={`מזומן (בקופה ${ils(desks.cash)})`}>
        <div className="flex gap-1.5">
          <Input type="number" inputMode="decimal" min={0} step="0.01" value={cash || ''} onChange={(e) => setCash(Math.max(0, Number(e.target.value) || 0))} className="w-36" aria-label="מזומן להפקדה" />
          <Button size="sm" variant="ghost" onClick={() => setCash(Math.max(0, desks.cash))}>הכל</Button>
        </div>
      </Field>
      <p className="mb-1 text-sm font-bold">צ׳קים ({here.length} בקופה)</p>
      {!here.length ? <p className="mb-2 text-sm text-muted">אין צ׳קים בקופה.</p> : (
        <ul className="mb-2 grid max-h-64 gap-1 overflow-y-auto text-sm">{here.map((c) => (
          <li key={c.id}><label className="flex items-center gap-2">
            <input type="checkbox" checked={chosen.has(c.id)} onChange={(e) => setChosen((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} />
            <span className="min-w-0 flex-1 truncate">צ׳ק {c.number || '—'}{c.bank ? ` · בנק ${c.bank}` : ''}{c.customer ? ` · ${c.customer}` : ''}{c.dueDate ? ` · פירעון ${ddmmyyyy(c.dueDate)}` : ''}</span>
            <strong className="tabular-nums">{ils(c.amount)}</strong>
          </label></li>
        ))}</ul>
      )}
      <Field label="הערה (לא חובה — סניף הבנק, אסמכתא)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className="min-h-12" /></Field>
      <p className="text-sm">סה״כ להפקדה: <strong className="tabular-nums">{ils(total)}</strong>{picked.length ? ` (${picked.length} צ׳קים)` : ''}</p>
      {errors.length > 0 && <div className="mt-2"><Note tone="warn">{errors.map((e) => <span key={e} className="block">{e}</span>)}</Note></div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={busy || total <= 0} onClick={() => void save()}>{busy ? 'רושם…' : 'רישום ההפקדה'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}
