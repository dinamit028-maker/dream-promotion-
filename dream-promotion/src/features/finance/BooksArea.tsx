'use client';
import { useCallback, useEffect, useMemo, useState, type DependencyList, type ReactNode } from 'react';
import { useApp } from '@/lib/store';
import { Button, Card, Chip, Field, Input, Select } from '@/components/ui/primitives';
import { Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { useLocations } from '@/features/locations/store';
import { LocationField, locationColumn } from '@/features/locations/LocationSwitch';
import { glCustomerKey } from '@/features/documents/customer-key';
import { useFinance } from './FinanceScreen';
import { TableCard } from './ReportBook';
import { LOAD_FAILED, LoadFailed, Note, PeriodPicker, Pill, Stat, ddmmyyyy, ils, periodNow, todayIL, type Period } from './ui';
import {
  KIND_LABEL, KINDS, RECON_BALANCES, RECON_AREA, accountAddProblems, accountText, accountUpdateProblems, ag, balanceSheetTable, bookJournalTable, booksViews,
  canDeactivate, canReverseEntry, chartList, docRefKey, docRefs, emptyLine, emptyManual, emptyOpening, entryBalance, groupTrialBalance, isBooksView, ledgerTable,
  manualProblems, openingBalance, openingProblems, originOf, profitLossTable, reconDiffers, reconcileTable, refText, reverseProblems, showBooksArea, sourceLabel,
  tbBalanced, trialBalanceTable, type AccountDraft, type BalanceSheet, type BooksView, type ChartAccount, type EntryLine, type ManualDraft, type OpeningLine, type Part,
  type Side,
} from './ledger';
import {
  addAccount, createManual, loadBalanceSheet, loadBookJournal, loadChart, loadDocIds, loadLedger, loadProfitLoss, loadReconcile, loadTrialBalance, reverseManual,
  saveOpening, setAccountActive, updateAccount, useBooksArea, type Res,
} from './ledger-data';
import type { BooksState } from './books';

/**
 * "הנהלת חשבונות" (2.123 — stage 4ד; docs/ita-registration/STAGE4_PLAN_HE.md, answers 13–17): the double-entry books of the business,
 * once migration 20261129007200 is in the database. Read (whoever has the whole of the money — the RLS decides what): מאזן בוחן,
 * כרטסת, יומן, רווח והפסד, מאזן, לוח חשבונות and התאמה (the books against the money screens). The owner (journal_writer — the
 * database refuses anyone else) also: the chart's edits, a manual double entry and its reversal, and — once — the opening balances.
 * Nothing is computed here: every number is the database's (report_* / gl_reconcile); the forms check by the database's rules first.
 * Every table downloads as CSV and PDF (statements.ts tableCsv / report-pdf). Mobile first: lists, never a page that scrolls sideways.
 */
export const BOOKS_MIGRATION = 'הנהלת החשבונות תופיע כאן אחרי עדכון המסד (מיגרציה 20261129007200).';

/** a signed amount, its sign before the shekel and kept left to right in the Hebrew line ("−₪50", never "₪50−") */
export function Money({ v, className }: { v: number; className?: string }) {
  return <bdi dir="ltr" className={cx('tabular-nums', className)}>{ag(v) < 0 ? '−' : ''}{ils(Math.abs(v))}</bdi>;
}

function useRes<T>(fn: () => Promise<Res<T>>, deps: DependencyList): { data: T | null; error: string | null; retry: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    fn().then((r) => { if (alive) { if (r.ok) setData(r.data); else setError(r.error); } }, () => alive && setError(LOAD_FAILED));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, retry: () => setN((x) => x + 1) };
}
const Wait = ({ error, retry }: { error: string | null; retry: () => void }) =>
  (error ? <LoadFailed message={error === LOAD_FAILED ? null : error} onRetry={retry} /> : <div className="py-8 text-center"><Spinner /></div>);

export function BooksArea() {
  const { profile, params, clearParams } = useFinance();
  const area = useBooksArea();
  const appAccess = useApp((s) => s.access);
  const [view, setView] = useState<BooksView>(() => { const v = params.get('view'); return isBooksView(v) ? v : 'tb'; });
  const [account, setAccount] = useState<string>(() => params.get('account') ?? '');
  useEffect(() => { if (params.get('view')) clearParams(); }, [params, clearParams]);
  const [period, setPeriod] = useState<Period>(() => periodNow(profile.vatPeriod === 'monthly' ? 'month' : 'bimonth'));
  const [chartN, setChartN] = useState(0);
  const chart = useRes(loadChart, [chartN]);

  if (!area.asked) return <div className="py-8 text-center"><Spinner /></div>;
  if (!area.state) return <Note tone="warn">{BOOKS_MIGRATION}</Note>;
  const st = area.state;
  if (!showBooksArea({ ready: true, state: st, access: appAccess })) {
    return <Note>הספרים עוד ריקים — הם יוצגו כאן מהפקודה הראשונה (תחילת הספרים: {ddmmyyyy(st.startDate)}).</Note>;
  }
  const views = booksViews(st);
  const shown = views.some((v) => v.id === view) ? view : 'tb';
  const subtitle = `${period.kind === 'custom' ? '' : `${period.label} · `}${ddmmyyyy(period.from)} – ${ddmmyyyy(period.to)}`;
  const openLedger = (key: string) => { setAccount(key); setView('ledger'); };
  const accounts = chart.data ?? [];
  const reloadChart = () => setChartN((x) => x + 1);
  const withPeriod = ['tb', 'ledger', 'journal', 'pnl', 'reconcile'].includes(shown);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <p className="text-sm text-ink-2">
        הספרים של העסק בחובה וזכות, מ-{ddmmyyyy(st.startDate)}: כל מסמך, תשלום, הוצאה והפקדה נרשמים כאן לבד. פקודה שנרשמה לא נמחקת ולא משתנה — תיקון בפקודה הפוכה.
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="הנהלת חשבונות — מה להציג">
        {views.map((v) => <Chip key={v.id} on={shown === v.id} onClick={() => setView(v.id)}>{v.label}</Chip>)}
      </div>
      {withPeriod && <PeriodPicker value={period} onChange={setPeriod} vatKind={profile.vatPeriod === 'monthly' ? 'month' : 'bimonth'} />}
      {shown === 'tb' && <TrialBalanceView period={period} subtitle={subtitle} onOpen={openLedger} />}
      {shown === 'ledger' && <LedgerView period={period} subtitle={subtitle} chart={accounts} account={account} onAccount={setAccount} />}
      {shown === 'journal' && <JournalView period={period} subtitle={subtitle} owner={st.owner} onOpen={openLedger} />}
      {shown === 'pnl' && <ProfitLossView period={period} subtitle={subtitle} onOpen={openLedger} />}
      {shown === 'balance' && <BalanceView onOpen={openLedger} />}
      {shown === 'chart' && (chart.data ? <ChartView chart={accounts} owner={st.owner} reload={reloadChart} onOpen={openLedger} />
        : <Wait error={chart.error} retry={chart.retry} />)}
      {shown === 'manual' && st.owner && (chart.data ? <ManualView state={st} chart={accounts} onDone={() => { area.reload(); setView('journal'); }} />
        : <Wait error={chart.error} retry={chart.retry} />)}
      {shown === 'opening' && st.owner && !st.openingEntered && (chart.data ? <OpeningView state={st} chart={accounts} onDone={() => { area.reload(); reloadChart(); setView('tb'); }} />
        : <Wait error={chart.error} retry={chart.retry} />)}
      {shown === 'reconcile' && <ReconcileView period={period} subtitle={subtitle} start={st.startDate} />}
      <p className="text-xs text-muted">ספרים לעבודה עם רואה החשבון — לא דוח שהוגש לרשות המסים.</p>
    </div>
  );
}

// ---- מאזן בוחן ----------------------------------------------------------------------------------------------------------------
function TrialBalanceView({ period, subtitle, onOpen }: { period: Period; subtitle: string; onOpen: (key: string) => void }) {
  const r = useRes(() => loadTrialBalance(period.from, period.to), [period.from, period.to]);
  if (!r.data) return <Wait error={r.error} retry={r.retry} />;
  const tb = r.data;
  const groups = groupTrialBalance(tb);
  const ok = tbBalanced(tb);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="חובה בתקופה" value={<Money v={tb.total.debit} />} />
        <Stat label="זכות בתקופה" value={<Money v={tb.total.credit} />} />
        <Stat label="חשבונות עם תנועה" value={String(tb.accounts.length)} />
        <Stat label="איזון" value={ok ? 'מאוזן' : 'לא מאוזן'} tone={ok ? 'ok' : 'bad'} />
      </div>
      {!groups.length ? <Card className="p-4"><p className="text-sm text-muted">אין תנועות עד סוף התקופה.</p></Card> : (
        <Card className="min-w-0 p-3 sm:p-4">
          <ul className="grid gap-2" aria-label="מאזן בוחן לפי קוד">
            {groups.map(({ group, accounts }) => (
              <li key={group.tbCode} data-tb={group.tbCode}>
                <details className="rounded-xl border border-line/60" open={accounts.length <= 3}>
                  <summary className="grid min-h-11 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 p-2">
                    <span className="min-w-0 font-semibold"><span className="text-xs text-muted">{group.tbCode}</span> {group.tbName} <span className="text-xs text-muted">({group.accounts})</span></span>
                    <Money v={group.closing} className="font-black" />
                    <span className="col-span-2 text-xs text-muted">חובה <Money v={group.debit} /> · זכות <Money v={group.credit} /> · פתיחה <Money v={group.opening} /></span>
                  </summary>
                  <ul className="grid gap-1 border-t border-line/60 p-2">
                    {accounts.map((a) => (
                      <li key={a.key}>
                        <button type="button" onClick={() => onOpen(a.key)} disabled={a.key === '?'}
                          className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-2 text-start text-sm hover:bg-surface-2">
                          <span className="min-w-0 break-words">{accountText(a)}</span>
                          <Money v={a.closing} className="font-semibold" />
                          <span className="col-span-2 text-xs text-muted">חובה <Money v={a.debit} /> · זכות <Money v={a.credit} /></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
          <p className="mt-2 flex flex-wrap justify-between gap-2 border-t border-line pt-2 text-sm font-black"><span>סה״כ</span>
            <span>חובה <Money v={tb.total.debit} /> · זכות <Money v={tb.total.credit} /></span></p>
          <p className="mt-1 text-xs text-muted">יתרה חיובית = חובה, שלילית = זכות. לחיצה על חשבון — הכרטסת שלו.</p>
        </Card>
      )}
      <TableCard table={trialBalanceTable(tb)} period={period} subtitle={subtitle} exportOnly />
    </div>
  );
}

// ---- an account picker (the chart, else what the trial balance knows) -------------------------------------------------------------
function AccountSearch({ accounts, value, onPick, label, id }: { accounts: { key: string; name: string }[]; value: string; onPick: (key: string) => void; label: string; id: string }) {
  return (
    <>
      <Input list={`${id}-list`} value={value} onChange={(e) => onPick(e.target.value)} aria-label={label} placeholder="מפתח או שם החשבון" dir="auto" />
      <datalist id={`${id}-list`}>{accounts.slice(0, 2000).map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}</datalist>
    </>
  );
}

// ---- כרטסת --------------------------------------------------------------------------------------------------------------------
function LedgerView({ period, subtitle, chart, account, onAccount }: { period: Period; subtitle: string; chart: ChartAccount[]; account: string; onAccount: (k: string) => void }) {
  const { go } = useFinance();
  const [typed, setTyped] = useState(account);
  useEffect(() => { setTyped(account); }, [account]);
  // a member who may not read the chart (limited to locations): the accounts of the trial balance
  const tb = useRes(() => (chart.length ? Promise.resolve({ ok: true as const, data: null }) : loadTrialBalance(period.from, period.to)), [chart.length, period.from, period.to]);
  const choices = chart.length ? chart : (tb.data?.accounts ?? []);
  const r = useRes(() => (account ? loadLedger(account, period.from, period.to) : Promise.resolve({ ok: false as const, error: '' })), [account, period.from, period.to]);
  const [ids, setIds] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    setIds({});
    if (r.data) void loadDocIds(docRefs(r.data.lines)).then((m) => { if (alive) setIds(m); });
    return () => { alive = false; };
  }, [r.data]);
  const known = (k: string) => choices.some((a) => a.key === k);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <Card className="p-3 sm:p-4">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) onAccount(typed.trim()); }}>
          <div className="min-w-0 flex-1"><Field label="חשבון"><AccountSearch id="ledger-account" accounts={choices} value={typed} label="חשבון לכרטסת"
            onPick={(k) => { setTyped(k); if (known(k.trim())) onAccount(k.trim()); }} /></Field></div>
          <div className="mb-4"><Button type="submit" variant="ghost" disabled={!typed.trim()}>הצגה</Button></div>
        </form>
        {!account && <p className="text-sm text-muted">בוחרים חשבון — או לוחצים על חשבון במאזן הבוחן. בחשבון "לקוחות" (1300) ו"ספקים" (2100) — כל הלקוחות / הספקים יחד.</p>}
      </Card>
      {account && (!r.data ? <Wait error={r.error} retry={r.retry} /> : <>
        <p className="font-bold">{accountText(r.data.account)} <span className="text-xs font-normal text-muted">{KIND_LABEL[r.data.account.kind as keyof typeof KIND_LABEL] ?? ''}{r.data.account.active ? '' : ' · לא פעיל'}</span></p>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Stat label="יתרת פתיחה" value={<Money v={r.data.opening} />} />
          <Stat label="חובה" value={<Money v={r.data.debit} />} />
          <Stat label="זכות" value={<Money v={r.data.credit} />} />
          <Stat label="יתרת סגירה" value={<Money v={r.data.closing} />} />
        </div>
        {!r.data.lines.length ? <Card className="p-4"><p className="text-sm text-muted">אין תנועות בחשבון בתקופה הזו.</p></Card> : (
          <Card className="min-w-0 p-3 sm:p-4">
            <ul className="grid gap-1" aria-label="תנועות הכרטסת">
              {r.data.lines.map((l) => {
                const k = docRefKey(l.ref1Type, l.ref1Number);
                const id = k ? ids[k] : undefined;
                return (
                  <li key={`${l.transactionId}:${l.lineNo}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-line/60 py-2 text-sm" data-entry={l.number}>
                    <span className="min-w-0 break-words"><span className="text-xs text-muted">{ddmmyyyy(l.date)} · פקודה {l.number}</span><br />{l.details}</span>
                    <span className="text-end"><span className="block">{l.side === 'D' ? 'חובה ' : 'זכות '}<Money v={l.side === 'D' ? l.debit : l.credit} className="font-semibold" /></span>
                      <span className="block text-xs text-muted">יתרה <Money v={l.balance} /></span></span>
                    <span className="col-span-2 flex flex-wrap gap-x-3 text-xs text-muted">
                      {l.account !== r.data!.account.key && <span>{accountText({ key: l.account, name: l.accountName })}</span>}
                      {l.ref1Number && (id
                        ? <button type="button" className="min-h-9 font-semibold text-primary underline" onClick={() => go('documents', { open: id })}>{refText(l.ref1Type, l.ref1Number)}</button>
                        : <span>{refText(l.ref1Type, l.ref1Number)}</span>)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
        <TableCard table={ledgerTable(r.data)} period={period} subtitle={subtitle} exportOnly />
      </>)}
    </div>
  );
}

// ---- יומן ---------------------------------------------------------------------------------------------------------------------
function JournalView({ period, subtitle, owner, onOpen }: { period: Period; subtitle: string; owner: boolean; onOpen: (key: string) => void }) {
  const { go, say } = useFinance();
  const r = useRes(() => loadBookJournal(period.from, period.to), [period.from, period.to]);
  const [ids, setIds] = useState<Record<string, string>>({});
  const [undo, setUndo] = useState<{ id: string; number: number; date: string } | null>(null);
  useEffect(() => {
    let alive = true;
    setIds({});
    if (r.data) void loadDocIds(docRefs(r.data.entries)).then((m) => { if (alive) setIds(m); });
    return () => { alive = false; };
  }, [r.data]);
  if (!r.data) return <Wait error={r.error} retry={r.retry} />;
  const j = r.data;
  const numberOf = new Map(j.entries.map((e) => [e.id, e.number]));
  const docLink = (type: number | null, n: string | null) => {
    if (!n) return null;
    const k = docRefKey(type, n);
    const id = k ? ids[k] : undefined;
    return id ? <button type="button" className="min-h-9 font-semibold text-primary underline" onClick={() => go('documents', { open: id })}>{refText(type, n)}</button>
      : <span>{refText(type, n)}</span>;
  };
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="פקודות" value={String(j.count)} />
        <Stat label="חובה" value={<Money v={j.debit} />} />
        <Stat label="זכות" value={<Money v={j.credit} />} />
      </div>
      {!j.entries.length ? <Card className="p-4"><p className="text-sm text-muted">אין פקודות בתקופה הזו.</p></Card> : (
        <ul className="grid gap-2" aria-label="פקודות היומן">
          {j.entries.map((e) => (
            <li key={e.id} data-entry={e.number}>
              <Card className="min-w-0 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="tabular-nums">פקודה {e.number}</strong>
                  <span className="text-sm text-muted">{ddmmyyyy(e.date)}</span>
                  <Pill tone={e.sourceKind === 'manual' ? 'info' : 'default'}>{sourceLabel(e.sourceKind)}</Pill>
                  {e.reverses && <Pill tone="info">הופכת את פקודה {numberOf.get(e.reverses) ?? ''}</Pill>}
                  {e.reversedBy && <Pill tone="bad">בוטלה{numberOf.get(e.reversedBy) ? ` בפקודה ${numberOf.get(e.reversedBy)}` : ''}</Pill>}
                </div>
                <p className="mt-1 break-words text-sm">{e.details}</p>
                {(e.ref1Number || e.ref2Number) && <p className="flex flex-wrap gap-x-3 text-xs text-muted">{docLink(e.ref1Type, e.ref1Number)}{docLink(e.ref2Type, e.ref2Number)}</p>}
                <table className="mt-2 w-full text-sm" aria-label={`שורות פקודה ${e.number}`}>
                  <thead><tr className="border-b border-line text-xs text-muted"><th className="py-1 text-start font-semibold">חשבון</th>
                    <th className="w-24 py-1 text-end font-semibold">חובה</th><th className="w-24 py-1 text-end font-semibold">זכות</th></tr></thead>
                  <tbody>{e.lines.map((x) => (
                    <tr key={x.lineNo} className="border-b border-line/40">
                      <td className="py-1 break-words"><button type="button" className="text-start hover:underline" onClick={() => onOpen(x.account)} disabled={x.account === '?'}>{accountText({ key: x.account, name: x.accountName })}</button></td>
                      <td className="py-1 text-end whitespace-nowrap">{x.side === 'D' ? <Money v={x.amount} /> : ''}</td>
                      <td className="py-1 text-end whitespace-nowrap">{x.side === 'C' ? <Money v={x.amount} /> : ''}</td>
                    </tr>))}</tbody>
                </table>
                {owner && canReverseEntry(e) && (
                  <div className="mt-2"><Button size="sm" variant="ghost" onClick={() => setUndo({ id: e.id, number: e.number, date: e.date })}>פקודה הפוכה</Button></div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      <TableCard table={bookJournalTable(j)} period={period} subtitle={subtitle} exportOnly />
      {undo && <ReverseDialog entry={undo} onClose={() => setUndo(null)} onDone={(n) => { const was = undo.number; setUndo(null); say(`פקודה ${n} הופכת את פקודה ${was}`); r.retry(); }} />}
    </div>
  );
}

function ReverseDialog({ entry, onClose, onDone }: { entry: { id: string; number: number; date: string }; onClose: () => void; onDone: (n: number) => void }) {
  const { access } = useFinance();
  const today = todayIL();
  const [id] = useState(() => crypto.randomUUID());
  const [date, setDate] = useState(today < entry.date ? entry.date : today);
  const [details, setDetails] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  async function save() {
    const e = reverseProblems({ date, entryDate: entry.date, today, lockedUntil: access.lockedUntil, details });
    if (e.length) { setErrors(e); return; }
    setBusy(true); setErrors([]);
    const r = await reverseManual(id, entry.id, date, details);
    setBusy(false);
    if (!r.ok) { setErrors([r.error]); return; }
    onDone(r.data.number);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">פקודה הפוכה לפקודה {entry.number}</h3>
      <p className="mb-3 text-sm text-muted">אותן שורות, חובה במקום זכות — פעם אחת. פקודה {entry.number} נשארת, מסומנת "בוטלה".</p>
      <Field label="תאריך"><Input type="date" value={date} min={entry.date} max={today} onChange={(e) => setDate(e.target.value || today)} /></Field>
      <Field label="פרטים (לא חובה)"><Input value={details} onChange={(e) => setDetails(e.target.value)} maxLength={50} placeholder={`ביטול פקודה ${entry.number}`} /></Field>
      {errors.length > 0 && <Note tone="warn">{errors.map((x) => <span key={x} className="block">{x}</span>)}</Note>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'רושם…' : 'רישום הפקודה ההפוכה'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}

// ---- רווח והפסד, מאזן ---------------------------------------------------------------------------------------------------------
function PartList({ title, part, total, onOpen }: { title: string; part: Part; total: string; onOpen: (key: string) => void }) {
  return (
    <Card className="min-w-0 p-3 sm:p-4">
      <p className="mb-1 font-bold">{title}</p>
      {!part.accounts.length ? <p className="text-sm text-muted">אין.</p> : (
        <ul className="grid gap-0.5 text-sm">
          {part.accounts.map((a) => (
            <li key={a.key}><button type="button" onClick={() => onOpen(a.key)} disabled={a.key === '?'}
              className="grid min-h-10 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-1 text-start hover:bg-surface-2">
              <span className="min-w-0 break-words">{accountText(a)}</span><Money v={a.amount} /></button></li>
          ))}
        </ul>
      )}
      <p className="mt-1 flex justify-between gap-2 border-t border-line pt-1 font-black"><span>{total}</span><Money v={part.total} /></p>
    </Card>
  );
}
function ProfitLossView({ period, subtitle, onOpen }: { period: Period; subtitle: string; onOpen: (key: string) => void }) {
  const r = useRes(() => loadProfitLoss(period.from, period.to), [period.from, period.to]);
  if (!r.data) return <Wait error={r.error} retry={r.retry} />;
  const p = r.data;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="הכנסות" value={<Money v={p.income.total} />} />
        <Stat label="הוצאות" value={<Money v={p.expenses.total} />} />
        <Stat label={ag(p.profit) < 0 ? 'הפסד' : 'רווח'} value={<Money v={p.profit} />} tone={ag(p.profit) < 0 ? 'bad' : 'ok'} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <PartList title="הכנסות" part={p.income} total="סה״כ הכנסות" onOpen={onOpen} />
        <PartList title="הוצאות" part={p.expenses} total="סה״כ הוצאות" onOpen={onOpen} />
      </div>
      <TableCard table={profitLossTable(p)} period={period} subtitle={subtitle} exportOnly />
    </div>
  );
}
function BalanceView({ onOpen }: { onOpen: (key: string) => void }) {
  const [asOf, setAsOf] = useState(todayIL());
  const r = useRes(() => loadBalanceSheet(asOf), [asOf]);
  const b: BalanceSheet | null = r.data;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <label className="flex items-center gap-2 text-sm">נכון ליום
        <input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} className="h-11 rounded-full border border-line bg-surface px-3 text-sm" aria-label="מאזן נכון ליום" /></label>
      {!b ? <Wait error={r.error} retry={r.retry} /> : <>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Stat label="נכסים" value={<Money v={b.assets.total} />} />
          <Stat label="התחייבויות והון" value={<Money v={b.liabilitiesAndEquity} />} />
          <Stat label="רווח (הפסד) שטרם נסגר" value={<Money v={b.earnings} />} />
          <Stat label="איזון" value={b.balanced ? 'מאוזן' : 'לא מאוזן'} tone={b.balanced ? 'ok' : 'bad'} />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <PartList title="נכסים" part={b.assets} total="סה״כ נכסים" onOpen={onOpen} />
          <div className="grid gap-3">
            <PartList title="התחייבויות" part={b.liabilities} total="סה״כ התחייבויות" onOpen={onOpen} />
            <PartList title="הון" part={b.equity} total="סה״כ הון" onOpen={onOpen} />
            <Card className="p-3 sm:p-4"><p className="flex justify-between gap-2 text-sm"><span>רווח (הפסד) שטרם נסגר</span><Money v={b.earnings} /></p>
              <p className="mt-1 flex justify-between gap-2 border-t border-line pt-1 font-black"><span>סה״כ התחייבויות והון</span><Money v={b.liabilitiesAndEquity} /></p></Card>
          </div>
        </div>
        <TableCard table={balanceSheetTable(b)} period={{ from: asOf, to: asOf, label: '', kind: 'custom' }} subtitle={`נכון ליום ${ddmmyyyy(asOf)}`} exportOnly />
      </>}
    </div>
  );
}

// ---- לוח חשבונות --------------------------------------------------------------------------------------------------------------
const ORIGIN_LABEL = { system: 'של המערכת', customer: 'לקוח', supplier: 'ספק', owner: 'נוסף ע״י הבעלים' } as const;
function ChartView({ chart, owner, reload, onOpen }: { chart: ChartAccount[]; owner: boolean; reload: () => void; onOpen: (key: string) => void }) {
  const { say } = useFinance();
  const [q, setQ] = useState('');
  const [parties, setParties] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ChartAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useMemo(() => chartList(chart, q, { parties }), [chart, q, parties]);
  async function toggle(a: ChartAccount) {
    if (a.active && !window.confirm(`להסיר את ${accountText(a)} מהשימוש? הוא לא נמחק — רק לא יהיה אפשר לרשום אליו. אפשר להחזיר אותו.`)) return;
    setBusy(a.key); setError(null);
    const r = await setAccountActive(a.key, !a.active);
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    say(a.active ? `${a.key} הוסר מהשימוש` : `${a.key} פעיל שוב`); reload();
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי מפתח או שם" aria-label="חיפוש חשבון" className="max-w-sm" />
        <Chip on={parties} onClick={() => setParties((x) => !x)}>כולל לקוחות וספקים</Chip>
        {owner && <Button variant="primary" onClick={() => setAdding(true)}>+ חשבון חדש</Button>}
      </div>
      {error && <Note tone="warn">{error}</Note>}
      <Card className="min-w-0 p-3 sm:p-4">
        {!list.length ? <p className="text-sm text-muted">{chart.length ? 'אין חשבון כזה.' : 'לוח החשבונות עוד לא נוצר — הוא נוצר עם הפקודה הראשונה.'}</p> : (
          <ul className="grid gap-1" aria-label="לוח החשבונות">
            {list.map((a) => (
              <li key={a.key} data-account={a.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line/60 py-2 text-sm">
                <button type="button" className="min-w-0 break-words text-start font-semibold hover:underline" onClick={() => onOpen(a.key)}>{accountText(a)}</button>
                <span className="flex flex-wrap justify-end gap-1">{!a.active && <Pill tone="warn">לא פעיל</Pill>}<Pill>{KIND_LABEL[a.kind]}</Pill></span>
                <span className="col-span-2 text-xs text-muted">מאזן בוחן: {a.tbCode} · {a.tbName}{a.parentKey ? ` · תחת ${a.parentKey}` : ''} · {ORIGIN_LABEL[originOf(a)]}</span>
                {owner && (
                  <span className="col-span-2 mt-1 flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(a)} aria-label={`עריכת ${a.key}`}>עריכה</Button>
                    {(canDeactivate(a) || !a.active) && <Button size="sm" variant="ghost" disabled={busy === a.key} onClick={() => void toggle(a)}
                      aria-label={a.active ? `הסרה מהשימוש ${a.key}` : `החזרה לשימוש ${a.key}`}>{a.active ? 'הסרה מהשימוש' : 'החזרה לשימוש'}</Button>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {!parties && !q && <p className="mt-2 text-xs text-muted">חשבונות הלקוחות והספקים (תחת 1300 / 2100) — בחיפוש, או ב"כולל לקוחות וספקים".</p>}
      </Card>
      {adding && <AccountDialog chart={chart} onClose={() => setAdding(false)} onDone={(k) => { setAdding(false); say(`החשבון ${k} נוסף`); reload(); }} />}
      {editing && <AccountDialog chart={chart} account={editing} onClose={() => setEditing(null)} onDone={(k) => { setEditing(null); say(`החשבון ${k} נשמר`); reload(); }} />}
    </div>
  );
}
function AccountDialog({ chart, account, onClose, onDone }: { chart: ChartAccount[]; account?: ChartAccount; onClose: () => void; onDone: (key: string) => void }) {
  const [d, setD] = useState<AccountDraft>(() => account
    ? { key: account.key, name: account.name, kind: account.kind, tbCode: account.tbCode, tbName: account.tbName, parentKey: account.parentKey ?? '' }
    : { key: '', name: '', kind: '', tbCode: '', tbName: '', parentKey: '' });
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<AccountDraft>) => setD((x) => ({ ...x, ...p }));
  async function save() {
    const e = account ? accountUpdateProblems(account, { name: d.name, tbCode: d.tbCode, tbName: d.tbName, newKey: d.key }, chart) : accountAddProblems(d, chart);
    if (e.length) { setErrors(e); return; }
    setBusy(true); setErrors([]);
    const r = account ? await updateAccount(account.key, { name: d.name, tbCode: d.tbCode, tbName: d.tbName, newKey: d.key }) : await addAccount(d);
    setBusy(false);
    if (!r.ok) { setErrors([r.error]); return; }
    onDone(r.data.key);
  }
  const keyFixed = Boolean(account?.role);
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">{account ? `עריכת חשבון ${account.key}` : 'חשבון חדש'}</h3>
      <p className="mb-3 text-sm text-muted">{account ? 'שם, וקוד ושם במאזן הבוחן. מפתח — רק של חשבון שהוספתם, לפני התנועה הראשונה.' : 'מפתח של 4 ספרות (אפשר "-" ועוד ספרה או שתיים). חשבון לא נמחק — אפשר להסיר אותו מהשימוש.'}</p>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="מפתח"><Input value={d.key} onChange={(e) => set({ key: e.target.value })} dir="ltr" inputMode="numeric" maxLength={7} disabled={keyFixed} /></Field>
        <Field label="שם החשבון"><Input value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={50} /></Field>
        {!account && (
          <Field label="סוג">
            <Select value={d.kind} onChange={(e) => set({ kind: e.target.value as AccountDraft['kind'] })}>
              <option value="" disabled>בוחרים…</option>
              {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </Select>
          </Field>
        )}
        {!account && <Field label="חשבון אב (לא חובה)"><Input value={d.parentKey} onChange={(e) => set({ parentKey: e.target.value })} dir="ltr" maxLength={15} placeholder="מפתח" /></Field>}
        <Field label="קוד במאזן הבוחן"><Input value={d.tbCode} onChange={(e) => set({ tbCode: e.target.value })} dir="ltr" maxLength={15} placeholder={account ? '' : 'ברירת מחדל: המפתח'} /></Field>
        <Field label="שם במאזן הבוחן"><Input value={d.tbName} onChange={(e) => set({ tbName: e.target.value })} maxLength={30} placeholder={account ? '' : 'ברירת מחדל: שם החשבון'} /></Field>
      </div>
      {errors.length > 0 && <Note tone="warn">{errors.map((x) => <span key={x} className="block">{x}</span>)}</Note>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'שומר…' : account ? 'שמירה' : 'הוספת החשבון'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}

// ---- the lines of a form (D / C, amount, account) ------------------------------------------------------------------------------
function SideChoice({ value, onChange, label }: { value: Side; onChange: (s: Side) => void; label: string }) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label={label}>
      {(['D', 'C'] as const).map((s) => <Chip key={s} role="radio" aria-checked={value === s} on={value === s} onClick={() => onChange(s)} className="min-h-11 px-3">{s === 'D' ? 'חובה' : 'זכות'}</Chip>)}
    </div>
  );
}
function BalanceBar({ debit, credit, note }: { debit: number; credit: number; note?: ReactNode }) {
  const diff = debit - credit;
  return (
    <p aria-live="polite" className={cx('flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl p-3 text-sm', diff === 0 && debit > 0 ? 'bg-emerald-500/15' : 'bg-surface-2')}>
      <span>חובה <Money v={debit / 100} className="font-black" /></span>
      <span>זכות <Money v={credit / 100} className="font-black" /></span>
      <span>{diff === 0 && debit > 0 ? 'מאוזן' : <>הפרש <Money v={diff / 100} className="font-black" /></>}</span>
      {note}
    </p>
  );
}

// ---- פקודה ידנית --------------------------------------------------------------------------------------------------------------
function ManualView({ state, chart, onDone }: { state: BooksState; chart: ChartAccount[]; onDone: () => void }) {
  const { access, say } = useFinance();
  const locState = useLocations((x) => x.state);
  const today = todayIL();
  const [id, setId] = useState(() => crypto.randomUUID());
  const [d, setD] = useState<ManualDraft>(() => emptyManual(today));
  const [location, setLocation] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const active = useMemo(() => chart.filter((a) => a.active), [chart]);
  const setLine = (i: number, p: Partial<EntryLine>) => setD((x) => ({ ...x, lines: x.lines.map((l, k) => (k === i ? { ...l, ...p } : l)) }));
  const b = entryBalance(d.lines);
  const nameOf = (k: string) => chart.find((a) => a.key === k.trim())?.name;
  async function save() {
    const e = manualProblems(d, { today, start: state.startDate, lockedUntil: access.lockedUntil, chart });
    if (e.length) { setErrors(e); return; }
    if (!window.confirm('לרשום את הפקודה? פקודה שנרשמה לא נמחקת ולא משתנה — תיקון רק בפקודה הפוכה.')) return;
    setBusy(true); setErrors([]);
    const r = await createManual(id, d, locationColumn(locState, location).location_id ?? null);
    setBusy(false);
    if (!r.ok) { setErrors([r.error]); return; }
    say(`פקודה ${r.data.number} נרשמה`);
    setId(crypto.randomUUID()); setD(emptyManual(today));
    onDone();
  }
  return (
    <Card className="min-w-0 p-3 sm:p-4">
      <p className="mb-1 font-bold">פקודה ידנית (חובה וזכות)</p>
      <p className="mb-3 text-sm text-muted">כל פקודה מאוזנת: סך החובה שווה לסך הזכות. מתאריך תחילת הספרים ({ddmmyyyy(state.startDate)}) ועד היום. אחרי הרישום — אין עריכה ואין מחיקה.</p>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="תאריך"><Input type="date" value={d.date} min={state.startDate} max={today} onChange={(e) => setD((x) => ({ ...x, date: e.target.value || today }))} /></Field>
        <Field label="פרטים (2–50 תווים)"><Input value={d.details} onChange={(e) => setD((x) => ({ ...x, details: e.target.value }))} maxLength={50} placeholder="למשל: הפרשה לחופשה לפי רו״ח" /></Field>
        <LocationField value={location} onChange={setLocation} />
      </div>
      <ol className="grid gap-2" aria-label="שורות הפקודה">
        {d.lines.map((l, i) => (
          <li key={i} className="grid gap-2 rounded-xl border border-line/60 p-2" data-line={i + 1}>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
              <div className="min-w-0"><AccountSearch id={`manual-${i}`} accounts={active} value={l.account} label={`חשבון שורה ${i + 1}`} onPick={(k) => setLine(i, { account: k })} />
                {nameOf(l.account) && <span className="text-xs text-muted">{nameOf(l.account)}</span>}</div>
              {d.lines.length > 2 && <Button size="sm" variant="ghost" onClick={() => setD((x) => ({ ...x, lines: x.lines.filter((_, k) => k !== i) }))} aria-label={`הסרת שורה ${i + 1}`}>✕</Button>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <SideChoice value={l.side} onChange={(s) => setLine(i, { side: s })} label={`חובה או זכות — שורה ${i + 1}`} />
              <Input value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} inputMode="decimal" dir="ltr" aria-label={`סכום שורה ${i + 1}`} placeholder="0.00" className="w-36" />
            </div>
          </li>
        ))}
      </ol>
      <div className="my-2"><Button size="sm" variant="ghost" onClick={() => setD((x) => ({ ...x, lines: [...x.lines, emptyLine(b.diff > 0 ? 'C' : 'D')] }))}>+ שורה</Button></div>
      <BalanceBar debit={b.debit} credit={b.credit} />
      {errors.length > 0 && <div className="mt-2"><Note tone="warn">{errors.map((x) => <span key={x} className="block">{x}</span>)}</Note></div>}
      <div className="mt-3"><Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'רושם…' : 'רישום הפקודה'}</Button></div>
    </Card>
  );
}

// ---- יתרות פתיחה --------------------------------------------------------------------------------------------------------------
function OpeningView({ state, chart, onDone }: { state: BooksState; chart: ChartAccount[]; onDone: () => void }) {
  const { say } = useFinance();
  const leads = useApp((s) => s.leads);
  const [lines, setLines] = useState<OpeningLine[]>(() => [emptyOpening('D'), emptyOpening('C')]);
  const [q, setQ] = useState<{ i: number; text: string } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const active = useMemo(() => chart.filter((a) => a.active && a.key !== '3100'), [chart]);
  const setLine = (i: number, p: Partial<OpeningLine>) => setLines((x) => x.map((l, k) => (k === i ? { ...l, ...p } : l)));
  const b = openingBalance(lines);
  const hits = useMemo(() => {
    const s = q?.text.trim().toLowerCase() ?? '';
    if (s.length < 2) return [];
    return leads.filter((l) => l.name.toLowerCase().includes(s) || (l.phone ?? '').replace(/\D/g, '').includes(s.replace(/\D/g, '') || '§')).slice(0, 6);
  }, [q, leads]);
  const pickLead = useCallback((i: number, l: { name: string; phone?: string | null }) => {
    // the customer's account as its documents post to it (gl_customer_key: the phone, else the name — customer-key.ts)
    setLine(i, { account: glCustomerKey(l.phone ?? '', l.name), name: l.name.slice(0, 50), customer: true }); setQ(null);
  }, []);
  async function save() {
    const e = openingProblems(lines, chart);
    if (e.length) { setErrors(e); return; }
    if (!window.confirm(`לרשום את יתרות הפתיחה ב-${ddmmyyyy(state.startDate)}? זה נעשה פעם אחת בלבד — תיקון אחר כך רק בפקודה.`)) return;
    setBusy(true); setErrors([]);
    const r = await saveOpening(lines, chart);
    setBusy(false);
    if (!r.ok) { setErrors([r.error]); return; }
    say(`יתרות הפתיחה נרשמו (פקודה ${r.data.number})`);
    onDone();
  }
  return (
    <Card className="min-w-0 p-3 sm:p-4">
      <p className="mb-1 font-bold">יתרות פתיחה — {ddmmyyyy(state.startDate)}</p>
      <p className="mb-3 text-sm text-muted">היתרות לפי רואה החשבון, ביום תחילת הספרים. פעם אחת בלבד. מה שלא מתאזן נרשם לבד בחשבון 3100 (יתרות פתיחה).</p>
      <ol className="grid gap-2" aria-label="שורות יתרות הפתיחה">
        {lines.map((l, i) => (
          <li key={i} className="grid gap-2 rounded-xl border border-line/60 p-2" data-line={i + 1}>
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={`חשבון או לקוח — שורה ${i + 1}`}>
              <Chip role="radio" aria-checked={!l.customer} on={!l.customer} className="min-h-11 px-3" onClick={() => setLine(i, { customer: false, account: '', name: '' })}>חשבון</Chip>
              <Chip role="radio" aria-checked={l.customer} on={l.customer} className="min-h-11 px-3" onClick={() => setLine(i, { customer: true, account: '', name: '' })}>לקוח</Chip>
              {lines.length > 1 && <Button size="sm" variant="ghost" className="ms-auto" onClick={() => setLines((x) => x.filter((_, k) => k !== i))} aria-label={`הסרת שורה ${i + 1}`}>✕</Button>}
            </div>
            {!l.customer ? (
              <div className="min-w-0"><AccountSearch id={`opening-${i}`} accounts={active} value={l.account} label={`חשבון שורה ${i + 1}`} onPick={(k) => setLine(i, { account: k })} />
                {chart.find((a) => a.key === l.account.trim()) && <span className="text-xs text-muted">{chart.find((a) => a.key === l.account.trim())!.name}</span>}</div>
            ) : l.account ? (
              <p className="text-sm">{l.name} <span className="text-xs text-muted">(חשבון {l.account})</span> <button type="button" className="min-h-9 text-xs text-primary" onClick={() => setLine(i, { account: '', name: '' })}>החלפה</button></p>
            ) : (
              <div className="relative">
                <Input value={q?.i === i ? q.text : ''} onChange={(e) => setQ({ i, text: e.target.value })} placeholder="חיפוש לקוח (שם או טלפון)" aria-label={`לקוח שורה ${i + 1}`} />
                {q?.i === i && hits.length > 0 && (
                  <div className="absolute inset-x-0 top-full z-10 mt-1 grid rounded-2xl border border-line bg-surface p-1 shadow-lg">
                    {hits.map((h) => <button key={h.id} type="button" onClick={() => pickLead(i, h)} className="min-h-11 rounded-xl px-3 text-start text-sm hover:bg-surface-2">{h.name}{h.phone ? ` · ${h.phone}` : ''}</button>)}
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <SideChoice value={l.side} onChange={(s) => setLine(i, { side: s })} label={`חובה או זכות — שורה ${i + 1}`} />
              <Input value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} inputMode="decimal" dir="ltr" aria-label={`סכום שורה ${i + 1}`} placeholder="0.00" className="w-36" />
            </div>
          </li>
        ))}
      </ol>
      <div className="my-2"><Button size="sm" variant="ghost" onClick={() => setLines((x) => [...x, emptyOpening('D')])}>+ שורה</Button></div>
      <BalanceBar debit={b.debit} credit={b.credit} note={b.toOpening !== 0 ? <span>יירשם ב-3100: <Money v={-b.toOpening / 100} /></span> : undefined} />
      <p className="mt-2 text-xs text-muted">לקוח — לפי הכרטיס שלו (הטלפון, ואם אין — השם), כדי שהמסמכים שלו יירשמו לאותו חשבון. ספק — רק ספק שכבר יש לו חשבון בלוח (מפתח שמתחיל ב-S-); ספק חדש עוד לא אפשרי כאן.</p>
      {errors.length > 0 && <div className="mt-2"><Note tone="warn">{errors.map((x) => <span key={x} className="block">{x}</span>)}</Note></div>}
      <div className="mt-3"><Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'רושם…' : 'רישום יתרות הפתיחה'}</Button></div>
    </Card>
  );
}

// ---- התאמה --------------------------------------------------------------------------------------------------------------------
function ReconcileView({ period, subtitle, start }: { period: Period; subtitle: string; start: string }) {
  const r = useRes(() => loadReconcile(period.from, period.to), [period.from, period.to]);
  if (!r.data) return <Wait error={r.error} retry={r.retry} />;
  const x = r.data;
  const today = todayIL();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <Note tone={x.same ? 'ok' : 'warn'}>{x.same ? 'הספרים תואמים לדוחות של הכספים.' : 'יש הפרשים בין הספרים לדוחות — מסומנים למטה. לבירור עם רואה החשבון.'}</Note>
      {period.from < start && <p className="text-xs text-muted">ההשוואה מתחילת הספרים ({ddmmyyyy(start)}).</p>}
      <Card className="min-w-0 p-3 sm:p-4">
        <ul className="grid gap-1" aria-label="התאמת הספרים">
          {x.rows.map((row) => {
            const bad = reconDiffers(row);
            return (
              <li key={row.area} data-area={row.area} className={cx('grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 rounded-xl p-2 text-sm', bad && 'bg-warn/10')}>
                <span className="font-semibold">{RECON_AREA[row.area] ?? row.area}</span>
                <span>{bad ? <Pill tone="bad">הפרש <Money v={row.difference} /></Pill> : <Pill tone="ok">תואם</Pill>}</span>
                <span className="col-span-2 text-xs text-muted">בספרים <Money v={row.books} /> · מוסבר <Money v={row.explained} /> · בדוחות <Money v={row.source} />
                  {RECON_BALANCES.includes(row.area) && x.to !== today ? ' · (יתרה — מול המצב של היום)' : ''}</span>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-xs text-muted">הפרש = בספרים − מוסבר − בדוחות. "מוסבר" — מה שרק הספרים יודעים: פקודות ידניות, הפרשי קופה, שורות בנק שנרשמו לחשבון ויתרות הפתיחה.</p>
      </Card>
      <TableCard table={reconcileTable(x)} period={period} subtitle={subtitle} exportOnly />
    </div>
  );
}
