import { AI_CONFIG, videoQualityOf, type ImageQuality, type ProviderId, type VideoQuality } from './config';
import { adminDb } from '@/lib/server/admin';
import { finishGeneration, logGeneration } from './ledger';
import { ProviderError, type ImageJobRequest, type ImageProvider, type JobState, type VideoJobRequest, type VideoProvider } from './types';
import { FalImageProvider, FalVideoProvider } from './providers/fal';
import { HiggsfieldWanProvider } from './providers/higgsfield';
import { AlibabaWanProvider } from './providers/alibaba';

/**
 * AIRouter — the one entry point for generation. Routes pick a quality mode; the router picks
 * the provider from AI_CONFIG, retries a retryable failure once, falls back only by the
 * configured rule, and writes every attempt to the ledger.
 *
 * Adding a provider (Kling, Seedance, MiniMax…) = one file implementing VideoProvider +
 * one line in VIDEO below + its name in AI_CONFIG. No screen changes.
 */
const VIDEO: Partial<Record<ProviderId, VideoProvider>> = { fal: FalVideoProvider, alibaba: AlibabaWanProvider, higgsfield: HiggsfieldWanProvider };
const IMAGE: Partial<Record<ProviderId, ImageProvider>> = { fal: FalImageProvider };

export interface Ctx { userId: string | null; contentId: string | null }

/** The job handle the browser keeps: "provider:model". Older handles have no prefix and are fal's. */
export const jobHandle = (provider: ProviderId, model: string) => `${provider}:${model}`;
export function parseHandle(handle: string): { provider: VideoProvider; model: string } | null {
  const i = handle.indexOf(':');
  const head = i > 0 ? handle.slice(0, i) as ProviderId : null;
  if (head && VIDEO[head]) return { provider: VIDEO[head]!, model: handle.slice(i + 1) };
  if (Object.values(AI_CONFIG.models.falVideo).includes(handle as any)) return { provider: FalVideoProvider, model: handle };
  return null;
}

export function videoAvailable() {
  return Object.values(VIDEO).some((p) => p!.available());
}
export function videoEngineName() {
  const r = AI_CONFIG.video.standard;
  if (r.provider === 'alibaba' && AlibabaWanProvider.available()) return 'Wan · Alibaba Cloud (fal fallback)';
  if (r.provider === 'higgsfield' && HiggsfieldWanProvider.available()) return 'Wan 3.0 · Higgsfield (fal fallback)';
  return 'Wan 3.0 · fal';
}

/** Starts a clip. Throws ProviderError when no provider could take it. */
export async function submitVideo(ctx: Ctx, req: VideoJobRequest, qualityIn?: VideoQuality) {
  const quality = qualityIn ?? videoQualityOf(undefined, req.resolution);
  const route = AI_CONFIG.video[quality];
  const chain = [route.provider, route.fallbackProvider].filter((p, k, a): p is ProviderId => Boolean(p) && a.indexOf(p) === k);
  let last: ProviderError | null = null;
  let failedProvider: ProviderId | null = null;

  for (const id of chain) {
    const p = VIDEO[id];
    if (!p || !p.available() || !p.supports(req)) continue; // not configured / cannot do this request → next in chain
    for (let attempt = 0; attempt <= AI_CONFIG.limits.retriesPerProvider; attempt++) {
      const started = Date.now();
      try {
        const job = await p.submit(req);
        const estimate = p.estimate(req);
        await logGeneration({
          userId: ctx.userId, contentId: ctx.contentId, type: 'video', provider: p.id, model: job.model, qualityMode: quality,
          durationSeconds: req.duration, resolution: req.resolution, inputUnits: req.duration, estimatedCostUsd: estimate,
          retryCount: attempt, fallbackFrom: failedProvider, providerGenerationId: job.jobId, status: 'running',
          meta: { aspect: req.aspectRatio, mode: req.startImage ? 'image' : 'text', submitMs: Date.now() - started },
        });
        return { handle: jobHandle(p.id, job.model), jobId: job.jobId, provider: p.id, model: job.model, estimate, quality };
      } catch (e: any) {
        const err = e instanceof ProviderError ? e : new ProviderError(p.id, 'retryable', String(e?.message ?? e));
        last = err;
        await logGeneration({
          userId: ctx.userId, contentId: ctx.contentId, type: 'video', provider: p.id, model: p.model(req), qualityMode: quality,
          durationSeconds: req.duration, resolution: req.resolution, status: 'failed', error: `${err.kind}: ${err.message}`,
          retryCount: attempt, fallbackFrom: failedProvider, estimatedCostUsd: 0, latencyMs: Date.now() - started,
        });
        // the user's input, content policy, credentials or provider credit: retrying or switching will not help
        if (err.kind !== 'retryable') throw err;
      }
    }
    failedProvider = id;
  }
  throw last ?? new ProviderError(route.provider, 'auth', 'no video provider is configured for this request');
}

/** One status check. Closes the ledger row when the job ends. */
export async function videoStatus(handle: string, jobId: string): Promise<JobState | null> {
  const parsed = parseHandle(handle);
  if (!parsed) return null;
  const st = await parsed.provider.status(parsed.model, jobId);
  if (st.state === 'succeeded') {
    let actual: number | null = null;
    if (st.billedSeconds) {
      let resolution = '720p';
      try {
        const { data } = await adminDb().from('ai_generations').select('resolution')
          .eq('provider', parsed.provider.id).eq('provider_generation_id', jobId).limit(1).maybeSingle();
        if (data?.resolution) resolution = data.resolution;
      } catch { /* ledger unavailable: price at the default tier */ }
      actual = parsed.provider.actualCost({ resolution }, st.billedSeconds);
    }
    await finishGeneration(parsed.provider.id, jobId, { status: 'succeeded', actualCostUsd: actual ?? undefined, outputUnits: st.billedSeconds ?? st.durationSec ?? null });
  } else if (st.state === 'failed') {
    await finishGeneration(parsed.provider.id, jobId, { status: 'failed', actualCostUsd: 0, error: `${st.kind}: ${st.error}` });
  }
  return st;
}

export async function cancelVideo(handle: string, jobId: string): Promise<boolean> {
  const parsed = parseHandle(handle);
  if (!parsed) return false;
  const dropped = await parsed.provider.cancel(parsed.model, jobId);
  if (dropped) await finishGeneration(parsed.provider.id, jobId, { status: 'cancelled' });
  return dropped;
}

// -------------------------------------------------------------------- images --
export function imageProvider(quality: ImageQuality = 'standard'): ImageProvider | null {
  const p = IMAGE[AI_CONFIG.image[quality].provider];
  return p && p.available() ? p : null;
}
export function imageByHandle(handle: string): { provider: ImageProvider; model: string } | null {
  const i = handle.indexOf(':');
  const head = i > 0 ? handle.slice(0, i) as ProviderId : null;
  if (head && IMAGE[head]) return { provider: IMAGE[head]!, model: handle.slice(i + 1) };
  if (Object.values(AI_CONFIG.models.falImage).includes(handle as any)) return { provider: FalImageProvider, model: handle };
  return null;
}

export async function submitImage(ctx: Ctx, req: ImageJobRequest, quality: ImageQuality = 'standard') {
  const p = imageProvider(quality);
  if (!p) throw new ProviderError('fal', 'auth', 'no image provider is configured');
  const started = Date.now();
  try {
    const job = await p.submit(req);
    const estimate = p.estimate(req);
    await logGeneration({
      userId: ctx.userId, contentId: ctx.contentId, type: 'image', provider: p.id, model: job.model, qualityMode: quality,
      inputUnits: req.count, estimatedCostUsd: estimate, providerGenerationId: job.jobId, status: 'running',
      meta: { aspect: req.aspectRatio, references: req.references.length },
    });
    return { handle: `${p.id}:${job.model}`, jobId: job.jobId, estimate };
  } catch (e: any) {
    const err = e instanceof ProviderError ? e : new ProviderError(p.id, 'retryable', String(e?.message ?? e));
    await logGeneration({
      userId: ctx.userId, contentId: ctx.contentId, type: 'image', provider: p.id, model: p.model(req), qualityMode: quality,
      status: 'failed', error: `${err.kind}: ${err.message}`, estimatedCostUsd: 0, latencyMs: Date.now() - started,
    });
    throw err;
  }
}

export async function imageStatus(handle: string, jobId: string) {
  const parsed = imageByHandle(handle);
  if (!parsed) return null;
  const st = await parsed.provider.status(parsed.model, jobId);
  if (st.state === 'succeeded') await finishGeneration(parsed.provider.id, jobId, { status: 'succeeded', outputUnits: st.urls.length });
  if (st.state === 'failed') await finishGeneration(parsed.provider.id, jobId, { status: 'failed', actualCostUsd: 0, error: st.error });
  return st;
}

// ----------------------------------------------------------------- benchmark --
/** Every video provider the router knows, with whether it is configured. */
export function videoProviders() {
  return (Object.keys(VIDEO) as ProviderId[]).map((id) => ({ id, available: VIDEO[id]!.available() }));
}

/**
 * Admin benchmark: one request sent to ONE named provider, no retry, no fallback — so the
 * comparison is fair. Logged like any generation, marked meta.benchmark.
 */
export async function submitVideoDirect(providerId: ProviderId, ctx: Ctx, req: VideoJobRequest) {
  const p = VIDEO[providerId];
  if (!p || !p.available()) throw new ProviderError(providerId, 'auth', 'provider not configured');
  if (!p.supports(req)) throw new ProviderError(providerId, 'input', 'this provider does not support this request (duration / resolution / start image)');
  const started = Date.now();
  try {
    const job = await p.submit(req);
    const estimate = p.estimate(req);
    await logGeneration({
      userId: ctx.userId, contentId: null, type: 'video', provider: p.id, model: job.model, qualityMode: 'benchmark',
      durationSeconds: req.duration, resolution: req.resolution, inputUnits: req.duration, estimatedCostUsd: estimate,
      providerGenerationId: job.jobId, status: 'running', meta: { benchmark: true, prompt: req.prompt.slice(0, 300), submitMs: Date.now() - started },
    });
    return { provider: p.id, handle: jobHandle(p.id, job.model), jobId: job.jobId, model: job.model, estimate };
  } catch (e: any) {
    const err = e instanceof ProviderError ? e : new ProviderError(p.id, 'retryable', String(e?.message ?? e));
    await logGeneration({
      userId: ctx.userId, type: 'video', provider: p.id, model: p.model(req), qualityMode: 'benchmark', status: 'failed',
      error: `${err.kind}: ${err.message}`, estimatedCostUsd: 0, latencyMs: Date.now() - started, meta: { benchmark: true },
    });
    throw err;
  }
}
