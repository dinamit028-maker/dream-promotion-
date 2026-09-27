'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { MediaService } from '@/lib/services';
import { Button, Chip, PageHead } from '@/components/ui/primitives';
import { AdapterNote, CloseButton, EmptyState, Modal } from '@/components/ui/feedback';
import { Images } from '@/components/ui/Icon';
import { cx } from '@/lib/utils';
import type { MediaAsset } from '@/types';

type Filter = 'all' | 'reel' | 'clip' | 'image' | 'audio';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'הכל' },
  { id: 'reel', label: 'רילים סופיים' },
  { id: 'clip', label: 'קליפים' },
  { id: 'image', label: 'תמונות' },
  { id: 'audio', label: 'קריינות ומוזיקה' },
];

/** What a file is, at a glance — names of a project's files all start the same. */
function typeOf(m: MediaAsset): Exclude<Filter, 'all'> {
  if (m.kind === 'audio') return 'audio';
  if (m.kind === 'video') return m.name.includes('ריל סופי') ? 'reel' : 'clip';
  return 'image';
}
const TYPE_HE: Record<Exclude<Filter, 'all'>, string> = { reel: 'ריל סופי', clip: 'קליפ', image: 'תמונה', audio: 'אודיו' };

export default function MediaPage() {
  const { media, addMedia, removeMedia } = useApp();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [menu, setMenu] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [open, setOpen] = useState<MediaAsset | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files) return;
    setBusy(true); setError(null);
    for (const f of Array.from(files)) {
      try { addMedia(await MediaService.upload(f)); }
      catch (e: any) { setError(`העלאת "${f.name}" נכשלה: ${e?.message ?? 'שגיאה לא ידועה'}`); }
    }
    setBusy(false);
    if (input.current) input.current.value = '';
  }

  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, f.id === 'all' ? media.length : media.filter((m) => typeOf(m) === f.id).length]));
  const shown = filter === 'all' ? media : media.filter((m) => typeOf(m) === filter);

  /** The one thing you most likely want to do with this file. */
  function primary(m: MediaAsset) {
    const t = typeOf(m);
    if (t === 'clip') return { label: 'ריל עם קריינות', go: () => router.push(`/reels?media=${m.id}`) };
    if (t === 'reel') return { label: 'יצירת פוסט', go: () => router.push(`/create?media=${m.id}`) };
    if (t === 'image') return { label: 'יצירת תוכן', go: () => router.push(`/create?media=${m.id}`) };
    return null;
  }

  return (
    <>
      <PageHead title="ספריית המדיה" sub={`${media.length} קבצים`}
        action={<Button variant="primary" onClick={() => input.current?.click()} disabled={busy}>{busy ? 'מעלה…' : '+ העלאה'}</Button>} />
      <input ref={input} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
      {!MediaService.persistent && (
        <div className="mb-6"><AdapterNote>אחסון קבצים מתמיד לא מוגדר, לכן הקבצים חיים בדפדפן עד רענון.</AdapterNote></div>
      )}
      {error && <p className="mb-4 text-sm text-[var(--danger)]">{error}</p>}

      {media.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Chip key={f.id} on={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label} <span className="opacity-60">{counts[f.id]}</span>
            </Chip>
          ))}
        </div>
      )}

      {media.length ? (
        shown.length ? (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(170px,1fr))]">
            {shown.map((m) => {
              const t = typeOf(m);
              const act = primary(m);
              return (
                <div key={m.id} className="group relative flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
                  <button type="button" onClick={() => setOpen(m)} className="relative block w-full" aria-label={`תצוגה של ${m.name}`}>
                    {t === 'audio' ? (
                      <div className="flex aspect-[4/5] w-full items-center justify-center bg-gradient-to-b from-surface-2 to-line text-4xl text-ink-2">♪</div>
                    ) : m.kind === 'video' ? (
                      <video src={`${m.url}#t=1`} preload="metadata" muted playsInline className="aspect-[4/5] w-full bg-black object-cover" />
                    ) : (
                      <img src={m.url} alt="" className="aspect-[4/5] w-full object-cover" />
                    )}
                    {m.kind === 'video' && (
                      <span className="absolute inset-0 m-auto flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white">▶</span>
                    )}
                    <span className={cx('absolute start-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                      t === 'reel' ? 'bg-primary text-white' : 'bg-white/90 text-ink')}>{TYPE_HE[t]}</span>
                  </button>

                  <div className="flex flex-1 flex-col gap-2 p-2.5">
                    <div className="flex items-start gap-1">
                      <p className="line-clamp-2 flex-1 text-[13px] leading-snug" title={m.name}>{m.name}</p>
                      <div className="relative">
                        <button type="button" aria-label="עוד פעולות" onClick={() => { setMenu(menu === m.id ? null : m.id); setConfirm(null); }}
                          className="flex h-7 w-7 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2">⋯</button>
                        {menu === m.id && (
                          <div className="absolute end-0 top-8 z-20 w-40 overflow-hidden rounded-xl border border-line bg-surface py-1 text-sm shadow-lg">
                            <a href={m.url} target="_blank" rel="noreferrer" download className="block px-3 py-2 hover:bg-surface-2" onClick={() => setMenu(null)}>הורדה</a>
                            {m.kind === 'video' && t === 'clip' && (
                              <button type="button" className="block w-full px-3 py-2 text-start hover:bg-surface-2"
                                onClick={() => router.push(`/create?media=${m.id}`)}>יצירת פוסט</button>
                            )}
                            {confirm === m.id ? (
                              <button type="button" className="block w-full px-3 py-2 text-start font-semibold text-[var(--danger)] hover:bg-surface-2"
                                onClick={() => { removeMedia(m.id); setMenu(null); setConfirm(null); }}>בטוח? מחיקה סופית</button>
                            ) : (
                              <button type="button" className="block w-full px-3 py-2 text-start text-[var(--danger)] hover:bg-surface-2"
                                onClick={() => setConfirm(m.id)}>מחיקה</button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    {t === 'audio' && <audio src={m.url} controls preload="none" className="h-8 w-full" />}
                    {act && <Button size="sm" variant="ghost" className="mt-auto w-full" onClick={act.go}>{act.label}</Button>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="rounded-2xl bg-surface-2 p-5 text-sm text-muted">אין קבצים מהסוג הזה.</p>
        )
      ) : (
        <EmptyState icon={<Images />} title="אין מדיה עדיין" body="העלו תמונות, סרטונים או מוזיקה, או צרו אותם בסטודיו."
          action={<Button variant="primary" onClick={() => input.current?.click()}>העלאת קבצים</Button>} />
      )}

      <Modal open={!!open} onClose={() => setOpen(null)} wide>
        {open && (
          <>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="truncate font-display text-lg font-bold">{open.name}</h3>
              <CloseButton onClick={() => setOpen(null)} />
            </div>
            <div className="flex justify-center">
              {open.kind === 'video'
                ? <video src={open.url} controls autoPlay playsInline className="max-h-[65vh] rounded-xl bg-black" />
                : open.kind === 'audio'
                ? <audio src={open.url} controls autoPlay className="w-full" />
                : <img src={open.url} alt="" className="max-h-[65vh] rounded-xl" />}
            </div>
            <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
              {primary(open) && <Button variant="primary" onClick={primary(open)!.go}>{primary(open)!.label}</Button>}
              <a href={open.url} target="_blank" rel="noreferrer" download
                className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2">הורדה</a>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
