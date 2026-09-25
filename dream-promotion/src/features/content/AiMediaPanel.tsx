'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { AIService } from '@/lib/services';
import { ImageService, PRICE_PER_IMAGE } from '@/lib/services/image.service';
import { VideoService, PRICE_PER_SECOND } from '@/lib/services/video.service';
import { archiveAsset } from '@/lib/services/archive.service';
import { Button, Chip } from '@/components/ui/primitives';
import { Spinner } from '@/components/ui/feedback';
import { aiErrorMessage, videoErrorMessage } from '@/lib/errors';
import { cx } from '@/lib/utils';
import type { ContentKind } from '@/types';

const RES = '720p' as const;

/**
 * AI image or short video for a single piece of content — straight from the editor,
 * so every item in the weekly plan can get its visual without leaving the calendar.
 * Everything generated is paid for, so all of it is kept in the media library.
 */
export function AiMediaPanel({
  kind, headline, visualDirection, mediaId, onAttach,
}: {
  kind: ContentKind; headline: string; visualDirection?: string; mediaId: string | null;
  onAttach: (id: string) => void;
}) {
  const router = useRouter();
  const { brand, media, addMedia } = useApp();
  const [busy, setBusy] = useState<null | 'image' | 'video'>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<string[]>([]);
  const [seconds, setSeconds] = useState(5);
  const abort = useRef<AbortController | null>(null);

  const vertical = kind === 'reel' || kind === 'story';
  const attached = mediaId ? media.find((m) => m.id === mediaId) : undefined;
  const subject = visualDirection || headline;

  async function keep(url: string, type: 'image' | 'video', name: string) {
    const saved = await archiveAsset(url, type, name);
    const id = saved.id ?? crypto.randomUUID();
    addMedia({ id, url: saved.url, name, kind: type, persistent: Boolean(saved.id) });
    return id;
  }

  async function makeImage() {
    setBusy('image'); setError(null); setStatus('מצייר…');
    try {
      const urls = await ImageService.generate({
        prompt: `${subject}. No text, no letters, no words, no captions, no logos anywhere in the image.`,
        aspectRatio: vertical ? '9:16' : '4:5', count: 2,
      });
      const ids = await Promise.all(urls.map((u, n) => keep(u, 'image', `${headline || 'תמונה'} ${n + 1}`)));
      setOptions((o) => [...ids, ...o]);
      if (ids[0]) onAttach(ids[0]);
    } catch (e: any) {
      setError(e?.code === 'insufficient_balance' ? 'אין יתרה בחשבון fal.' : aiErrorMessage(e?.code) );
    } finally { setBusy(null); setStatus(''); }
  }

  async function makeVideo() {
    setBusy('video'); setError(null); setStatus('כותב כיוון לסרטון…');
    abort.current = new AbortController();
    try {
      // the video model wants an English camera/motion prompt, never on-screen text
      const idea = await AIService.sceneIdea(brand, 'hook', headline, subject);
      const url = await VideoService.generate({
        prompt: idea.videoPrompt, duration: seconds, resolution: RES,
        aspectRatio: vertical ? '9:16' : '1:1',
        // with an image attached, the clip brings that image to life
        startImage: attached?.kind === 'image' ? attached.url : undefined,
      }, (u) => setStatus(
        u.status === 'queued' ? `בתור${u.position ? ` (מקום ${u.position})` : ''}… זה לוקח כמה דקות`
          : u.status === 'running' ? 'מרנדר את הסרטון… זה לוקח כמה דקות' : '',
      ), abort.current.signal);
      const id = await keep(url, 'video', `${headline || 'סרטון'} · ${seconds} שנ׳`);
      onAttach(id);
    } catch (e: any) {
      const m = videoErrorMessage(e?.message, e?.code);
      if (e?.code !== 'aborted') setError(`${m.title}. ${m.body}`);
    } finally { setBusy(null); setStatus(''); abort.current = null; }
  }

  return (
    <div className="mt-3 rounded-2xl border border-line p-3">
      <p className="mb-2 text-sm font-semibold text-ink-2">יצירה ב-AI</p>
      <Button variant="ghost" size="sm" className="w-full" onClick={makeImage} disabled={!!busy}>
        {busy === 'image' ? <><Spinner />{status}</> : <>תמונה · ${(PRICE_PER_IMAGE * 2).toFixed(2)}</>}
      </Button>

      <div className="mt-3 flex items-center gap-2">
        {[5, 10].map((s) => <Chip key={s} on={seconds === s} onClick={() => setSeconds(s)} disabled={!!busy}>{s} שנ׳</Chip>)}
      </div>
      <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={makeVideo} disabled={!!busy}>
        {busy === 'video' ? <><Spinner />מייצר סרטון…</> : <>סרטון · ${(PRICE_PER_SECOND[RES] * seconds).toFixed(2)}</>}
      </Button>
      {busy === 'video' && (
        <>
          <p className="mt-2 text-xs text-muted">{status}</p>
          <button type="button" className="mt-1 text-xs text-muted underline" onClick={() => abort.current?.abort()}>ביטול</button>
        </>
      )}
      {!busy && attached?.kind === 'image' && <p className="mt-2 text-xs text-muted">הסרטון יתחיל מהתמונה שכבר בפוסט.</p>}

      {options.length > 1 && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {options.map((id) => {
            const m = media.find((x) => x.id === id);
            if (!m) return null;
            return (
              <button key={id} type="button" onClick={() => onAttach(id)}
                className={cx('overflow-hidden rounded-xl ring-2', id === mediaId ? 'ring-primary' : 'ring-transparent hover:ring-line')}>
                <img src={m.url} alt="" className="aspect-[4/5] w-full object-cover" />
              </button>
            );
          })}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-[var(--danger)]">{error}</p>}
      {kind === 'reel' && (
        <button type="button" className="mt-3 text-xs font-semibold text-primary hover:underline"
          onClick={() => router.push(`/reels?brief=${encodeURIComponent(headline)}`)}>
          ריל מלא עם תסריט וקריינות ← אולפן הרילס
        </button>
      )}
    </div>
  );
}
