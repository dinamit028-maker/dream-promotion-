'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { Modal, Spinner } from '@/components/ui/feedback';
import { Note, Pill } from '@/features/finance/ui';
import { formatIL } from '@/lib/il-time';
import { activeLocations, defaultLocation, locationName, type LocationState } from '@/features/locations/locations';
import {
  TRANSFER_STATUS_HE, lineName, qtyAt, receiptError, receiptPayload, stockKey, transferError, transferSummary,
  type DraftLine, type Received, type StockRow, type Transfer,
} from './stock-locations';
import { cancelTransfer, loadTransfers, receiveTransfer, sendTransfer, type StockCatalog } from './stock-data';
import type { TransferDraft } from './StockScreen';

const PILL = { sent: 'info', received: 'ok', cancelled: 'default' } as const;

/** "העברות": transfer notes between locations — sent (the units are on the way), received (with what arrived), or cancelled */
export function Transfers({ rows, catalog, loc, draft, onDraftUsed, onMoved }: {
  rows: StockRow[]; catalog: StockCatalog; loc: LocationState; draft: TransferDraft | null; onDraftUsed: () => void; onMoved: () => Promise<void> | void;
}) {
  const [list, setList] = useState<Transfer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [say, setSay] = useState<string | null>(null);
  const [form, setForm] = useState<TransferDraft | null>(null);
  const [receiving, setReceiving] = useState<Transfer | null>(null);
  const load = useCallback(async () => {
    const r = await loadTransfers();
    if (r.ok) { setList(r.data); setError(null); } else { setList([]); setError(r.error); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // a suggestion of "לפי סניף" opens the form with it
  useEffect(() => { if (draft) { setForm(draft); onDraftUsed(); } }, [draft, onDraftUsed]);
  const done = async (m: string) => { setSay(m); setTimeout(() => setSay(null), 4000); await Promise.all([load(), onMoved()]); };
  const mine = (id: string) => loc.locations.some((l) => l.id === id);
  const places = activeLocations(loc);
  const fresh = (): TransferDraft => {
    const from = defaultLocation(loc) ?? places[0]?.id ?? '';
    return { from, to: places.find((p) => p.id !== from)?.id ?? '', lines: [] };
  };

  async function cancel(t: Transfer) {
    const reason = window.prompt(`לבטל את העברה ${t.number}? היחידות חוזרות ל${locationName(loc, t.from)}.\n\nלמה מבטלים?`, '');
    if (reason === null) return;
    const r = await cancelTransfer(t.id, reason);
    if (!r.ok) return window.alert(r.error);
    await done(`העברה ${t.number} בוטלה — היחידות חזרו ל${locationName(loc, t.from)}.`);
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">היחידות יוצאות מהסניף ששולח מיד, ונכנסות לסניף שמקבל כשמאשרים קבלה. תעודת העברה פנימית — לא מסמך מס.</p>
        <Button variant="primary" onClick={() => setForm(fresh())} disabled={places.length < 2}>+ העברה חדשה</Button>
      </div>
      {say && <p role="status" className="rounded-2xl bg-emerald-500/15 p-3 text-sm font-semibold">✓ {say}</p>}
      {error && <Note tone="warn">{error}</Note>}
      {list === null ? <div className="py-6 text-center"><Spinner /></div> : !list.length ? <p className="py-6 text-center text-sm text-muted">עוד אין העברות.</p> : (
        <div className="grid gap-2">
          {list.map((t) => (
            <Card key={t.id} className="p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-bold">העברה {t.number} · מ{locationName(loc, t.from) || 'סניף אחר'} אל {locationName(loc, t.to) || 'סניף אחר'}</p>
                  <p className="text-xs text-muted">{transferSummary(t)} · נשלחה {formatIL(t.sentAt, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    {t.receivedAt ? ` · התקבלה ${formatIL(t.receivedAt, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
                    {t.note ? ` · "${t.note}"` : ''}</p>
                </div>
                <Pill tone={PILL[t.status]}>{TRANSFER_STATUS_HE[t.status]}</Pill>
              </div>
              <ul className="mt-2 grid gap-1 text-sm">
                {t.lines.map((l) => (
                  <li key={stockKey(l.itemId, l.variantId)} className="flex flex-wrap justify-between gap-2 rounded-xl bg-surface-2 px-3 py-1.5">
                    <span>{lineName(l)}</span>
                    <span className="tabular-nums">{l.qty}{l.received != null && l.received !== l.qty ? ` · הגיעו ${l.received}${l.reason ? ` — ${l.reason}` : ''}` : ''}</span>
                  </li>
                ))}
              </ul>
              {t.status === 'cancelled' && t.cancelReason && <p className="mt-2 text-xs text-muted">בוטלה: {t.cancelReason}</p>}
              {t.status === 'sent' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {mine(t.to) && <Button size="sm" variant="primary" onClick={() => setReceiving(t)}>קבלה ב{locationName(loc, t.to)}</Button>}
                  {(mine(t.from) || loc.owner) && <Button size="sm" variant="ghost" onClick={() => void cancel(t)}>ביטול העברה</Button>}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {form && <TransferForm initial={form} rows={rows} catalog={catalog} loc={loc} onClose={() => setForm(null)}
        onSent={async (n) => { setForm(null); await done(`העברה ${n} נשלחה — היחידות בדרך.`); }} />}
      {receiving && <ReceiveDialog t={receiving} loc={loc} onClose={() => setReceiving(null)}
        onDone={async (gaps) => { const n = receiving.number; setReceiving(null); await done(gaps ? `העברה ${n} התקבלה — ${gaps === 1 ? 'פער אחד נרשם' : `${gaps} פערים נרשמו`}.` : `העברה ${n} התקבלה.`); }} />}
    </div>
  );
}

function TransferForm({ initial, rows, catalog, loc, onClose, onSent }: {
  initial: TransferDraft; rows: StockRow[]; catalog: StockCatalog; loc: LocationState; onClose: () => void; onSent: (n: number) => void;
}) {
  const places = activeLocations(loc);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [lines, setLines] = useState<DraftLine[]>(initial.lines.length ? initial.lines : []);
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [id] = useState(() => crypto.randomUUID());   // a second try of the same form is the same transfer
  const tracked = catalog.items.filter((i) => i.trackStock && i.active);
  const options = tracked.flatMap((it) => it.hasVariants
    ? catalog.variants.filter((v) => v.itemId === it.id && v.active).map((v) => ({ key: stockKey(it.id, v.id), itemId: it.id, variantId: v.id as string | null, name: `${it.name} · ${v.label}` }))
    : [{ key: stockKey(it.id, null), itemId: it.id, variantId: null as string | null, name: it.name }]);
  const nameOf = (l: DraftLine) => options.find((o) => o.key === stockKey(l.itemId, l.variantId))?.name ?? '';
  function add() {
    const o = options.find((x) => x.key === pick);
    if (!o) return;
    if (lines.some((l) => stockKey(l.itemId, l.variantId) === o.key)) { setPick(''); return; }
    setLines([...lines, { itemId: o.itemId, variantId: o.variantId, qty: 1 }]); setPick('');
  }
  async function send() {
    const e = transferError(from, to, lines, catalog.items);
    if (e) return setErr(e);
    setBusy(true);
    const r = await sendTransfer(from, to, lines, note, id);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    onSent(r.data.number);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-4 font-display text-xl font-extrabold">העברה חדשה</h3>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="מ"><Select value={from} onChange={(e) => setFrom(e.target.value)}>
          {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select></Field>
        <Field label="אל"><Select value={to} onChange={(e) => setTo(e.target.value)}>
          {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select></Field>
      </div>
      <p className="mb-1.5 text-sm font-semibold">מה עובר</p>
      <ul className="mb-2 grid gap-1.5">
        {lines.map((l, k) => {
          const have = qtyAt(rows, from, l.itemId, l.variantId);
          return (
            <li key={stockKey(l.itemId, l.variantId)} className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1"><strong>{nameOf(l)}</strong><span className={have < l.qty ? 'block text-xs text-warn' : 'block text-xs text-muted'}>
                יש ב{locationName(loc, from)}: {have}</span></span>
              <Input type="number" inputMode="numeric" min={1} value={String(l.qty)} aria-label={`כמה: ${nameOf(l)}`} className="h-9 w-20 py-0 text-center"
                onChange={(e) => setLines(lines.map((x, i) => (i === k ? { ...x, qty: Math.floor(Number(e.target.value) || 0) } : x)))} />
              <button type="button" className="text-xs font-semibold text-muted underline" onClick={() => setLines(lines.filter((_, i) => i !== k))}>הסרה</button>
            </li>
          );
        })}
      </ul>
      <div className="mb-4 flex gap-2">
        <Select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="מוצר להעברה" className="flex-1">
          <option value="">בחירת מוצר…</option>
          {options.map((o) => <option key={o.key} value={o.key}>{o.name} ({qtyAt(rows, from, o.itemId, o.variantId)})</option>)}
        </Select>
        <Button variant="ghost" onClick={add} disabled={!pick}>הוספה</Button>
      </div>
      <Field label="הערה (לא חובה)"><Textarea value={note} maxLength={300} className="min-h-[60px]" onChange={(e) => setNote(e.target.value)} /></Field>
      {err && <p role="alert" className="mb-3 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void send()}>{busy ? 'שולח…' : 'שליחה'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}

function ReceiveDialog({ t, loc, onClose, onDone }: { t: Transfer; loc: LocationState; onClose: () => void; onDone: (gaps: number) => void }) {
  const [got, setGot] = useState<Record<string, Received | undefined>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function receive() {
    const e = receiptError(t.lines, got);
    if (e) return setErr(e);
    setBusy(true);
    const r = await receiveTransfer(t.id, receiptPayload(t.lines, got), note);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    onDone(r.data.gaps);
  }
  return (
    <Modal open onClose={onClose}>
      <h3 className="mb-1 font-display text-xl font-extrabold">קבלת העברה {t.number}</h3>
      <p className="mb-4 text-sm text-muted">מ{locationName(loc, t.from)} אל {locationName(loc, t.to)} · מה שהגיע אחרת ממה שנשלח נרשם כפער, עם הסיבה.</p>
      <ul className="mb-4 grid gap-2">
        {t.lines.map((l) => {
          const k = stockKey(l.itemId, l.variantId), g = got[k], rec = g ? g.received : l.qty;
          return (
            <li key={k} className="rounded-2xl bg-surface-2 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span><strong>{lineName(l)}</strong> · נשלחו {l.qty}</span>
                <label className="flex items-center gap-1.5">הגיעו
                  <Input type="number" inputMode="numeric" min={0} value={String(rec)} aria-label={`הגיעו: ${lineName(l)}`} className="h-9 w-20 py-0 text-center"
                    onChange={(e) => setGot({ ...got, [k]: { received: Math.floor(Number(e.target.value) || 0), reason: g?.reason ?? '' } })} />
                </label>
              </div>
              {rec !== l.qty && (
                <Input className="mt-2" value={g?.reason ?? ''} maxLength={200} aria-label={`למה: ${lineName(l)}`} placeholder="למה? למשל: נשבר בדרך"
                  onChange={(e) => setGot({ ...got, [k]: { received: rec, reason: e.target.value } })} />
              )}
            </li>
          );
        })}
      </ul>
      <Field label="הערה (לא חובה)"><Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
      {err && <p role="alert" className="mb-3 rounded-2xl bg-warn/10 p-3 text-sm text-warn">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void receive()}>{busy ? 'שומר…' : 'אישור קבלה'}</Button>
        <Button variant="ghost" onClick={onClose}>ביטול</Button>
      </div>
    </Modal>
  );
}
