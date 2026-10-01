import { NextResponse } from 'next/server';
import { accessDenied } from '@/lib/server/access';
import { commitUsage, finishUsage, refundUsage, releaseUsage, requestUser, reserveUsage } from '@/lib/server/quota';
import { AI_CONFIG, videoQualityOf } from '@/lib/server/ai/config';
import { cancelVideo, submitVideo, videoAvailable, videoEngineName, videoStatus } from '@/lib/server/ai/router';
import { contentIdFrom } from '@/lib/server/ai/ledger';
import { ProviderError } from '@/lib/server/ai/types';

export const runtime = 'nodejs';

/**
 * Video clips, through the AI router (provider, model and fallback come from AI_CONFIG).
 *  submit → { requestId, model }   (model is the job handle "provider:model" — the browser keeps it)
 *  status → IN_QUEUE | IN_PROGRESS | COMPLETED (url) | FAILED
 *  cancel → { cancelled } (true only if nothing was billed)
 */
const RESOLUTIONS = ['480p', '720p', '1080p'] as const;
const ASPECTS = ['9:16', '16:9', '1:1', '3:4', '4:3', 'adaptive'] as const;
const isImage = (v: unknown): v is string => typeof v === 'string' && (v.startsWith('data:image/') || v.startsWith('https://'));

const failureCode = (e: ProviderError) =>
  e.kind === 'quota' ? 'insufficient_balance' : e.kind === 'input' ? 'rejected_input' : e.kind === 'policy' ? 'content_policy'
    : e.kind === 'auth' ? 'provider_not_configured' : 'video_error';

export async function GET() {
  return NextResponse.json({ available: videoAvailable(), engine: videoEngineName() });
}

export async function POST(req: Request) {
  if (!videoAvailable()) return NextResponse.json({ code: 'no_fal_key', message: 'No video provider is configured' }, { status: 503 });
  const denied = await accessDenied(req);
  if (denied) return denied;

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ code: 'bad_request', message: 'Invalid JSON' }, { status: 400 });
  }

  try {
    if (body.action === 'submit') {
      const prompt = String(body.prompt ?? '').trim().slice(0, 4000);
      if (!prompt) return NextResponse.json({ code: 'bad_request', message: 'prompt required' }, { status: 400 });
      const duration = Math.min(AI_CONFIG.limits.maxVideoSeconds, Math.max(2, Math.round(Number(body.duration) || 15)));
      const resolution = RESOLUTIONS.includes(body.resolution) ? body.resolution : '720p';
      const quality = videoQualityOf(body.quality, resolution);

      const userId = await requestUser(req);
      const r = await reserveUsage(userId, 'video', duration, { resolution, quality });
      if (r.denied) return r.denied;
      const slot = r.reservation;

      try {
        const job = await submitVideo({ userId, contentId: await contentIdFrom(req, userId) }, {
          prompt, duration, resolution: AI_CONFIG.video[quality].resolution,
          aspectRatio: ASPECTS.includes(body.aspectRatio) ? body.aspectRatio : '9:16',
          startImage: isImage(body.startImage) ? body.startImage : undefined,
          endImage: isImage(body.endImage) ? body.endImage : undefined,
          audio: body.audio !== false,
        }, quality);
        // "running" until a status check sees it finish — it counts toward the parallel-jobs limit meanwhile
        await commitUsage(slot, { status: 'running', costUsd: job.estimate ?? 0, requestId: job.jobId, meta: { provider: job.provider, model: job.model, quality } });
        return NextResponse.json({ requestId: job.jobId, model: job.handle, duration, resolution: AI_CONFIG.video[quality].resolution, provider: job.provider });
      } catch (e) {
        await releaseUsage(slot, String((e as any)?.message ?? e));
        throw e;
      }
    }

    if (body.action === 'status') {
      const handle = String(body.model ?? ''), requestId = String(body.requestId ?? '');
      if (!handle || !requestId) return NextResponse.json({ code: 'bad_request', message: 'unknown job' }, { status: 400 });
      const st = await videoStatus(handle, requestId);
      if (!st) return NextResponse.json({ code: 'bad_request', message: 'unknown job' }, { status: 400 });
      if (st.state === 'succeeded') { await finishUsage(requestId, true); return NextResponse.json({ status: 'COMPLETED', url: st.url, duration: st.durationSec ?? null }); }
      if (st.state === 'failed') { await finishUsage(requestId, false, true); return NextResponse.json({ status: 'FAILED', code: failureCode(new ProviderError('fal', st.kind, st.error)), error: st.error }); }
      return NextResponse.json(st.state === 'queued' ? { status: 'IN_QUEUE', position: st.position ?? null } : { status: 'IN_PROGRESS', position: null });
    }

    if (body.action === 'cancel') {
      const handle = String(body.model ?? ''), requestId = String(body.requestId ?? '');
      if (!handle || !requestId) return NextResponse.json({ code: 'bad_request', message: 'unknown job' }, { status: 400 });
      // a provider can drop a job only while it waits in the queue; once rendering it is billed and kept
      const dropped = await cancelVideo(handle, requestId);
      if (dropped) await refundUsage(await requestUser(req), requestId);
      return NextResponse.json({ cancelled: dropped });
    }

    return NextResponse.json({ code: 'bad_request', message: 'unknown action' }, { status: 400 });
  } catch (e: any) {
    if (e instanceof ProviderError) {
      return NextResponse.json({ status: 'FAILED', code: failureCode(e), error: e.message, provider: e.provider }, { status: 200 });
    }
    return NextResponse.json({ status: 'FAILED', code: 'video_error', error: String(e?.message ?? e).slice(0, 400) }, { status: 200 });
  }
}
