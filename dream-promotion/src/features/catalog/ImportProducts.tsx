'use client';
import { useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { Button } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { itemColumns, type CatalogItem, type CatalogVariant } from './catalog';
import { insertItem, quoteReady } from './data';
import { IMPORT_COLUMNS, fileName, parseCsv, planImport, type ImportPlan } from './import';
import { uploadPicture } from './upload';

/**
 * "ייבוא מוצרים מקובץ" (2.102): products.csv (Excel → "CSV UTF-8"), alone or in a ZIP with the pictures. The file is read here,
 * in the browser; what will be added is shown first, and nothing is written before "ייבוא". Only adds — a product whose SKU is
 * already in the catalog is left as it is. Each product goes in as ProductEditor saves one (the same rules and columns), and its
 * picture through the same upload as the editor's (/api/store/media) — one at a time, at a pace the server allows.
 */
type Picked = { name: string; plan: ImportPlan; pictures: Map<string, () => Promise<Blob>>; quoteOk: boolean };
type Run = { done: number; total: number; current: string; added: number; failed: { name: string; message: string }[]; stopped?: boolean; finished?: boolean };

const MIME: Record<string, string> = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
const PICTURE_PACE_MS = 1300;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ImportProducts({ open, onClose, items, variants, nextSort, onDone }: {
  open: boolean; onClose: () => void; items: CatalogItem[]; variants: CatalogVariant[]; nextSort: number; onDone: () => void;
}) {
  const userId = useApp((s) => s.userId);
  const input = useRef<HTMLInputElement>(null);
  const stop = useRef(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);

  const reset = () => { setPicked(null); setError(null); setRun(null); stop.current = false; if (input.current) input.current.value = ''; };
  const close = () => { if (run && !run.finished) return; if (run?.added) onDone(); reset(); onClose(); };

  async function read(file: File) {
    setBusy(true); setError(null); setPicked(null);
    try {
      let csv = '';
      const pictures = new Map<string, () => Promise<Blob>>();
      if (/\.zip$/i.test(file.name)) {
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(file);
        const entries = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name));
        const table = entries.find((f) => fileName(f.name) === 'products.csv') ?? entries.find((f) => /\.csv$/i.test(f.name));
        if (!table) { setError('בקובץ ה-ZIP אין products.csv.'); return; }
        csv = await table.async('string');
        for (const f of entries) if (/\.(webp|jpe?g|png)$/i.test(f.name)) pictures.set(fileName(f.name), () => f.async('blob'));
      } else if (/\.csv$/i.test(file.name)) {
        csv = await file.text();
      } else { setError('צריך קובץ CSV, או ZIP עם products.csv ותמונות.'); return; }
      const plan = planImport(parseCsv(csv), {
        takenSkus: [...items.map((i) => i.sku), ...variants.map((v) => v.sku)],
        takenSlugs: items.map((i) => i.slug).filter((s): s is string => Boolean(s)),
        images: pictures.size ? pictures.keys() : undefined,
      });
      setPicked({ name: file.name, plan, pictures, quoteOk: await quoteReady() });
    } catch {
      setError('לא הצלחנו לקרוא את הקובץ. ודאו שהוא ZIP או CSV תקין (שמירה מ-Excel: "CSV UTF-8").');
    } finally { setBusy(false); }
  }

  async function start() {
    if (!picked || !userId) return;
    const rows = picked.plan.add;
    stop.current = false;
    const state: Run = { done: 0, total: rows.length, current: '', added: 0, failed: [] };
    setRun({ ...state });
    let sort = nextSort;
    let lastPicture = 0;
    for (const row of rows) {
      if (stop.current) { state.stopped = true; break; }
      state.current = row.draft.name; setRun({ ...state });
      const r = await insertItem(userId, itemColumns(row.draft, [], { quote: picked.quoteOk }), sort++);
      if (!r.ok) { state.failed.push({ name: row.draft.name, message: r.error }); state.done++; setRun({ ...state }); continue; }
      state.added++;
      const get = row.image ? picked.pictures.get(row.image) : null;
      if (get) {
        const ext = row.image.split('.').pop()!.toLowerCase();
        const file = new File([await get()], row.image, { type: MIME[ext] ?? 'image/webp' });
        // one picture takes two calls of the server; it allows 120 a minute — never faster than that
        const since = Date.now() - lastPicture;
        if (since < PICTURE_PACE_MS) await wait(PICTURE_PACE_MS - since);
        let up = await uploadPicture(file, r.data.id, { alt: row.draft.name });
        if (!up.ok) { await wait(15_000); up = await uploadPicture(file, r.data.id, { alt: row.draft.name }); }
        lastPicture = Date.now();
        if (!up.ok) state.failed.push({ name: row.draft.name, message: `נוסף בלי תמונה: ${up.error}` });
      }
      state.done++; setRun({ ...state });
    }
    state.finished = true; state.current = '';
    setRun({ ...state });
  }

  const p = picked?.plan;
  const needsQuote = Boolean(p?.add.some((r) => r.draft.quoteMode)) && picked?.quoteOk === false;
  return (
    <Modal open={open} onClose={close} wide>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-extrabold">ייבוא מוצרים מקובץ</h2>
          <p className="text-sm text-ink-2">רק מוסיף מוצרים חדשים. מוצר שהמק״ט שלו כבר קיים — נשאר כמו שהוא.</p>
        </div>
        <CloseButton onClick={close} />
      </div>

      {!run && (
        <>
          <details className="mb-3 rounded-xl bg-surface-2 p-3 text-sm">
            <summary className="cursor-pointer font-semibold">איך מכינים את הקובץ</summary>
            <p className="mt-2">טבלה בשם <bdi dir="ltr">products.csv</bdi> (ב-Excel: שמירה בשם ← &quot;CSV UTF-8&quot;), ובשורה הראשונה שמות העמודות. אפשר לשים אותה ב-ZIP יחד עם התמונות.</p>
            <ul className="mt-2 list-disc ps-5 text-xs text-ink-2">
              {Object.entries(IMPORT_COLUMNS).map(([k, names]) => <li key={k}><bdi dir="ltr">{k}</bdi> — {names.slice(1).join(' / ') || names[0]}</li>)}
            </ul>
            <p className="mt-2 text-xs text-muted">חובה: שם. כדאי: מק״ט — כך ייבוא חוזר לא מכפיל. תמונה: שם הקובץ שבתוך ה-ZIP.</p>
          </details>
          <label className="mb-3 flex min-h-11 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-line p-4 text-sm font-semibold">
            {busy ? <><Spinner /> קורא את הקובץ…</> : picked ? `קובץ: ${picked.name} — אפשר לבחור אחר` : 'בחירת קובץ (ZIP או CSV)'}
            <input ref={input} type="file" accept=".zip,.csv,application/zip,text/csv" className="sr-only" disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); }} />
          </label>
          {error && <p role="alert" className="mb-3 rounded-xl bg-red-500/10 p-3 text-sm font-semibold text-red-700 dark:text-red-300">{error}</p>}
        </>
      )}

      {p && !run && (
        <div className="grid gap-3">
          <p className="text-sm">
            <strong>{p.add.length === 1 ? 'מוצר אחד ייכנס' : `${p.add.length} מוצרים ייכנסו`}</strong>
            {p.add.filter((r) => r.image).length ? ` · ${p.add.filter((r) => r.image).length} עם תמונה` : ''}
            {p.skip.length === 1 ? ' · מוצר אחד כבר קיים (לא משתנה)' : p.skip.length ? ` · ${p.skip.length} כבר קיימים (לא משתנים)` : ''}
            {p.errors.length === 1 ? ' · שורה אחת עם בעיה (לא תיכנס)' : p.errors.length ? ` · ${p.errors.length} שורות עם בעיה (לא ייכנסו)` : ''}
          </p>
          {p.add.length > 0 && (
            <ul className="max-h-60 overflow-auto rounded-xl border border-line text-sm">
              {p.add.slice(0, 60).map((r) => (
                <li key={r.line} className="flex justify-between gap-2 border-b border-line px-3 py-1.5 last:border-0">
                  <span className="min-w-0 truncate">{r.draft.name}</span>
                  <span className="shrink-0 text-xs text-muted" dir="ltr">{r.draft.sku}{r.draft.quoteMode ? ` · ${r.draft.quoteFrom || '—'} ${r.draft.quoteCurrency || '₪'}` : ''}{r.image ? ' · 🖼' : ''}</span>
                </li>
              ))}
            </ul>
          )}
          {p.errors.length > 0 && (
            <details className="rounded-xl bg-red-500/10 p-3 text-sm" open>
              <summary className="cursor-pointer font-semibold text-red-700 dark:text-red-300">שורות שלא ייכנסו</summary>
              <ul className="mt-1 list-disc ps-5">{p.errors.slice(0, 30).map((e, i) => <li key={i}>שורה {e.line}: {e.message}</li>)}</ul>
            </details>
          )}
          {p.skip.length > 0 && (
            <details className="rounded-xl bg-surface-2 p-3 text-sm">
              <summary className="cursor-pointer font-semibold">כבר בקטלוג — לא משתנים ({p.skip.length})</summary>
              <ul className="mt-1 list-disc ps-5">{p.skip.slice(0, 60).map((s) => <li key={s.line}>{s.name || s.sku} <bdi dir="ltr">({s.sku})</bdi></li>)}</ul>
            </details>
          )}
          {p.missingImages.length > 0 && <p className="text-sm text-warn">תמונות שלא נמצאו ב-ZIP (המוצר ייכנס בלי תמונה): {p.missingImages.slice(0, 10).join(', ')}</p>}
          {needsQuote && <p role="alert" className="rounded-xl bg-amber-500/15 p-3 text-sm font-semibold">יש בקובץ מוצרים בהצעת מחיר: צריך קודם להריץ את מיגרציה 20261017005400 ב-Supabase.</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={!p.add.length || needsQuote || !userId} onClick={() => void start()}>{p.add.length === 1 ? 'ייבוא מוצר אחד' : `ייבוא ${p.add.length} מוצרים`}</Button>
            <Button variant="ghost" onClick={close}>ביטול</Button>
          </div>
        </div>
      )}

      {run && (
        <div className="grid gap-3" aria-live="polite">
          <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.done} aria-label="התקדמות הייבוא">
            <div className="h-full bg-primary transition-[width]" style={{ width: `${run.total ? Math.round((run.done / run.total) * 100) : 100}%` }} />
          </div>
          <p className="text-sm">
            {run.finished ? (run.stopped ? 'הייבוא נעצר.' : 'הייבוא הסתיים.') : <><Spinner /> {run.done + 1} מתוך {run.total}: {run.current}</>}
            {' '}{run.added === 1 ? 'נוסף מוצר אחד.' : run.added ? `נוספו ${run.added} מוצרים.` : 'לא נוסף אף מוצר.'}
          </p>
          {run.failed.length > 0 && (
            <ul className="list-disc rounded-xl bg-amber-500/10 p-3 ps-8 text-sm">{run.failed.map((f, i) => <li key={i}>{f.name}: {f.message}</li>)}</ul>
          )}
          <div className="flex gap-2">
            {!run.finished
              ? <Button variant="ghost" onClick={() => { stop.current = true; }}>עצירה אחרי המוצר הזה</Button>
              : <Button variant="primary" onClick={close}>חזרה למוצרים</Button>}
          </div>
        </div>
      )}
    </Modal>
  );
}
