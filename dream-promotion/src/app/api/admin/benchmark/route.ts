import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/server/admin-auth';
import { submitVideoDirect, videoProviders, videoStatus } from '@/lib/server/ai/router';
import { ProviderError } from '@/lib/server/ai/types';
import type { ProviderId } from '@/lib/server/ai/config';

export const runtime = 'nodejs';

/**
 * Provider benchmark — admins only, never automatic: the same prompt to several video
 * providers, each run logged with its time, cost and result (meta.benchmark in the ledger).
 *  GET                         → providers and whether they are configured
 *  POST {action:'submit', prompt, duration, resolution, providers[], confirm:true}
 *  POST {action:'status', handle, jobId}
 */
export async function GET(req: Request) {
  const gate = await requireAdmin(req);
  if (gate.denied) return gate.denied;
  return NextResponse.json({ providers: videoProviders() });
}

export async function POST(req: Request) {
  const gate = await requireAdmin(req);
  if (gate.denied) return gate.denied;
  const body = await req.json().catch(() => ({}));

  if (body.action === 'submit') {
    if (body.confirm !== true) return NextResponse.json({ code: 'confirm_required', message: 'a benchmark spends money — confirm first' }, { status: 400 });
    const prompt = String(body.prompt ?? '').trim().slice(0, 2000);
    if (!prompt) return NextResponse.json({ code: 'bad_request', message: 'prompt required' }, { status: 400 });
    const duration = Math.min(10, Math.max(2, Math.round(Number(body.duration) || 5))); // short on purpose: it is a test
    const resolution = body.resolution === '1080p' ? '1080p' : body.resolution === '480p' ? '480p' : '720p';
    const known = new Set(videoProviders().map((p) => p.id));
    const chosen = (Array.isArray(body.providers) ? body.providers : []).filter((p: string) => known.has(p as ProviderId)).slice(0, 4) as ProviderId[];
    if (!chosen.length) return NextResponse.json({ code: 'bad_request', message: 'choose providers' }, { status: 400 });

    const req2 = { prompt, duration, resolution, aspectRatio: '9:16', audio: true } as const;
    const results = await Promise.all(chosen.map(async (id) => {
      try { return { ok: true as const, startedAt: Date.now(), ...(await submitVideoDirect(id, { userId: gate.admin.id, contentId: null }, { ...req2 })) }; }
      catch (e: any) { return { ok: false as const, provider: id, error: e instanceof ProviderError ? `${e.kind}: ${e.message}` : String(e?.message ?? e) }; }
    }));
    return NextResponse.json({ duration, resolution, results });
  }

  if (body.action === 'status') {
    const st = await videoStatus(String(body.handle ?? ''), String(body.jobId ?? ''));
    if (!st) return NextResponse.json({ code: 'bad_request', message: 'unknown job' }, { status: 400 });
    return NextResponse.json(st);
  }

  return NextResponse.json({ code: 'bad_request', message: 'unknown action' }, { status: 400 });
}
