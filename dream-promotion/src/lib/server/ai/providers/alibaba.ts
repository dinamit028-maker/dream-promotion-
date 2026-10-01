import { AI_CONFIG, PRICES } from '../config';
import { ProviderError, type FailureKind, type JobState, type VideoProvider } from '../types';

/**
 * Wan on Alibaba Cloud Model Studio (DashScope), called directly — official HTTP API:
 *   POST {base}/services/aigc/video-generation/video-synthesis   (header X-DashScope-Async: enable)
 *   GET  {base}/tasks/{task_id}
 * https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference
 *
 * Text-to-video only, with the Wan 2.7 protocol (resolution 720P / 1080P + ratio, duration 2–15 s).
 * Requests it does not support (a start image, 480p, longer than 15 s) go to fal.
 * STATUS: written against the documentation, NOT yet tested with a real key on this account.
 *
 * Env: DASHSCOPE_API_KEY, DASHSCOPE_BASE_URL (default Singapore: https://dashscope-intl.aliyuncs.com/api/v1;
 *      the region of the key must match), ALIBABA_WAN_T2V_MODEL (default wan2.7-t2v),
 *      ALIBABA_WAN_USD_PER_SEC_720P / _1080P for cost estimates.
 */
const KEY = process.env.DASHSCOPE_API_KEY;
const BASE = (process.env.DASHSCOPE_BASE_URL || 'https://dashscope-intl.aliyuncs.com/api/v1').replace(/\/+$/, '');
const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];

function classify(code: string, status: number): FailureKind {
  // throttling first: "Throttling.RateQuota" is a busy provider, not an empty account
  if (status === 429 || /^Throttling/i.test(code)) return 'retryable';
  if (status === 401 || /InvalidApiKey|AccessDenied/i.test(code)) return 'auth';
  if (/Arrearage|Quota|Balance/i.test(code)) return 'quota';
  if (/DataInspection|IPInfringement|Inappropriate/i.test(code)) return 'policy';
  if (/InvalidParameter|InvalidUrl|BadRequest/i.test(code) || status === 400) return 'input';
  return 'retryable'; // Throttling, InternalError, 5xx, network
}

async function call(path: string, init: RequestInit) {
  if (!KEY) throw new ProviderError('alibaba', 'auth', 'DASHSCOPE_API_KEY is not configured');
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    throw new ProviderError('alibaba', 'retryable', `network: ${e?.message ?? e}`);
  }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.code) {
    const code = String(j.code || `http_${res.status}`);
    throw new ProviderError('alibaba', classify(code, res.status), `${code}: ${j.message || ''}`.slice(0, 400), res.status);
  }
  return j;
}

export const AlibabaWanProvider: VideoProvider = {
  id: 'alibaba',
  available: () => Boolean(KEY),
  supports: (req) => !req.startImage && (req.resolution === '720p' || req.resolution === '1080p') && req.duration >= 2 && req.duration <= 15,
  model: () => AI_CONFIG.models.alibabaVideo.text,
  async submit(req) {
    const model = this.model(req);
    const j = await call('/services/aigc/video-generation/video-synthesis', {
      method: 'POST',
      headers: { 'X-DashScope-Async': 'enable' },
      body: JSON.stringify({
        model,
        input: { prompt: req.prompt.slice(0, 5000) },
        parameters: {
          resolution: req.resolution === '1080p' ? '1080P' : '720P',
          ratio: RATIOS.includes(req.aspectRatio) ? req.aspectRatio : '9:16',
          duration: req.duration,
          prompt_extend: true,
          watermark: false,
        },
      }),
    });
    const id = j?.output?.task_id;
    if (!id) throw new ProviderError('alibaba', 'retryable', 'no task_id in response');
    return { jobId: String(id), model };
  },
  async status(_model, jobId): Promise<JobState> {
    try {
      const j = await call(`/tasks/${encodeURIComponent(jobId)}`, { method: 'GET' });
      const o = j?.output ?? {};
      switch (o.task_status) {
        case 'PENDING': return { state: 'queued', position: null };
        case 'RUNNING': return { state: 'running' };
        case 'SUCCEEDED':
          if (!o.video_url) return { state: 'failed', error: 'no video_url', kind: 'retryable' };
          return {
            state: 'succeeded', url: String(o.video_url),
            durationSec: Number(j?.usage?.output_video_duration) || null,
            billedSeconds: Number(j?.usage?.duration) || null,
          };
        case 'FAILED': {
          const code = String(o.code || 'FAILED');
          return { state: 'failed', error: `${code}: ${o.message || ''}`.slice(0, 400), kind: classify(code, 200) };
        }
        case 'CANCELED': return { state: 'failed', error: 'cancelled by provider', kind: 'retryable' };
        default: return { state: 'failed', error: `unknown task (${o.task_status ?? 'no status'})`, kind: 'retryable' };
      }
    } catch (e: any) {
      return e instanceof ProviderError && e.kind !== 'retryable'
        ? { state: 'failed', error: e.message, kind: e.kind }
        : { state: 'running' }; // a hiccup while polling is not a failed job — ask again next time
    }
  },
  cancel: async () => false, // no cancel call in the documented API: the job is tracked to the end
  estimate(req) {
    const per = req.resolution === '1080p' ? PRICES.alibabaWanPerSec['1080p'] : PRICES.alibabaWanPerSec['720p'];
    return per == null ? null : per * req.duration;
  },
  actualCost(req, billedSeconds) {
    const per = req.resolution === '1080p' ? PRICES.alibabaWanPerSec['1080p'] : PRICES.alibabaWanPerSec['720p'];
    return per == null || !billedSeconds ? null : per * billedSeconds;
  },
};
