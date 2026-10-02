import { randomUUID } from 'node:crypto';
import { PRICES } from '../config';
import { ProviderError, type FailureKind, type JobState, type VideoJobRequest, type VideoProvider } from '../types';

/**
 * Wan 3.0 through Higgsfield's official API (https://docs.higgsfield.ai) — an OPTIONAL video
 * provider, never the default. Documented request lifecycle:
 *   POST https://api.higgsfield.ai/alibaba/wan-3.0/text-to-video    { prompt, duration, resolution, aspect_ratio, generate_audio }
 *   POST https://api.higgsfield.ai/alibaba/wan-3.0/image-to-video   { …, image_url (first frame, public URL), end_image_url? }
 *   GET  https://api.higgsfield.ai/requests/{request_id}/status      → queued … completed | failed | nsfw | canceled
 *   completed → { video: { url } }
 * Auth: "Authorization: Key <key id>:<key secret>" (server-side only). Every submit carries an
 * Idempotency-Key, so a retried submit never creates a second paid job.
 *
 * STATUS: written against the official documentation (checked 2 Oct 2026). NOT yet tested with a
 * real key on this account. Kling 3.0 / Seedance on Higgsfield are not wired: their exact
 * request schemas were not verified.
 *
 * Env: HF_API_KEY_ID, HF_API_KEY_SECRET (console.higgsfield.ai),
 *      HIGGSFIELD_WAN3_USD_PER_SEC_480P / _720P / _1080P for cost estimates (no price is assumed).
 */
const BASE = 'https://api.higgsfield.ai';
const ID = process.env.HF_API_KEY_ID;
const SECRET = process.env.HF_API_KEY_SECRET;
const T2V = 'alibaba/wan-3.0/text-to-video';
const I2V = 'alibaba/wan-3.0/image-to-video';
const RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16'];

const headers = () => ({ Authorization: `Key ${ID}:${SECRET}`, 'Content-Type': 'application/json' });

function classify(status: number, text: string): FailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || /insufficient|balance|credit/i.test(text)) return 'quota';
  if (status === 400 || status === 422) return 'input';
  if (/nsfw|policy|moderation/i.test(text)) return 'policy';
  return 'retryable'; // 429, 5xx, network
}

async function call(path: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
  } catch (e: any) {
    throw new ProviderError('higgsfield', 'retryable', `network: ${String(e?.message ?? e).slice(0, 160)}`);
  }
  const text = await res.text();
  let j: any = {}; try { j = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new ProviderError('higgsfield', classify(res.status, text), `http ${res.status}: ${(j.detail ?? j.message ?? text).toString().slice(0, 200)}`);
  return j;
}

const price = (res: string): number | null =>
  (PRICES as any).higgsfieldWan3PerSec?.[res] ?? null;

export const HiggsfieldWanProvider: VideoProvider = {
  id: 'higgsfield',
  available: () => Boolean(ID && SECRET),
  supports(req: VideoJobRequest) {
    if (req.duration < 2 || req.duration > 30) return false;
    // Higgsfield needs PUBLIC image URLs; a start frame kept as a data URI stays with fal
    if (req.startImage && !/^https:\/\//.test(req.startImage)) return false;
    if (req.endImage && !/^https:\/\//.test(req.endImage)) return false;
    return true;
  },
  model: (req) => (req.startImage ? I2V : T2V),
  async submit(req) {
    const model = req.startImage ? I2V : T2V;
    const body: Record<string, unknown> = {
      prompt: req.prompt.slice(0, 4000),
      duration: Math.round(req.duration),
      resolution: req.resolution,
      aspect_ratio: RATIOS.includes(req.aspectRatio) ? req.aspectRatio : '9:16',
      generate_audio: Boolean((req as any).audio),
    };
    if (req.startImage) body.image_url = req.startImage;
    if (req.endImage) body.end_image_url = req.endImage;
    const j = await call(`/${model}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': randomUUID() } });
    if (!j.request_id) throw new ProviderError('higgsfield', 'retryable', 'no request_id in the answer');
    return { jobId: String(j.request_id), model };
  },
  async status(_model, jobId): Promise<JobState> {
    const j = await call(`/requests/${encodeURIComponent(jobId)}/status`);
    const s = String(j.status ?? '').toLowerCase();
    if (s === 'completed') {
      const url = j.video?.url;
      return url ? { state: 'succeeded', url, durationSec: null, billedSeconds: null }
        : { state: 'failed', error: 'completed without a video url', kind: 'retryable' };
    }
    if (s === 'failed') return { state: 'failed', error: String(j.error ?? j.detail ?? 'generation failed').slice(0, 200), kind: 'retryable' };
    if (s === 'nsfw') return { state: 'failed', error: 'blocked by content moderation', kind: 'policy' };
    if (s === 'canceled' || s === 'cancelled') return { state: 'failed', error: 'canceled', kind: 'input' };
    if (s === 'queued') return { state: 'queued', position: null };
    return { state: 'running' };
  },
  async cancel(_model, jobId) {
    try { await call(`/requests/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }); return true; }
    catch { return false; } // only queued requests can be canceled
  },
  estimate(req) { const p = price(req.resolution); return p == null ? null : p * req.duration; },
  actualCost() { return null; }, // the API does not report the billed amount per request
};
