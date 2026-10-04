import { adminDb } from '@/lib/server/admin';
import { workBusiness } from '@/lib/server/business';

/**
 * The generation ledger (public.ai_generations): one row per provider call, written by the
 * server only. Never throws — a ledger problem must not break a user's generation.
 * Without migration 500 the inserts fail quietly and a warning is logged once.
 */
export type GenerationType = 'text' | 'image' | 'video' | 'voice' | 'transcribe' | 'render';

export interface GenerationStart {
  userId: string | null;
  contentId?: string | null;
  type: GenerationType;
  provider: string;
  model: string;
  qualityMode?: string | null;
  durationSeconds?: number | null;
  resolution?: string | null;
  inputUnits?: number | null;
  outputUnits?: number | null;
  estimatedCostUsd?: number | null;
  actualCostUsd?: number | null;
  status?: 'running' | 'succeeded' | 'failed' | 'cancelled';
  retryCount?: number;
  fallbackFrom?: string | null;
  error?: string | null;
  providerGenerationId?: string | null;
  latencyMs?: number | null;
  meta?: Record<string, unknown>;
}

let warned = false;
const round = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 1e6) / 1e6);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The reel / post this request belongs to (header x-dp-content), only if it is the user's own. */
export async function contentIdFrom(req: Request, userId: string | null): Promise<string | null> {
  const id = req.headers.get('x-dp-content') || '';
  if (!userId || !UUID.test(id)) return null;
  try {
    const { data } = await adminDb().from('content').select('id').eq('id', id).eq('business_id', await workBusiness(userId)).maybeSingle();
    return data?.id ?? null;
  } catch { return null; }
}

export async function logGeneration(g: GenerationStart): Promise<string | null> {
  try {
    const { data, error } = await adminDb().from('ai_generations').insert({
      user_id: g.userId, content_id: g.contentId ?? null, generation_type: g.type, provider: g.provider, model: g.model,
      quality_mode: g.qualityMode ?? null, status: g.status ?? 'running',
      duration_seconds: g.durationSeconds ?? null, resolution: g.resolution ?? null,
      input_units: g.inputUnits ?? null, output_units: g.outputUnits ?? null,
      estimated_cost_usd: round(g.estimatedCostUsd), actual_cost_usd: round(g.actualCostUsd),
      retry_count: g.retryCount ?? 0, fallback_from: g.fallbackFrom ?? null, error: g.error?.slice(0, 500) ?? null,
      provider_generation_id: g.providerGenerationId ?? null, latency_ms: g.latencyMs ?? null, meta: g.meta ?? {},
    }).select('id').single();
    if (error) throw error;
    return data.id as string;
  } catch (e: any) {
    if (!warned) { warned = true; console.warn('[ledger] could not write ai_generations (run migration 500):', e?.message ?? e); }
    return null;
  }
}

/** Closes a running job by the provider's job id (video, image). Only rows still running change. */
export async function finishGeneration(provider: string, providerGenerationId: string, patch: {
  status: 'succeeded' | 'failed' | 'cancelled'; actualCostUsd?: number | null; outputUnits?: number | null;
  durationSeconds?: number | null; error?: string | null;
}) {
  try {
    const { data } = await adminDb().from('ai_generations').select('id, created_at')
      .eq('provider', provider).eq('provider_generation_id', providerGenerationId).eq('status', 'running').limit(1).maybeSingle();
    if (!data) return;
    await adminDb().from('ai_generations').update({
      status: patch.status,
      ...(patch.actualCostUsd !== undefined ? { actual_cost_usd: round(patch.actualCostUsd) } : {}),
      ...(patch.status === 'cancelled' ? { actual_cost_usd: 0 } : {}),
      ...(patch.outputUnits != null ? { output_units: patch.outputUnits } : {}),
      ...(patch.durationSeconds != null ? { duration_seconds: patch.durationSeconds } : {}),
      ...(patch.error ? { error: patch.error.slice(0, 500) } : {}),
      latency_ms: Date.now() - new Date(data.created_at as string).getTime(),
    }).eq('id', data.id);
  } catch { /* ledger is best effort */ }
}
