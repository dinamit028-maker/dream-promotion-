import { fal } from '@fal-ai/client';
import { AI_CONFIG, PRICES } from '../config';
import { ProviderError, type FailureKind, type ImageJobRequest, type ImageProvider, type JobState, type VideoJobRequest, type VideoProvider } from '../types';

const KEY = process.env.FAL_KEY;
if (KEY) fal.config({ credentials: KEY });

function classify(e: any): FailureKind {
  const s = Number(e?.status);
  const text = `${e?.message ?? ''} ${JSON.stringify(e?.body?.detail ?? '')}`;
  if (s === 401 || s === 403) return 'auth';
  if (s === 402 || /balance|credit|billing/i.test(text)) return 'quota';
  if (/content.?policy|nsfw|safety|moderat/i.test(text)) return 'policy';
  if (s === 400 || s === 422) return 'input';
  return 'retryable'; // 429, 5xx, network, timeouts
}
const fail = (e: any) => new ProviderError('fal', classify(e), String(e?.body?.detail ? JSON.stringify(e.body.detail) : e?.message ?? e).slice(0, 400), e?.status);

const isImage = (v: unknown): v is string => typeof v === 'string' && (v.startsWith('data:image/') || v.startsWith('https://'));

/** Wan on fal — the provider the studio was built on; also the fallback for every other video provider. */
export const FalVideoProvider: VideoProvider = {
  id: 'fal',
  available: () => Boolean(KEY),
  supports: (req) => req.duration >= 2 && req.duration <= 30,
  model: (req) => (isImage(req.startImage) ? AI_CONFIG.models.falVideo.image : AI_CONFIG.models.falVideo.text),
  async submit(req) {
    const model = this.model(req);
    const input: Record<string, unknown> = {
      prompt: req.prompt, duration: req.duration, resolution: req.resolution, aspect_ratio: req.aspectRatio,
      audio: req.audio, enable_prompt_expansion: true,
    };
    if (isImage(req.startImage)) {
      input.start_image_url = req.startImage;
      if (isImage(req.endImage)) input.end_image_url = req.endImage;
    }
    try {
      const q = await fal.queue.submit(model, { input: input as any });
      return { jobId: q.request_id, model };
    } catch (e) { throw fail(e); }
  },
  async status(model, jobId): Promise<JobState> {
    try {
      const st: any = await fal.queue.status(model, { requestId: jobId, logs: false });
      if (st.status === 'COMPLETED') {
        const r: any = await fal.queue.result(model, { requestId: jobId });
        const url = r?.data?.video?.url;
        if (!url) return { state: 'failed', error: 'no video in result', kind: 'retryable' };
        return { state: 'succeeded', url, durationSec: r.data.duration ?? null };
      }
      return st.status === 'IN_QUEUE' ? { state: 'queued', position: st.queue_position ?? null } : { state: 'running' };
    } catch (e: any) {
      const err = fail(e);
      return { state: 'failed', error: err.message, kind: err.kind };
    }
  },
  async cancel(model, jobId) {
    // fal drops a job only while it waits in the queue; once rendering it runs (and bills) to the end
    try { await fal.queue.cancel(model, { requestId: jobId }); return true; } catch { return false; }
  },
  estimate: (req) => req.duration * PRICES.falWanPerSec[req.resolution],
  actualCost: () => null, // fal does not report billed usage per job
};

/** Nano Banana 2 on fal. */
export const FalImageProvider: ImageProvider = {
  id: 'fal',
  available: () => Boolean(KEY),
  model: (req) => (req.references.length ? AI_CONFIG.models.falImage.edit : AI_CONFIG.models.falImage.create),
  async submit(req) {
    const model = this.model(req);
    const input: Record<string, unknown> = { prompt: req.prompt, num_images: req.count, aspect_ratio: req.aspectRatio, output_format: 'jpeg' };
    if (req.references.length) input.image_urls = req.references;
    try {
      const q = await fal.queue.submit(model, { input: input as any });
      return { jobId: q.request_id, model };
    } catch (e) { throw fail(e); }
  },
  async status(model, jobId) {
    try {
      const st: any = await fal.queue.status(model, { requestId: jobId, logs: false });
      if (st.status === 'COMPLETED') {
        const r: any = await fal.queue.result(model, { requestId: jobId });
        const urls = (r?.data?.images ?? []).map((i: any) => i.url).filter(Boolean);
        return urls.length ? { state: 'succeeded' as const, urls } : { state: 'failed' as const, error: 'no image in result' };
      }
      return { state: st.status === 'IN_QUEUE' ? 'queued' as const : 'running' as const };
    } catch (e) { return { state: 'failed' as const, error: fail(e).message }; }
  },
  estimate: (req) => req.count * PRICES.falImage,
};

export { fal };
