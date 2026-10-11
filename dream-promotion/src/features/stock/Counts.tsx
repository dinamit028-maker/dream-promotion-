'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Field, Input, Select } from '@/components/ui/primitives';
import { Modal, Spinner } from '@/components/ui/feedback';
import { Note, Pill } from '@/features/finance/ui';
import { formatIL } from '@/lib/il-time';
import { cx } from '@/lib/utils';
import { useApp } from '@/lib/store';
import { activeLocations, defaultLocation, locationName, multiLocation, type LocationState } from '@/features/locations/locations';
import {
  COUNT_STATUS_HE, countList, countSummary, findByCode, stockKey, type Count, type CountResult,
} from './stock-locations';
import { approveCount, cancelCount, countResults, loadCounts, setCountLine, startCount, type StockCatalog } from './stock-data';
import { CameraScan } from './CameraScan';

const PILL = { open: 'info', approved: 'ok', cancelled: 'default' } as const;

/** "ספירות": a count of a location, line by line from the phone; the owner approves, and only then the differences are recorded */
export function Counts({ catalog, loc, onMoved }: { catalog: StockCatalog; loc: LocationState; onMoved: () => Promise<void> | void }) {
  const [list, setList] = useState<Count[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [say, setSay] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const load = useCallback(async () => {
    const r = await loadCounts();
    if (r.ok) { setList(r.data); setError(null); } else { setList([]); setError(r.error); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const open = list?.find((c) => c.id === openId) ?? null;
  const flash = (m: string) => { setSay(m); setTimeout(() => setSay(null), 4000); };
  const where = (c: Count) => (multiLocation(loc) ? ` · ${locationName(loc, c.locationId)}` : '');

  if (open) return <CountSheet count={open} catalog={catalog} loc={loc} onBack={() => { setOpenId(null); void load(); }}
    onClosed={async (m) => { setOpenId(null); flash(m); await Promise.all([load(), onMoved()]); }} />;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">סופרים מהטלפון שורה אחרי שורה (גם בסריקת ברקוד). הספירה נשמרת תוך כדי, והפערים נרשמים רק אחרי אישור הבעלים.</p>
        <Button variant="primary" onClick={() => setStarting(true)}>+ ספירה חדשה</Button>
      </div>
      {say && <p role="status" className="rounded-2xl bg-emerald-500/15 p-3 text-sm font-semibold">✓ {say}</p>}
      {error && <Note tone="warn">{error}</Note>}
      {list === null ? <div className="py-6 text-center"><Spinner /></div> : !list.length ? <p className="py-6 text-center text-sm text-muted">עוד אין ספירות.</p> : (
        <div className="grid gap-2">
          {list.map((c) => (
            <Card key={c.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <span className="min-w-0">
                <strong className="block">ספירה {c.number}{where(c)}</strong>
                <span className="text-xs text-muted">{formatIL(c.createdAt, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  {' · '}{c.status === 'approved' && c.result ? `${c.result.filter((r) => r.gap !== 0).length} פערים נרשמו` : `${c.lines.length} שורות נספרו`}
                  {c.note ? ` · "${c.note}"` : ''}</span>
              </span>
              <span className="flex items-center gap-2">
                <Pill tone={PILL[c.status]}>{COUNT_STATUS_HE[c.status]}</Pill>
                {c.status !== 'cancelled' && <Button size="sm" variant={c.status === 'open' ? 'primary' : 'ghost'} onClick={() => setOpenId(c.id)}>
                  {c.status === 'open' ? 'המשך ספירה' : 'מה נמצא'}</Button>}
              </span>
            </Card>
          ))}
        </div>
      )}
      {starting && <StartCount loc={loc} onClose={() => setStarting(false)} onStarted={async (id) => { setStarting(false); await load(); setOpenId(id); }} />}
    </div>
  );
}

function StartCount({ loc, onClose, onStarted }: { loc: LocationState; onClose: () => void; onStarted: (id: string) => void }) {
  const places = activeLocations(loc);
  const [at, setAt] = useState(defaultLocation(loc) ?? loc.businessId ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [id] = useState(() => crypto.randomUUID());
  async function start() {
    setBusy(true);
    const r = await startCount(at, note, id);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    onStarted(r.data.id);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-4 font-display text-xl font-extrabold">ספירה חדשה</h3>
      {multiLocation(loc) && <Field label="איפה סופרים"><Select value={at} onChange={(e) => setAt(e.target.value)}>
        {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select></Field>}
      <Field label="הערה (לא חובה)"><Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="למשל: ספירת סוף חודש" /></Field>
      {err && <p role="alert" className="mb-3 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || !at} onClick={() => void start()}>{busy ? 'פותח…' : 'פתיחת הספירה'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}

function CountSheet({ count, catalog, loc, onBack, onClosed }: {
  count: Count; catalog: StockCatalog; loc: LocationState; onBack: () => void; onClosed: (m: string) => void;
}) {
  const me = useApp((s) => s.userId);
  const [counted, setCounted] = useState<Record<string, number | null>>(() => Object.fromEntries(count.lines.map((l) => [stockKey(l.itemId, l.variantId), l.counted])));
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [summary, setSummary] = useState<CountResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const sheet = useRef<HTMLUListElement>(null);
  const closed = count.status !== 'open';
  const rows = countList(catalog.items, catalog.variants, { lines: Object.entries(counted).filter(([, v]) => v != null)
    .map(([k, v]) => { const [itemId, variantId] = k.split('|'); return { itemId, variantId: variantId || null, counted: v!, at: '' }; }) });
  const shown = rows.filter((r) => !q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()));
  const nameOf = (itemId: string, variantId: string | null) => rows.find((r) => r.key === stockKey(itemId, variantId))?.name ?? '';

  async function save(key: string, itemId: string, variantId: string | null) {
    const raw = draft[key];
    if (raw === undefined) return;
    const v = raw.trim() === '' ? null : Number(raw);
    if (v !== null && (!Number.isInteger(v) || v < 0)) { setMsg('ספירה ביחידות שלמות, אפס או יותר.'); return; }
    if ((counted[key] ?? null) === v) { setDraft(({ [key]: _, ...rest }) => rest); return; }
    const r = await setCountLine(count.id, itemId, variantId, v);
    if (!r.ok) { setMsg(r.error); return; }
    setCounted((c) => ({ ...c, [key]: v })); setDraft(({ [key]: _, ...rest }) => rest); setMsg(null); setSummary(null);
  }
  function go(scanned: string) {
    const hit = findByCode(scanned, catalog.items, catalog.variants);
    if (!hit) { setMsg(`לא נמצא מוצר עם הקוד "${scanned.trim()}".`); return; }
    const key = stockKey(hit.itemId, hit.variantId);
    setQ(''); setCode(''); setMsg(`נמצא: ${nameOf(hit.itemId, hit.variantId)}`);
    setTimeout(() => { const el = sheet.current?.querySelector<HTMLInputElement>(`input[data-key="${key}"]`); el?.scrollIntoView({ block: 'center' }); el?.focus(); el?.select(); }, 50);
  }
  async function showSummary() {
    setBusy(true);
    const r = await countResults(count.id);
    setBusy(false);
    if (!r.ok) return setMsg(r.error);
    setSummary(r.data);
  }
  async function approve() {
    if (!window.confirm('לאשר את הספירה? כל פער נרשם כתנועת "ספירת מלאי" בסניף, והמלאי מתעדכן.')) return;
    setBusy(true);
    const r = await approveCount(count.id);
    setBusy(false);
    if (!r.ok) return setMsg(r.error);
    onClosed(`ספירה ${count.number} אושרה — ${r.data.moved === 0 ? 'אין פערים' : r.data.moved === 1 ? 'פער אחד נרשם' : `${r.data.moved} פערים נרשמו`}.`);
  }
  async function drop() {
    if (!window.confirm('לבטל את הספירה? מה שנספר לא יירשם.')) return;
    const r = await cancelCount(count.id);
    if (!r.ok) return setMsg(r.error);
    onClosed(`ספירה ${count.number} בוטלה.`);
  }
  const s = summary ? countSummary(summary, rows.length) : null;
  const result = count.result ?? [];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl font-extrabold">ספירה {count.number}{multiLocation(loc) ? ` · ${locationName(loc, count.locationId)}` : ''}</h2>
        <Button variant="ghost" onClick={onBack}>חזרה לספירות</Button>
      </div>
      {msg && <p role="status" className="rounded-2xl bg-surface-2 p-3 text-sm">{msg}</p>}
      {count.status === 'approved' ? (
        <Card className="p-4">
          <p className="mb-2 font-bold">אושרה {count.approvedAt ? formatIL(count.approvedAt, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</p>
          {!result.some((r) => r.gap !== 0) ? <p className="text-sm text-muted">הכל היה כמו במלאי.</p> : (
            <ul className="grid gap-1 text-sm">{result.filter((r) => r.gap !== 0).map((r) => (
              <li key={stockKey(r.itemId, r.variantId)} className="flex justify-between gap-2 rounded-xl bg-surface-2 px-3 py-1.5">
                <span>{nameOf(r.itemId, r.variantId) || 'מוצר'}</span>
                <span className="tabular-nums">נספרו {r.counted} · במערכת {r.expected} · <strong dir="ltr">{r.gap > 0 ? `+${r.gap}` : r.gap}</strong></span>
              </li>))}</ul>
          )}
        </Card>
      ) : <>
        <div className="flex flex-wrap gap-2">
          <Input value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) { e.preventDefault(); go(code); } }}
            placeholder="ברקוד / מק״ט — סריקה או הקלדה ואנטר" aria-label="ברקוד או מק״ט" className="min-w-0 flex-1" dir="ltr" disabled={closed} />
          <CameraScan onCode={go} />
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי שם" aria-label="חיפוש לפי שם" />
        <p className="text-xs text-muted">{rows.filter((r) => counted[r.key] != null).length} מתוך {rows.length} נספרו · כל שורה נשמרת מיד, והספירה שלה היא של הרגע שבו נספרה (מכירות אחריה לא נבלעות).</p>
        <ul ref={sheet} className="grid gap-1.5">
          {shown.map((r) => {
            const val = draft[r.key] ?? (counted[r.key] != null ? String(counted[r.key]) : '');
            const done = counted[r.key] != null && draft[r.key] === undefined;
            return (
              <li key={r.key} className={cx('flex items-center gap-2 rounded-2xl px-3 py-2 text-sm', done ? 'bg-emerald-500/10' : 'bg-surface-2')}>
                <span className="min-w-0 flex-1 font-semibold">{done ? '✓ ' : ''}{r.name}</span>
                <Input data-key={r.key}
                  type="number" inputMode="numeric" min={0} value={val} aria-label={`נספרו: ${r.name}`} className="h-10 max-w-24 shrink-0 py-0 text-center" disabled={closed}
                  onChange={(e) => setDraft((d) => ({ ...d, [r.key]: e.target.value }))}
                  onBlur={() => void save(r.key, r.itemId, r.variantId)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
              </li>
            );
          })}
        </ul>
        {s && summary && (
          <Card className="p-4">
            <p className="mb-2 font-bold">סיכום</p>
            <p className="text-sm">{s.counted} שורות נספרו · {s.matched} כמו במלאי · {s.short ? `${s.short} חסרים (${s.unitsShort} יח׳)` : 'אין חוסרים'} · {s.over ? `${s.over} עודפים (${s.unitsOver} יח׳)` : 'אין עודפים'}
              {s.notCounted ? ` · ${s.notCounted} לא נספרו (נשארים כמו שהם)` : ''}</p>
            {summary.some((r) => r.gap !== 0) && (
              <ul className="mt-2 grid gap-1 text-sm">{summary.filter((r) => r.gap !== 0).map((r) => (
                <li key={stockKey(r.itemId, r.variantId)} className="flex justify-between gap-2 rounded-xl bg-surface-2 px-3 py-1.5">
                  <span>{nameOf(r.itemId, r.variantId)}</span>
                  <span className="tabular-nums">נספרו {r.counted} · במערכת {r.expected} · <strong dir="ltr">{r.gap > 0 ? `+${r.gap}` : r.gap}</strong></span>
                </li>))}</ul>
            )}
            {loc.owner
              ? <Button variant="primary" className="mt-3" disabled={busy || !summary.length} onClick={() => void approve()}>אישור ורישום הפערים</Button>
              : <p className="mt-3 text-sm text-muted">רק הבעלים מאשרים ספירה. הספירה שמורה ומחכה לאישור.</p>}
          </Card>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant={summary ? 'ghost' : 'primary'} disabled={busy} onClick={() => void showSummary()}>{busy ? 'מחשב…' : 'סיכום פערים'}</Button>
          {(count.createdBy === me || loc.owner) && <Button variant="ghost" onClick={() => void drop()}>ביטול הספירה</Button>}
        </div>
      </>}
    </div>
  );
}
