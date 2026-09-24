import { authHeaders } from './http';

/**
 * VideoService — talks to /api/video, which runs Wan 3.0 on fal.
 * Generation is queued: submit returns a job id, then we poll. A 15-second clip
 * usually takes a few minutes, so every caller must show progress, never block.
 */
export type ClipStatus = 'queued' | 'running' | 'done' | 'failed';
export interface ClipUpdate { status: ClipStatus; position?: number | null; url?: string; error?: string }

export interface ClipRequest {
  prompt: string;
  duration: number;             // whole seconds, 2–30
  resolution: '480p' | '720p' | '1080p';
  aspectRatio?: '9:16' | '16:9' | '1:1';
  startImage?: string;          // data URI or https URL; omit for text-to-video
  endImage?: string;
  audio?: boolean;
}

/** fal list prices for Wan 3.0, USD per output second. */
export const PRICE_PER_SECOND = { '480p': 0.05, '720p': 0.10, '1080p': 0.20 } as const;

export class VideoError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const VideoService = {
  async available(): Promise<boolean> {
    try { const r = await fetch('/api/video'); return !!(await r.json()).available; } catch { return false; }
  },

  async submit(req: ClipRequest): Promise<{ requestId: string; model: string }> {
    const res = await fetch('/api/video', { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ action: 'submit', ...req }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.status === 'FAILED') throw new VideoError(j.code || 'submit_failed', j.error || j.message || 'submit failed');
    return { requestId: j.requestId, model: j.model };
  },

  /** Submit, then poll every 5s until the clip is ready or fails (15 min ceiling). */
  async generate(req: ClipRequest, onUpdate: (u: ClipUpdate) => void, signal?: AbortSignal): Promise<string> {
    onUpdate({ status: 'queued' });
    const job = await this.submit(req);
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new VideoError('aborted', 'cancelled');
      await sleep(5000);
      const res = await fetch('/api/video', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({ action: 'status', requestId: job.requestId, model: job.model }),
      });
      const j = await res.json().catch(() => ({}));
      if (j.status === 'COMPLETED') { onUpdate({ status: 'done', url: j.url }); return j.url; }
      if (j.status === 'FAILED' || !res.ok) {
        const err = new VideoError(j.code || 'failed', j.error || j.message || 'generation failed');
        onUpdate({ status: 'failed', error: err.message });
        throw err;
      }
      onUpdate({ status: j.status === 'IN_QUEUE' ? 'queued' : 'running', position: j.position });
    }
    throw new VideoError('timeout', 'generation took too long');
  },
};
