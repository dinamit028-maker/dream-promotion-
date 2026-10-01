import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Server-side usage limits for everything that costs money: video seconds, images,
 * voice characters. Counted per user per calendar month in public.usage, written only
 * with the service key — the browser can neither see nor reset the counter.
 *
 * Limits come from the environment; 0 means unlimited:
 *   QUOTA_VIDEO_SECONDS_MONTH  (default 300)
 *   QUOTA_IMAGES_MONTH         (default 200)
 *   QUOTA_VOICE_CHARS_MONTH    (default 30000)
 */
export type UsageKind = 'video' | 'image' | 'voice';

const LIMITS: Record<UsageKind, { env: string; def: number; unit: string }> = {
  video: { env: 'QUOTA_VIDEO_SECONDS_MONTH', def: 300, unit: 'שניות וידאו' },
  image: { env: 'QUOTA_IMAGES_MONTH', def: 200, unit: 'תמונות' },
  voice: { env: 'QUOTA_VOICE_CHARS_MONTH', def: 30000, unit: 'תווי קריינות' },
};
export const limitFor = (k: UsageKind) => {
  const v = Number(process.env[LIMITS[k].env]);
  return Number.isFinite(v) && process.env[LIMITS[k].env] !== undefined ? v : LIMITS[k].def;
};

let admin: SupabaseClient | null = null;
function db(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!admin) admin = createClient(url, key, { auth: { persistSession: false } });
  return admin;
}

/** The signed-in user behind a request, or null (access-code callers share one bucket). */
export async function requestUser(req: Request): Promise<string | null> {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const sb = db();
  if (!token || !sb) return null;
  const { data } = await sb.auth.getUser(token);
  return data.user?.id ?? null;
}

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };

export async function usedThisMonth(userId: string | null, kind: UsageKind): Promise<number | null> {
  const sb = db();
  if (!sb) return null;
  let q = sb.from('usage').select('*').eq('kind', kind).gte('created_at', monthStart());
  q = userId ? q.eq('user_id', userId) : q.is('user_id', null);
  const { data, error } = await q;
  if (error) { console.warn('[quota] usage table unavailable:', error.message); return null; }
  return (data ?? []).filter((r: any) => r.status !== 'released').reduce((s: number, r: any) => s + Number(r.units || 0), 0);
}

/** Per-user protection besides the monthly quota (0 = off). */
const GUARDS: Record<UsageKind, { concurrentEnv: string; concurrent: number; perMinuteEnv: string; perMinute: number }> = {
  video: { concurrentEnv: 'LIMIT_CONCURRENT_VIDEO', concurrent: 3, perMinuteEnv: 'LIMIT_PER_MINUTE_VIDEO', perMinute: 10 },
  image: { concurrentEnv: 'LIMIT_CONCURRENT_IMAGE', concurrent: 4, perMinuteEnv: 'LIMIT_PER_MINUTE_IMAGE', perMinute: 20 },
  voice: { concurrentEnv: 'LIMIT_CONCURRENT_VOICE', concurrent: 4, perMinuteEnv: 'LIMIT_PER_MINUTE_VOICE', perMinute: 40 },
};
const envInt = (name: string, def: number) => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(v) ? Math.max(0, Math.round(v)) : def;
};

/**
 * A slot reserved before spending. id is the usage row; null when the database functions
 * are not installed yet (then the older check-then-record path runs, see legacy).
 */
export interface Reservation { id: string | null; userId: string | null; kind: UsageKind; units: number; legacy?: boolean }

const MISSING_FN = /reserve_usage|PGRST202|42883|function .* does not exist|schema cache/i;

/**
 * Call before spending. Reserves the units atomically (one transaction, per-user lock), so
 * requests sent together cannot slip past the monthly quota, the number of jobs running at
 * once, or the per-minute limit. Returns { denied } with a ready 429 response, or { reservation }.
 * Afterwards call commitUsage (the provider accepted the job) or releaseUsage (it failed first).
 */
export async function reserveUsage(userId: string | null, kind: UsageKind, units: number, meta: Record<string, unknown> = {}):
  Promise<{ denied: NextResponse; reservation?: undefined } | { denied?: undefined; reservation: Reservation }> {
  const sb = db();
  if (!sb) return { reservation: { id: null, userId, kind, units, legacy: true } };
  const g = GUARDS[kind];
  const { data, error } = await sb.rpc('reserve_usage', {
    p_user: userId, p_kind: kind, p_units: units, p_limit: limitFor(kind),
    p_max_concurrent: envInt(g.concurrentEnv, g.concurrent), p_max_per_minute: envInt(g.perMinuteEnv, g.perMinute), p_meta: meta,
  });
  if (error) {
    if (MISSING_FN.test(`${error.code} ${error.message}`)) {
      console.warn('[quota] reserve_usage missing — run supabase/migrations/20261001000300. Falling back to the old check.');
      const over = await legacyDenied(userId, kind, units);
      return over ? { denied: over } : { reservation: { id: null, userId, kind, units, legacy: true } };
    }
    console.error('[quota] reserve failed:', error.message);
    return { denied: NextResponse.json({ code: 'quota_unavailable', message: 'לא ניתן לבדוק את המכסה כרגע. נסו שוב בעוד רגע.' }, { status: 503 }) };
  }
  const r = data as { ok: boolean; id?: string; reason?: string; used?: number; limit?: number; max?: number };
  if (r.ok && r.id) return { reservation: { id: r.id, userId, kind, units } };
  if (r.reason === 'quota_exceeded') {
    return { denied: NextResponse.json({
      code: 'quota_exceeded', kind, limit: r.limit, used: r.used, requested: units,
      message: `הגעתם למכסה החודשית: ${Math.round(Number(r.used ?? 0))} מתוך ${r.limit} ${LIMITS[kind].unit}.`,
    }, { status: 429 }) };
  }
  if (r.reason === 'too_many_running') {
    return { denied: NextResponse.json({ code: 'too_many_running', kind, max: r.max,
      message: `כבר רצות ${r.max} יצירות במקביל. חכו שאחת תסתיים ונסו שוב.` }, { status: 429 }) };
  }
  if (r.reason === 'rate_limited') {
    return { denied: NextResponse.json({ code: 'rate_limited', kind, max: r.max,
      message: 'יותר מדי בקשות בדקה האחרונה. נסו שוב בעוד רגע.' }, { status: 429 }) };
  }
  return { denied: NextResponse.json({ code: 'bad_request', message: r.reason ?? 'refused' }, { status: 400 }) };
}

/**
 * The provider accepted the job. status 'running' for jobs that finish later (video — closed
 * by finishUsage when its status is polled), 'done' for the rest. Cost is computed on the server.
 */
export async function commitUsage(r: Reservation, o: { status: 'running' | 'done'; costUsd: number; requestId?: string; meta?: Record<string, unknown> }) {
  const sb = db();
  if (!sb) return;
  if (r.legacy || !r.id) { await legacyRecord(r.userId, r.kind, r.units, o.costUsd, { ...(o.meta ?? {}), ...(o.requestId ? { requestId: o.requestId } : {}) }); return; }
  const { error } = await sb.rpc('commit_usage', { p_id: r.id, p_status: o.status, p_cost: o.costUsd, p_request_id: o.requestId ?? null, p_meta: o.meta ?? {} });
  if (error) console.warn('[quota] commit failed:', error.message);
}

/** The job failed before the provider accepted it: the units go back. Never throws. */
export async function releaseUsage(r: Reservation, reason: string) {
  const sb = db();
  if (!sb || r.legacy || !r.id) return;
  const { error } = await sb.rpc('release_usage', { p_id: r.id, p_reason: reason.slice(0, 200) });
  if (error) console.warn('[quota] release failed:', error.message);
}

/** A running job ended. refund: the provider dropped it before billing (cancelled in queue, failed). */
export async function finishUsage(requestId: string, ok: boolean, refund = false) {
  const sb = db();
  if (!sb || !requestId) return;
  const { error } = await sb.rpc('finish_usage', { p_request_id: requestId, p_ok: ok, p_refund: refund });
  if (error && !MISSING_FN.test(`${error.code} ${error.message}`)) console.warn('[quota] finish failed:', error.message);
}

/** Cancelled while still queued, so nothing was billed. */
export async function refundUsage(userId: string | null, requestId: string) {
  await finishUsage(requestId, false, true);
  const sb = db();
  if (!sb) return;
  // rows written before the reservation functions existed
  let q = sb.from('usage').delete().eq('kind', 'video').eq('meta->>requestId', requestId).is('request_id', null);
  q = userId ? q.eq('user_id', userId) : q.is('user_id', null);
  const { error } = await q;
  if (error && !/request_id/.test(error.message)) console.warn('[quota] refund failed:', error.message);
}

// ------------------------------------------------ before migration 300 is installed --
async function legacyDenied(userId: string | null, kind: UsageKind, units: number) {
  const limit = limitFor(kind);
  if (!limit) return null;
  const used = await usedThisMonth(userId, kind);
  if (used === null || used + units <= limit) return null;
  return NextResponse.json({
    code: 'quota_exceeded', kind, limit, used, requested: units,
    message: `הגעתם למכסה החודשית: ${Math.round(used)} מתוך ${limit} ${LIMITS[kind].unit}.`,
  }, { status: 429 });
}
async function legacyRecord(userId: string | null, kind: UsageKind, units: number, costUsd: number, meta: Record<string, unknown>) {
  const sb = db();
  if (!sb || !(units > 0)) return;
  const { error } = await sb.from('usage').insert({ user_id: userId, kind, units, cost_usd: costUsd, meta });
  if (error) console.warn('[quota] could not record usage:', error.message);
}
