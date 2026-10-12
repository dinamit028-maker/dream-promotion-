'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import { SmallSelect } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { FX_MAIN, convert, formatMinor, fxDay, fxName, fxShort, inverseText, parseAmount, rateText, type FxDirection, type FxRate } from './fx';
import { loadFxRates } from './fx-data';
import { ddmmyyyy } from './ui';

/**
 * Foreign currencies in the money lobby (2.98): the dollar, the euro and the pound at a glance, and a converter both ways —
 * the Bank of Israel's representative rate, always with its date. Everything is figured in fx.ts; this only shows it.
 * The rates load once with the lobby; the converter opens on a tap.
 */
export function FxCard() {
  const [state, setState] = useState<{ rates: FxRate[] } | { error: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('USD');
  const [dir, setDir] = useState<FxDirection>('toIls');
  const [amount, setAmount] = useState('');
  const ids = useId();

  const load = useCallback(() => {
    let alive = true;
    setState(null);
    void loadFxRates().then((r) => { if (alive) setState(r.ok ? { rates: r.rates } : { error: r.message }); });
    return () => { alive = false; };
  }, []);
  useEffect(() => load(), [load]);

  const rates = state && 'rates' in state ? state.rates : null;
  const main = (rates ?? []).filter((r) => FX_MAIN.includes(r.code));
  const r = rates?.find((x) => x.code === code) ?? rates?.[0] ?? null;
  const typed = amount.trim();
  const value = typed ? parseAmount(typed) : null;
  const out = r && value !== null ? convert(value, r, dir) : null;
  const from = dir === 'toIls' ? (r ? fxName(r.code) : '') : 'שקלים';

  return (
    <section aria-label="מטבעות חוץ" className="rounded-2xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
        <span className="font-bold">💱 מטבעות חוץ</span>
        {!state && <span className="text-muted"><Spinner /> טוען את השערים…</span>}
        {state && 'error' in state && <span role="status" className="text-muted">{state.error}</span>}
        {main.map((m) => (
          <span key={m.code} className="tabular-nums"><span className="text-muted">{fxShort(m.code)}</span> <bdi dir="ltr">₪{rateText(m)}</bdi></span>
        ))}
        {main[0] && <span className="text-xs text-muted">שער יציג, {ddmmyyyy(fxDay(main[0]))}</span>}
        <span className="ms-auto">
          {state && 'error' in state
            ? <button type="button" onClick={load} className="min-h-11 font-semibold text-primary underline">לטעון שוב את השערים</button>
            : rates && <button type="button" aria-expanded={open} aria-controls={`${ids}-fx`} onClick={() => setOpen(!open)}
                className="min-h-11 font-semibold text-primary underline">{open ? 'סגירת הממיר' : 'ממיר מטבעות'}</button>}
        </span>
      </div>

      {open && rates && r && (
        <div id={`${ids}-fx`} className="grid gap-3 border-t border-line p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            {/* each label apart from its field: a label around a select would carry every option's name into the field's own */}
            <div className="grid min-w-0 gap-1">
              <label htmlFor={`${ids}-amount`} className="text-sm font-semibold text-ink-2">סכום ב{from}</label>
              <input id={`${ids}-amount`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr" placeholder="100"
                aria-invalid={typed !== '' && value === null}
                className="h-11 min-w-0 rounded-md border-[1.5px] border-line bg-surface px-3 text-[15px] tabular-nums outline-hidden focus:border-primary" />
            </div>
            <div className="grid min-w-0 gap-1">
              <label htmlFor={`${ids}-code`} className="text-sm font-semibold text-ink-2">מטבע</label>
              <SmallSelect id={`${ids}-code`} value={r.code} onChange={(e) => setCode(e.target.value)} className="h-11 w-full sm:w-56">
                {rates.map((x) => <option key={x.code} value={x.code}>{fxName(x.code)} ({x.code})</option>)}
              </SmallSelect>
            </div>
            <button type="button" onClick={() => setDir(dir === 'toIls' ? 'fromIls' : 'toIls')}
              className="min-h-11 rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2">⇄ החלפת כיוון</button>
          </div>
          <p className="text-sm text-muted">{dir === 'toIls' ? `מ${fxName(r.code)} לשקלים` : `משקלים ל${fxName(r.code)}`}</p>
          <output aria-live="polite" className="block text-2xl font-black tabular-nums">
            {out ? <bdi dir="ltr">{dir === 'toIls' ? `₪${formatMinor(out.minor, out.digits)}` : `${formatMinor(out.minor, out.digits)} ${r.code}`}</bdi>
              : typed ? <span className="text-base font-semibold text-warn">מספר לא תקין — ספרות ונקודה עשרונית בלבד</span>
                : <span className="text-base font-semibold text-muted">מקלידים סכום</span>}
          </output>
          <p className="text-sm tabular-nums">
            <bdi dir="ltr">{r.unit} {r.code} = ₪{rateText(r)}</bdi> · <bdi dir="ltr">₪1 = {inverseText(r)} {r.code}</bdi>
          </p>
          <p className="text-xs text-muted">
            השער היציג של בנק ישראל, מ-{ddmmyyyy(fxDay(r))}. המרה בבנק או בכרטיס אשראי היא לפי השער שלהם ועם עמלות. זה כלי עזר — המסמכים נשארים בשקלים.
          </p>
        </div>
      )}
    </section>
  );
}
