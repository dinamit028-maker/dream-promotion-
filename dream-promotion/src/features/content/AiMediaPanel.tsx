'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { useJobs } from '@/lib/jobs';
import { AIService } from '@/lib/services';
import { ImageService, PRICE_PER_IMAGE } from '@/lib/services/image.service';
import { VideoService, PRICE_PER_SECOND } from '@/lib/services/video.service';
import { archiveAsset } from '@/lib/services/archive.service';
import { Button, Chip } from '@/components/ui/primitives';
import { CloseButton, Modal, Spinner } from '@/components/ui/feedback';
import { PlatformPreview, type PreviewPlatform } from '@/features/preview/PlatformPreview';
import { aiErrorMessage, videoErrorMessage } from '@/lib/errors';
import { cx } from '@/lib/utils';
import type { ContentKind, Platform } from '@/types';

const RES = '720p' as const;

function initialTab(kind: ContentKind, platform?: Platform): PreviewPlatform {
  if (platform === 'TikTok') return 'tiktok';
  if (kind === 'story') return 'story';
  if (kind === 'reel') return 'ig-reel';
  return platform === 'Facebook' ? 'facebook' : 'ig-feed';
}

/**
 * AI image or short video for one piece of content, straight from the editor.
 * Nothing replaces the post's current media until the user has seen the result
 * in a per-platform preview and approved it. Everything paid for is kept in the library.
 */
export function AiMediaPanel({
  contentId, kind, platform, headline, caption, palette, visualDirection, mediaId, onAttach,
}: {
  contentId: string; kind: ContentKind; platform?: Platform; headline: string; caption: string;
  palette?: [string, string]; visualDirection?: string; mediaId: string | null; onAttach: (id: string) => void;
}) {
  const router = useRouter();
  const { brand, media, addMedia } = useApp();
  const jobs = useJobs((s) => s.jobs.filter((j) => j.contentId === contentId));
  const { add, update, remove } = useJobs();
  const [imaging, setImaging] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(5);
  // what is being reviewed: candidate media ids, and the job to clear once decided
  const [review, setReview] = useState<{ ids: string[]; jobId?: string } | null>(null);
  const [choice, setChoice] = useState<string | null>(null);

  const vertical = kind === 'reel' || kind === 'story';
  const attached = mediaId ? media.find((m) => m.id === mediaId) : undefined;
  const subject = visualDirection || headline;
  const running = jobs.find((j) => j.status === 'running');
  const ready = jobs.filter((j) => j.status === 'ready' && j.mediaId);
  const failed = jobs.find((j) => j.status === 'failed');

  function openReview(ids: string[], jobId?: string) { setReview({ ids, jobId }); setChoice(ids[0] ?? null); }

  async function makeImage() {
    setImaging(true); setError(null); setNote(null);
    try {
      const urls = await ImageService.generate({
        prompt: `${subject}. No text, no letters, no words, no captions, no logos anywhere in the image.`,
        aspectRatio: vertical ? '9:16' : '4:5', count: 2,
      });
      const ids: string[] = [];
      for (const [n, u] of urls.entries()) {
        const name = `${headline || 'תמונה'} ${n + 1}`;
        const saved = await archiveAsset(u, 'image', name);
        const id = saved.id ?? crypto.randomUUID();
        addMedia({ id, url: saved.url, name, kind: 'image', persistent: Boolean(saved.id) });
        ids.push(id);
      }
      openReview(ids);
    } catch (e: any) {
      setError(aiErrorMessage(e?.code));
    } finally { setImaging(false); }
  }

  async function makeVideo() {
    setStarting(true); setError(null); setNote(null);
    try {
      // the video model wants an English camera/motion prompt, never on-screen text
      const idea = await AIService.sceneIdea(brand, 'hook', headline, subject);
      const job = await VideoService.submit({
        prompt: idea.videoPrompt, duration: seconds, resolution: RES,
        aspectRatio: vertical ? '9:16' : '1:1',
        startImage: attached?.kind === 'image' ? attached.url : undefined,
      });
      // from here the render is tracked in the background, even if this window closes
      add({
        id: crypto.randomUUID(), requestId: job.requestId, model: job.model,
        name: `${headline || 'סרטון'} · ${seconds} שנ׳`, contentId, seconds,
        cost: PRICE_PER_SECOND[RES] * seconds, status: 'running', phase: 'queued', createdAt: Date.now(),
      });
    } catch (e: any) {
      const m = videoErrorMessage(e?.message, e?.code);
      setError(`${m.title}. ${m.body}`);
    } finally { setStarting(false); }
  }

  async function stop() {
    if (!running) return;
    const dropped = await VideoService.cancel(running.requestId, running.model);
    if (dropped) {
      remove(running.id);
      setNote('היצירה בוטלה לפני שהרינדור התחיל. לא תחויב.');
    } else {
      // fal does not stop a render that has started; it is billed, so we keep it
      update(running.id, { contentId: null });
      setNote('הרינדור כבר התחיל אצל fal ואי אפשר לעצור אותו בשלב הזה, והוא יחויב. כשיסתיים הוא יישמר בספריית המדיה ולא יוחלף בפוסט.');
    }
  }

  function approve() {
    if (choice) onAttach(choice);
    if (review?.jobId) remove(review.jobId);
    setReview(null);
  }
  function keepInLibraryOnly() {
    if (review?.jobId) remove(review.jobId);
    setReview(null);
    setNote('נשמר בספריית המדיה. הפוסט לא השתנה.');
  }

  return (
    <div className="mt-3 rounded-2xl border border-line p-3">
      <p className="mb-2 text-sm font-semibold text-ink-2">יצירה ב-AI</p>
      <Button variant="ghost" size="sm" className="w-full" onClick={makeImage} disabled={imaging || starting}>
        {imaging ? <><Spinner />מצייר…</> : <>תמונה · ${(PRICE_PER_IMAGE * 2).toFixed(2)}</>}
      </Button>

      {running ? (
        <div className="mt-3 rounded-xl bg-surface-2 p-3 text-xs">
          <p className="flex items-center gap-2 font-semibold"><Spinner />
            {running.phase === 'running' ? 'מרנדר את הסרטון…' : `בתור${running.position ? ` (מקום ${running.position})` : ''}…`}
          </p>
          <p className="mt-1 text-muted">לוקח כמה דקות. אפשר לסגור את החלון — הסרטון ימשיך וייכנס לספרייה.</p>
          {running.phase !== 'running' && (
            <button type="button" className="mt-2 font-semibold text-[var(--danger)] underline" onClick={stop}>ביטול (לפני שהרינדור מתחיל — בלי חיוב)</button>
          )}
          {running.phase === 'running' && (
            <button type="button" className="mt-2 text-muted underline" onClick={stop}>ביטול</button>
          )}
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-2">
            {[5, 10].map((s) => <Chip key={s} on={seconds === s} onClick={() => setSeconds(s)}>{s} שנ׳</Chip>)}
          </div>
          <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={makeVideo} disabled={imaging || starting}>
            {starting ? <><Spinner />שולח…</> : <>סרטון · ${(PRICE_PER_SECOND[RES] * seconds).toFixed(2)}</>}
          </Button>
          {attached?.kind === 'image' && <p className="mt-2 text-xs text-muted">הסרטון יתחיל מהתמונה שכבר בפוסט.</p>}
        </>
      )}

      {ready.map((j) => (
        <div key={j.id} className="mt-3 rounded-xl bg-[var(--ok-soft,#e8f7ee)] p-3 text-xs">
          <p className="font-semibold">הסרטון מוכן ונשמר בספרייה.</p>
          <Button size="sm" variant="primary" className="mt-2 w-full" onClick={() => openReview([j.mediaId!], j.id)}>תצוגה מקדימה ואישור</Button>
        </div>
      ))}
      {failed && (
        <p className="mt-2 text-xs text-[var(--danger)]">
          יצירת הסרטון נכשלה: {failed.error}{' '}
          <button type="button" className="underline" onClick={() => remove(failed.id)}>הבנתי</button>
        </p>
      )}
      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
      {error && <p className="mt-2 text-xs text-[var(--danger)]">{error}</p>}

      {kind === 'reel' && (
        <button type="button" className="mt-3 text-xs font-semibold text-primary hover:underline"
          onClick={() => router.push(`/reels?brief=${encodeURIComponent(headline)}`)}>
          ריל מלא עם תסריט וקריינות ← אולפן הרילס
        </button>
      )}

      <Modal open={!!review} onClose={() => setReview(null)} wide>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="font-display text-xl font-extrabold">תצוגה מקדימה לפני שיבוץ</h3>
          <CloseButton onClick={() => setReview(null)} />
        </div>
        {review && review.ids.length > 1 && (
          <div className="mb-4 flex gap-2">
            {review.ids.map((id, n) => {
              const m = media.find((x) => x.id === id);
              return m ? (
                <button key={id} type="button" onClick={() => setChoice(id)}
                  className={cx('w-20 overflow-hidden rounded-xl ring-2', id === choice ? 'ring-primary' : 'ring-transparent')}>
                  <img src={m.url} alt={`אפשרות ${n + 1}`} className="aspect-[4/5] w-full object-cover" />
                </button>
              ) : null;
            })}
          </div>
        )}
        <PlatformPreview mediaId={choice} headline={headline} caption={caption} palette={palette} initial={initialTab(kind, platform)} />
        <div className="mt-5 flex flex-wrap gap-3 border-t border-line pt-4">
          <Button variant="primary" onClick={approve}>שיבוץ בפוסט</Button>
          <Button variant="ghost" onClick={keepInLibraryOnly}>השארה בספרייה בלבד</Button>
        </div>
      </Modal>
    </div>
  );
}
