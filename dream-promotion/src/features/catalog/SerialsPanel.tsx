'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, SmallSelect, Textarea } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL } from '@/lib/il-time';
import { useLocations } from '@/features/locations/store';
import { activeLocations, defaultLocation, locationName, multiLocation } from '@/features/locations/locations';
import { loadItemStock } from '@/features/stock/stock-data';
import { qtyAt, type StockRow } from '@/features/stock/stock-locations';
import { useQuickCount } from '@/features/stock/useQuickCount';
import { variantLabel, type CatalogItem, type CatalogVariant } from './catalog';
import { SERIAL_LIMITS, SERIAL_STATUS_HE, historyLine, parseSerials, unnumbered, type Serial, type SerialEvent } from './serials';
import { loadItemSerials, loadSerialHistory, receiveSerials, removeSerial, setSerialTracking } from './items-data';
import { Switch } from './PublishSwitch';

/**
 * "מספרים סידוריים" in the product editor (2.93 — T12ג): on / off for the product, units in by number (new ones, or ones already
 * in stock), the list with each unit's history, and writing a unit off (the owner). Before migration 4800 — nothing is shown.
 * The database decides everything (serial_tracking, serial_receive, serial_remove); this screen asks and shows.
 */
export function SerialsPanel({ item, variants, onChanged, say, fail }: {
  item: CatalogItem; variants: CatalogVariant[];
  /** the product changed (its stock, its flag): the editor reloads it */
  onChanged: () => Promise<void> | void;
  say: (m: string) => void; fail: (m: string) => void;
}) {
  const loc = useLocations((s) => s.state);
  const owner = useQuickCount();
  const [serials, setSerials] = useState<Serial[] | null | undefined>(undefined);
  const [levels, setLevels] = useState<StockRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const places = activeLocations(loc);
  const [where, setWhere] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string>('');
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<{ id: string; events: SerialEvent[] | null } | null>(null);
  const [writeOff, setWriteOff] = useState<{ id: string; reason: string } | null>(null);
  const actives = variants.filter((v) => v.active);

  const load = useCallback(async () => {
    const r = await loadItemSerials(item.id);
    if (r === null) { setSerials(null); return; }
    if (!r.ok) { fail(r.error); setSerials([]); return; }
    setSerials(r.data);
    setLevels(await loadItemStock(item.id));
  }, [item.id, fail]);
  useEffect(() => { void load(); }, [load, item.trackSerials, item.stockQty]);
  useEffect(() => { if (!where && loc.ready) setWhere(defaultLocation(loc) ?? loc.businessId); }, [loc, where]);
  useEffect(() => { if (item.hasVariants && !variantId && actives[0]) setVariantId(actives[0].id); }, [item.hasVariants, variantId, actives]);

  const here = where ?? loc.businessId ?? '';
  const vid = item.hasVariants ? (variantId || null) : null;
  // the location's count (stock by location), else — one location, before 4700 — the product's own count
  const stockHere = levels ? qtyAt(levels, here, item.id, vid) : vid ? (variants.find((v) => v.id === vid)?.stockQty ?? 0) : item.stockQty;
  const free = serials ? unnumbered(stockHere, serials, item.id, here, vid) : 0;
  const shown = useMemo(() => (serials ?? []).filter((s) => !q.trim() || s.serial.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (a.status === 'in_stock' ? 0 : 1) - (b.status === 'in_stock' ? 0 : 1) || a.serial.localeCompare(b.serial, 'he', { numeric: true })), [serials, q]);

  if (serials === undefined || serials === null) return null;               // loading, or before migration 4800: as before
  const inStock = serials.filter((s) => s.status === 'in_stock');
  const byPlace = places.map((p) => ({ name: p.name, n: inStock.filter((s) => s.locationId === p.id).length })).filter((x) => x.n > 0);

  async function toggle() {
    if (!item.trackSerials && !window.confirm('לכל יחידה יהיה מספר משלה: קולטים לפי מספר, בקופה בוחרים את המספר שנמכר, ובהעברה שולחים לפי מספר. המוצר לא יימכר באתר. להפעיל?')) return;
    setBusy(true);
    const r = await setSerialTracking(item.id, !item.trackSerials);
    setBusy(false);
    if (!r.ok) return fail(r.error);
    await onChanged();
    say(item.trackSerials ? 'המספרים הסידוריים כובו' : 'מספר סידורי לכל יחידה — פעיל ✓');
  }
  async function receive(existing: boolean) {
    const p = parseSerials(text);
    if (!p.ok) return fail(p.error);
    if (item.hasVariants && !vid) return fail('בוחרים מידה / צבע.');
    if (existing && p.serials.length > free) return fail(`יש ${free} יחידות בלי מספר ב${locationName(loc, here) || 'מלאי'} — לרישום יחידות חדשות: "קליטה".`);
    setBusy(true);
    const r = await receiveSerials(item.id, vid, loc.ready ? here : null, p.serials, existing, note);
    setBusy(false);
    if (!r.ok) return fail(r.error);
    setText(''); setNote('');
    await onChanged(); await load();
    say(existing ? `נרשמו ${r.data.count} מספרים ✓` : `נקלטו ${r.data.count} יחידות ✓ — במלאי ${r.data.stock}`);
  }
  async function history(s: Serial) {
    if (open?.id === s.id) return setOpen(null);
    setOpen({ id: s.id, events: null });
    const r = await loadSerialHistory(s.id);
    if (!r.ok) { setOpen(null); return fail(r.error); }
    setOpen({ id: s.id, events: r.data });
  }
  async function remove() {
    if (!writeOff) return;
    if (!writeOff.reason.trim()) return fail('למה היחידה יוצאת מהמלאי? (חובה)');
    setBusy(true);
    const r = await removeSerial(writeOff.id, writeOff.reason);
    setBusy(false);
    if (!r.ok) return fail(r.error);
    setWriteOff(null);
    await onChanged(); await load();
    say('היחידה הוצאה מהמלאי ✓');
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 p-3">
        <span>
          <strong className="block">מספר סידורי לכל יחידה</strong>
          <span className="text-xs text-muted">{item.trackSerials
            ? `במלאי עם מספר: ${inStock.length}${byPlace.length > 1 ? ` (${byPlace.map((x) => `${x.name} ${x.n}`).join(' · ')})` : ''}`
            : 'לתכשיטים, אלקטרוניקה ומוצרים עם אחריות: קליטה, מכירה והחזרה לפי מספר, וההיסטוריה של כל יחידה.'}</span>
        </span>
        <Switch on={item.trackSerials} onClick={() => void toggle()} disabled={busy} label="מספר סידורי לכל יחידה" />
      </div>
      {item.trackSerials && <>
        <div className="grid gap-2 rounded-xl border border-line p-3">
          <p className="font-semibold">קליטה עם מספרים</p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {item.hasVariants && (
              <SmallSelect value={variantId} onChange={(e) => setVariantId(e.target.value)} className="w-auto" aria-label="הווריאנט שנקלט">
                {actives.map((v) => <option key={v.id} value={v.id}>{variantLabel(v) || item.name}</option>)}
              </SmallSelect>
            )}
            {loc.ready && (multiLocation(loc) || loc.limited) && places.length > 0 && (
              <label className="flex items-center gap-1">ב-
                <SmallSelect value={here} onChange={(e) => setWhere(e.target.value)} className="w-auto" aria-label="הסניף שבו נקלט">
                  {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </SmallSelect>
              </label>
            )}
          </div>
          <Textarea value={text} rows={3} onChange={(e) => setText(e.target.value)} dir="ltr" className="min-h-20 font-mono text-sm"
            placeholder={'מספר בכל שורה — סורק מקליד ו-Enter\nA1001\nA1002'} aria-label="המספרים הסידוריים" />
          <Input value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} placeholder="הערה (לא חובה) — למשל ספק או תעודת משלוח" className="py-2" aria-label="הערה לקליטה" />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" disabled={busy || !text.trim()} onClick={() => void receive(false)}>{busy ? <Spinner /> : null}קליטה — יחידות חדשות</Button>
            {free > 0 && <Button size="sm" variant="ghost" disabled={busy || !text.trim()} onClick={() => void receive(true)}>רישום מספרים ליחידות שכבר במלאי</Button>}
          </div>
          {free > 0 && <p className="text-xs text-amber-700 dark:text-amber-300">{free === 1 ? 'יחידה אחת' : `${free} יחידות`} {loc.ready && multiLocation(loc) ? `ב${locationName(loc, here)} ` : ''}בלי מספר — בקופה מוכרים רק לפי מספר, אז רושמים להן מספרים.</p>}
          <p className="text-xs text-muted">עד {SERIAL_LIMITS.list} מספרים בפעם. מספר שכבר קיים למוצר — נדחה (בלי הבדל בין אותיות גדולות וקטנות).</p>
        </div>
        <div className="grid gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש מספר סידורי" dir="auto" className="py-2" aria-label="חיפוש מספר סידורי" />
          {!shown.length ? <p className="text-sm text-muted">{serials.length ? 'לא נמצא.' : 'עוד אין מספרים — קולטים למעלה.'}</p> : (
            <ul className="grid max-h-96 gap-1.5 overflow-y-auto" aria-label="המספרים הסידוריים של המוצר">
              {shown.slice(0, 300).map((s) => {
                const v = s.variantId ? variants.find((x) => x.id === s.variantId) : null;
                return (
                  <li key={s.id} className="rounded-xl bg-surface-2 px-3 py-2 text-sm" data-serial={s.serial}>
                    <div className="flex flex-wrap items-center gap-2">
                      <strong dir="ltr" className="font-mono">{s.serial}</strong>
                      {v && <span className="text-xs text-muted">{variantLabel(v)}</span>}
                      <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-bold', s.status === 'in_stock' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : s.status === 'in_transit' ? 'bg-sky-500/15 text-sky-800 dark:text-sky-200' : 'bg-line text-ink-2')}>{SERIAL_STATUS_HE[s.status]}</span>
                      {loc.ready && multiLocation(loc) && <span className="text-xs text-muted">{locationName(loc, s.locationId)}</span>}
                      <span className="flex-1" />
                      <button type="button" className="text-xs font-semibold text-primary" onClick={() => void history(s)} aria-expanded={open?.id === s.id}>היסטוריה</button>
                      {owner === true && s.status === 'in_stock' && (
                        <button type="button" className="text-xs font-semibold text-(--danger)" onClick={() => setWriteOff({ id: s.id, reason: '' })}>הוצאה מהמלאי</button>
                      )}
                    </div>
                    {writeOff?.id === s.id && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Input autoFocus value={writeOff.reason} maxLength={SERIAL_LIMITS.reason} onChange={(e) => setWriteOff({ ...writeOff, reason: e.target.value })}
                          placeholder="למה? (נשבר, אבד, דוגמה…)" className="max-w-xs py-1.5" aria-label={`סיבה להוצאת ${s.serial}`} />
                        <Button size="sm" variant="primary" disabled={busy} onClick={() => void remove()}>הוצאה</Button>
                        <Button size="sm" variant="ghost" onClick={() => setWriteOff(null)}>ביטול</Button>
                      </div>
                    )}
                    {open?.id === s.id && (
                      open.events === null ? <div className="py-2"><Spinner /></div> : (
                        <ol className="mt-2 grid gap-1 border-s-2 border-line ps-3 text-xs" aria-label={`ההיסטוריה של ${s.serial}`}>
                          {[...open.events].reverse().map((e) => (
                            <li key={e.id}><span className="text-muted">{formatIL(e.at)}</span> · {historyLine(e, loc.ready && multiLocation(loc) ? locationName(loc, e.locationId) : '')}</li>
                          ))}
                        </ol>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {shown.length > 300 && <p className="text-xs text-muted">מוצגים 300 — מחפשים מספר כדי לצמצם.</p>}
        </div>
      </>}
    </div>
  );
}
