'use client';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { useJobs } from '@/lib/jobs';
import { VideoService } from '@/lib/services/video.service';
import { archiveAsset } from '@/lib/services/archive.service';

/**
 * Finishes every paid video render in the background, whichever screen is open:
 * polls fal, copies the clip into the user's storage, adds it to the media library,
 * and tells the user it is ready. Mounted once in the app shell.
 */
export function JobRunner() {
  const jobs = useJobs((s) => s.jobs);
  const busy = useRef(new Set<string>());
  const [notice, setNotice] = useState<{ text: string; contentId: string | null } | null>(null);

  useEffect(() => {
    const tick = async () => {
      const { jobs: list, update } = useJobs.getState();
      for (const job of list) {
        if (job.status !== 'running' || busy.current.has(job.id)) continue;
        busy.current.add(job.id);
        try {
          const s = await VideoService.status(job.requestId, job.model);
          if (s.status === 'COMPLETED' && s.url) {
            const saved = await archiveAsset(s.url, 'video', job.name);
            const mediaId = saved.id ?? crypto.randomUUID();
            useApp.getState().addMedia({ id: mediaId, url: saved.url, name: job.name, kind: 'video', persistent: Boolean(saved.id) });
            update(job.id, { status: 'ready', mediaId });
            setNotice({ text: 'הסרטון מוכן ונשמר בספריית המדיה.', contentId: job.contentId });
          } else if (s.status === 'FAILED') {
            update(job.id, { status: 'failed', error: s.error || 'היצירה נכשלה' });
          } else if (s.status === 'IN_QUEUE' || s.status === 'IN_PROGRESS') {
            update(job.id, { phase: s.status === 'IN_QUEUE' ? 'queued' : 'running', position: s.position ?? null });
          }
          // give up on a job fal no longer knows about after a day
          if (Date.now() - job.createdAt > 24 * 3600_000 && s.status === 'ERROR') update(job.id, { status: 'failed', error: 'expired' });
        } catch { /* network blip — next tick */ }
        finally { busy.current.delete(job.id); }
      }
    };
    void tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [jobs.length]);

  if (!notice) return null;
  return (
    <div role="status" className="fixed inset-x-4 bottom-24 z-[120] mx-auto flex max-w-md items-center gap-3 rounded-2xl bg-ink px-4 py-3 text-sm text-white shadow-lg md:bottom-6">
      <span className="flex-1">{notice.text}</span>
      {notice.contentId && (
        <button type="button" className="font-semibold underline"
          onClick={() => { useApp.getState().openEditor(notice.contentId!); setNotice(null); }}>
          לתצוגה ואישור
        </button>
      )}
      <button type="button" aria-label="סגירה" className="opacity-70" onClick={() => setNotice(null)}>✕</button>
    </div>
  );
}
