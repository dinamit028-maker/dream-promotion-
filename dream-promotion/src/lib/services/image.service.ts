import { authHeaders } from './http';

/** fal list price for Nano Banana 2 at standard resolution. */
export const PRICE_PER_IMAGE = 0.08;

export type ImageAspect = '9:16' | '4:5' | '1:1' | '16:9';

export interface ImageRequest {
  prompt: string;
  aspectRatio?: ImageAspect;
  count?: number;
  /** existing images to edit or keep consistent with */
  imageUrls?: string[];
}

export class ImageError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const ImageService = {
  async available(): Promise<boolean> {
    try { const r = await fetch('/api/image'); return !!(await r.json()).available; } catch { return false; }
  },

  /** Submits and polls. Images usually land in well under a minute. */
  async generate(req: ImageRequest, onTick?: (s: string) => void, signal?: AbortSignal): Promise<string[]> {
    const res = await fetch('/api/image', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ action: 'submit', ...req }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.status === 'FAILED') throw new ImageError(j.code || 'submit_failed', j.error || j.message || 'submit failed');

    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new ImageError('aborted', 'cancelled');
      await sleep(3000);
      const r = await fetch('/api/image', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ action: 'status', requestId: j.requestId, model: j.model }),
      });
      const s = await r.json().catch(() => ({}));
      if (s.status === 'COMPLETED') return s.urls as string[];
      if (s.status === 'FAILED') throw new ImageError(s.code || 'failed', s.error || 'generation failed');
      onTick?.(s.status);
    }
    throw new ImageError('timeout', 'image generation took too long');
  },
};
