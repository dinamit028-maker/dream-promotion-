'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Chip, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { Modal, Spinner } from '@/components/ui/feedback';
import { useLocations } from '@/features/locations/store';
import { useFinance } from './FinanceScreen';
import {
  CASH_MIGRATION, handleLine, importBank, loadBankBook, loadCandidates, matchLine, reopenLine, unmatchLine, useCashReadyState,
} from './cash-data';
import {
  LINE_STATUS, NO_COLUMNS, chosenGap, depositLabel, detectColumns, fileSummary, mapReady, payCardLabel, readBankFile, suggest, toBankLines,
  type BankLine, type BankLineIn, type ColumnMap, type DepositCard, type Grid, type PayCard, type Statement,
} from './bank';
import { LOAD_FAILED, LoadFailed, Note, PeriodPicker, Pill, ddmmyyyy, ils, periodNow, todayIL, type Period } from './ui';

/**
 * "התאמת בנק" (2.95, T9 — once the business turned the desks on): the owner uploads the file of movements the bank's site gives
 * (CSV or Excel — not a connection to the bank); each line is kept once. For every line "לטיפול" a match is suggested by amount
 * and date — a receipt or a deposit for money in, a payment to a supplier for money out — and saved only when the owner approves
 * it; or chosen by hand (several receipts for one line, to the agora); or marked handled with a note (a bank fee). A match
 * approved by mistake is undone with a reason. The bank is the whole business's: a member limited to some locations does not see it.
 */
type Filter = 'open' | 'matched' | 'handled' | 'all';
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export function BankRecon() {
  const { profile, say, fail, go } = useFinance();
  const ready = useCashReadyState();
  const limited = useLocations((x) => x.state.limited);
  const [period, setPeriod] = useState<Period>(() => periodNow('month'));
  const [filter, setFilter] = useState<Filter>('open');
  const [lines, setLines] = useState<BankLine[] | null>(null);
  const [files, setFiles] = useState<Statement[]>([]);
  const [cand, setCand] = useState<{ payments: PayCard[]; deposits: DepositCard[] }>({ payments: [], deposits: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picking, setPicking] = useState<BankLine | null>(null);
  const [undoing, setUndoing] = useState<BankLine | null>(null);
  const [noting, setNoting] = useState<BankLine | null>(null);
  const [upload, setUpload] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const today = todayIL();
      const around = { from: addDays(period.from, -14), to: [addDays(period.to, 14), today].sort()[0] };
      const [b, c] = await Promise.all([loadBankBook(period), loadCandidates(around)]);
      if (!b.ok) { setError(b.error); return; }
      setLines(b.data.lines); setFiles(b.data.statements);
      setCand(c.ok ? c.data : { payments: [], deposits: [] });
    } catch { setError(LOAD_FAILED); }
  }, [period]);
  useEffect(() => { if (ready && profile.cashDrawers && !limited) void load(); }, [ready, profile.cashDrawers, limited, load]);
  const sugg = useMemo(() => suggest(lines ?? [], cand), [lines, cand]);

  if (ready === null) return <div className="py-10 text-center"><Spinner /></div>;
  if (!ready) return <Note tone="warn">{CASH_MIGRATION}</Note>;
  if (!profile.cashDrawers) {
    return (
      <Card className="p-4">
        <p className="mb-1 font-bold">התאמת בנק — כבויה</p>
        <p className="mb-3 text-sm text-muted">מעלים קובץ תנועות מאתר הבנק, והמערכת מציעה התאמה לקבלות, להפקדות ולתשלומים לספקים. מפעילים בהגדרות הכספים (&quot;קופות, הפקדות והתאמת בנק&quot;).</p>
        <Button variant="primary" onClick={() => go('settings')}>להגדרות הכספים</Button>
      </Card>
    );
  }
  if (limited) return <Note tone="warn">התאמת בנק — רק למי שרואה את כל הסניפים של העסק.</Note>;

  const counts = { open: 0, matched: 0, handled: 0, all: lines?.length ?? 0 };
  for (const l of lines ?? []) counts[l.status]++;
  const shown = (lines ?? []).filter((l) => filter === 'all' || l.status === filter);
  const payOf = (id: string) => cand.payments.find((p) => p.id === id);
  const depOf = (id: string) => cand.deposits.find((d) => d.id === id);
  async function approve(l: BankLine) {
    const s = sugg.get(l.id);
    if (!s) return;
    setBusy(l.id);
    const r = await matchLine(l.id, s.kind === 'payment' ? [s.id] : [], s.kind === 'deposit' ? [s.id] : []);
    setBusy(null);
    if (!r.ok) { fail(r.error); void load(); return; }
    say('ההתאמה נשמרה'); void load();
  }
  async function reopen(l: BankLine) {
    setBusy(l.id);
    const r = await reopenLine(l.id);
    setBusy(null);
    if (r.ok) say('השורה חזרה לטיפול'); else fail(r.error);
    void load();
  }
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setUpload(true)}>העלאת קובץ מהבנק</Button>
        <span className="text-xs text-muted">CSV או Excel מאתר הבנק. זה לא חיבור לבנק — רק קובץ שאתם מורידים ומעלים.</span>
      </div>
      <PeriodPicker value={period} onChange={setPeriod} />
      {error ? <LoadFailed message={error} onRetry={() => void load()} /> : !lines ? <div className="py-8 text-center"><Spinner /></div> : <>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="שורות הבנק">
          {([['open', `לטיפול (${counts.open})`], ['matched', `הותאמו (${counts.matched})`], ['handled', `טופלו (${counts.handled})`], ['all', `הכל (${counts.all})`]] as [Filter, string][])
            .map(([k, label]) => <Chip key={k} on={filter === k} onClick={() => setFilter(k)} role="tab" aria-selected={filter === k}>{label}</Chip>)}
        </div>
        {!shown.length ? <Note>{lines.length ? 'אין שורות כאן.' : 'עוד לא הועלה קובץ לתקופה הזו.'}</Note> : (
          <ul className="grid gap-2">{shown.map((l) => {
            const s = l.status === 'open' ? sugg.get(l.id) : undefined;
            const sp = s?.kind === 'payment' ? payOf(s.id) : undefined;
            const sd = s?.kind === 'deposit' ? depOf(s.id) : undefined;
            return (
              <li key={l.id} className="min-w-0 rounded-2xl border border-line bg-surface p-3 text-sm" data-line={l.description}>
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <span className="min-w-0">
                    <strong className="block truncate">{l.description || 'בלי תיאור'}</strong>
                    <span className="text-xs text-muted">{ddmmyyyy(l.date)}{l.reference ? ` · אסמכתא ${l.reference}` : ''}{l.account ? ` · ${l.account}` : ''}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Pill tone={l.status === 'open' ? 'warn' : l.status === 'matched' ? 'ok' : 'default'}>{LINE_STATUS[l.status]}</Pill>
                    <strong className={l.amount > 0 ? 'tabular-nums text-emerald-600 dark:text-emerald-400' : 'tabular-nums text-red-600 dark:text-red-400'}>{l.amount > 0 ? '+' : '−'}{ils(Math.abs(l.amount))}</strong>
                  </span>
                </div>
                {l.status === 'open' && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {s && (sp || sd) && <>
                      <span className="min-w-0 flex-1 text-xs">הצעה: <strong>{sp ? payCardLabel(sp) : sd ? depositLabel(sd) : ''}</strong> · {ddmmyyyy(sp?.paidOn ?? sd?.date ?? '')}{s.days ? ` (${s.days} ימים)` : ''}</span>
                      <Button size="sm" variant="primary" disabled={busy === l.id} onClick={() => void approve(l)}>אישור</Button>
                    </>}
                    <Button size="sm" variant="ghost" onClick={() => setPicking(l)}>{s ? 'בחירה אחרת' : 'התאמה ידנית'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setNoting(l)}>טופל בלי התאמה</Button>
                  </div>
                )}
                {l.status === 'matched' && (
                  <div className="mt-2 grid gap-0.5 text-xs">
                    {l.matches.map((m) => <span key={m.id}>✓ {m.payment ? payCardLabel(m.payment) : m.deposit ? depositLabel(m.deposit) : ''} · {ils(m.amount)}</span>)}
                    <div><Button size="sm" variant="ghost" onClick={() => setUndoing(l)}>ביטול ההתאמה</Button></div>
                  </div>
                )}
                {l.status === 'handled' && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span className="min-w-0 flex-1">📝 {l.note}</span>
                    <Button size="sm" variant="ghost" disabled={busy === l.id} onClick={() => void reopen(l)}>החזרה לטיפול</Button></div>
                )}
              </li>
            );
          })}</ul>
        )}
        {files.length > 0 && (
          <Card className="p-4">
            <p className="mb-1 font-bold">קבצים שהועלו</p>
            <ul className="grid gap-1 text-xs">{files.slice(0, 10).map((f) => <li key={f.id}>{f.file || 'קובץ'}{f.account ? ` · ${f.account}` : ''} · {f.total} שורות, {f.added} חדשות{f.from ? ` · ${ddmmyyyy(f.from)}–${ddmmyyyy(f.to)}` : ''}</li>)}</ul>
          </Card>
        )}
      </>}
      {upload && <UploadDialog defaultAccount={[profile.bankName, profile.bankAccount].filter(Boolean).join(' ')} onClose={() => setUpload(false)}
        onDone={(r) => { setUpload(false); say(`נוספו ${r.added} שורות חדשות${r.total > r.added ? ` (${r.total - r.added} כבר היו)` : ''}`); void load(); }} />}
      {picking && <PickDialog line={picking} cand={cand} onClose={() => setPicking(null)} onDone={() => { setPicking(null); say('ההתאמה נשמרה'); void load(); }} />}
      {undoing && <ReasonDialog title="ביטול התאמה" hint="השורה חוזרת לטיפול. ההתאמה נשארת בהיסטוריה, עם הסיבה." label="סיבה"
        onClose={() => setUndoing(null)} act={(r) => unmatchLine(undoing.id, r)} onDone={() => { setUndoing(null); say('ההתאמה בוטלה'); void load(); }} />}
      {noting && <ReasonDialog title="טופל בלי התאמה" hint="למשל עמלת בנק או ריבית. השורה יוצאת מ'לטיפול' — אפשר להחזיר אותה." label="הערה"
        onClose={() => setNoting(null)} act={(r) => handleLine(noting.id, r)} onDone={() => { setNoting(null); say('השורה סומנה כטופלה'); void load(); }} />}
    </div>
  );
}

/** choose by hand: receipts / deposits (money in) or payments (money out) of the line's sign, adding up to it to the agora */
function PickDialog({ line, cand, onClose, onDone }: { line: BankLine; cand: { payments: PayCard[]; deposits: DepositCard[] }; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inMoney = line.amount > 0;
  const pays = cand.payments.filter((p) => (p.direction === 'in') === inMoney);
  const deps = inMoney ? cand.deposits : [];
  const text = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase());
  const list = [
    ...deps.map((d) => ({ id: d.id, kind: 'deposit' as const, label: depositLabel(d), date: d.date, amount: d.total })),
    ...pays.map((p) => ({ id: p.id, kind: 'payment' as const, label: payCardLabel(p), date: p.paidOn, amount: p.amount })),
  ].filter((x) => !q.trim() || text(x.label) || String(x.amount).includes(q.trim()))
    .sort((a, b) => Math.abs(Math.round(a.amount * 100) - Math.abs(Math.round(line.amount * 100))) - Math.abs(Math.round(b.amount * 100) - Math.abs(Math.round(line.amount * 100))) || a.date.localeCompare(b.date));
  const all = [...deps.map((d) => ({ id: d.id, amount: d.total })), ...pays.map((p) => ({ id: p.id, amount: p.amount }))].filter((x) => chosen.has(x.id));
  const gap = chosenGap(line, all);
  async function save() {
    setBusy(true);
    const r = await matchLine(line.id, [...chosen].filter((id) => pays.some((p) => p.id === id)), [...chosen].filter((id) => deps.some((d) => d.id === id)));
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    onDone();
  }
  return (
    <Modal open onClose={onClose} wide>
      <h3 className="mb-1 font-display text-lg font-extrabold">התאמה: {line.description || 'שורה'} · {line.amount > 0 ? '+' : '−'}{ils(Math.abs(line.amount))}</h3>
      <p className="mb-2 text-sm text-muted">{inMoney ? 'קבלות והפקדות' : 'תשלומים (הוצאות, החזרים)'} שעוד לא הותאמו. אפשר לבחור כמה — הסכום צריך להיות שווה לשורה.</p>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי שם או סכום" className="mb-2 py-2" aria-label="חיפוש" />
      {!list.length ? <p className="text-sm text-muted">אין מה להתאים בתקופה הזו.</p> : (
        <ul className="grid max-h-72 gap-1 overflow-y-auto text-sm">{list.slice(0, 100).map((x) => (
          <li key={x.id}><label className="flex items-center gap-2">
            <input type="checkbox" checked={chosen.has(x.id)} onChange={(e) => setChosen((s) => { const n = new Set(s); if (e.target.checked) n.add(x.id); else n.delete(x.id); return n; })} />
            <span className="min-w-0 flex-1 truncate">{x.label} · {ddmmyyyy(x.date)}</span>
            <strong className="tabular-nums">{ils(x.amount)}</strong>
          </label></li>
        ))}</ul>
      )}
      <p className="mt-2 text-sm">נבחרו {all.length}: {gap == null && all.length ? <strong className="text-emerald-600">שווה לשורה ✓</strong> : all.length ? <span className="text-warn">חסר/עודף {ils(Math.abs(gap ?? 0))}</span> : '—'}</p>
      {err && <div className="mt-2"><Note tone="warn">{err}</Note></div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={busy || !all.length || gap != null} onClick={() => void save()}>{busy ? 'שומר…' : 'אישור ההתאמה'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}

function ReasonDialog({ title, hint, label, act, onClose, onDone }: {
  title: string; hint: string; label: string; act: (text: string) => Promise<{ ok: true } | { ok: false; error: string }>; onClose: () => void; onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const r = await act(text);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    onDone();
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-lg font-extrabold">{title}</h3>
      <p className="mb-3 text-sm text-muted">{hint}</p>
      <Field label={label}><Input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} /></Field>
      {err && <Note tone="warn">{err}</Note>}
      <div className="mt-3 flex gap-2"><Button variant="primary" disabled={busy || text.trim().length < 2} onClick={() => void save()}>שמירה</Button><Button variant="ghost" onClick={onClose}>חזרה</Button></div>
    </Modal>
  );
}

const FIELDS: { key: Exclude<keyof ColumnMap, 'header'>; label: string; need?: boolean }[] = [
  { key: 'date', label: 'תאריך', need: true }, { key: 'description', label: 'תיאור' }, { key: 'reference', label: 'אסמכתא' },
  { key: 'amount', label: 'סכום (פלוס / מינוס)' }, { key: 'debit', label: 'חובה (יצא)' }, { key: 'credit', label: 'זכות (נכנס)' }, { key: 'balance', label: 'יתרה' },
];
/** a file of the bank: read here, its columns found (or pointed at), its lines shown — then imported, each line once */
function UploadDialog({ defaultAccount, onClose, onDone }: { defaultAccount: string; onClose: () => void; onDone: (r: { total: number; added: number }) => void }) {
  const [id, setId] = useState(() => crypto.randomUUID());
  const [file, setFile] = useState<string>('');
  const [grid, setGrid] = useState<Grid | null>(null);
  const [map, setMap] = useState<ColumnMap>(NO_COLUMNS);
  const [auto, setAuto] = useState(true);
  const [account, setAccount] = useState(defaultAccount);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function pick(f: File | undefined) {
    setErr(null); setGrid(null);
    if (!f) return;
    const r = await readBankFile(f.name, new Uint8Array(await f.arrayBuffer()));
    if (!r.ok) { setErr(r.error); return; }
    setFile(f.name); setGrid(r.grid); setId(crypto.randomUUID());
    const m = detectColumns(r.grid);
    setAuto(Boolean(m)); setMap(m ?? { ...NO_COLUMNS, header: 0 });
  }
  const read = useMemo((): { lines: BankLineIn[]; skipped: number } => (grid && mapReady(map) ? toBankLines(grid, map) : { lines: [], skipped: 0 }), [grid, map]);
  const sum = fileSummary(read.lines);
  const heads = grid ? (grid[Math.max(0, map.header)] ?? []).map((h, i) => `עמודה ${i + 1}${h ? `: ${h}` : ''}`) : [];
  async function save() {
    setBusy(true); setErr(null);
    const r = await importBank({ id, account, file, lines: read.lines });
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    onDone(r.data);
  }
  return (
    <Modal open onClose={onClose} wide>
      <h3 className="mb-1 font-display text-lg font-extrabold">העלאת קובץ תנועות מהבנק</h3>
      <p className="mb-3 text-sm text-muted">מורידים מאתר הבנק את תנועות החשבון (Excel או CSV) ומעלים כאן. שורה שכבר הועלתה בקובץ קודם לא נכנסת פעמיים.</p>
      <input type="file" accept=".csv,.txt,.xlsx,.xls,.htm,.html" onChange={(e) => void pick(e.target.files?.[0])} aria-label="קובץ מהבנק" className="mb-3 block text-sm" />
      {grid && <>
        {!auto && <Note tone="warn">לא זיהינו את שמות העמודות. בחרו לכל שדה את העמודה שלו (לפחות תאריך, וסכום או חובה/זכות).</Note>}
        <details className="mb-2 text-sm" open={!auto}>
          <summary className="cursor-pointer font-semibold">העמודות {auto ? '(זוהו אוטומטית)' : ''}</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Field label="שורת הכותרות"><Select value={map.header} onChange={(e) => setMap({ ...map, header: Number(e.target.value) })}>
              {grid.slice(0, 30).map((r, i) => <option key={i} value={i}>שורה {i + 1}: {r.filter(Boolean).slice(0, 3).join(' · ').slice(0, 40)}</option>)}</Select></Field>
            {FIELDS.map((f) => (
              <Field key={f.key} label={f.label}><Select value={map[f.key]} onChange={(e) => setMap({ ...map, [f.key]: Number(e.target.value) })}>
                <option value={-1}>— אין —</option>{heads.map((h, i) => <option key={i} value={i}>{h.slice(0, 40)}</option>)}</Select></Field>
            ))}
          </div>
        </details>
        <Field label="החשבון (לזיהוי — לא חובה)"><Input value={account} onChange={(e) => setAccount(e.target.value)} maxLength={60} placeholder="למשל: לאומי 800-12345" /></Field>
        {read.lines.length > 0 ? (
          <div className="rounded-2xl bg-surface-2 p-3 text-sm">
            <p><strong>{sum.count} שורות</strong>{sum.from ? ` · ${ddmmyyyy(sum.from)}–${ddmmyyyy(sum.to)}` : ''} · נכנס {ils(sum.in)} · יצא {ils(sum.out)}{read.skipped ? ` · ${read.skipped} שורות בלי תאריך או סכום דולגו` : ''}</p>
            <ul className="mt-1 grid gap-0.5 text-xs">{read.lines.slice(0, 5).map((l, i) => <li key={i} className="flex justify-between gap-2"><span className="truncate">{ddmmyyyy(l.date)} · {l.description}</span><span className="tabular-nums">{l.amount > 0 ? '+' : '−'}{ils(Math.abs(l.amount))}</span></li>)}</ul>
          </div>
        ) : <Note tone="warn">לא נמצאו שורות עם תאריך וסכום. בדקו את העמודות.</Note>}
      </>}
      {err && <div className="mt-2"><Note tone="warn">{err}</Note></div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={busy || !read.lines.length || read.lines.length > 5000} onClick={() => void save()}>{busy ? 'מעלה…' : `ייבוא ${read.lines.length || ''} שורות`}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}
