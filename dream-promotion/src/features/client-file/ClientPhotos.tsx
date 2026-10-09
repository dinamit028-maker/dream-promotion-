'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Chip, Input, Select } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { cx } from '@/lib/utils';
import { formatIL } from '@/lib/il-time';
import { authHeaders } from '@/lib/services/http';
import { supabase } from '@/lib/supabase/client';
import {
  CLIENT_BUCKET, CLIENT_FILE_CHANGED, MAX_AUTO_RETRIES, MAX_PHOTO_BYTES, PHOTO_LINK_SECONDS, STAGES, comparePair, galleryGroups, retryDelay, stageLabel,
  type PhotoRow, type QueueState, type Stage, type TreatmentRow,
} from './photos';

/**
 * Photos in the client card (docs/CLIENT FILE ENGINEERING HE.md §4): "📷 צלם" → before / after / process → a treatment
 * (or a new one) → an upload queue that keeps trying on a weak network; a gallery by treatment and date, and a
 * before/after comparison with a drag bar. Shown only to the owner and the practitioners the owner marked (the server
 * answers no_access to anyone else, and not_ready before the migration is in the database — then nothing is shown).
 * Every picture on screen comes from a 5-minute signed link that the server gives only after writing the view in the log.
 */
type Api<T> = { ok: true; data: T } | { ok: false; status: number; code: string; error: string };
async function api<T>(body: Record<string, unknown>): Promise<Api<T>> {
  try {
    const r = await fetch('/api/client-file/photos', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, status: r.status, code: j?.code ?? 'error', error: j?.message ?? 'משהו השתבש — נסו שוב.' };
    return { ok: true, data: j as T };
  } catch {
    return { ok: false, status: 0, code: 'offline', error: 'אין חיבור כרגע.' };
  }
}
/** refusals that another try will not fix */
const FINAL = new Set(['not_image', 'too_big', 'broken', 'quota', 'no_access', 'not_found', 'bad_request', 'view_only', 'business_locked']);

interface QueueItem {
  id: string; file: File; preview: string; stage: Stage; treatmentId: string | null; takenAt: string;
  state: QueueState; attempt: number; error: string; nextAt: number;
}

/** a HEIC (or anything the server does not read) becomes a JPEG in the phone first; JPEG / PNG / WebP go as they are */
async function sendable(file: File): Promise<Blob> {
  if (['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file;
  const b = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  try {
    const s = Math.min(1, 4096 / Math.max(b.width, b.height));
    const c = document.createElement('canvas');
    c.width = Math.round(b.width * s); c.height = Math.round(b.height * s);
    c.getContext('2d')!.drawImage(b, 0, 0, c.width, c.height);
    const out = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
    if (!out) throw new Error('encode');
    return out;
  } finally { b.close(); }
}

export function ClientPhotos({ leadId }: { leadId: string }) {
  const [shown, setShown] = useState<'loading' | 'hidden' | 'ready'>('loading');
  const [treatments, setTreatments] = useState<TreatmentRow[]>([]);
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [linksAt, setLinksAt] = useState(0);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [pick, setPick] = useState<{ files: File[]; stage: Stage | null; treatment: string; newTitle: string } | null>(null);
  const [view, setView] = useState<PhotoRow | null>(null);
  const [compare, setCompare] = useState<{ before: string; after: string } | null>(null);
  const [split, setSplit] = useState(50);
  const [loadError, setLoadError] = useState('');
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    const r = await api<{ treatments: TreatmentRow[]; photos: PhotoRow[] }>({ action: 'list', leadId });
    if (!r.ok) {
      if (['no_access', 'not_ready', 'no_session', 'no_business', 'business_locked'].includes(r.code)) setShown('hidden');
      else { setShown('ready'); setLoadError(r.error); }
      return;
    }
    setTreatments(r.data.treatments); setPhotos(r.data.photos); setLoadError(''); setShown('ready');
  }, [leadId]);
  useEffect(() => { setShown('loading'); setUrls({}); setQueue([]); setPick(null); load(); }, [load]);
  // the whole file was deleted from the card: the gallery empties
  useEffect(() => {
    const again = (e: Event) => { if ((e as CustomEvent<string>).detail === leadId) { setUrls({}); load(); } };
    window.addEventListener(CLIENT_FILE_CHANGED, again);
    return () => window.removeEventListener(CLIENT_FILE_CHANGED, again);
  }, [leadId, load]);

  /** signed links for these photos — each one written in the view log by the server */
  const open = useCallback(async (ids: string[]) => {
    const out: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += 40) {
      const r = await api<{ urls: Record<string, string> }>({ action: 'open', photoIds: ids.slice(i, i + 40) });
      if (r.ok) Object.assign(out, r.data.urls);
    }
    setUrls((u) => ({ ...u, ...out })); setLinksAt(Date.now());
  }, []);
  // the gallery's links: for photos that have none yet (not refreshed by a timer — every link is a line in the log;
  // a picture opened large or compared gets a fresh one when the gallery's is about to run out)
  useEffect(() => {
    const missing = photos.filter((p) => !urls[p.id]).map((p) => p.id);
    if (missing.length) open(missing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos]);
  const fresh = () => Date.now() - linksAt < (PHOTO_LINK_SECONDS - 60) * 1000;

  // ---- the upload queue ------------------------------------------------------------------------------------------------
  const patch = (id: string, p: Partial<QueueItem>) => setQueue((q) => q.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const sendOne = useCallback(async (item: QueueItem) => {
    patch(item.id, { state: 'uploading', error: '' });
    const fail = (code: string, error: string) => {
      const attempt = item.attempt + 1;
      const final = FINAL.has(code) || attempt > MAX_AUTO_RETRIES;
      patch(item.id, { state: 'failed', attempt, error, nextAt: final ? Infinity : Date.now() + retryDelay(attempt) });
    };
    let blob: Blob;
    try { blob = await sendable(item.file); } catch { return fail('not_image', 'לא הצלחנו לקרוא את התמונה. נסו לצלם שוב.'); }
    if (blob.size > MAX_PHOTO_BYTES) return fail('too_big', 'התמונה גדולה מ-15MB.');
    const signed = await api<{ path: string; token: string }>({ action: 'sign', leadId, uploadId: item.id });
    if (!signed.ok) return fail(signed.code, signed.error);
    const up = await supabase().storage.from(CLIENT_BUCKET).uploadToSignedUrl(signed.data.path, signed.data.token, blob, { contentType: blob.type || 'image/jpeg', upsert: true });
    if (up.error) return fail('offline', 'ההעלאה נקטעה.');
    const done = await api<{ photo: PhotoRow }>({ action: 'commit', leadId, uploadId: item.id, stage: item.stage, treatmentId: item.treatmentId, takenAt: item.takenAt });
    if (!done.ok) return fail(done.code, done.error);
    setPhotos((ps) => (ps.some((p) => p.id === done.data.photo.id) ? ps : [...ps, done.data.photo]));
    URL.revokeObjectURL(item.preview);
    setQueue((q) => q.filter((x) => x.id !== item.id));
  }, [leadId]);

  // one upload at a time; failed ones again when their time comes or the network is back
  useEffect(() => {
    const next = queue.find((x) => x.state === 'waiting') ?? queue.find((x) => x.state === 'failed' && x.nextAt <= Date.now());
    if (next && !busy.current) {
      busy.current = true;
      sendOne(next).finally(() => { busy.current = false; setQueue((q) => [...q]); });
    }
    const due = queue.filter((x) => x.state === 'failed' && Number.isFinite(x.nextAt)).map((x) => x.nextAt);
    const t = due.length ? window.setTimeout(() => setQueue((q) => [...q]), Math.max(500, Math.min(...due) - Date.now())) : 0;
    return () => window.clearTimeout(t);
  }, [queue, sendOne]);
  useEffect(() => {
    const again = () => setQueue((q) => q.map((x) => (x.state === 'failed' && Number.isFinite(x.nextAt) ? { ...x, nextAt: 0 } : x)));
    window.addEventListener('online', again);
    return () => window.removeEventListener('online', again);
  }, []);
  // closing the card with photos not yet uploaded: ask first
  useEffect(() => {
    if (!queue.length) return;
    const stay = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', stay);
    return () => window.removeEventListener('beforeunload', stay);
  }, [queue.length]);

  function chosen(list: FileList | null) {
    const files = [...(list ?? [])].filter((f) => f.size > 0);
    if (!files.length) return;
    const active = treatments.find((t) => t.status === 'active');
    setPick({ files, stage: null, treatment: active?.id ?? '', newTitle: '' });
  }
  async function enqueue() {
    if (!pick?.stage) return;
    let treatmentId: string | null = pick.treatment && pick.treatment !== 'new' ? pick.treatment : null;
    if (pick.treatment === 'new') {
      const r = await api<{ treatment: TreatmentRow }>({ action: 'treatment', leadId, title: pick.newTitle });
      if (!r.ok) { setLoadError(r.error); return; }
      setTreatments((ts) => [r.data.treatment, ...ts]);
      treatmentId = r.data.treatment.id;
    }
    const items: QueueItem[] = pick.files.map((file) => ({
      id: crypto.randomUUID(), file, preview: URL.createObjectURL(file), stage: pick.stage!, treatmentId,
      takenAt: new Date(file.lastModified || Date.now()).toISOString(), state: 'waiting', attempt: 0, error: '', nextAt: 0,
    }));
    setQueue((q) => [...q, ...items]);
    setPick(null);
  }
  function giveUp(item: QueueItem) {
    URL.revokeObjectURL(item.preview);
    setQueue((q) => q.filter((x) => x.id !== item.id));
    api({ action: 'discard', leadId, uploadId: item.id });
  }
  async function restage(p: PhotoRow, stage: Stage) {
    const r = await api<{ photo: PhotoRow }>({ action: 'update', photoId: p.id, stage });
    if (r.ok) { setPhotos((ps) => ps.map((x) => (x.id === p.id ? r.data.photo : x))); setView(r.data.photo); }
  }
  /** a picture opened large: a fresh link (and a fresh line in the log) when the gallery's is about to run out */
  async function openLarge(p: PhotoRow) {
    setView(p);
    if (!fresh()) await open([p.id]);
  }

  const groups = useMemo(() => galleryGroups(photos, treatments), [photos, treatments]);
  if (shown !== 'ready') return null;

  return (
    <div className="mb-4 rounded-2xl border border-line p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">📷 צילומים</p>
        <div className="flex gap-2">
          <Button size="sm" variant="primary" onClick={() => camera.current?.click()}>📷 צלם</Button>
          <Button size="sm" variant="ghost" onClick={() => gallery.current?.click()}>מהגלריה</Button>
        </div>
        <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" aria-hidden tabIndex={-1}
          onChange={(e) => { chosen(e.target.files); e.target.value = ''; }} />
        <input ref={gallery} type="file" accept="image/*" multiple className="hidden" aria-hidden tabIndex={-1}
          onChange={(e) => { chosen(e.target.files); e.target.value = ''; }} />
      </div>

      {pick && (
        <div className="mb-3 rounded-xl bg-surface-2 p-3">
          <p className="mb-1.5 text-sm font-semibold">{pick.files.length === 1 ? 'מה בתמונה?' : `מה ב-${pick.files.length} התמונות?`}</p>
          <div className="mb-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="שלב">
            {STAGES.map((s) => <Chip key={s.id} on={pick.stage === s.id} role="radio" aria-checked={pick.stage === s.id} onClick={() => setPick({ ...pick, stage: s.id })}>{s.label}</Chip>)}
          </div>
          <Select value={pick.treatment} onChange={(e) => setPick({ ...pick, treatment: e.target.value })} aria-label="טיפול" className="mb-2">
            <option value="">בלי שיוך לטיפול</option>
            {treatments.map((t) => <option key={t.id} value={t.id}>{t.title || 'טיפול'}{t.area ? ` · ${t.area}` : ''} · {t.started_at}</option>)}
            <option value="new">+ טיפול חדש…</option>
          </Select>
          {pick.treatment === 'new' && (
            <Input value={pick.newTitle} onChange={(e) => setPick({ ...pick, newTitle: e.target.value })} placeholder="שם הטיפול, למשל: לייזר רגליים" aria-label="שם הטיפול" className="mb-2" />
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={enqueue} disabled={!pick.stage || (pick.treatment === 'new' && !pick.newTitle.trim())}>שמירה בתיק</Button>
            <Button size="sm" variant="ghost" onClick={() => setPick(null)}>ביטול</Button>
          </div>
          {!pick.stage && <p className="mt-1.5 text-xs text-muted">בחרו לפני, אחרי או תהליך.</p>}
        </div>
      )}

      {queue.length > 0 && (
        <ul className="mb-3 grid gap-2">
          {queue.map((q) => (
            <li key={q.id} className="flex items-center gap-2 rounded-xl bg-surface-2 p-2 text-sm">
              <img src={q.preview} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{stageLabel(q.stage)} · לא הועלה עדיין</span>
                <span className="block text-xs text-muted">
                  {q.state === 'uploading' ? <><Spinner />מעלה…</> : q.state === 'waiting' ? 'ממתין בתור'
                    : Number.isFinite(q.nextAt) ? `${q.error} ננסה שוב בעוד רגע.` : q.error}
                </span>
              </span>
              {q.state === 'failed' && <Button size="sm" variant="ghost" onClick={() => patch(q.id, { state: 'waiting', attempt: 0, nextAt: 0 })}>נסו שוב</Button>}
              {q.state !== 'uploading' && <button type="button" className="text-xs text-muted hover:text-(--danger)" onClick={() => giveUp(q)} aria-label="ביטול ההעלאה">✕</button>}
            </li>
          ))}
        </ul>
      )}

      {loadError && <p className="mb-2 text-sm text-warn">{loadError}</p>}
      {!groups.length && !queue.length && <p className="text-xs text-muted">עוד אין צילומים בתיק. הצילומים נשמרים בתיק בלבד — לא לשיתוף ולא לפרסום.</p>}

      {groups.map((g) => {
        const pair = comparePair(g.photos);
        return (
          <div key={g.treatment?.id ?? 'none'} id={g.treatment ? `cf-treatment-${g.treatment.id}` : undefined} className="mb-3 scroll-mt-4">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-ink-2">
                {g.treatment ? `${g.treatment.title || 'טיפול'}${g.treatment.area ? ` · ${g.treatment.area}` : ''} · מ-${g.treatment.started_at}` : 'בלי שיוך לטיפול'}
              </p>
              {pair && <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => { setSplit(50); setCompare({ before: pair.before.id, after: pair.after.id }); if (!fresh()) open(g.photos.map((p) => p.id)); }}>השוואה לפני/אחרי</button>}
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {g.photos.map((p) => (
                <button key={p.id} type="button" onClick={() => openLarge(p)} className="relative h-24 w-24 shrink-0 overflow-hidden rounded-xl border border-line bg-surface-2 hover:border-primary">
                  {urls[p.id] ? <img src={urls[p.id]} alt={`${stageLabel(p.stage)} · ${formatIL(p.taken_at, { dateStyle: 'short' })}`} loading="lazy" className="h-full w-full object-cover" />
                    : <span className="flex h-full items-center justify-center"><Spinner /></span>}
                  <span className="absolute bottom-1 start-1 rounded-full bg-black/60 px-1.5 text-[10px] font-semibold text-white">{stageLabel(p.stage)}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}

      <Modal open={Boolean(view)} onClose={() => setView(null)} wide>
        {view && (
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">{stageLabel(view.stage)} · {formatIL(view.taken_at)}</p>
              <CloseButton onClick={() => setView(null)} />
            </div>
            {urls[view.id] ? <img src={urls[view.id]} alt={stageLabel(view.stage)} className="mx-auto max-h-[70vh] rounded-xl object-contain" /> : <Spinner />}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {STAGES.map((s) => <Chip key={s.id} on={view.stage === s.id} onClick={() => restage(view, s.id)}>{s.label}</Chip>)}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={Boolean(compare)} onClose={() => setCompare(null)} wide>
        {compare && (() => {
          const g = groups.find((x) => x.photos.some((p) => p.id === compare.before));
          const list = g?.photos ?? photos;
          return (
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">השוואה לפני/אחרי</p>
                <CloseButton onClick={() => setCompare(null)} />
              </div>
              <div className="mb-2 grid grid-cols-2 gap-2">
                <Select value={compare.before} onChange={(e) => setCompare({ ...compare, before: e.target.value })} aria-label="תמונת לפני">
                  {list.map((p) => <option key={p.id} value={p.id}>{stageLabel(p.stage)} · {formatIL(p.taken_at, { dateStyle: 'short' })}</option>)}
                </Select>
                <Select value={compare.after} onChange={(e) => setCompare({ ...compare, after: e.target.value })} aria-label="תמונת אחרי">
                  {list.map((p) => <option key={p.id} value={p.id}>{stageLabel(p.stage)} · {formatIL(p.taken_at, { dateStyle: 'short' })}</option>)}
                </Select>
              </div>
              <div className="relative mx-auto aspect-[3/4] max-h-[65vh] w-full overflow-hidden rounded-xl bg-surface-2" dir="ltr">
                {urls[compare.before] && <img src={urls[compare.before]} alt="לפני" className="absolute inset-0 h-full w-full object-contain" />}
                {urls[compare.after] && (
                  <img src={urls[compare.after]} alt="אחרי" className="absolute inset-0 h-full w-full object-contain"
                    style={{ clipPath: `inset(0 0 0 ${split}%)` }} />
                )}
                <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${split}%` }} aria-hidden />
                <span className="absolute top-2 left-2 rounded-full bg-black/60 px-2 text-xs font-semibold text-white">לפני</span>
                <span className="absolute top-2 right-2 rounded-full bg-black/60 px-2 text-xs font-semibold text-white">אחרי</span>
              </div>
              <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} className="mt-2 w-full" dir="ltr" aria-label="פס השוואה" />
            </div>
          );
        })()}
      </Modal>
      <p className={cx('mt-1 text-[11px] text-muted')}>כל פתיחה של צילום נרשמת ביומן הצפייה של העסק.</p>
    </div>
  );
}
