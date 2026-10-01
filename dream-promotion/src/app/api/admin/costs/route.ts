import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/server/admin';
import { requireAdmin } from '@/lib/server/admin-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Internal cost & usage report from the generation ledger (ai_generations). Admins only.
 * GET ?from=ISO&to=ISO (default: this month). Never returns keys or tokens — only costs, counts,
 * names and emails. The cost that counts is the actual one when the provider reported it,
 * otherwise the estimate; "unknown" rows (no price configured) are counted separately.
 */
type Row = {
  user_id: string | null; content_id: string | null; generation_type: string; provider: string; model: string;
  quality_mode: string | null; status: string; estimated_cost_usd: number | null; actual_cost_usd: number | null;
  retry_count: number; fallback_from: string | null; latency_ms: number | null; error: string | null; created_at: string; meta: any;
};
const usd = (r: Row) => Number(r.actual_cost_usd ?? r.estimated_cost_usd ?? 0);
const known = (r: Row) => r.actual_cost_usd != null || r.estimated_cost_usd != null;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

function groupBy(rows: Row[], key: (r: Row) => string) {
  const m = new Map<string, { key: string; cost: number; calls: number; failed: number; unknown: number }>();
  for (const r of rows) {
    const k = key(r) || '—';
    const g = m.get(k) ?? { key: k, cost: 0, calls: 0, failed: 0, unknown: 0 };
    if (r.status !== 'cancelled') g.cost += usd(r);
    g.calls++;
    if (r.status === 'failed') g.failed++;
    if (!known(r)) g.unknown++;
    m.set(k, g);
  }
  return [...m.values()].map((g) => ({ ...g, cost: r4(g.cost) })).sort((a, b) => b.cost - a.cost);
}

export async function GET(req: Request) {
  const gate = await requireAdmin(req);
  if (gate.denied) return gate.denied;

  const url = new URL(req.url);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const from = new Date(url.searchParams.get('from') || monthStart.toISOString());
  const to = new Date(url.searchParams.get('to') || now.toISOString());
  if (Number.isNaN(+from) || Number.isNaN(+to) || from > to) return NextResponse.json({ code: 'bad_request', message: 'bad dates' }, { status: 400 });

  const db = adminDb();
  const rows: Row[] = [];
  // page through the period (the ledger can be large)
  for (let page = 0; page < 50; page++) {
    const { data, error } = await db.from('ai_generations')
      .select('user_id, content_id, generation_type, provider, model, quality_mode, status, estimated_cost_usd, actual_cost_usd, retry_count, fallback_from, latency_ms, error, created_at, meta')
      .gte('created_at', from.toISOString()).lte('created_at', to.toISOString())
      .order('created_at', { ascending: false }).range(page * 1000, page * 1000 + 999);
    if (error) return NextResponse.json({ code: 'no_ledger', message: `${error.message} — run supabase/migrations/20261001000500` }, { status: 500 });
    rows.push(...(data as Row[]));
    if (!data || data.length < 1000) break;
  }

  // today & this month always, whatever the filter
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const sumSince = async (iso: string) => {
    const { data } = await db.from('ai_generations').select('estimated_cost_usd, actual_cost_usd, status, meta').gte('created_at', iso).limit(50000);
    return r4((data ?? []).filter((r: any) => r.status !== 'cancelled' && !r.meta?.benchmark).reduce((a: number, r: any) => a + Number(r.actual_cost_usd ?? r.estimated_cost_usd ?? 0), 0));
  };
  const [today, month] = await Promise.all([sumSince(dayStart), sumSince(monthStart.toISOString())]);

  const live = rows.filter((r) => r.status !== 'cancelled' && !r.meta?.benchmark);
  const bench = rows.filter((r) => r.meta?.benchmark);
  const total = r4(live.reduce((a, r) => a + usd(r), 0));
  const users = new Set(live.map((r) => r.user_id).filter(Boolean));

  // per reel: everything made for a content item that is a reel
  const contentIds = [...new Set(live.map((r) => r.content_id).filter(Boolean))] as string[];
  const reelInfo = new Map<string, { title: string; kind: string; user: string | null }>();
  for (let k = 0; k < contentIds.length; k += 200) {
    const { data } = await db.from('content').select('id, headline, kind, user_id').in('id', contentIds.slice(k, k + 200));
    for (const c of data ?? []) reelInfo.set(c.id, { title: c.headline || '—', kind: c.kind, user: c.user_id });
  }
  const perContent = groupBy(live.filter((r) => r.content_id), (r) => r.content_id!);
  const reels = perContent.filter((g) => reelInfo.get(g.key)?.kind === 'reel').map((g) => {
    const rs = live.filter((r) => r.content_id === g.key);
    const by = (t: string) => r4(rs.filter((r) => r.generation_type === t).reduce((a, r) => a + usd(r), 0));
    return {
      contentId: g.key, title: reelInfo.get(g.key)?.title ?? '—', userId: reelInfo.get(g.key)?.user ?? null,
      total: g.cost, video: by('video'), image: by('image'), voice: by('voice'), text: by('text'), transcribe: by('transcribe'), render: by('render'),
      retry: r4(rs.filter((r) => r.retry_count > 0 || r.fallback_from).reduce((a, r) => a + usd(r), 0)), calls: g.calls,
    };
  });

  // emails for the user ids that appear (profiles.email; never tokens)
  const ids = [...users] as string[];
  const emails = new Map<string, string>();
  for (let k = 0; k < ids.length; k += 200) {
    const { data } = await db.from('profiles').select('id, email').in('id', ids.slice(k, k + 200));
    for (const p of data ?? []) emails.set(p.id, p.email || p.id.slice(0, 8));
  }
  const name = (id: string | null) => (id ? emails.get(id) ?? id.slice(0, 8) : 'access code');

  const health = groupBy(rows.filter((r) => r.status !== 'running'), (r) => `${r.provider}|${r.model}|${r.generation_type}`).map((g) => {
    const [provider, model, type] = g.key.split('|');
    const rs = rows.filter((r) => r.provider === provider && r.model === model && r.generation_type === type);
    const done = rs.filter((r) => r.status === 'succeeded');
    const lat = done.map((r) => r.latency_ms).filter((n): n is number => typeof n === 'number');
    return {
      provider, model, type, calls: rs.length, succeeded: done.length, failed: rs.filter((r) => r.status === 'failed').length,
      running: rs.filter((r) => r.status === 'running').length,
      successRate: rs.filter((r) => r.status !== 'running').length ? Math.round((1000 * done.length) / rs.filter((r) => r.status !== 'running').length) / 10 : null,
      avgSeconds: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length / 100) / 10 : null,
      recentErrors: rs.filter((r) => r.error).slice(0, 3).map((r) => ({ at: r.created_at, error: r.error })),
    };
  });

  return NextResponse.json({
    period: { from: from.toISOString(), to: to.toISOString() },
    summary: {
      today, month, total,
      reels: reels.length, avgPerReel: reels.length ? r4(reels.reduce((a, r) => a + r.total, 0) / reels.length) : null,
      activeUsers: users.size, avgPerUser: users.size ? r4(total / users.size) : null,
      failedCost: r4(live.filter((r) => r.status === 'failed').reduce((a, r) => a + usd(r), 0)),
      retryCost: r4(live.filter((r) => r.retry_count > 0 || r.fallback_from).reduce((a, r) => a + usd(r), 0)),
      unknownPriceCalls: live.filter((r) => !known(r)).length,
      benchmarkCost: r4(bench.reduce((a, r) => a + usd(r), 0)),
      calls: live.length,
    },
    byType: groupBy(live, (r) => r.generation_type),
    byProvider: groupBy(live, (r) => r.provider),
    byModel: groupBy(live, (r) => `${r.provider} · ${r.model}`),
    byQuality: groupBy(live.filter((r) => r.quality_mode), (r) => r.quality_mode!),
    byUser: groupBy(live, (r) => name(r.user_id)).slice(0, 20),
    topReels: reels.sort((a, b) => b.total - a.total).slice(0, 20).map((r) => ({ ...r, user: name(r.userId) })),
    health,
  });
}
