/**
 * AI_CONFIG — the ONLY place that names providers, models and prices.
 * Nothing in the UI or the API routes picks a vendor; they ask the router for a quality mode.
 *
 * Prices are list prices used for ESTIMATES (USD). Where a provider reports billable usage
 * (Alibaba: seconds, Anthropic: tokens) the ledger also stores the actual cost.
 * Any price can be overridden from the environment — keep them in line with your invoices.
 * A price of null means "unknown": the ledger stores no estimate rather than a made-up number.
 */
export type ProviderId = 'fal' | 'alibaba' | 'anthropic' | 'elevenlabs';
export type VideoQuality = 'draft' | 'standard' | 'premium';
export type ImageQuality = 'economy' | 'standard' | 'premium';

const num = (name: string, def: number | null): number | null => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const pick = <T extends string>(name: string, allowed: readonly T[], def: T): T => {
  const v = (process.env[name] || '').toLowerCase() as T;
  return allowed.includes(v) ? v : def;
};

// ------------------------------------------------------------------- prices --
export const PRICES = {
  /** fal · Wan, USD per output second, by resolution */
  falWanPerSec: { '480p': num('FAL_WAN_USD_PER_SEC_480P', 0.05)!, '720p': num('FAL_WAN_USD_PER_SEC_720P', 0.10)!, '1080p': num('FAL_WAN_USD_PER_SEC_1080P', 0.20)! },
  /** Alibaba Model Studio · Wan, USD per second — set from your Model Studio price list (unknown until set) */
  alibabaWanPerSec: { '720p': num('ALIBABA_WAN_USD_PER_SEC_720P', null), '1080p': num('ALIBABA_WAN_USD_PER_SEC_1080P', null) },
  /** fal · Nano Banana 2, USD per image */
  falImage: num('FAL_IMAGE_USD_EACH', 0.08)!,
  /** fal · Whisper, USD per audio minute (unknown until set) */
  falWhisperPerMin: num('FAL_WHISPER_USD_PER_MIN', null),
  /** Anthropic, USD per million tokens */
  anthropicIn: num('ANTHROPIC_USD_PER_MTOK_IN', 3)!,
  anthropicOut: num('ANTHROPIC_USD_PER_MTOK_OUT', 15)!,
  /** ElevenLabs, USD per 1,000 characters — depends on your plan (unknown until set) */
  voicePer1k: num('VOICE_USD_PER_1K_CHARS', null),
  /** Final render on Vercel, USD per minute of function time (unknown until set) */
  renderPerMin: num('RENDER_USD_PER_MINUTE', null),
};

// -------------------------------------------------------------------- video --
export interface VideoRoute {
  provider: ProviderId;
  resolution: '480p' | '720p' | '1080p';
  defaultDuration: number;
  maxDuration: number;
  /** tried once more on a retryable error, then this provider takes over (null = no fallback) */
  fallbackProvider: ProviderId | null;
}

/**
 * Which provider serves each quality mode. fal stays primary until Alibaba is tested on this
 * account: set AI_VIDEO_PRIMARY=alibaba (with DASHSCOPE_API_KEY) to make Alibaba primary for
 * standard and premium, with fal as the fallback. Draft (480p) is fal only — Alibaba Wan 2.7
 * offers 720P / 1080P.
 */
const videoPrimary = pick('AI_VIDEO_PRIMARY', ['fal', 'alibaba'] as const, 'fal');
export const AI_CONFIG = {
  video: {
    draft:    { provider: 'fal', resolution: '480p', defaultDuration: 5, maxDuration: 30, fallbackProvider: null } as VideoRoute,
    standard: { provider: videoPrimary, resolution: '720p', defaultDuration: 5, maxDuration: 30, fallbackProvider: videoPrimary === 'fal' ? null : 'fal' } as VideoRoute,
    premium:  { provider: videoPrimary, resolution: '1080p', defaultDuration: 5, maxDuration: 30, fallbackProvider: videoPrimary === 'fal' ? null : 'fal' } as VideoRoute,
  },
  /** model ids per provider */
  models: {
    falVideo: { text: process.env.FAL_VIDEO_MODEL_T2V || 'alibaba/wan-3.0/text-to-video', image: process.env.FAL_VIDEO_MODEL_I2V || 'alibaba/wan-3.0/image-to-video' },
    alibabaVideo: { text: process.env.ALIBABA_WAN_T2V_MODEL || 'wan2.7-t2v' },
    falImage: { create: process.env.FAL_IMAGE_MODEL || 'fal-ai/nano-banana-2', edit: process.env.FAL_IMAGE_EDIT_MODEL || 'fal-ai/nano-banana-2/edit' },
    falWhisper: 'fal-ai/whisper',
    text: process.env.AI_MODEL || 'claude-sonnet-4-6',
  },
  /** images: one model today for every mode; the modes exist so a cheaper / better one can be routed later */
  image: {
    economy:  { provider: 'fal' as ProviderId },
    standard: { provider: 'fal' as ProviderId },
    premium:  { provider: 'fal' as ProviderId },
  },
  /** hard ceilings, whatever a request asks for */
  limits: { maxVideoSeconds: 30, maxImagesPerRequest: 4, retriesPerProvider: 1 },
} as const;

/** The quality mode a request means: explicit, or read from the resolution the studio sends today. */
export function videoQualityOf(quality: unknown, resolution: unknown): VideoQuality {
  if (quality === 'draft' || quality === 'standard' || quality === 'premium') return quality;
  return resolution === '480p' ? 'draft' : resolution === '1080p' ? 'premium' : 'standard';
}
