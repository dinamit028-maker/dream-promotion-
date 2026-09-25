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
  let q = sb.from('usage').select('units').eq('kind', kind).gte('created_at', monthStart());
  q = userId ? q.eq('user_id', userId) : q.is('user_id', null);
  const { data, error } = await q;
  if (error) { console.warn('[quota] usage table unavailable:', error.message); return null; }
  return (data ?? []).reduce((s: number, r: any) => s + Number(r.units || 0), 0);
}

/**
 * Call before spending. Returns a 429 quota_exceeded response when this request would
 * go over the monthly limit; otherwise null. If the usage table has not been created
 * yet the request is allowed and a warning is logged (see supabase/migrations).
 */
export async function quotaDenied(userId: string | null, kind: UsageKind, units: number) {
  const limit = limitFor(kind);
  if (!limit) return null;
  const used = await usedThisMonth(userId, kind);
  if (used === null) return null;
  if (used + units > limit) {
    return NextResponse.json({
      code: 'quota_exceeded', kind, limit, used, requested: units,
      message: `הגעתם למכסה החודשית: ${Math.round(used)} מתוך ${limit} ${LIMITS[kind].unit}.`,
    }, { status: 429 });
  }
  return null;
}

/** Removes the usage row of a job that was cancelled before it cost anything. */
export async function refundUsage(userId: string | null, requestId: string) {
  const sb = db();
  if (!sb) return;
  let q = sb.from('usage').delete().eq('kind', 'video').eq('meta->>requestId', requestId);
  q = userId ? q.eq('user_id', userId) : q.is('user_id', null);
  const { error } = await q;
  if (error) console.warn('[quota] refund failed:', error.message);
}

/** Call after the provider accepted the job. Never throws. */
export async function recordUsage(userId: string | null, kind: UsageKind, units: number, costUsd = 0, meta: Record<string, unknown> = {}) {
  const sb = db();
  if (!sb || !(units > 0)) return;
  const { error } = await sb.from('usage').insert({ user_id: userId, kind, units, cost_usd: costUsd, meta });
  if (error) console.warn('[quota] could not record usage:', error.message);
}
