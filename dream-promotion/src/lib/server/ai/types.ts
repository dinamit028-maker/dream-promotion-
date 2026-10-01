import type { ProviderId } from './config';

/**
 * Why a provider call failed — this decides what the router may do next.
 *  retryable: timeouts, 5xx, overload, rate limit on the provider side → retry once, then fall back
 *  input:     the request itself is wrong (bad size, bad image) → no retry, no fallback
 *  policy:    content moderation rejected it → no retry, no fallback
 *  auth:      bad / missing key → no fallback (fix the configuration)
 *  quota:     the provider account is out of credit → no fallback by default
 */
export type FailureKind = 'retryable' | 'input' | 'policy' | 'auth' | 'quota';

export class ProviderError extends Error {
  constructor(public provider: ProviderId, public kind: FailureKind, message: string, public status?: number) {
    super(message);
  }
}

export interface VideoJobRequest {
  prompt: string;
  duration: number;
  resolution: '480p' | '720p' | '1080p';
  aspectRatio: string;
  startImage?: string;
  endImage?: string;
  audio: boolean;
}

export interface VideoSubmitResult { jobId: string; model: string }

export type JobState =
  | { state: 'queued'; position?: number | null }
  | { state: 'running' }
  | { state: 'succeeded'; url: string; durationSec?: number | null; billedSeconds?: number | null }
  | { state: 'failed'; error: string; kind: FailureKind };

export interface VideoProvider {
  readonly id: ProviderId;
  available(): boolean;
  /** can this provider do this request (image start frame, duration, resolution)? */
  supports(req: VideoJobRequest): boolean;
  model(req: VideoJobRequest): string;
  submit(req: VideoJobRequest): Promise<VideoSubmitResult>;
  status(model: string, jobId: string): Promise<JobState>;
  /** true only if the job was dropped before the provider billed it */
  cancel(model: string, jobId: string): Promise<boolean>;
  /** USD for this request at list price, or null when the price is unknown */
  estimate(req: VideoJobRequest): number | null;
  /** USD for what the provider reports it billed, or null */
  actualCost(req: { resolution: string }, billedSeconds: number | null | undefined): number | null;
}

export interface ImageJobRequest { prompt: string; count: number; aspectRatio: string; references: string[] }
export interface ImageProvider {
  readonly id: ProviderId;
  available(): boolean;
  model(req: ImageJobRequest): string;
  submit(req: ImageJobRequest): Promise<{ jobId: string; model: string }>;
  status(model: string, jobId: string): Promise<{ state: 'queued' | 'running' } | { state: 'succeeded'; urls: string[] } | { state: 'failed'; error: string }>;
  estimate(req: ImageJobRequest): number | null;
}
